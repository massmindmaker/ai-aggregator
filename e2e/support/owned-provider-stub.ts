/**
 * Owned provider stub for the buyer-journey end-to-end run.
 *
 * The gateway must make a REAL outbound HTTPS call for the charge to be real:
 * a mocked transport would make the billing path synthetic, which is exactly
 * the defect this suite exists to close (see docs/product/acceptance/AG-P7.md,
 * blocker 1). But the test may not spend real money or touch the real provider.
 *
 * So the call is real end to end EXCEPT for the far end of the socket:
 *
 *   gateway stored-chat attempt
 *     -> openrouter adapter -> fetchUpstream -> safeFetch
 *     -> "openrouter.ai" is in the adapter's own allowlist, so no DNS and no
 *        IP-range check happen
 *     -> AIAG_EGRESS_PROXY_URL points at our loopback CONNECT proxy
 *     -> the tunnel target is TLS-verified against OUR throwaway CA
 *        (NODE_EXTRA_CA_CERTS), for the real hostname openrouter.ai
 *     -> our stub answers with a schema-valid OpenRouter completion
 *
 * Nothing about the gateway, the adapter, safeFetch, the SSRF guard, the egress
 * tunnel, admission, settlement or the receipt is stubbed. The CA is generated
 * per run into a private temp dir and is trusted ONLY by the gateway child
 * process we spawn, never by the machine's trust store.
 *
 * Ports are ephemeral (0) so this never collides with the owned web preview.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Upstream host the openrouter adapter is hard-wired to. */
const UPSTREAM_HOST = "openrouter.ai";

export type ProviderStub = {
  /** Value for the gateway child's AIAG_EGRESS_PROXY_URL. */
  proxyUrl: string;
  /** Value for the gateway child's NODE_EXTRA_CA_CERTS. */
  caFile: string;
  /** Requests the stub actually received — proves the call was not short-circuited. */
  readonly calls: ReadonlyArray<{ path: string; body: unknown }>;
  close(): void;
};

function openssl(cwd: string, args: string[]): void {
  execFileSync("openssl", args, { cwd, stdio: "pipe" });
}

export async function startProviderStub(): Promise<ProviderStub> {
  const dir = mkdtempSync(join(tmpdir(), "aiag-buyer-stub-"));
  // A CA plus a leaf for the upstream hostname. openSSL is the only dependency;
  // the private key never leaves the temp dir.
  openssl(dir, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", "ca.key", "-out", "ca.pem", "-days", "1",
    "-subj", "/CN=AIAG Owned Test Provider CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
  ]);
  writeFileSync(
    join(dir, "leaf.cnf"),
    `subjectAltName=DNS:${UPSTREAM_HOST}\nbasicConstraints=critical,CA:FALSE\n` +
      "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  );
  openssl(dir, [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${UPSTREAM_HOST}`,
  ]);
  openssl(dir, [
    "x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "leaf.cnf",
  ]);

  const calls: Array<{ path: string; body: unknown }> = [];

  // The stub provider. Only the two endpoints the openrouter adapter can reach
  // for an admitted chat are answered; anything else is a hard 404 so an
  // unexpected outbound call fails loudly instead of passing quietly.
  const provider: HttpsServer = createHttpsServer({
    key: readFileSync(join(dir, "leaf.key")),
    cert: readFileSync(join(dir, "leaf.pem")),
  });
  provider.on("request", (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      if (request.method !== "POST" || !request.url?.startsWith("/api/v1/")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "owned stub: unexpected route" }));
        return;
      }
      calls.push({ path: request.url, body });
      const model =
        body && typeof body === "object" && "model" in body
          ? String((body as { model: unknown }).model)
          : "openai/gpt-4o-mini";
      // Shaped to satisfy the adapter's admittedResponse zod schema, so the
      // gateway accepts it as genuine provider output. The token counts are
      // fixed and non-zero so the settled charge is a deterministic number.
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-owned-stub",
          object: "chat.completion",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "owned stub reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
    });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const providerPort = (provider.address() as { port: number }).port;

  // HTTP CONNECT proxy. It deliberately ignores the requested authority and
  // dials the loopback stub instead: that is what keeps the run offline while
  // leaving the gateway's own TLS verification fully intact.
  const proxy: NetServer = createNetServer((client) => {
    let head = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onHead);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = head.subarray(end + 4);
      const upstream = netConnect(providerPort, "127.0.0.1");
      upstream.on("error", () => client.destroy());
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
    };
    client.on("data", onHead);
    client.on("error", () => {});
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyPort = (proxy.address() as { port: number }).port;

  return {
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    caFile: join(dir, "ca.pem"),
    calls,
    close() {
      provider.close();
      proxy.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Spawn the real gateway (packages/api-gateway/src/server-node.ts under tsx)
 * against the disposable test database and Redis, wired to the provider stub.
 *
 * This is the production entry point pm2 runs (ops/ecosystem.config.cjs), not a
 * test-only composition — the only differences are the disposable DSNs and the
 * stub egress proxy.
 */
export type GatewayHandle = {
  url: string;
  output: () => string;
  stop(): Promise<void>;
};

export async function startGateway(args: {
  databaseUrl: string;
  redisUrl: string;
  stub: ProviderStub;
  logFile: string;
  repoRoot: string;
}): Promise<GatewayHandle> {
  const { appendFileSync: append } = await import("node:fs");
  const port = 4000;
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--import", "tsx",
      "packages/api-gateway/src/server-node.ts",
    ],
    {
      cwd: args.repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C.UTF-8",
        NODE_ENV: "production",
        PORT: String(port),
        DATABASE_URL: args.databaseUrl,
        REDIS_URL: args.redisUrl,
        // Sold v1 execution: durable claim -> admit -> dispatch -> settle.
        GATEWAY_HTTP_EXECUTION_MODE: "stored_chat_only",
        // Present so the openrouter adapter does not fail closed before it ever
        // reaches the transport. Never sent anywhere real: the request is
        // routed to the owned stub through the egress proxy below.
        OPENROUTER_API_KEY: "owned-stub-transport-only",
        AIAG_EGRESS_PROXY_URL: args.stub.proxyUrl,
        NODE_EXTRA_CA_CERTS: args.stub.caFile,
        LOG_LEVEL: "error",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const record = (chunk: Buffer) => append(args.logFile, chunk);
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(
        "Owned gateway exited before ready:\n" + readFileSync(args.logFile, "utf8"),
      );
    try {
      const response = await fetch(url + "/health", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.status === 200) break;
    } catch {
      /* still starting */
    }
    if (Date.now() > deadline)
      throw new Error(
        "Owned gateway did not become ready:\n" + readFileSync(args.logFile, "utf8"),
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    url,
    output: () => {
      try {
        return readFileSync(args.logFile, "utf8");
      } catch {
        return "";
      }
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}
