import {
  loadRun,
  loadAgent,
  sumMonthlySpend,
  getOrResetDailyBucket,
  loadHistory,
  markStarted,
  markFailed,
  getBalance,
  settleRun,
  loadProviderCredential,
  InsufficientBalanceError,
  type AgentRow,
} from './db.js';
import { pickToolDefs, executeTool, type ToolDef } from './tools.js';
import {
  sendBotMessage,
  buildRunCompletedMessage,
  buildRunFailedMessage,
} from './bot-api.js';
import { decryptSecret } from './crypto.js';
import { safeFetch } from './safe-fetch.js';
import { openMcp, listMcpToolDefs, callMcpTool, MCP_PREFIX, type McpClient } from './mcp-client.js';

// R0-1: aiag runs route through the :4000 gateway (revenue + white-label).
// OPENROUTER_URL stays ONLY as the documented degraded fallback when the
// gateway lacks the requested model (404 / model_not_found / 400 Unknown model).
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AIAG_GATEWAY_URL = 'http://127.0.0.1:4000/v1/chat/completions';
// safeFetch allowlist: the only hosts the worker is allowed to reach WITHOUT
// public-IP validation. Everything else (external/provider user-supplied URLs)
// is DNS-resolved + IP-validated by safeFetch. '127.0.0.1:4000' is http:// so
// it MUST be allowlisted (allowlist bypasses the HTTPS check too).
const SAFE_FETCH_ALLOWLIST = ['127.0.0.1:4000', 'openrouter.ai'];
// Registered gateway slug. The previous default ('nousresearch/hermes-4-405b')
// is NOT in the gateway model registry, so the :4000 gateway returns a 400
// "Unknown model" (resolver.ts) instead of serving the run. Use a registered slug.
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const MAX_ITERATIONS = 12;
const USD_TO_RUB = 90;
// D-0: the gateway returns the AUTHORITATIVE charged amount and the upstream
// cost it bore, in ₽, per request. We bill off these instead of the local
// PRICING×USD_TO_RUB estimate so realized margin is a real, readable number.
// Brand-neutral (₽ figures only); keyed to gateway_request_id via X-Request-Id.
const HDR_CHARGED_RUB = 'x-aiag-charged-rub';
const HDR_UPSTREAM_COST_RUB = 'x-aiag-upstream-cost-rub';
// R0-2 run-start gate: minimum spendable balance (₽) required to begin a
// billable run. 1₽ floor (Claude's discretion per CONTEXT).
const MIN_RUN_COST = 1;

interface Upstream {
  url: string;          // full chat-completions URL
  apiKey: string;
  model: string;
  isExternal: boolean;  // external = user-supplied; cost stays 0
}

export async function resolveUpstream(agent: AgentRow): Promise<Upstream> {
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
    const model =
      agent.external_model_slug?.trim() ||
      agent.model_slug?.trim() ||
      DEFAULT_MODEL;
    return { url, apiKey, model, isExternal: true };
  }

  // R0-1: aiag path → the :4000 gateway (OpenAI-compatible) when AIAG_GATEWAY_KEY
  // is provisioned. The gateway applies markup, writes the gateway_transactions
  // audit row, and keeps the upstream white-labelled.
  //
  // Graceful fallback (deploy-safety): until AIAG_GATEWAY_KEY is set on the host,
  // fall back to OpenRouter directly so runs keep working — the R0-2 balance debit
  // and the auth fixes still apply; only the gateway routing/markup/white-label is
  // OFF. Logged loudly so the missing-key state is visible in the worker logs.
  const model = agent.model_slug?.trim() || DEFAULT_MODEL;
  const gwKey = process.env.AIAG_GATEWAY_KEY;
  if (gwKey) {
    return { url: AIAG_GATEWAY_URL, apiKey: gwKey, model, isExternal: false };
  }
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) throw new Error('neither AIAG_GATEWAY_KEY nor OPENROUTER_API_KEY set');
  console.warn(
    '[agent-worker] AIAG_GATEWAY_KEY not set — aiag run falling back to direct OpenRouter ' +
      '(gateway routing/markup/white-label OFF until the key is provisioned)',
  );
  return { url: OPENROUTER_URL, apiKey: orKey, model, isExternal: false };
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

/**
 * True when a gateway response means "I don't have this model" → fall back.
 * Covers OpenRouter-style 404 / model_not_found AND the AIAG :4000 gateway's
 * 400 "Unknown model" (resolver.ts), which the old check missed.
 */
function isModelNotFound(status: number, text: string): boolean {
  if (status === 404) return true;
  if (status === 400 && /unknown model/i.test(text)) return true;
  return /model_not_found|model not found|no such model/i.test(text);
}

/**
 * Result of one chat call: the parsed model response PLUS, when the response
 * came from the AIAG gateway, the gateway's AUTHORITATIVE billing figures (₽).
 *
 * D-0: `billedByGateway` is true ONLY when the response actually came back from
 * the :4000 gateway (not the OpenRouter fallback) AND the X-AIAG-Charged-Rub
 * header parsed to a finite number. In that case `chargedRub` is the number the
 * caller MUST bill off (the gateway already debited the house org for it) and
 * `upstreamCostRub` is the upstream cost we bore (charged − cost = margin).
 * Otherwise `billedByGateway` is false → the caller falls back to estimateCostRub
 * (NEVER 0 / free).
 */
export interface ChatResult {
  response: ModelResponse;
  billedByGateway: boolean;
  chargedRub: number;
  upstreamCostRub: number;
}

/** Parse a ₽ billing header into a finite number, or null if absent/garbage. */
function parseRubHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
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
  const res = await postChat(upstream.url, upstream.apiKey, body, !upstream.isExternal, label);
  if (res.ok) {
    // D-0: read billing figures BEFORE consuming the body. Only trust them on
    // the real gateway path (not external/OpenRouter, which never set them).
    const charged = isGateway ? parseRubHeader(res, HDR_CHARGED_RUB) : null;
    const upstreamCost = isGateway ? parseRubHeader(res, HDR_UPSTREAM_COST_RUB) : null;
    const response = (await res.json()) as ModelResponse;
    return {
      response,
      billedByGateway: charged != null,
      chargedRub: charged ?? 0,
      // upstream cost may be absent even when charged is present; default 0.
      upstreamCostRub: upstreamCost ?? 0,
    };
  }

  const text = await res.text();

  // Degraded fallback: ONLY for the aiag gateway path, ONLY on model-not-found.
  if (isGateway && isModelNotFound(res.status, text)) {
    const orKey = process.env.OPENROUTER_API_KEY;
    if (orKey) {
      const fb = await postChat(OPENROUTER_URL, orKey, body, true, 'openrouter');
      if (fb.ok) {
        // Fallback to OpenRouter direct: no gateway markup/headers → estimate.
        const response = (await fb.json()) as ModelResponse;
        return { response, billedByGateway: false, chargedRub: 0, upstreamCostRub: 0 };
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

export function estimateCostRub(modelSlug: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[modelSlug] ?? FALLBACK_PRICE;
  const usd = (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
  return usd * USD_TO_RUB;
}

/**
 * CHARGE-0 floor: the amount we actually settle a run at.
 *
 * The gateway's authoritative X-AIAG-Charged-Rub is trusted as-is, but a
 * zero-usage gateway response (0 prompt+completion tokens → charged 0.0000) or a
 * zero-token estimate would otherwise settle a BILLABLE run at 0₽ (free). The
 * R0-2 MIN_RUN_COST gate only protects run START, not settle — so we re-apply it
 * here as a nonzero floor on the final billable amount. Tool fees are already
 * folded into `rawCostRub` (totalCostRub = basis + toolFeesRub), so they ride
 * inside the floor. External / BYOK runs (isExternal=true) pay their own provider
 * and MUST stay at exactly 0 — no floor.
 */
export function finalBillableCostRub(rawCostRub: number, isExternal: boolean): number {
  if (isExternal) return 0;
  return Math.max(MIN_RUN_COST, rawCostRub);
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

async function notifyCompleted(
  tgUserId: string, agentName: string, agentId: string, costRub: number, output: string,
): Promise<void> {
  await sendBotMessage(tgUserId, buildRunCompletedMessage({ agentName, agentId, costRub, output }));
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

  // ---- budgets ----
  const monthlyBudget = Number(agent.budget_rub_monthly);
  const monthlySpend = await sumMonthlySpend(agent.tg_user_id);
  if (monthlySpend >= monthlyBudget) {
    await markFailed(runId, 'budget_exceeded_monthly');
    await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'budget_exceeded_monthly');
    return;
  }
  const daily = await getOrResetDailyBucket(agent.id);
  if (daily.spent_today_rub >= daily.daily_budget_rub) {
    await markFailed(runId, 'budget_exceeded_daily');
    await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'budget_exceeded_daily');
    return;
  }

  // ---- upstream resolution (provider_id / aiag-gateway / external) ----
  // Resolve BEFORE the balance gate so external (user-paid) runs skip it.
  let upstream: Upstream;
  try {
    upstream = await resolveUpstream(agent);
  } catch (e) {
    const msg = `upstream_misconfigured: ${(e as Error).message.slice(0, 160)}`;
    await markFailed(runId, msg);
    await notifyFailed(agent.tg_user_id, agent.name, agent.id, msg);
    return;
  }

  // ---- R0-2 run-start balance gate (billable runs only) ----
  // A zero/low-balance user can no longer run a billable agent for free.
  if (!upstream.isExternal) {
    const bal = await getBalance(agent.tg_user_id);
    if (bal < MIN_RUN_COST) {
      await markFailed(runId, 'insufficient_balance');
      await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'insufficient_balance');
      return;
    }
  }

  await markStarted(runId);

  // ---- conversation history ----
  const history = await loadHistory(agent.id, runId, 10);
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
  let mcp: McpClient | null = null;
  if (agent.mcp_endpoint_url) {
    try {
      const authHeader = agent.mcp_auth_encrypted
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
  let totalCostRub = 0;
  // D-0 margin accounting (gateway path only):
  //  - gatewayChargedTotal: Σ authoritative charged ₽ from the gateway headers.
  //  - gatewayUpstreamCostTotal: Σ authoritative upstream cost ₽ (charged − cost
  //    = realized margin, now a readable number for tool/author payouts).
  //  - allModelCallsBilledByGateway: true while EVERY model call this run came
  //    back authoritatively billed. The moment one call lacks figures (gateway
  //    didn't return them, or we fell back to OpenRouter) we flip to the local
  //    estimate for the WHOLE run — never silently mix the two, never bill 0.
  //  - toolFeesRub: tool-side fees, added on top of either basis.
  let gatewayChargedTotal = 0;
  let gatewayUpstreamCostTotal = 0;
  let allModelCallsBilledByGateway = !upstream.isExternal;
  let toolFeesRub = 0;

  try {
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let call: ChatResult;
    try {
      call = await callModel(upstream, messages, tools);
    } catch (e) {
      const msg = `upstream_error: ${(e as Error).message.slice(0, 200)}`;
      await markFailed(runId, msg);
      await notifyFailed(agent.tg_user_id, agent.name, agent.id, msg);
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
        gatewayChargedTotal += call.chargedRub;
        gatewayUpstreamCostTotal += call.upstreamCostRub;
      } else {
        allModelCallsBilledByGateway = false;
      }
    }

    // Effective run cost so far (excl. tool fees added below):
    //  - external: 0 (user pays their own provider),
    //  - gateway-authoritative: Σ gateway charge (the REAL charge),
    //  - fallback: local estimate from cumulative tokens (NEVER 0).
    if (upstream.isExternal) {
      totalCostRub = 0;
    } else if (allModelCallsBilledByGateway) {
      totalCostRub = gatewayChargedTotal + toolFeesRub;
    } else {
      if (i === 0) {
        console.warn(
          '[agent-worker] D-0: gateway authoritative charge missing/unparseable — ' +
            'falling back to local estimateCostRub (never 0). ' +
            `model=${upstream.model} run=${runId}`,
        );
      }
      totalCostRub = estimateCostRub(upstream.model, tokensIn, tokensOut) + toolFeesRub;
    }

    // Mid-run budget cutoff (monthly + daily)
    if (monthlySpend + totalCostRub > monthlyBudget) {
      await markFailed(runId, 'budget_exceeded_monthly_mid_run');
      await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'budget_exceeded_monthly_mid_run');
      return;
    }
    if (daily.spent_today_rub + totalCostRub > daily.daily_budget_rub) {
      await markFailed(runId, 'budget_exceeded_daily_mid_run');
      await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'budget_exceeded_daily_mid_run');
      return;
    }

    const choice = resp.choices[0];
    if (!choice) {
      await markFailed(runId, 'empty_response');
      await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'empty_response');
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
        const marginRub = gatewayChargedTotal - gatewayUpstreamCostTotal;
        console.info(
          `[agent-worker] D-0 settle run=${runId} charged=${gatewayChargedTotal.toFixed(4)}₽ ` +
            `upstreamCost=${gatewayUpstreamCostTotal.toFixed(4)}₽ margin=${marginRub.toFixed(4)}₽ ` +
            `toolFees=${toolFeesRub.toFixed(4)}₽ (gateway-authoritative)`,
        );
      }
      // CHARGE-0: floor the BILLABLE settle amount to MIN_RUN_COST so a
      // zero-usage gateway charge (or a zero-token estimate) can never settle a
      // billable run at 0₽. External/BYOK stays exactly 0. Tool fees are already
      // inside totalCostRub, so they ride inside the floor.
      const billable = finalBillableCostRub(totalCostRub, upstream.isExternal);
      // R0-2 + R0-3: mark completed + atomic daily-spend guard + balance debit
      // in ONE transaction. A failed guard/debit rolls back the completion too,
      // so the run never lands 'completed' without being paid for.
      try {
        await settleRun({
          runId,
          tgUserId: agent.tg_user_id,
          agentId: agent.id,
          output,
          costRub: billable,
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
        await notifyFailed(agent.tg_user_id, agent.name, agent.id, reason);
        return;
      }
      await notifyCompleted(agent.tg_user_id, agent.name, agent.id, billable, output);
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
      const exec =
        mcp && toolCall.function.name.startsWith(MCP_PREFIX)
          ? await callMcpTool(mcp, toolCall.function.name.slice(MCP_PREFIX.length), parsed)
          : await executeTool(toolCall.function.name, parsed, { agentId: agent.id });
      if (exec.cost_rub > 0) {
        // Accumulate into toolFeesRub, NOT totalCostRub — the next iteration
        // recomputes totalCostRub from (basis + toolFeesRub), so adding here
        // would be overwritten. Tool fees ride on top of either billing basis.
        toolFeesRub += exec.cost_rub;
      }
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(exec.result).slice(0, 8000),
      });
    }
  }

  await markFailed(runId, 'max_iterations_exceeded');
  await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'max_iterations_exceeded');
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
