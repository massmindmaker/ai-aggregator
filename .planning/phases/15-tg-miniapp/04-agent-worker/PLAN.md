# Phase 15 / Wave 04 — apps/agent-worker (Hermes 4 405B + tools + budget)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** Развернуть BullMQ worker `apps/agent-worker/` который исполняет агенты на Hermes 4 405B через OpenRouter с function-calling, реализует базовый tool-set (`web_search`, `image_gen`-stub, `code_interpreter`-safe-eval), и enforce-ит daily budget.

**Architecture:** API `/tg/api/tma/agents/[id]/run` ставит job в Redis-queue `agent-execute`. Worker берёт job → грузит agent + last-N steps из `agent_runs` → вызывает OpenRouter с `tools[]` → tool-call loop (макс 12 итераций) → каждый tool-call settle'ит charge → final response пишет в `agent_runs.final_response`. Бот шлёт DM с результатом (wave 07).

**Tech stack:** BullMQ, ioredis, OpenAI SDK (`baseURL=openrouter.ai`), Drizzle, существующий `packages/billing`.

**Prereq:** Waves 01-03.

---

## File map

| Action | File | Purpose |
|--------|------|---------|
| Create | `apps/agent-worker/package.json` | Worker manifest |
| Create | `apps/agent-worker/src/index.ts` | BullMQ worker bootstrap |
| Create | `apps/agent-worker/src/run-agent.ts` | Core tool-call loop |
| Create | `apps/agent-worker/src/tools/index.ts` | Tool registry + schema |
| Create | `apps/agent-worker/src/tools/web-search.ts` | DuckDuckGo HTTP search |
| Create | `apps/agent-worker/src/tools/calc.ts` | Safe math eval (mathjs) |
| Create | `apps/agent-worker/src/tools/image-gen.ts` | Proxy через aiag gateway |
| Create | `apps/agent-worker/src/budget.ts` | Daily + monthly budget check |
| Create | `apps/tg-miniapp/src/lib/queue.ts` | enqueue helper |
| Create | `apps/tg-miniapp/app/api/tma/agents/[id]/run/route.ts` | POST → enqueue |
| Create | `apps/tg-miniapp/app/api/tma/runs/[id]/route.ts` | GET status poll |

---

## Task 1: Worker scaffold

- [ ] **Step 1:** `apps/agent-worker/package.json` — deps: `bullmq`, `ioredis`, `openai`, `@aiag/database`, `mathjs`.
- [ ] **Step 2:** `src/index.ts`

```ts
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { runAgent } from './run-agent';

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
const worker = new Worker('agent-execute', async (job) => {
  return runAgent(job.data.runId);
}, { connection, concurrency: 4 });

worker.on('failed', (job, err) => console.error('[worker] failed', job?.id, err));
console.log('[agent-worker] listening on agent-execute queue');
```

---

## Task 2: Tool registry & implementations

- [ ] **Step 1: `tools/index.ts`** — экспорт `TOOLS_BY_SLUG` мапа + `toOpenAISchema(slugs[])` строит `tools[]` для OpenRouter.

```ts
export const TOOL_SCHEMAS: Record<string, OpenAI.ChatCompletionTool> = {
  web_search: { type:'function', function:{ name:'web_search',
    description:'Search the public web', parameters:{
      type:'object', properties:{ query:{type:'string'} }, required:['query'] } } },
  calc: { type:'function', function:{ name:'calc',
    description:'Evaluate math expression', parameters:{
      type:'object', properties:{ expr:{type:'string'} }, required:['expr'] } } },
  image_gen: { type:'function', function:{ name:'image_gen',
    description:'Generate image', parameters:{
      type:'object',
      properties:{ prompt:{type:'string'}, aspect_ratio:{type:'string'} },
      required:['prompt'] } } },
};
```

- [ ] **Step 2: `tools/web-search.ts`** — fetch `https://duckduckgo.com/?q=...&format=json`, return top-5 results. Cost: 0₽ MVP.
- [ ] **Step 3: `tools/calc.ts`** — `mathjs.evaluate(expr)` в try/catch. Cost: 0₽.
- [ ] **Step 4: `tools/image-gen.ts`** — POST `${GATEWAY_INTERNAL_URL}/v1/images/generations` с user `system_key`, возвращает URL + cost_rub из ответа gateway.

---

## Task 3: Budget enforcement

- [ ] **Step 1: `budget.ts`**

```ts
export async function checkBudget(agentId: string, estimatedCost: number) {
  const [a] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!a) return { ok: false, reason: 'agent_not_found' };
  if (Number(a.spentTodayRub) + estimatedCost > Number(a.dailyBudgetRub))
    return { ok: false, reason: 'daily_budget_exceeded' };
  // user balance check via packages/billing
  const balance = await getUserBalance(a.ownerUserId);
  if (balance < estimatedCost) return { ok: false, reason: 'insufficient_balance' };
  return { ok: true };
}
```

- [ ] **Step 2:** Cron `0 0 * * *` MSK reset `UPDATE agents SET spent_today_rub=0` (добавить в существующий `apps/worker/`).

---

## Task 4: Tool-call loop

- [ ] **Step 1: `run-agent.ts`** — основной алгоритм:

```ts
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY!, baseURL: 'https://openrouter.ai/api/v1' });

export async function runAgent(runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
  await db.update(agentRuns).set({ status:'running', startedAt:new Date() }).where(eq(agentRuns.id, runId));

  const history = await loadHistory(agent.id, 20); // last 20 steps as messages
  const messages: any[] = [
    { role: 'system', content: agent.systemPrompt },
    ...history,
    { role: 'user', content: run.userMessage },
  ];
  const tools = toolSchemasFor(agent.allowedTools as string[]);
  const steps: any[] = [];
  let totalCost = 0;

  for (let i = 0; i < 12; i++) {
    const resp = await client.chat.completions.create({
      model: 'nousresearch/hermes-4-405b', messages, tools, tool_choice:'auto',
    });
    const choice = resp.choices[0];
    steps.push({ kind:'reasoning', content: choice.message.content, model:'hermes-4-405b' });
    if (!choice.message.tool_calls?.length) {
      await finalize(runId, choice.message.content ?? '', steps, totalCost);
      return;
    }
    messages.push(choice.message);
    for (const tc of choice.message.tool_calls) {
      const budget = await checkBudget(agent.id, estimateCost(tc));
      if (!budget.ok) {
        const errPayload = JSON.stringify({ error: budget.reason });
        messages.push({ role:'tool', tool_call_id: tc.id, content: errPayload });
        steps.push({ kind:'tool_result', name: tc.function.name, error: budget.reason });
        continue;
      }
      const { result, cost } = await dispatchTool(tc);
      totalCost += cost;
      steps.push({ kind:'tool_call', name: tc.function.name, args: tc.function.arguments });
      steps.push({ kind:'tool_result', name: tc.function.name, content: result, cost });
      messages.push({ role:'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      // settle_charge — списываем с баланса
      await settleCharge(agent.ownerUserId, cost, 'agent_tool', runId);
      await db.update(agents).set({ spentTodayRub: sql`spent_today_rub + ${cost}` }).where(eq(agents.id, agent.id));
    }
  }
  await db.update(agentRuns).set({ status:'failed', error:'step_limit', finishedAt:new Date() }).where(eq(agentRuns.id, runId));
}
```

- [ ] **Step 2:** Hard timeout 5 min через `Promise.race`.

---

## Task 5: API endpoints

- [ ] **Step 1: `/api/tma/agents/[id]/run/route.ts`** — POST `{ message }` → insert `agent_runs` (status='queued') → enqueue BullMQ → return `{ runId }`.
- [ ] **Step 2: `/api/tma/runs/[id]/route.ts`** — GET → возвращает `status`, `steps`, `final_response`, `total_cost_rub`.
- [ ] **Step 3:** Client poll в `agents/[id]/page.tsx` — `useSWR(\`/api/tma/runs/${runId}\`, { refreshInterval: status==='running' ? 1500 : 0 })`.

Verification:

```bash
curl -X POST -H "Authorization: Bearer $JWT" -d '{"message":"5+5"}' \
  http://localhost:3100/tg/api/tma/agents/$AGENT_ID/run
# → {runId:"..."} → poll runs/{id} → status='completed', final_response contains "10"
```

---

## Commit

```bash
git add apps/agent-worker apps/tg-miniapp
git commit -m "feat(agent-worker): Hermes 4 405B tool-call loop + budget enforcement + 3 base tools"
```

## Done when

- Worker запускается, лог `listening on agent-execute queue`.
- Calc-агент решает `2+2` за <5s.
- Budget exceeded → `agent_runs.error='daily_budget_exceeded'` + agent.status стало `paused` (можно сделать в cron-resume).
- Step limit (12) защищает от runaway.
