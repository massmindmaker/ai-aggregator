import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  // Defer hard failure until first use so dev/build doesn't break.
  console.warn('[agent-worker] DATABASE_URL is not set');
}

export const sql = postgres(url ?? '', { prepare: false });

export interface AgentRow {
  id: string;
  tg_user_id: string;
  name: string;
  system_prompt: string;
  tools: string[];
  model_slug: string | null;
  budget_rub_monthly: string;
  daily_budget_rub: string;
  spent_today_rub: string;
  spent_today_date: string;
  status: string;
  connection_type: 'aiag' | 'external_openai';
  external_base_url: string | null;
  external_api_key_encrypted: Buffer | null;
  external_model_slug: string | null;
}

export interface AgentRunRow {
  id: string;
  agent_id: string;
  tg_user_id: string;
  input: string;
  status: string;
}

export interface HistoryRow {
  input: string;
  output: string | null;
}

export async function loadRun(runId: string): Promise<AgentRunRow | null> {
  const rows = (await sql`
    SELECT id::text, agent_id::text, tg_user_id::text, input, status
    FROM agent_runs WHERE id = ${runId}::uuid LIMIT 1
  `) as unknown as AgentRunRow[];
  return rows[0] ?? null;
}

export async function loadAgent(agentId: string): Promise<AgentRow | null> {
  const rows = (await sql`
    SELECT id::text, tg_user_id::text, name, system_prompt, tools, model_slug,
           budget_rub_monthly::text  AS budget_rub_monthly,
           daily_budget_rub::text    AS daily_budget_rub,
           spent_today_rub::text     AS spent_today_rub,
           spent_today_date::text    AS spent_today_date,
           status,
           connection_type,
           external_base_url,
           external_api_key_encrypted,
           external_model_slug
    FROM agents WHERE id = ${agentId}::uuid LIMIT 1
  `) as unknown as AgentRow[];
  return rows[0] ?? null;
}

/**
 * Sum cost_rub spent by this tg_user this calendar month (UTC).
 * Used for the monthly aggregate budget gate at the user level.
 */
export async function sumMonthlySpend(tgUserId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(cost_rub), 0)::text AS total
    FROM agent_runs
    WHERE tg_user_id = ${tgUserId}::bigint
      AND created_at >= date_trunc('month', NOW())
  `) as unknown as Array<{ total: string }>;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Atomically reset today's counter if the stored date is stale, then
 * return the current bucket. Race-safe under concurrent runs.
 */
export async function getOrResetDailyBucket(
  agentId: string,
): Promise<{ daily_budget_rub: number; spent_today_rub: number }> {
  const rows = (await sql`
    UPDATE agents
       SET spent_today_rub  = CASE
             WHEN spent_today_date < (now() AT TIME ZONE 'Europe/Moscow')::date THEN 0
             ELSE spent_today_rub
           END,
           spent_today_date = (now() AT TIME ZONE 'Europe/Moscow')::date
     WHERE id = ${agentId}::uuid
     RETURNING daily_budget_rub::text AS daily_budget_rub,
               spent_today_rub::text  AS spent_today_rub
  `) as unknown as Array<{ daily_budget_rub: string; spent_today_rub: string }>;
  const r = rows[0];
  if (!r) return { daily_budget_rub: 0, spent_today_rub: 0 };
  return {
    daily_budget_rub: Number(r.daily_budget_rub),
    spent_today_rub: Number(r.spent_today_rub),
  };
}

export async function incrementDailySpend(
  agentId: string,
  deltaRub: number,
): Promise<void> {
  await sql`
    UPDATE agents
       SET spent_today_rub = spent_today_rub + ${deltaRub}
     WHERE id = ${agentId}::uuid
  `;
}

/**
 * Last N COMPLETED runs (excluding the current one) — input + output pairs,
 * ordered oldest-first so they slot naturally into messages[].
 */
export async function loadHistory(
  agentId: string,
  excludeRunId: string,
  limit = 10,
): Promise<HistoryRow[]> {
  const rows = (await sql`
    SELECT input, output
      FROM agent_runs
     WHERE agent_id = ${agentId}::uuid
       AND id <> ${excludeRunId}::uuid
       AND status = 'completed'
       AND output IS NOT NULL
     ORDER BY created_at DESC
     LIMIT ${limit}
  `) as unknown as HistoryRow[];
  return rows.reverse();
}

// -- agent_memory (key-value store backing the `memory` tool) -------------

export async function memorySet(
  agentId: string,
  key: string,
  value: string,
): Promise<void> {
  await sql`
    INSERT INTO agent_memory (agent_id, key, value, updated_at)
    VALUES (${agentId}::uuid, ${key}, ${value}, NOW())
    ON CONFLICT (agent_id, key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

export async function memoryGet(
  agentId: string,
  key: string,
): Promise<string | null> {
  const rows = (await sql`
    SELECT value FROM agent_memory
    WHERE agent_id = ${agentId}::uuid AND key = ${key}
    LIMIT 1
  `) as unknown as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}

export async function memoryList(
  agentId: string,
  limit = 100,
): Promise<Array<{ key: string; value: string }>> {
  const rows = (await sql`
    SELECT key, value FROM agent_memory
    WHERE agent_id = ${agentId}::uuid
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `) as unknown as Array<{ key: string; value: string }>;
  return rows;
}

export async function markStarted(runId: string): Promise<void> {
  await sql`
    UPDATE agent_runs
    SET status = 'running', started_at = NOW()
    WHERE id = ${runId}::uuid
  `;
}

export async function markCompleted(
  runId: string,
  output: string,
  costRub: number,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  await sql`
    UPDATE agent_runs
    SET status = 'completed',
        output = ${output},
        cost_rub = ${costRub},
        tokens_in = ${tokensIn},
        tokens_out = ${tokensOut},
        completed_at = NOW()
    WHERE id = ${runId}::uuid
  `;
}

export async function markFailed(runId: string, error: string): Promise<void> {
  await sql`
    UPDATE agent_runs
    SET status = 'failed',
        error = ${error},
        completed_at = NOW()
    WHERE id = ${runId}::uuid
  `;
}
