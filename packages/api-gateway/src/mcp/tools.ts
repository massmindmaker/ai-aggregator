/**
 * MCP facade tools (plan 2026-10-09 agentic-rail, Task 11).
 *
 * Nine `aiag_*` tools that expose the ALREADY-EXISTING agent rail to MCP
 * clients. NO business logic lives here: every tool delegates to the
 * `AgentGatewayService` seam, which `mcp/server.ts` implements by invoking the
 * SAME Hono route handlers the public /v1 HTTP surface uses (agent-topup,
 * agent-keys, agent-policy, balance, models, chat) — so every guard, rate
 * window, error mapping and audit trail of those routes applies unchanged.
 *
 * Result contract:
 *  - 2xx service reply → CallToolResult with BOTH `structuredContent` (the
 *    gateway JSON body, machine-readable) and a text mirror of it.
 *  - non-2xx service reply → CallToolResult with `isError: true` whose
 *    `structuredContent` is the EXACT gateway error envelope
 *    ({error:{code,message}}) — code and message are 1:1 with the HTTP
 *    contract. MCP execution errors are reported inside the result
 *    (CallToolResult.isError), not as JSON-RPC protocol errors: that is the
 *    MCP spec's channel for tool failures and what the SDK enforces — the
 *    gateway codes still cross the wire unchanged for the agent to branch on.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A gateway route reply: HTTP status + the parsed JSON body ({} on parse failure). */
export interface ServiceReply {
  status: number;
  body: unknown;
}

/**
 * The seam tools delegate to. Implemented in mcp/server.ts as an in-process
 * Hono sub-app over the existing v1 routes — never an HTTP loopback.
 */
export interface AgentGatewayService {
  get(path: string): Promise<ServiceReply>;
  post(path: string, body?: unknown): Promise<ServiceReply>;
  put(path: string, body: unknown): Promise<ServiceReply>;
  /** `aiag://catalog` resource: public-catalog snapshot for the calling key. */
  readCatalogSnapshot(): Promise<ServiceReply>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Service reply → CallToolResult (see the module doc for the error contract). */
export function toToolResult(reply: ServiceReply): CallToolResult {
  const text = JSON.stringify(isRecord(reply.body) ? reply.body : {});
  if (reply.status >= 200 && reply.status < 300 && isRecord(reply.body)) {
    return {
      content: [{ type: 'text', text }],
      structuredContent: reply.body,
    };
  }
  return {
    content: [{ type: 'text', text }],
    ...(isRecord(reply.body) ? { structuredContent: reply.body } : {}),
    isError: true,
  };
}

// ── Shared schemas (mirror the route contracts; final validation stays in the routes) ──

/** Same charset the agent rail enforces (agent-topup.ts CREDITS). */
const WHOLE_CREDITS = /^(0|[1-9][0-9]{0,15})$/;
/** Same charset the agent rail enforces (agent-topup.ts IDEMPOTENCY_KEY). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,96}$/;
/** Lowercase canonical UUID (agent-topup.ts / agent-keys.ts UUID). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ROUTING_MODES = ['auto', 'fastest', 'cheapest', 'balanced', 'ru-only'] as const;

/**
 * PATCH-semantics policy patch — the same field set PUT /v1/agent/policy
 * (Task 8) accepts: every field optional, null clears. The "at least one
 * field" refinement is NOT mirrored here on purpose: the tool schema is a
 * plain ZodRawShape (the SDK wraps raw shapes into its own object schema,
 * which a ZodEffects product of .refine() is not), and the ROUTE keeps
 * enforcing the refinement — invalid patches surface as the gateway's 400
 * envelope through the MCP error channel.
 */
export const routingPolicyPatchShape = {
  default_mode: z.enum(ROUTING_MODES).nullish(),
  allowed_providers: z.array(z.string().min(1).max(128)).max(64).nullish(),
  blocked_providers: z.array(z.string().min(1).max(128)).max(64).nullish(),
  forbid_non_ru: z.boolean().nullish(),
  allow_pii_transborder: z.boolean().nullish(),
  model_whitelist: z.array(z.string().min(1).max(128)).max(200).nullish(),
  session_micro_limit: z.number().int().min(0).max(9_007_199_254_740_991).nullish(),
  monthly_credits_limit: z.number().int().min(0).max(99_999_999).nullish(),
  daily_org_usd_micro_limit: z.number().int().min(0).max(9_007_199_254_740_991).nullish(),
} as const;

const chatMessageSchema = z.object({
  role: z.string().min(1).max(64),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
});

/** Tool names — pinned by the facade contract test (all nine must be listed). */
export const AIAG_TOOL_NAMES = [
  'aiag_list_models',
  'aiag_get_balance',
  'aiag_create_topup_invoice',
  'aiag_get_invoice_status',
  'aiag_set_routing_policy',
  'aiag_list_keys',
  'aiag_rotate_key',
  'aiag_revoke_key',
  'aiag_chat_completion',
] as const;

/**
 * Registers the nine agent-rail tools on an McpServer instance. Pure
 * delegation: every callback is one service call wrapped in `toToolResult`.
 */
export function registerAgentTools(server: McpServer, service: AgentGatewayService): void {
  server.registerTool(
    'aiag_list_models',
    {
      title: 'List models',
      description:
        'List the gateway model catalog (enabled models with type and author pricing). Same data as GET /v1/models.',
    },
    async () => toToolResult(await service.get('/v1/models')),
  );

  server.registerTool(
    'aiag_get_balance',
    {
      title: 'Get balance',
      description:
        'Current subscription + payg credits of the calling organization. Same data as GET /v1/balance.',
    },
    async () => toToolResult(await service.get('/v1/balance')),
  );

  server.registerTool(
    'aiag_create_topup_invoice',
    {
      title: 'Create topup invoice',
      description:
        'Mint a TON (gram native or usdt jetton) topup invoice for credits (minimum 100). ' +
        'Idempotent per idempotencyKey. Same behaviour as POST /v1/agent/topup.',
      inputSchema: {
        asset: z.enum(['gram', 'usdt']).describe('Settlement asset on the TON network'),
        credits: z
          .string()
          .regex(WHOLE_CREDITS)
          .describe('Whole credits to buy, canonical decimal string, minimum "100"'),
        idempotencyKey: z
          .string()
          .regex(IDEMPOTENCY_KEY)
          .describe('Client-minted unique key per logical topup (reuse returns the same invoice)'),
      },
    },
    async ({ asset, credits, idempotencyKey }) =>
      toToolResult(
        await service.post('/v1/agent/topup', { asset, credits, idempotencyKey }),
      ),
  );

  server.registerTool(
    'aiag_get_invoice_status',
    {
      title: 'Get invoice status',
      description:
        'Status of one of the organization topup invoices (pending/settled). Same data as GET /v1/agent/invoices/:id.',
      inputSchema: {
        invoiceId: z.string().regex(UUID).describe('Invoice UUID returned by aiag_create_topup_invoice'),
      },
    },
    async ({ invoiceId }) =>
      toToolResult(await service.get(`/v1/agent/invoices/${encodeURIComponent(invoiceId)}`)),
  );

  server.registerTool(
    'aiag_set_routing_policy',
    {
      title: 'Set routing policy',
      description:
        'Update the calling key routing policy and optional self-service quotas (PATCH semantics: absent fields ' +
        'stay unchanged, null clears, at least one field required). Same behaviour as PUT /v1/agent/policy.',
      inputSchema: routingPolicyPatchShape,
    },
    async (patch) => toToolResult(await service.put('/v1/agent/policy', patch)),
  );

  server.registerTool(
    'aiag_list_keys',
    {
      title: 'List keys',
      description:
        'Inventory of the organization gateway keys (id, name, prefix, timestamps; no secrets). Same data as GET /v1/agent/keys.',
    },
    async () => toToolResult(await service.get('/v1/agent/keys')),
  );

  server.registerTool(
    'aiag_rotate_key',
    {
      title: 'Rotate key',
      description:
        'Rotate one gateway key: the old plaintext dies atomically, the new one is returned exactly once. ' +
        'Rotating the calling key is allowed and final. Same behaviour as POST /v1/agent/keys/:id/rotate.',
      inputSchema: {
        keyId: z.string().regex(UUID).describe('UUID of the key to rotate'),
      },
    },
    async ({ keyId }) =>
      toToolResult(await service.post(`/v1/agent/keys/${encodeURIComponent(keyId)}/rotate`, {})),
  );

  server.registerTool(
    'aiag_revoke_key',
    {
      title: 'Revoke key',
      description:
        'Revoke (retire) one gateway key. Revoking the calling key is allowed. Same behaviour as POST /v1/agent/keys/:id/revoke.',
      inputSchema: {
        keyId: z.string().regex(UUID).describe('UUID of the key to revoke'),
      },
    },
    async ({ keyId }) =>
      toToolResult(await service.post(`/v1/agent/keys/${encodeURIComponent(keyId)}/revoke`, {})),
  );

  server.registerTool(
    'aiag_chat_completion',
    {
      title: 'Chat completion (non-streaming)',
      description:
        'Run an OpenAI-compatible NON-STREAMING chat completion through the gateway routing/failover/billing ' +
        'pipeline. For streaming responses use the direct POST /v1/chat/completions HTTP endpoint instead.',
      inputSchema: {
        model: z.string().min(1).max(128).describe('Gateway model slug (see aiag_list_models)'),
        messages: z.array(chatMessageSchema).min(1).max(512).describe('Conversation messages'),
        max_tokens: z.number().int().min(1).optional().describe('Generation limit'),
      },
    },
    async ({ model, messages, max_tokens }) =>
      toToolResult(
        await service.post('/v1/chat/completions', {
          model,
          messages,
          ...(max_tokens !== undefined ? { max_tokens } : {}),
          stream: false,
        }),
      ),
  );
}
