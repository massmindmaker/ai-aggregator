/**
 * MCP (skills) client for the agent-worker — feat-4 smallest slice.
 *
 * Lets an agent call tools on a USER-SUPPLIED remote MCP server over Streamable
 * HTTP (the only transport that fits a 2GB, no-per-user-process box). One
 * transient client per run, opened at run start and closed in a `finally` — the
 * stateless worker keeps zero MCP state between runs.
 *
 * SECURITY (load-bearing):
 *  - The MCP SDK's transport uses plain `fetch`, which BYPASSES our SSRF guard.
 *    We inject `safeFetch` (allowlist `[]` → no internal host may pass) as the
 *    transport's fetch, so EVERY hop (initialize / listTools / callTool /
 *    redirects) is HTTPS-only, IP-range-blocked, socket-pinned (anti DNS-rebind)
 *    and per-redirect re-validated. `127.0.0.1:4000` (our gateway), RFC1918,
 *    link-local and cloud-metadata are all blocked.
 *  - We advertise EMPTY client capabilities → the server cannot request
 *    sampling/roots/elicitation (no server-initiated, billable, brand-leaking
 *    LLM calls).
 *  - Tool count clamped, results size-capped, per-call timeout. Read-only v1.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { safeFetch } from './safe-fetch.js';
import type { ToolDef, ToolExecResult } from './tools.js';

export type McpClient = Client;

const MAX_MCP_TOOLS = 32;
const MCP_TIMEOUT_MS = 15_000;
const MCP_RESULT_MAX = 8000;
export const MCP_PREFIX = 'mcp__';

export interface McpEndpoint {
  url: string;
  authHeader?: string | null;
}

// safeFetch with NO allowlist → a user MCP URL gets full SSRF validation on
// every hop. Cast through unknown: safeFetch's RequestInit superset is assignable
// to the SDK's expected fetch signature for our use (method/headers/body/signal).
const mcpSafeFetch = ((input: string | URL | Request, init?: RequestInit) =>
  safeFetch(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, {
    ...(init ?? {}),
    allowlist: [],
  })) as unknown as typeof fetch;

/** Connect to a user MCP server. Throws (SsrfError / connect error) on failure. */
export async function openMcp(ep: McpEndpoint): Promise<McpClient> {
  const u = new URL(ep.url);
  if (u.protocol !== 'https:') throw new Error('mcp_endpoint_must_be_https');

  const transport = new StreamableHTTPClientTransport(u, {
    fetch: mcpSafeFetch,
    requestInit: ep.authHeader ? { headers: { Authorization: ep.authHeader } } : {},
  });
  const client = new Client(
    { name: 'aiag-agent-worker', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

/** List the server's tools, clamp + namespace them as OpenAI ToolDefs. */
export async function listMcpToolDefs(client: McpClient): Promise<ToolDef[]> {
  const listed = await client.listTools();
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  return tools
    .filter(
      (t) =>
        t &&
        typeof t.name === 'string' &&
        // sane function name (OpenAI allows [a-zA-Z0-9_-], ≤64); also blocks a
        // hostile server from injecting weird/huge names that break the model call
        /^[a-zA-Z0-9_.-]{1,48}$/.test(t.name) &&
        t.inputSchema,
    )
    .slice(0, MAX_MCP_TOOLS)
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: `${MCP_PREFIX}${t.name}`,
        // cap attacker-controlled description (defense-in-depth vs context flooding)
        description: (typeof t.description === 'string' ? t.description : '').slice(0, 1000),
        parameters: (t.inputSchema as Record<string, unknown>) ?? {
          type: 'object',
          properties: {},
        },
      },
    }));
}

/**
 * Call one MCP tool (bare name, prefix already stripped). Returns the same
 * { result, cost_rub } shape as executeTool so the run loop's accounting is
 * untouched. cost_rub = 0 (we proxy a call to the user's own server, no model
 * debit — commission rule). Never throws: errors degrade to a result the model
 * can read.
 */
export async function callMcpTool(
  client: McpClient,
  bareName: string,
  args: Record<string, unknown>,
): Promise<ToolExecResult> {
  try {
    const res = await client.callTool(
      { name: bareName, arguments: args },
      undefined,
      { timeout: MCP_TIMEOUT_MS },
    );
    const content = Array.isArray((res as { content?: unknown }).content)
      ? ((res as { content: Array<{ type?: string; text?: string }> }).content)
      : [];
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
      .slice(0, MCP_RESULT_MAX);
    if ((res as { isError?: boolean }).isError) {
      return { result: { error: text || 'mcp tool error' }, cost_rub: 0 };
    }
    return { result: { result: text }, cost_rub: 0 };
  } catch (e) {
    return { result: { error: `mcp: ${(e as Error).message.slice(0, 200)}` }, cost_rub: 0 };
  }
}
