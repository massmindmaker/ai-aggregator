import {
  loadRun,
  loadAgent,
  loadAgentByName,
  sumMonthlySpend,
  loadRentalSubscriptionForAgent,
  sumPeriodSpendForAgent,
  getOrResetDailyBucket,
  loadHistory,
  resolveRunScope,
  markStarted,
  markFailed,
  getBalance,
  settleRun,
  loadProviderCredential,
  recordToolCalls,
  InsufficientBalanceError,
  type AgentRow,
} from './db.js';
import { pickToolDefs, executeTool, type ToolDef, type SubAgentResult } from './tools.js';
import {
  sendBotMessage,
  buildRunCompletedMessage,
  buildRunFailedMessage,
} from './bot-api.js';
import { decryptSecret } from './crypto.js';
import { safeFetch } from './safe-fetch.js';
import { openMcp, listMcpToolDefs, callMcpTool, MCP_PREFIX, type McpClient } from './mcp-client.js';
import { resolveMcpOauthBearer } from './mcp-oauth.js';
import { hermesEnabled } from './hermes-client.js';

// R0-1: aiag runs route through the :4000 gateway (revenue + white-label).
// OPENROUTER_URL stays ONLY as the documented degraded fallback when the
// gateway lacks the requested model (404 / model_not_found / 400 Unknown model).
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AIAG_GATEWAY_URL = 'http://127.0.0.1:4000/v1/chat/completions';
// safeFetch allowlist: the only hosts the worker is allowed to reach WITHOUT
// public-IP validation. Everything else (external/provider user-supplied URLs)
// is DNS-resolved + IP-validated by safeFetch. '127.0.0.1:4000' is http:// so
// it MUST be allowlisted (allowlist bypasses the HTTPS check too).
// '127.0.0.1:8642' is the reverse-tunnelled Hermes REST endpoint (server #2);
// http:// so it MUST be allowlisted (bypasses safeFetch's HTTPS-only check too).
const SAFE_FETCH_ALLOWLIST = ['127.0.0.1:4000', '127.0.0.1:8642', 'openrouter.ai'];
// Registered gateway slug. The previous default ('nousresearch/hermes-4-405b')
// is NOT in the gateway model registry, so the :4000 gateway returns a 400
// "Unknown model" (resolver.ts) instead of serving the run. Use a registered slug.
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const MAX_ITERATIONS = 12;
// R-20 (internal A2A): hard cap on call_agent invocations per parent run. A
// depth-1 sub-agent never gets the tool at all (it is stripped), so this only
// bounds fan-out at the top level — guarding against a parent that loops
// delegating and runs up spend. Tunable; 3 is the spec default.
const MAX_CALL_AGENT_PER_RUN = 3;
// D-1: the credit unit is integer US cents (1 credit = $0.01). PRICING below is
// already USD-native, so the worker bills purely in credits — there is no more
// ₽ leg and no frozen USD→₽ rate. The crypto→USD conversion now happens ONCE at
// top-up time (apps/tg-miniapp), after which everything here is credits.
// D-0 (deferred gateway edit): the :4000 gateway returns the AUTHORITATIVE
// charged amount + the upstream cost it bore, per request, as integer micro-USD
// ($0.000001) headers (avoids float on the wire). The worker divides micro-USD
// into credits/cents with Math.ceil(micro / 10_000). Until the gateway emits
// these USD headers, they are absent → billedByGateway=false → the worker falls
// back to the local estimateCostCredits (the existing "never bill 0" path).
// Exported so the gateway↔worker contract test can assert these reader names are
// byte-equal to the names the gateway EMITS (packages/api-gateway
// BILLING_HEADERS.CHARGED_USD_MICRO / UPSTREAM_COST_USD_MICRO). If either side
// renames a header, that test fails instead of silently disabling billing.
export const HDR_CHARGED_USD_MICRO = 'x-aiag-charged-usd-micro';
export const HDR_UPSTREAM_COST_USD_MICRO = 'x-aiag-upstream-cost-usd-micro';
// R0-2 run-start gate: minimum spendable balance (credits = US cents) required to
// begin a billable run. 1-credit ($0.01) floor.
const MIN_RUN_COST = 1;

interface Upstream {
  url: string;          // full chat-completions URL
  apiKey: string;
  model: string;
  isExternal: boolean;  // external = user-supplied; cost stays 0
  // Optional per-request headers merged into postChat (e.g. the Hermes route's
  // X-Hermes-Session-Key, which is filled SERVER-SIDE in runAgent from the run
  // scope — never from the request body).
  extraHeaders?: Record<string, string>;
}

/**
 * Multimodel per-role (migration 0042). An agent may set OPTIONAL per-role model
 * slugs; pick the slug for the given task role, falling back to the primary
 * `model_slug` whenever the role slot is empty/blank.
 *
 * Roles:
 *  - 'chat'   → the primary model_slug (default; ordinary text turn)
 *  - 'vision' → vision_model_slug ?? model_slug (an image came IN the message)
 *  - 'image'  → image_model_slug  ?? model_slug (image GENERATION, image_gen tool)
 *  - 'voice'  → voice_model_slug  ?? model_slug (voice / TTS)
 *
 * This ONLY chooses WHICH slug per role. Billing/markup/settleRun are untouched —
 * the worker bills by the model it actually CALLS. An out-of-registry slug falls
 * back to OpenRouter via the gateway exactly like the primary model does today.
 * Returns null when the agent has no primary model (caller then uses DEFAULT_MODEL).
 */
export type ModelRole = 'chat' | 'vision' | 'image' | 'voice';
export function resolveModelForRole(agent: AgentRow, role: ModelRole): string | null {
  const base = agent.model_slug?.trim() || null;
  const pick = (slot: string | null | undefined) => slot?.trim() || base;
  switch (role) {
    case 'vision':
      return pick(agent.vision_model_slug);
    case 'image':
      return pick(agent.image_model_slug);
    case 'voice':
      return pick(agent.voice_model_slug);
    case 'chat':
    default:
      return base;
  }
}

/**
 * Pick the task role of a run from its input. Today a run carries a single text
 * field, so the only role we can actually detect is VISION — when the input clearly
 * references an image (data:image URI, an http(s) image URL, or markdown image
 * syntax). Text-only ⇒ 'chat'. Image-GENERATION and voice/TTS are driven by tools,
 * not the run input, so they resolve their model at the tool call (image_gen below),
 * not here. Conservative: a false 'chat' is harmless (uses the primary model).
 */
export function detectInputRole(input: string): ModelRole {
  const s = input ?? '';
  if (/data:image\//i.test(s)) return 'vision';
  if (/!\[[^\]]*\]\(/.test(s)) return 'vision'; // markdown image ![alt](url)
  if (/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#]\S*)?/i.test(s)) return 'vision';
  return 'chat';
}

export async function resolveUpstream(agent: AgentRow, role: ModelRole = 'chat'): Promise<Upstream> {
  // Hermes-managed route (migration 0045) — ADDITIVE, highest priority. Runs on
  // OUR Hermes box (server #2) via the reverse tunnel; the profile is addressed
  // as `model`. isExternal=false → AIAG path (debit+markup), same as the gateway.
  // The X-Hermes-Session-Key header is left empty here and filled SERVER-SIDE in
  // runAgent from the run scope (agentId + hire scope), never from the body.
  if (agent.connection_type === 'hermes_managed' && agent.hermes_profile) {
    if (!hermesEnabled()) throw new Error('hermes_disabled');
    return {
      url: `${(process.env.HERMES_GATEWAY_URL ?? '').replace(/\/$/, '')}/v1/chat/completions`,
      apiKey: process.env.HERMES_API_KEY ?? '',
      model: agent.hermes_profile,
      isExternal: false,
      extraHeaders: {},
    };
  }

  // R0-6: provider-picker path (most specific first). provider_id NOT NULL ⇒
  // the agent was created via the new catalog; route to its chosen provider's
  // decrypted credential. It IS billable through us (isExternal=false).
  if (agent.provider_id) {
    const cred = await loadProviderCredential(agent.auth_ref!);
    if (!cred) throw new Error('provider_credential_missing');
    const base = (agent.base_url_override ?? cred.base_url ?? cred.api_base)?.replace(/\/+$/, '');
    if (!base) throw new Error('provider_base_url_missing');
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    return {
      url,
      apiKey: decryptSecret(cred.enc_key),
      model: agent.model_id ?? cred.model_id ?? DEFAULT_MODEL,
      isExternal: false,
    };
  }

  if (agent.connection_type === 'external_openai') {
    if (!agent.external_base_url) throw new Error('external_base_url missing');
    if (!agent.external_api_key_encrypted) throw new Error('external_api_key missing');
    const base = agent.external_base_url.replace(/\/+$/, '');
    // Accept either "https://x/v1" (we append /chat/completions) or
    // a complete "https://x/v1/chat/completions" URL.
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    const apiKey = decryptSecret(agent.external_api_key_encrypted);
    // BYOK keeps its explicit external_model_slug first; otherwise the role-resolved
    // primary slug (vision/image/voice override → chat fallback).
    const model =
      agent.external_model_slug?.trim() ||
      resolveModelForRole(agent, role) ||
      DEFAULT_MODEL;
    return { url, apiKey, model, isExternal: true };
  }

  // R0-1: aiag path → the :4000 gateway (OpenAI-compatible). AIAG_GATEWAY_KEY is
  // REQUIRED here — the aiag path is where billing, markup, gateway_transactions
  // and white-label all live.
  //
  // 🔴 FAIL-CLOSED (split-task-2, risk #2): a missing/empty AIAG_GATEWAY_KEY used
  // to "gracefully" fall back to a direct OpenRouter call using OUR OWN
  // OPENROUTER_API_KEY. That is a config-time money-path bug: on OUR
  // misconfiguration (e.g. an env-var rotation gone wrong) the worker would
  // silently start paying OpenRouter out of our own pocket for every aiag run —
  // margin leak, wrong billing entity, and a white-label break — with only a
  // console.warn to notice it by. TMA is a CLIENT of the aggregator gateway and
  // must always route through it; a config error we can see beats a silent
  // wrong-account charge. Refuse the run instead.
  // Role-resolved slug: vision/image/voice override → primary model_slug fallback.
  const model = resolveModelForRole(agent, role) || DEFAULT_MODEL;
  const gwKey = process.env.AIAG_GATEWAY_KEY;
  if (!gwKey) {
    throw new Error(
      'AIAG_GATEWAY_KEY not set — refusing to run: the aiag path must route through the ' +
        ':4000 gateway (billing/markup/white-label). Falling back to a direct upstream on ' +
        'our own misconfiguration would silently pay from our own pocket.',
    );
  }
  return { url: AIAG_GATEWAY_URL, apiKey: gwKey, model, isExternal: false };
}

// OpenRouter approximate pricing per model (USD per 1M tokens).
// Conservative numbers — slight over-estimate is OK, we won't undercharge.
const PRICING: Record<string, { in: number; out: number }> = {
  'nousresearch/hermes-4-405b':        { in: 0.9,  out: 1.5  },
  'openai/gpt-4o':                     { in: 2.5,  out: 10.0 },
  'openai/gpt-4o-mini':                { in: 0.15, out: 0.6  },
  'anthropic/claude-3.5-sonnet':       { in: 3.0,  out: 15.0 },
  'anthropic/claude-3-haiku':          { in: 0.25, out: 1.25 },
  'google/gemini-2.0-flash-001':       { in: 0.1,  out: 0.4  },
  'meta-llama/llama-3.3-70b-instruct': { in: 0.13, out: 0.4  },
};
const FALLBACK_PRICE = { in: 1.0, out: 2.0 }; // unknown models — assume mid-range

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ModelResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function buildBody(
  upstream: Upstream,
  messages: Message[],
  tools: ToolDef[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: upstream.model,
    messages,
    max_tokens: 2000,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
}

/** Single POST to a chat-completions URL. Throws on !res.ok with a sliced body. */
async function postChat(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  attribution: boolean,
  label: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  };
  // Routing/attribution headers — harmless on the gateway + OpenRouter, skip
  // for user-supplied external upstreams. Do NOT log the URL/provider (white-label).
  if (attribution) {
    headers['HTTP-Referer'] = 'https://ai-aggregator.ru';
    headers['X-Title'] = 'AIAG TMA';
  }
  // Per-request extra headers (e.g. the Hermes route's X-Hermes-Session-Key,
  // derived server-side). Merged last, before fetch.
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  }
  // SSRF guard (D-7 / R1-7). safeFetch DNS-resolves the host and rejects
  // private / link-local / loopback / CGNAT / IPv6-ULA targets, pins the socket
  // to the validated IP (anti-rebind) and re-validates every redirect hop.
  // External & provider (user-influenced base_url) upstreams thus get full
  // validation; the trusted internal gateway (http://127.0.0.1:4000) and
  // openrouter.ai are allowlisted (allowlist also bypasses the HTTPS-only check).
  return safeFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    allowlist: SAFE_FETCH_ALLOWLIST,
  });
}

/** Shape of the info `shouldFallbackToDirectUpstream` decides on. `text` is the
 * raw (unparsed) response body; `code` is an already-parsed error code, when
 * the caller has one. Neither is required — the 401/402/403 guard below needs
 * only `status`. */
export interface UpstreamErrorInfo {
  status: number;
  code?: string;
  text?: string;
}

/**
 * Whether a failed gateway response should trigger the degraded direct-to-
 * OpenRouter fallback.
 *
 * 🔴 SAFETY (split-task-2, risk #1): 401 (bad key) / 402 (insufficient funds) /
 * 403 (forbidden) must NEVER fall back. Falling back on these would silently
 * pay the upstream ourselves — a margin leak AND a white-label break — with no
 * error surfaced anywhere. These three are checked FIRST and unconditionally
 * deny, regardless of what `code`/`text` say (defense in depth: even if an
 * auth/funds error's body happened to mention "model", it still won't
 * fall back).
 *
 * The only legitimate reason to go direct: the gateway genuinely doesn't have
 * this model in its registry — OpenRouter-style 404 / model_not_found, or the
 * AIAG :4000 gateway's 400 "Unknown model" (resolver.ts).
 */
export function shouldFallbackToDirectUpstream(err: UpstreamErrorInfo): boolean {
  if (err.status === 401 || err.status === 402 || err.status === 403) return false;
  if (err.status === 404) return true;
  const text = err.text ?? '';
  if (err.status === 400 && /unknown model/i.test(text)) return true;
  return /model_not_found|model not found|no such model/i.test(text);
}

/**
 * Result of one chat call: the parsed model response PLUS, when the response
 * came from the AIAG gateway, the gateway's AUTHORITATIVE billing figures, in
 * credits (US cents).
 *
 * D-0/D-1: `billedByGateway` is true ONLY when the response actually came back
 * from the :4000 gateway (not the OpenRouter fallback) AND the
 * X-AIAG-Charged-USD-Micro header parsed to a finite micro-USD value. In that
 * case `chargedCredits` is the number the caller MUST bill off (the gateway
 * already debited the house org for it) and `upstreamCostCredits` is the
 * upstream cost we bore (charged − cost = margin). Otherwise `billedByGateway`
 * is false → the caller falls back to estimateCostCredits (NEVER 0 / free).
 */
export interface ChatResult {
  response: ModelResponse;
  billedByGateway: boolean;
  chargedCredits: number;
  upstreamCostCredits: number;
}

/**
 * Parse an integer micro-USD ($0.000001) billing header into credits (US cents),
 * or null if absent/garbage. credits = ceil(micro / 10_000) — round UP so we
 * never undercharge, and the result is an exact integer.
 */
function parseUsdMicroHeaderToCredits(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw == null || raw.trim() === '') return null;
  const micro = Number(raw);
  if (!Number.isFinite(micro) || micro < 0) return null;
  return Math.ceil(micro / 10_000);
}

/**
 * R0-1: issue the chat request, with the documented degraded fallback.
 *
 * aiag (gateway) path: POST to the :4000 gateway. If the gateway returns
 * 404 / model_not_found, re-issue the SAME request directly to OpenRouter
 * with OPENROUTER_API_KEY (the documented fallback — still wired, not removed).
 * The happy path does NOT make a second client-side OpenRouter call.
 *
 * D-0: on the gateway path we read the authoritative billing headers off the
 * gateway's response so the caller bills off the REAL charge, not a local
 * estimate. The OpenRouter-fallback response has no such headers → billedByGateway
 * stays false and the caller estimates.
 *
 * Exported so the gateway→OpenRouter fallback is unit-testable (Task 5).
 */
export async function callWithFallback(
  upstream: Upstream,
  body: Record<string, unknown>,
): Promise<ChatResult> {
  const label = upstream.isExternal ? 'external' : 'upstream';
  const isGateway = upstream.url === AIAG_GATEWAY_URL;
  // Pass the upstream's per-request extra headers (Hermes session-key) to the
  // primary hop only — the OpenRouter degraded fallback below is a different host
  // and must NOT receive them.
  const res = await postChat(
    upstream.url,
    upstream.apiKey,
    body,
    !upstream.isExternal,
    label,
    upstream.extraHeaders,
  );
  if (res.ok) {
    // D-0/D-1: read billing figures BEFORE consuming the body. Only trust them
    // on the real gateway path (not external/OpenRouter, which never set them).
    // Headers are integer micro-USD → converted to credits (cents) here.
    const charged = isGateway ? parseUsdMicroHeaderToCredits(res, HDR_CHARGED_USD_MICRO) : null;
    const upstreamCost = isGateway
      ? parseUsdMicroHeaderToCredits(res, HDR_UPSTREAM_COST_USD_MICRO)
      : null;
    const response = (await res.json()) as ModelResponse;
    return {
      response,
      billedByGateway: charged != null,
      chargedCredits: charged ?? 0,
      // upstream cost may be absent even when charged is present; default 0.
      upstreamCostCredits: upstreamCost ?? 0,
    };
  }

  const text = await res.text();

  // Degraded fallback: ONLY for the aiag gateway path, ONLY on model-not-found.
  // (never on 401/402/403 — see shouldFallbackToDirectUpstream.)
  if (isGateway && shouldFallbackToDirectUpstream({ status: res.status, text })) {
    const orKey = process.env.OPENROUTER_API_KEY;
    if (orKey) {
      const fb = await postChat(OPENROUTER_URL, orKey, body, true, 'openrouter');
      if (fb.ok) {
        // Fallback to OpenRouter direct: no gateway markup/headers → estimate.
        const response = (await fb.json()) as ModelResponse;
        return { response, billedByGateway: false, chargedCredits: 0, upstreamCostCredits: 0 };
      }
      const fbText = await fb.text();
      throw new Error(`upstream ${fb.status}: ${fbText.slice(0, 300)}`);
    }
  }

  throw new Error(`${label} ${res.status}: ${text.slice(0, 300)}`);
}

async function callModel(
  upstream: Upstream,
  messages: Message[],
  tools: ToolDef[],
): Promise<ChatResult> {
  return callWithFallback(upstream, buildBody(upstream, messages, tools));
}

/**
 * Local cost estimate in credits (US cents). PRICING is USD per 1M tokens, so we
 * convert USD → integer cents with Math.ceil(usd * 100) — round UP so a small
 * (sub-cent) run never undercharges and the result is an exact integer.
 */
export function estimateCostCredits(modelSlug: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[modelSlug] ?? FALLBACK_PRICE;
  const usd = (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
  return Math.ceil(usd * 100);
}

/**
 * CHARGE-0 floor: the amount (in credits = US cents) we actually settle a run at.
 *
 * The gateway's authoritative charge is trusted as-is, but a zero-usage gateway
 * response (0 prompt+completion tokens → charged 0) or a zero-token estimate
 * would otherwise settle a BILLABLE run at 0 credits (free). The R0-2
 * MIN_RUN_COST gate only protects run START, not settle — so we re-apply it here
 * as a nonzero floor on the final billable amount. Tool fees are already folded
 * into `rawCostCredits` (totalCostCredits = basis + toolFeesCredits), so they
 * ride inside the floor. External / BYOK runs (isExternal=true) pay their own
 * provider and MUST stay at exactly 0 — no floor.
 */
export function finalBillableCostCredits(rawCostCredits: number, isExternal: boolean): number {
  if (isExternal) return 0;
  return Math.max(MIN_RUN_COST, rawCostCredits);
}

function buildSystem(agent: AgentRow): string {
  const lines = [agent.system_prompt];
  const hasTools = (agent.tools ?? []).length > 0;
  if (!hasTools) {
    lines.push(
      '\nИнструменты тебе НЕ ДОСТУПНЫ в этом запуске — отвечай из своих знаний.',
    );
  }
  return lines.join('\n');
}

/**
 * R-20 (internal A2A): run ONE completion of a TARGET agent as a sub-agent and
 * return its output text + the credit cost of that sub-completion. Billing is
 * NOT done here — the cost is returned and rides the caller run's existing
 * toolFeesCredits → settleRun (no new debit path, no separate ledger entry).
 *
 * Hard guards (all enforced here):
 *  - OWNERSHIP: the target MUST belong to the SAME tg_user_id as the calling run.
 *    loadAgentByName is already scoped by tg_user_id; loadAgent (by id) is NOT, so
 *    we re-assert `target.tg_user_id === parentTgUserId` on the loaded row and
 *    reject otherwise with a neutral error (no leak of another user's agents).
 *  - RECURSION (depth 1): the sub-agent runs with `call_agent` STRIPPED from its
 *    tools, so it can never delegate further → no agent→agent→agent loops.
 *  - BYOK/commission: a BYOK/external target (isExternal) costs 0 — the sub-call
 *    respects the same `if (isExternal) return` zero-charge rule as a normal run.
 *
 * Cost basis mirrors the parent run: the gateway's authoritative charge when the
 * model call came back billed by the :4000 gateway, otherwise the local
 * estimateCostCredits (never 0 for a billable target). Errors are returned as a
 * neutral tool error (output) with cost 0 — a failed sub-call must not bill or
 * leak an upstream brand.
 */
async function runSubAgent(
  parentTgUserId: string,
  args: { agentId?: string; agentName?: string; prompt: string },
): Promise<SubAgentResult> {
  const neutral = (msg: string): SubAgentResult => ({ output: `delegation error: ${msg}`, cost_credits: 0 });

  // Resolve the target (id preferred). loadAgentByName is tg_user-scoped; the
  // by-id path is NOT, so the ownership re-assertion below is the real guard.
  let target: AgentRow | null = null;
  if (args.agentId && args.agentId.trim()) {
    // Guard the uuid shape so a malformed id can't throw inside loadAgent's cast.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.agentId.trim())) {
      return neutral('agent not found');
    }
    target = await loadAgent(args.agentId.trim());
  } else if (args.agentName && args.agentName.trim()) {
    target = await loadAgentByName(parentTgUserId, args.agentName.trim());
  } else {
    return neutral('provide agent_id or agent_name');
  }

  if (!target) return neutral('agent not found');
  // HARD OWNERSHIP GUARD — reject cross-user targets (covers the by-id path).
  if (String(target.tg_user_id) !== String(parentTgUserId)) {
    return neutral('agent not found');
  }
  if (target.status !== 'active') return neutral('agent not available');

  // RECURSION STRIP (depth 1): the sub-agent must NOT have call_agent.
  const subTools = (target.tools ?? []).filter((t) => t !== 'call_agent');
  const subAgent: AgentRow = { ...target, tools: subTools };

  let upstream: Upstream;
  try {
    upstream = await resolveUpstream(subAgent);
  } catch (e) {
    return neutral(`target misconfigured: ${(e as Error).message.slice(0, 80)}`);
  }

  // Single completion: system_prompt + the delegated prompt. No history, no tools
  // are offered to the sub-agent (it answers from its persona/knowledge in one
  // shot) — depth 1, deterministic spend.
  const messages: Message[] = [
    { role: 'system', content: buildSystem(subAgent) },
    { role: 'user', content: args.prompt.slice(0, 16000) },
  ];
  let call: ChatResult;
  try {
    call = await callModel(upstream, messages, []);
  } catch (e) {
    return neutral(`target run failed: ${(e as Error).message.slice(0, 80)}`);
  }

  const choice = call.response.choices[0];
  const output = choice?.message?.content ?? '';

  // Cost: BYOK/external → 0 (respect the zero-charge rule). Otherwise the
  // gateway's authoritative charge if it billed this call, else the local
  // estimate (never 0 for a billable sub-call).
  let cost = 0;
  if (!upstream.isExternal) {
    if (call.billedByGateway) {
      cost = call.chargedCredits;
    } else {
      const tIn = call.response.usage?.prompt_tokens ?? 0;
      const tOut = call.response.usage?.completion_tokens ?? 0;
      cost = estimateCostCredits(upstream.model, tIn, tOut);
    }
  }

  return { output, cost_credits: cost };
}

// ISSUE #12: the recipient of a run notification is the PAYER of the run, not
// necessarily the agent owner. After issue #5, settleRun/the budget+balance
// gates all bill run.tg_user_id (owner on an owner run, the hirer on a hire
// run) — the notification must go to that same identity, or a hirer who was
// just debited never sees the outcome. Every call site below already has
// `run` in scope, so this is a same-identity swap: owner run ⇒
// run.tg_user_id === agent.tg_user_id (unchanged behaviour); hire run ⇒
// run.tg_user_id is the hirer (the actual payer). Owner-side notification is
// intentionally NOT sent here (out of scope per issue #12: "владельцу —
// опционально/вторично"; boundaries say don't add channels).
async function notifyCompleted(
  tgUserId: string, agentName: string, agentId: string, costCredits: number, output: string,
): Promise<void> {
  await sendBotMessage(tgUserId, buildRunCompletedMessage({ agentName, agentId, costCredits, output }));
}

async function notifyFailed(
  tgUserId: string, agentName: string, agentId: string, error: string,
): Promise<void> {
  await sendBotMessage(tgUserId, buildRunFailedMessage({ agentName, agentId, error }));
}

export async function runAgent(runId: string): Promise<void> {
  const run = await loadRun(runId);
  if (!run) {
    console.error(`[agent-worker] run not found: ${runId}`);
    return;
  }
  const agent = await loadAgent(run.agent_id);
  if (!agent) {
    await markFailed(runId, 'agent_not_found');
    return;
  }

  // ---- budgets (all in credits = US cents) ----
  // BILLING SUBJECT (issue #5, SECURITY.md hire isolation): the debited/gated
  // identity is the RUN'S caller — run.tg_user_id, set server-side by the
  // run route from the authenticated header, NEVER the request body, and
  // already restricted by the route to (owner OR an active hirer). For an
  // owner run this equals agent.tg_user_id (unchanged behaviour); for a hire
  // run it is the HIRER, so the hirer's own monthly spend/balance is gated
  // and debited — never the agent owner's. agent.tg_user_id must NOT be used
  // for money gates/debits below. NOTIFY SUBJECT (issue #12): notifications
  // below use run.tg_user_id too — the same payer identity — so the hirer who
  // was actually debited is the one who sees the run outcome.
  const monthlyBudget = Number(agent.budget_credits_monthly);
  const monthlySpend = await sumMonthlySpend(run.tg_user_id);
  if (monthlySpend >= monthlyBudget) {
    await markFailed(runId, 'budget_exceeded_monthly');
    await notifyFailed(run.tg_user_id, agent.name, agent.id, 'budget_exceeded_monthly');
    return;
  }
  const daily = await getOrResetDailyBucket(agent.id);
  if (daily.spent_today_credits >= daily.daily_budget_credits) {
    await markFailed(runId, 'budget_exceeded_daily');
    await notifyFailed(run.tg_user_id, agent.name, agent.id, 'budget_exceeded_daily');
    return;
  }

  // ---- Аренда = месячная подписка: period-scoped лимит трат (ADDITIVE) ----
  // Если агент создан через аренду (template_rentals с rent_period='month'),
  // расход в ТЕКУЩЕМ периоде подписки не должен превышать месячный лимит, входящий
  // в цену. Истёк период без продления → запуск лапсится (доступ закрыт). Это
  // зеркало месячного user-гарда выше, но scoped по подписке. settleRun не трогаем.
  // limit=null (автор не задал) → подписочного лимита нет, ведём только по бюджету.
  const rentalSub = await loadRentalSubscriptionForAgent(agent.id);
  let subLimit = 0;
  let subPeriodSpend = 0;
  if (rentalSub) {
    if (rentalSub.expired) {
      await markFailed(runId, 'rental_expired');
      await notifyFailed(run.tg_user_id, agent.name, agent.id, 'rental_expired');
      return;
    }
    if (rentalSub.monthly_limit_credits !== null && rentalSub.period_start) {
      subLimit = rentalSub.monthly_limit_credits;
      subPeriodSpend = await sumPeriodSpendForAgent(agent.id, rentalSub.period_start);
      if (subPeriodSpend >= subLimit) {
        await markFailed(runId, 'rental_limit_exceeded');
        await notifyFailed(run.tg_user_id, agent.name, agent.id, 'rental_limit_exceeded');
        return;
      }
    }
  }

  // ---- upstream resolution (provider_id / aiag-gateway / external) ----
  // Resolve BEFORE the balance gate so external (user-paid) runs skip it.
  // Multimodel per-role: pick the role from the run input (vision when an image is
  // referenced, else chat) so the agent's vision_model_slug is used for image-input
  // turns. Image-generation/voice models are resolved at their tool call, not here.
  const runRole = detectInputRole(run.input);
  let upstream: Upstream;
  try {
    upstream = await resolveUpstream(agent, runRole);
  } catch (e) {
    const msg = `upstream_misconfigured: ${(e as Error).message.slice(0, 160)}`;
    await markFailed(runId, msg);
    await notifyFailed(run.tg_user_id, agent.name, agent.id, msg);
    return;
  }

  // ---- R0-2 run-start balance gate (billable runs only) ----
  // A zero/low-balance user can no longer run a billable agent for free.
  // Gated on run.tg_user_id (the billing subject — see comment above), so a
  // hire run checks/consumes the HIRER's balance, matching the pre-check the
  // run route already performs on the caller (issue #5).
  if (!upstream.isExternal) {
    const bal = await getBalance(run.tg_user_id);
    if (bal < MIN_RUN_COST) {
      await markFailed(runId, 'insufficient_balance');
      await notifyFailed(run.tg_user_id, agent.name, agent.id, 'insufficient_balance');
      return;
    }
  }

  await markStarted(runId);

  // P0 SAFETY: once the run is 'running', ANY throw below (scope/history/MCP
  // setup OR the model loop) MUST land the run in a terminal 'failed' state +
  // notify the user. Without this, an exception in the setup gap (resolveRunScope,
  // loadHistory, etc.) escaped runAgent, failing the BullMQ job but leaving the DB
  // row 'running' forever (stuck UI, infinite client polling). mcp is declared out
  // here so the finally can still close it after the try opens immediately below.
  let mcp: McpClient | null = null;
  try {
  // ---- HIRE ISOLATION (OWASP LLM06): resolve per-hirer scope SERVER-SIDE ----
  // scope is derived from the run row (run.tg_user_id = who launched it) vs the
  // agent owner (agent.tg_user_id) + an ACTIVE agent_sessions row — NEVER from
  // the request body. Owner run ⇒ null (shared memory, legacy). Hirer run ⇒ the
  // hirer's tg_user_id, which namespaces both history and the memory tool.
  const scopeHirerId = await resolveRunScope(agent.id, run.tg_user_id, agent.tg_user_id);

  // ---- Hermes per-tenant isolation: derive X-Hermes-Session-Key SERVER-SIDE ----
  // Only for the Hermes-managed route (upstream.extraHeaders set by resolveUpstream).
  // sessionKey = `${agentId}:${scope}` where scope = the per-hirer id (server-derived
  // from the run, NEVER the request body) or 'owner' for an owner run. Hermes uses
  // this header to isolate memory/session per tenant. Non-Hermes upstreams are
  // untouched (extraHeaders undefined → no-op).
  if (upstream.extraHeaders) {
    const hermesSessionKey = `${agent.id}:${scopeHirerId ?? 'owner'}`;
    upstream.extraHeaders['X-Hermes-Session-Key'] = hermesSessionKey;
  }

  // ---- conversation history ----
  const history = await loadHistory(agent.id, runId, 10, scopeHirerId);
  const messages: Message[] = [{ role: 'system', content: buildSystem(agent) }];
  for (const h of history) {
    messages.push({ role: 'user', content: h.input });
    if (h.output) messages.push({ role: 'assistant', content: h.output });
  }
  messages.push({ role: 'user', content: run.input });

  const tools = pickToolDefs(agent.tools);

  // MCP (skills): attach the agent's optional remote MCP server (read-only,
  // SSRF-guarded via safeFetch, billed 0₽). Degrades to built-in tools if the
  // connect/list fails — a misconfigured MCP server must never block the run.
  if (agent.mcp_endpoint_url) {
    try {
      // OAuth bearer takes priority: if the agent has an agent_mcp_oauth row,
      // resolve (and refresh-if-stale) the access token. Falls back to the
      // static encrypted bearer (basic MCP) when there is no OAuth row.
      const oauthBearer = await resolveMcpOauthBearer(agent.id);
      const authHeader = oauthBearer
        ? `Bearer ${oauthBearer}`
        : agent.mcp_auth_encrypted
          ? decryptSecret(Buffer.from(agent.mcp_auth_encrypted, 'base64'))
          : null;
      mcp = await openMcp({ url: agent.mcp_endpoint_url, authHeader });
      tools.push(...(await listMcpToolDefs(mcp)));
    } catch (e) {
      console.warn(
        `[agent-worker] MCP attach failed run=${runId}: ${(e as Error).message.slice(0, 160)}`,
      );
      mcp = null;
    }
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let totalCostCredits = 0;
  // D-0 margin accounting (gateway path only), all in credits (US cents):
  //  - gatewayChargedTotal: Σ authoritative charged credits from gateway headers.
  //  - gatewayUpstreamCostTotal: Σ authoritative upstream cost credits (charged −
  //    cost = realized margin, a readable number for tool/author payouts).
  //  - allModelCallsBilledByGateway: true while EVERY model call this run came
  //    back authoritatively billed. The moment one call lacks figures (gateway
  //    didn't return them, or we fell back to OpenRouter) we flip to the local
  //    estimate for the WHOLE run — never silently mix the two, never bill 0.
  //  - toolFeesCredits: tool-side fees, added on top of either basis.
  let gatewayChargedTotal = 0;
  let gatewayUpstreamCostTotal = 0;
  let allModelCallsBilledByGateway = !upstream.isExternal;
  let toolFeesCredits = 0;
  // R-20: per-run call_agent counter (hard cap). Closed over by the callAgent
  // callback below.
  let callAgentCount = 0;

  // Additive observability ONLY (run-trace): collected tool-call steps, written
  // once via recordToolCalls() AFTER settleRun (separate UPDATE, no billing impact).
  const capturedToolCalls: Array<{
    name: string;
    args?: unknown;
    result?: string;
    cost_credits?: number;
    duration_ms?: number;
    status: 'ok' | 'error';
  }> = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let call: ChatResult;
    try {
      call = await callModel(upstream, messages, tools);
    } catch (e) {
      const msg = `upstream_error: ${(e as Error).message.slice(0, 200)}`;
      await markFailed(runId, msg);
      await notifyFailed(run.tg_user_id, agent.name, agent.id, msg);
      return;
    }
    const resp = call.response;

    tokensIn += resp.usage?.prompt_tokens ?? 0;
    tokensOut += resp.usage?.completion_tokens ?? 0;

    // D-0: accumulate the gateway's authoritative figures when present; the
    // instant a billable model call is NOT gateway-billed, drop to the estimate
    // for the whole run (fallback — never free).
    if (!upstream.isExternal) {
      if (call.billedByGateway) {
        gatewayChargedTotal += call.chargedCredits;
        gatewayUpstreamCostTotal += call.upstreamCostCredits;
      } else {
        allModelCallsBilledByGateway = false;
      }
    }

    // Effective run cost so far in credits (excl. tool fees added below):
    //  - external: 0 (user pays their own provider),
    //  - gateway-authoritative: Σ gateway charge (the REAL charge),
    //  - fallback: local estimate from cumulative tokens (NEVER 0).
    if (upstream.isExternal) {
      totalCostCredits = 0;
    } else if (allModelCallsBilledByGateway) {
      totalCostCredits = gatewayChargedTotal + toolFeesCredits;
    } else {
      if (i === 0) {
        console.warn(
          '[agent-worker] D-0: gateway authoritative charge missing/unparseable — ' +
            'falling back to local estimateCostCredits (never 0). ' +
            `model=${upstream.model} run=${runId}`,
        );
      }
      totalCostCredits = estimateCostCredits(upstream.model, tokensIn, tokensOut) + toolFeesCredits;
    }

    // Mid-run budget cutoff (monthly + daily)
    if (monthlySpend + totalCostCredits > monthlyBudget) {
      await markFailed(runId, 'budget_exceeded_monthly_mid_run');
      await notifyFailed(run.tg_user_id, agent.name, agent.id, 'budget_exceeded_monthly_mid_run');
      return;
    }
    if (daily.spent_today_credits + totalCostCredits > daily.daily_budget_credits) {
      await markFailed(runId, 'budget_exceeded_daily_mid_run');
      await notifyFailed(run.tg_user_id, agent.name, agent.id, 'budget_exceeded_daily_mid_run');
      return;
    }
    // Аренда-подписка: period-scoped лимит (mid-run). subLimit=0 ⇒ нет подписки/лимита.
    if (subLimit > 0 && subPeriodSpend + totalCostCredits > subLimit) {
      await markFailed(runId, 'rental_limit_exceeded_mid_run');
      await notifyFailed(run.tg_user_id, agent.name, agent.id, 'rental_limit_exceeded_mid_run');
      return;
    }

    const choice = resp.choices[0];
    if (!choice) {
      await markFailed(runId, 'empty_response');
      await notifyFailed(run.tg_user_id, agent.name, agent.id, 'empty_response');
      return;
    }

    const toolCalls = choice.message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const output = choice.message.content ?? '';
      // D-0: realized margin is now a readable number on the gateway path
      // (charged − upstream cost, both authoritative from the gateway). This is
      // the figure tool/author payouts must derive from — log it so it is
      // observable. Brand-neutral (₽ only). margin can be <0 only if the gateway
      // mispriced; we still bill the authoritative charge.
      if (!upstream.isExternal && allModelCallsBilledByGateway) {
        const marginCredits = gatewayChargedTotal - gatewayUpstreamCostTotal;
        console.info(
          `[agent-worker] D-0 settle run=${runId} charged=${gatewayChargedTotal}cr ` +
            `upstreamCost=${gatewayUpstreamCostTotal}cr margin=${marginCredits}cr ` +
            `toolFees=${toolFeesCredits}cr (gateway-authoritative)`,
        );
      }
      // CHARGE-0: floor the BILLABLE settle amount to MIN_RUN_COST so a
      // zero-usage gateway charge (or a zero-token estimate) can never settle a
      // billable run at 0 credits. External/BYOK stays exactly 0. Tool fees are
      // already inside totalCostCredits, so they ride inside the floor.
      const billable = finalBillableCostCredits(totalCostCredits, upstream.isExternal);
      // R0-2 + R0-3: mark completed + atomic daily-spend guard + balance debit
      // in ONE transaction. A failed guard/debit rolls back the completion too,
      // so the run never lands 'completed' without being paid for.
      // tgUserId = run.tg_user_id, the billing subject (issue #5): debits the
      // HIRER on a hire run, the owner on an owner run — matching the
      // monthly-spend/balance gates above, never agent.tg_user_id.
      try {
        await settleRun({
          runId,
          tgUserId: run.tg_user_id,
          agentId: agent.id,
          output,
          costCredits: billable,
          tokensIn,
          tokensOut,
          isExternal: upstream.isExternal,
        });
      } catch (e) {
        const reason =
          e instanceof InsufficientBalanceError
            ? 'insufficient_balance_settle'
            : (e as Error).message === 'budget_exceeded_daily_settle'
              ? 'budget_exceeded_daily_settle'
              : `settle_failed: ${(e as Error).message.slice(0, 120)}`;
        await markFailed(runId, reason);
        await notifyFailed(run.tg_user_id, agent.name, agent.id, reason);
        return;
      }
      // Additive observability: persist captured tool steps as a SEPARATE UPDATE
      // after settleRun (outside its tx). Self-swallowing — never affects the run.
      await recordToolCalls(runId, capturedToolCalls);
      await notifyCompleted(run.tg_user_id, agent.name, agent.id, billable, output);
      return;
    }

    // record assistant message (with tool_calls) into convo
    messages.push({
      role: 'assistant',
      content: choice.message.content,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        parsed = {};
      }
      const __t0 = Date.now();
      const exec =
        mcp && toolCall.function.name.startsWith(MCP_PREFIX)
          ? await callMcpTool(mcp, toolCall.function.name.slice(MCP_PREFIX.length), parsed)
          : await executeTool(toolCall.function.name, parsed, {
              agentId: agent.id,
              // ISSUE (cross-tenant call_agent): tgUserId is documented in
              // tools.ts as "the owning tg_user_id of the CALLING run" — on a
              // hire run that is the HIRER (run.tg_user_id), never the agent
              // owner (agent.tg_user_id). Mirrors the fix below at callAgent.
              tgUserId: run.tg_user_id,
              // HIRE ISOLATION: server-derived per-hirer memory scope (null for
              // owner runs). The memory tool namespaces every read/write by it.
              scopeHirerId,
              // Multimodel per-role: agent's resolved IMAGE model (image_model_slug
              // ?? model_slug) → image_gen. Non-image/null slug keeps the default.
              imageModelSlug: resolveModelForRole(agent, 'image'),
              // R-20: delegation callback. Enforces the per-run cap, then runs ONE
              // owner-guarded, recursion-stripped sub-completion. Its cost is
              // returned as cost_rub and folded into toolFeesCredits → settleRun
              // (no separate debit). The cap rejects with a neutral, zero-cost
              // error once exceeded.
              // R-20 BLOCKER fix: call_agent is DISABLED for BYOK/external parents.
              // A BYOK parent run zeroes the WHOLE run cost (the isExternal short-circuit
              // in settleRun), so letting it hire a billable AIAG sub-agent = marked-up
              // model inference for 0 credits (free-exfil). Only a billable (AIAG-supplied)
              // parent may delegate; tools.ts degrades to a neutral «not available» when
              // callAgent is absent.
              callAgent: upstream.isExternal
                ? undefined
                : async (a) => {
                    if (callAgentCount >= MAX_CALL_AGENT_PER_RUN) {
                      return {
                        output: `delegation error: limit of ${MAX_CALL_AGENT_PER_RUN} agent calls per run reached`,
                        cost_credits: 0,
                      };
                    }
                    callAgentCount++;
                    // SECURITY FIX (cross-tenant call_agent escalation): on a
                    // HIRE run the run is driven by the HIRER, not the agent
                    // owner — parentTgUserId MUST be run.tg_user_id so the
                    // ownership guard inside runSubAgent (target.tg_user_id ===
                    // parentTgUserId) authorizes against the caller's OWN
                    // agent fleet, never the owner's. Passing agent.tg_user_id
                    // here let a hirer delegate into the owner's PRIVATE agents
                    // (and spend the owner's BYOK key for free). run.tg_user_id
                    // equals agent.tg_user_id on an owner run, so this is a
                    // no-op there — matches the pattern already used for
                    // resolveRunScope/settleRun/notify above (issue #5/#12).
                    return runSubAgent(run.tg_user_id, a);
                  },
            });
      if (exec.cost_rub > 0) {
        // Accumulate into toolFeesCredits, NOT totalCostCredits — the next
        // iteration recomputes totalCostCredits from (basis + toolFeesCredits),
        // so adding here would be overwritten. Tool fees ride on top of either
        // billing basis. (NB: tools.ts still names its fee field `cost_rub`; it
        // is out of scope for D-1 and treated as a credit-denominated fee here.)
        toolFeesCredits += exec.cost_rub;
      }
      // Additive observability: capture the step (truncated). Pure read of the
      // existing exec result — does NOT alter the exec flow or billing.
      capturedToolCalls.push({
        name: toolCall.function.name,
        args: parsed,
        result:
          typeof exec.result === 'string'
            ? exec.result.slice(0, 500)
            : JSON.stringify(exec.result).slice(0, 500),
        cost_credits: exec.cost_rub ?? 0,
        duration_ms: Date.now() - __t0,
        status: 'ok',
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(exec.result).slice(0, 8000),
      });
    }
  }

  await markFailed(runId, 'max_iterations_exceeded');
  await notifyFailed(run.tg_user_id, agent.name, agent.id, 'max_iterations_exceeded');
  } catch (e) {
    // P0 SAFETY NET: any unexpected throw after markStarted (setup gap or an
    // uncaught error inside the loop) → mark the run terminally failed + notify,
    // so the DB row never stays 'running'. Mirrors the markFailed/notifyFailed
    // signatures used on every other failure path above.
    const msg = `run_failed: ${(e as Error).message.slice(0, 200)}`;
    await markFailed(runId, msg);
    await notifyFailed(run.tg_user_id, agent.name, agent.id, msg);
    return;
  } finally {
    if (mcp) {
      try {
        await mcp.close();
      } catch {
        /* ignore close errors — stateless worker leaves no dangling MCP conn */
      }
    }
  }
}
