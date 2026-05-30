import {
  loadRun,
  loadAgent,
  sumMonthlySpend,
  getOrResetDailyBucket,
  incrementDailySpend,
  loadHistory,
  markStarted,
  markCompleted,
  markFailed,
  type AgentRow,
} from './db.js';
import { pickToolDefs, executeTool, type ToolDef } from './tools.js';
import {
  sendBotMessage,
  buildRunCompletedMessage,
  buildRunFailedMessage,
} from './bot-api.js';
import { decryptSecret } from './crypto.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'nousresearch/hermes-4-405b';
const MAX_ITERATIONS = 12;
const USD_TO_RUB = 90;

interface Upstream {
  url: string;          // full chat-completions URL
  apiKey: string;
  model: string;
  isExternal: boolean;  // external = user-supplied; cost stays 0
}

function resolveUpstream(agent: AgentRow): Upstream {
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
  const model = agent.model_slug?.trim() || DEFAULT_MODEL;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  return { url: OPENROUTER_URL, apiKey, model, isExternal: false };
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

async function callModel(
  upstream: Upstream,
  messages: Message[],
  tools: ToolDef[],
): Promise<ModelResponse> {
  const body: Record<string, unknown> = {
    model: upstream.model,
    messages,
    max_tokens: 2000,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${upstream.apiKey}`,
    'content-type': 'application/json',
  };
  // OpenRouter wants these for routing/attribution; harmless on other servers.
  if (!upstream.isExternal) {
    headers['HTTP-Referer'] = 'https://ai-aggregator.ru';
    headers['X-Title'] = 'AIAG TMA';
  }
  const res = await fetch(upstream.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const label = upstream.isExternal ? 'external' : 'openrouter';
    throw new Error(`${label} ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as ModelResponse;
}

function estimateCostRub(modelSlug: string, tokensIn: number, tokensOut: number): number {
  const p = PRICING[modelSlug] ?? FALLBACK_PRICE;
  const usd = (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
  return usd * USD_TO_RUB;
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

  await markStarted(runId);

  // ---- conversation history ----
  const history = await loadHistory(agent.id, runId, 10);
  const messages: Message[] = [{ role: 'system', content: buildSystem(agent) }];
  for (const h of history) {
    messages.push({ role: 'user', content: h.input });
    if (h.output) messages.push({ role: 'assistant', content: h.output });
  }
  messages.push({ role: 'user', content: run.input });

  // ---- upstream resolution (aiag vs external) + tools ----
  let upstream: Upstream;
  try {
    upstream = resolveUpstream(agent);
  } catch (e) {
    const msg = `upstream_misconfigured: ${(e as Error).message.slice(0, 160)}`;
    await markFailed(runId, msg);
    await notifyFailed(agent.tg_user_id, agent.name, agent.id, msg);
    return;
  }
  const tools = pickToolDefs(agent.tools);

  let tokensIn = 0;
  let tokensOut = 0;
  let totalCostRub = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let resp: ModelResponse;
    try {
      resp = await callModel(upstream, messages, tools);
    } catch (e) {
      const msg = `openrouter_error: ${(e as Error).message.slice(0, 200)}`;
      await markFailed(runId, msg);
      await notifyFailed(agent.tg_user_id, agent.name, agent.id, msg);
      return;
    }

    tokensIn += resp.usage?.prompt_tokens ?? 0;
    tokensOut += resp.usage?.completion_tokens ?? 0;
    // External upstream — cost stays 0 (user pays their own provider). AIAG
    // is just the UI / orchestrator in that case.
    totalCostRub = upstream.isExternal
      ? 0
      : estimateCostRub(upstream.model, tokensIn, tokensOut);

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
      await markCompleted(runId, output, totalCostRub, tokensIn, tokensOut);
      await incrementDailySpend(agent.id, totalCostRub);
      await notifyCompleted(agent.tg_user_id, agent.name, agent.id, totalCostRub, output);
      return;
    }

    // record assistant message (with tool_calls) into convo
    messages.push({
      role: 'assistant',
      content: choice.message.content,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || '{}');
      } catch {
        parsed = {};
      }
      const exec = await executeTool(call.function.name, parsed, { agentId: agent.id });
      if (exec.cost_rub > 0) {
        totalCostRub += exec.cost_rub;
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(exec.result).slice(0, 8000),
      });
    }
  }

  await markFailed(runId, 'max_iterations_exceeded');
  await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'max_iterations_exceeded');
}
