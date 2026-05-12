import {
  loadRun,
  loadAgent,
  sumMonthlySpend,
  markStarted,
  markCompleted,
  markFailed,
} from './db.js';
import { TOOL_DEFS, executeTool } from './tools.js';
import {
  sendBotMessage,
  buildRunCompletedMessage,
  buildRunFailedMessage,
} from './bot-api.js';

async function notifyCompleted(
  tgUserId: string,
  agentName: string,
  agentId: string,
  costRub: number,
  output: string,
): Promise<void> {
  await sendBotMessage(
    tgUserId,
    buildRunCompletedMessage({ agentName, agentId, costRub, output }),
  );
}

async function notifyFailed(
  tgUserId: string,
  agentName: string,
  agentId: string,
  error: string,
): Promise<void> {
  await sendBotMessage(
    tgUserId,
    buildRunFailedMessage({ agentName, agentId, error }),
  );
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'nousresearch/hermes-4-405b';
const MAX_ITERATIONS = 12;

// OpenRouter Hermes 4 405B approximate pricing (USD per 1M tokens).
const PRICE_IN_PER_M_USD = 0.9;
const PRICE_OUT_PER_M_USD = 1.5;
const USD_TO_RUB = 90;

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

interface HermesResponse {
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

async function callHermes(messages: Message[]): Promise<HermesResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://ai-aggregator.ru',
      'X-Title': 'AIAG TMA',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOL_DEFS,
      tool_choice: 'auto',
      max_tokens: 2000,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as HermesResponse;
}

function estimateCostRub(tokensIn: number, tokensOut: number): number {
  const usd = (tokensIn * PRICE_IN_PER_M_USD + tokensOut * PRICE_OUT_PER_M_USD) / 1_000_000;
  return usd * USD_TO_RUB;
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

  const budget = Number(agent.budget_rub_monthly);
  const monthlySpend = await sumMonthlySpend(agent.tg_user_id);
  if (monthlySpend >= budget) {
    await markFailed(runId, 'budget_exceeded');
    await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'budget_exceeded');
    return;
  }

  await markStarted(runId);

  const messages: Message[] = [
    { role: 'system', content: agent.system_prompt },
    { role: 'user', content: run.input },
  ];

  let tokensIn = 0;
  let tokensOut = 0;
  let totalCostRub = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let resp: HermesResponse;
    try {
      resp = await callHermes(messages);
    } catch (e) {
      const msg = `openrouter_error: ${(e as Error).message.slice(0, 200)}`;
      await markFailed(runId, msg);
      await notifyFailed(agent.tg_user_id, agent.name, agent.id, msg);
      return;
    }

    tokensIn += resp.usage?.prompt_tokens ?? 0;
    tokensOut += resp.usage?.completion_tokens ?? 0;
    totalCostRub = estimateCostRub(tokensIn, tokensOut);

    if (monthlySpend + totalCostRub > budget) {
      await markFailed(runId, 'budget_exceeded_mid_run');
      await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'budget_exceeded_mid_run');
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
      const result = await executeTool(call.function.name, parsed);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 8000),
      });
    }
  }

  await markFailed(runId, 'max_iterations_exceeded');
  await notifyFailed(agent.tg_user_id, agent.name, agent.id, 'max_iterations_exceeded');
}
