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
  status: string;
}

export interface AgentRunRow {
  id: string;
  agent_id: string;
  tg_user_id: string;
  input: string;
  status: string;
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
           budget_rub_monthly::text AS budget_rub_monthly, status
    FROM agents WHERE id = ${agentId}::uuid LIMIT 1
  `) as unknown as AgentRow[];
  return rows[0] ?? null;
}

/**
 * Sum cost_rub spent by this tg_user this calendar month (UTC).
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
