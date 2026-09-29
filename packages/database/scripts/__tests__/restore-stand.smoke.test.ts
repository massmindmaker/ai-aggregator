import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as net from "node:net";

// Smoke test for the off-cluster restore stand (AG-6 Task 1).
// Boots a throwaway PostgreSQL 18 cluster via packages/database/scripts/restore-stand.sh,
// checks that psql reaches exactly that cluster, and verifies reset removes PGDATA.
// Fully self-contained: own PGDATA under /tmp, dynamically picked port, no shared
// cluster and no external calls.
//
// Gated on the native driver flag as well as the bundled tools: this test runs a real
// initdb + pg_ctl start, which costs seconds of CPU and must not ride along on every
// ordinary unit run. Same gate as the neighbouring native suites.

const script = resolve(__dirname, "../restore-stand.sh");
const toolsRoot = resolve(__dirname, "../../../../.superpowers/tools/native18/root");

const available =
  existsSync(join(toolsRoot, "usr/lib/postgresql/18/bin/postgres")) &&
  process.env.RUN_NATIVE_DB_INTEGRATION === "1";
const describeStand = available ? describe : describe.skip;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

describeStand("restore-stand smoke", () => {
  let pgdata: string;
  let port: number;
  const env: NodeJS.ProcessEnv = {};

  const run = (mode: string, args: string[] = []) =>
    execFileSync("bash", [script, mode, ...args], {
      env,
      encoding: "utf8",
      timeout: 120_000,
    });

  beforeAll(async () => {
    pgdata = join(mkdtempSync(join(tmpdir(), "aiag-stand-smoke-")), "pgdata");
    port = await freePort();
    env.PGDATA = pgdata;
    env.PGPORT = String(port);
    env.PATH = process.env.PATH;
  });

  afterAll(() => {
    if (pgdata !== undefined) {
      try {
        run("reset");
      } catch {
        // best effort: afterAll must not mask the test verdict
      }
      rmSync(join(pgdata, ".."), { recursive: true, force: true });
    }
  });

  it("start boots the stand on the caller-selected port", () => {
    const out = run("start");
    expect(out).toContain(`started on 127.0.0.1:${port}`);
  });

  it("psql sends commands to that exact cluster", () => {
    const out = run("psql", ["-tAc", "select inet_server_port(), current_user"]);
    expect(out.trim()).toBe(`${port}|postgres`);
  });

  it("reset stops the cluster and removes PGDATA entirely", () => {
    const out = run("reset");
    expect(out).toContain("removed");
    expect(existsSync(pgdata)).toBe(false);
  });
});
