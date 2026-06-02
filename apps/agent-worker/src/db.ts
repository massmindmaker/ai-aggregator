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

// -- R0-2: prepaid balance (tg_user_balances) -----------------------------
//
// tg_user_balances.balance_rub IS the live spendable balance: the topup-check
// route credits it (`INSERT … ON CONFLICT DO UPDATE SET balance_rub = balance
// + EXCLUDED.balance_rub`, migration 0019) and the wallet route reads it.
// `tg_users` is NOT the balance table in this repo — debit tg_user_balances.

/**
 * Live spendable balance (₽) for a tg_user. Returns 0 when no row exists
 * (no row ⇒ never topped up ⇒ zero balance), never null/throws.
 */
export async function getBalance(tgUserId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(balance_rub, 0)::text AS balance_rub
    FROM tg_user_balances
    WHERE tg_user_id = ${tgUserId}::bigint
    LIMIT 1
  `) as unknown as Array<{ balance_rub: string }>;
  return Number(rows[0]?.balance_rub ?? 0);
}

/** Thrown when the guarded balance debit affects 0 rows (insufficient funds). */
export class InsufficientBalanceError extends Error {
  constructor(message = 'insufficient_balance') {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

/**
 * R0-2 + R0-3 + R0-6: settle a completed run in ONE transaction.
 *
 * Concurrency model: READ COMMITTED (postgres default — NO isolation argument)
 * + guarded `UPDATE … WHERE <guard> RETURNING`. Double-spend / over-budget
 * safety comes from the per-row lock postgres takes on the updated row plus the
 * WHERE-guard — NOT from a SERIALIZABLE level, so there is intentionally no
 * 40001 serialization-failure retry loop.
 *
 * All-or-nothing: markCompleted + the atomic daily-spend guard + the guarded
 * balance debit run inside one `sql.begin`. Any throw auto-ROLLBACKs all three,
 * so cost is never recorded without a debit, and a failed daily-spend guard
 * rolls the balance debit back too.
 *
 * External (user-supplied upstream) runs cost us 0 ₽ → skip the daily-spend
 * guard and the balance debit (only the run row is marked completed).
 */
export async function settleRun(args: {
  runId: string;
  tgUserId: string;
  agentId: string;
  output: string;
  costRub: number;
  tokensIn: number;
  tokensOut: number;
  isExternal: boolean;
}): Promise<void> {
  const { runId, tgUserId, agentId, output, costRub, tokensIn, tokensOut, isExternal } = args;
  // Plain sql.begin → READ COMMITTED (the chosen approach). Use the
  // callback-scoped `sql`, not the module-level one, so queries stay in-tx.
  await sql.begin(async (sql) => {
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

    if (isExternal) return; // user pays their own provider — nothing to debit

    // R0-3: atomic guarded daily-spend increment (kills the 4× TOCTOU).
    const daily = (await sql`
      UPDATE agents
      SET spent_today_rub = spent_today_rub + ${costRub}
      WHERE id = ${agentId}::uuid
        AND spent_today_rub + ${costRub} <= daily_budget_rub
      RETURNING id::text
    `) as unknown as Array<{ id: string }>;
    if (daily.length === 0) throw new Error('budget_exceeded_daily_settle');

    // R0-2: guarded balance debit on the live spendable balance.
    const debit = (await sql`
      UPDATE tg_user_balances
      SET balance_rub = balance_rub - ${costRub},
          updated_at = NOW()
      WHERE tg_user_id = ${tgUserId}::bigint
        AND balance_rub >= ${costRub}
      RETURNING balance_rub::text
    `) as unknown as Array<{ balance_rub: string }>;
    if (debit.length === 0) throw new InsufficientBalanceError();
  });
}
