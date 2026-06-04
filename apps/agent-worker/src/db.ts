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
  // D-1: credit unit = integer US cents (BIGINT). 1 credit = $0.01.
  budget_credits_monthly: string;
  daily_budget_credits: string;
  spent_today_credits: string;
  spent_today_date: string;
  status: string;
  connection_type: 'aiag' | 'external_openai';
  external_base_url: string | null;
  external_api_key_encrypted: Buffer | null;
  external_model_slug: string | null;
  // R0-6: migration 0026 provider-picker columns. provider_id IS NULL ⇒
  // legacy aiag/external_openai path; NOT NULL ⇒ new provider-catalog path.
  provider_id: string | null;
  model_id: string | null;
  auth_ref: string | null;
  base_url_override: string | null;
  // MCP (skills) — optional remote Streamable-HTTP MCP server attached to the agent.
  // mcp_auth_encrypted = AES-256-GCM base64 (crypto.ts), decrypted at run time.
  mcp_endpoint_url: string | null;
  mcp_auth_encrypted: string | null;
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
           budget_credits_monthly::text AS budget_credits_monthly,
           daily_budget_credits::text   AS daily_budget_credits,
           spent_today_credits::text    AS spent_today_credits,
           spent_today_date::text       AS spent_today_date,
           status,
           connection_type,
           external_base_url,
           external_api_key_encrypted,
           external_model_slug,
           provider_id,
           model_id::text          AS model_id,
           auth_ref::text          AS auth_ref,
           base_url_override,
           mcp_endpoint_url,
           mcp_auth_encrypted
    FROM agents WHERE id = ${agentId}::uuid LIMIT 1
  `) as unknown as AgentRow[];
  return rows[0] ?? null;
}

// -- R0-6: provider-picker credential loader (migration 0026) -------------

export interface ProviderCredential {
  provider_id: string;
  api_base: string | null;      // providers.api_base (default OpenAI-compatible base)
  base_url: string | null;      // per-credential override (custom provider)
  model_id: string | null;
  enc_key: Buffer;              // AES-256-GCM ciphertext (crypto.ts format)
  requires_base_url: boolean;
}

/**
 * Load + JOIN an agent's BYO provider credential (agent_provider_credentials)
 * to its provider catalog row (providers). Returns the ciphertext as a Buffer
 * — does NOT decrypt here so crypto stays in one place (resolveUpstream calls
 * decryptSecret).
 *
 * enc_key encoding: the column is TEXT (migration 0026) holding the same
 * AES-256-GCM blob crypto.ts produces, base64-encoded. The BYOK write route
 * MUST store `encryptSecret(key).toString('base64')` to match this decode.
 */
export async function loadProviderCredential(
  authRef: string,
): Promise<ProviderCredential | null> {
  const rows = (await sql`
    SELECT c.provider_id,
           p.api_base,
           c.base_url,
           c.model_id,
           c.enc_key,
           p.requires_base_url
    FROM agent_provider_credentials c
    JOIN providers p ON p.id = c.provider_id
    WHERE c.id = ${authRef}::uuid
    LIMIT 1
  `) as unknown as Array<{
    provider_id: string;
    api_base: string | null;
    base_url: string | null;
    model_id: string | null;
    enc_key: string;
    requires_base_url: boolean;
  }>;
  const r = rows[0];
  if (!r) return null;
  return {
    provider_id: r.provider_id,
    api_base: r.api_base,
    base_url: r.base_url,
    model_id: r.model_id,
    enc_key: Buffer.from(r.enc_key, 'base64'),
    requires_base_url: r.requires_base_url,
  };
}

/**
 * Sum cost_credits (US cents) spent by this tg_user this calendar month (UTC).
 * Used for the monthly aggregate budget gate at the user level.
 */
export async function sumMonthlySpend(tgUserId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(cost_credits), 0)::text AS total
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
): Promise<{ daily_budget_credits: number; spent_today_credits: number }> {
  const rows = (await sql`
    UPDATE agents
       SET spent_today_credits = CASE
             WHEN spent_today_date < (now() AT TIME ZONE 'Europe/Moscow')::date THEN 0
             ELSE spent_today_credits
           END,
           spent_today_date = (now() AT TIME ZONE 'Europe/Moscow')::date
     WHERE id = ${agentId}::uuid
     RETURNING daily_budget_credits::text AS daily_budget_credits,
               spent_today_credits::text  AS spent_today_credits
  `) as unknown as Array<{ daily_budget_credits: string; spent_today_credits: string }>;
  const r = rows[0];
  if (!r) return { daily_budget_credits: 0, spent_today_credits: 0 };
  return {
    daily_budget_credits: Number(r.daily_budget_credits),
    spent_today_credits: Number(r.spent_today_credits),
  };
}

export async function incrementDailySpend(
  agentId: string,
  deltaCredits: number,
): Promise<void> {
  await sql`
    UPDATE agents
       SET spent_today_credits = spent_today_credits + ${deltaCredits}
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

// -- agent_schedules (scheduled self-running runs, migration 0034) ---------
//
// The scheduler tick claims due schedules with an ATOMIC guarded UPDATE …
// RETURNING and, for each row, enqueues a NORMAL run through the existing money
// path. The UPDATE is the double-fire guard: it advances next_run_at in the same
// statement that reads the due rows, so a concurrent tick (another instance)
// sees the advanced next_run_at and claims nothing. Pure scheduling — no billing
// here; settleRun/budget guards run later inside runAgent().

export interface DueSchedule {
  id: string;
  agent_id: string;
  tg_user_id: string;
  prompt: string;
}

/**
 * Atomically claim every schedule due now: advance next_run_at to its NEXT
 * occurrence (per schedule_kind) and stamp last_run_at, RETURNING the claimed
 * rows. The guarded
 * `UPDATE … WHERE enabled = true AND next_run_at <= now() RETURNING` IS the
 * double-fire guard — a second tick can't re-claim a row whose next_run_at this
 * statement already pushed into the future. Returns [] when nothing is due.
 *
 * next_run_at ADVANCE per kind (0035 named/kind-aware schedules):
 *   'interval' → next_run_at + interval_minutes (unchanged from 0034).
 *   'daily'    → the next Europe/Moscow wall-clock `at_time` STRICTLY after now().
 *   'weekly'   → the next Europe/Moscow `weekday`@`at_time` STRICTLY after now()
 *                (weekday 0=Sun..6=Sat — matches EXTRACT(DOW)).
 *
 * The next-occurrence math is pure SQL inside the SAME guarded UPDATE, so the
 * atomic "claim advances next_run_at" property is never lost (no read-then-write
 * window). All timezone arithmetic is anchored to Europe/Moscow, matching
 * getOrResetDailyBucket's daily-reset tz so a "09:00 daily" run and the budget
 * day boundary agree.
 *
 * EXISTS(active agent) gate + the enqueue-a-normal-run path (scheduler.ts) are
 * unchanged → budget guards / settleRun / BYOK-zero all still apply. No billing.
 */
export async function claimDueSchedules(): Promise<DueSchedule[]> {
  const rows = (await sql`
    UPDATE agent_schedules s
       SET last_run_at = now(),
           next_run_at = CASE s.schedule_kind
             -- interval: simple add, exactly as 0034.
             WHEN 'interval' THEN
               s.next_run_at + (s.interval_minutes * INTERVAL '1 minute')

             -- daily: the next Europe/Moscow date carrying at_time that is > now().
             -- 1. now_local = now() as a Moscow wall-clock timestamp (no tz).
             -- 2. candidate = today_local@at_time; if already passed, +1 day.
             -- 3. re-anchor the local wall-clock back to a real timestamptz.
             WHEN 'daily' THEN
               (
                 (
                   ((now() AT TIME ZONE 'Europe/Moscow')::date
                     + s.at_time)
                   + CASE
                       WHEN ((now() AT TIME ZONE 'Europe/Moscow')::date + s.at_time)
                              > (now() AT TIME ZONE 'Europe/Moscow')
                       THEN INTERVAL '0 day'
                       ELSE INTERVAL '1 day'
                     END
                 ) AT TIME ZONE 'Europe/Moscow'
               )

             -- weekly: next matching weekday@at_time (Moscow) strictly after now().
             -- delta = (weekday - dow + 7) % 7; if delta=0 and time already passed
             -- today, roll a full week (+7). dow/weekday: 0=Sun..6=Sat.
             WHEN 'weekly' THEN
               (
                 (
                   ((now() AT TIME ZONE 'Europe/Moscow')::date
                     + s.at_time)
                   + (
                     (
                       ((s.weekday
                         - EXTRACT(DOW FROM (now() AT TIME ZONE 'Europe/Moscow'))::int
                         + 7) % 7)
                       + CASE
                           WHEN ((s.weekday
                                  - EXTRACT(DOW FROM (now() AT TIME ZONE 'Europe/Moscow'))::int
                                  + 7) % 7) = 0
                             AND ((now() AT TIME ZONE 'Europe/Moscow')::date + s.at_time)
                                  <= (now() AT TIME ZONE 'Europe/Moscow')
                           THEN 7
                           ELSE 0
                         END
                     ) * INTERVAL '1 day'
                   )
                 ) AT TIME ZONE 'Europe/Moscow'
               )

             -- Unknown kind: push 1h so a bad row can't hot-loop the tick.
             ELSE s.next_run_at + INTERVAL '1 hour'
           END
     WHERE s.enabled = true
       AND s.next_run_at <= now()
       -- Only fire for a LIVE agent. The app convention is SOFT-delete
       -- (status='deleted'); the FK CASCADE only fires on a hard delete, so without
       -- this gate a soft-deleted agent's schedule would keep spending the owner's
       -- credits on an agent they believe is gone. The manual /run route already
       -- requires status='active' — the scheduled path must match it.
       AND EXISTS (
         SELECT 1 FROM agents a
          WHERE a.id = s.agent_id AND a.status = 'active'
       )
     RETURNING s.id::text, s.agent_id::text, s.tg_user_id::text, s.prompt
  `) as unknown as DueSchedule[];
  return rows;
}

/**
 * Insert a pending agent_runs row for a scheduled fire — the SAME shape the TMA
 * /run route inserts, so the worker's runAgent() path (budget guard + settleRun
 * + BYOK-zero rule) applies identically. Returns the new run id, or null if the
 * agent vanished (FK gone) — caller skips, never crashes the tick.
 */
export async function insertScheduledRun(
  agentId: string,
  tgUserId: string,
  input: string,
): Promise<string | null> {
  const rows = (await sql`
    INSERT INTO agent_runs (agent_id, tg_user_id, input, status)
    VALUES (${agentId}::uuid, ${tgUserId}::bigint, ${input.slice(0, 16000)}, 'pending')
    RETURNING id::text
  `) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
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
  costCredits: number,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  await sql`
    UPDATE agent_runs
    SET status = 'completed',
        output = ${output},
        cost_credits = ${costCredits},
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
// D-1: tg_user_balances.balance_credits IS the live spendable balance, in
// integer US cents (1 credit = $0.01). The topup-check route credits it
// (`INSERT … ON CONFLICT DO UPDATE SET balance_credits = balance + EXCLUDED`,
// migration 0029) and the wallet route reads it. `tg_users` is NOT the balance
// table in this repo — debit tg_user_balances.

/**
 * Live spendable balance (credits = US cents) for a tg_user. Returns 0 when no
 * row exists (no row ⇒ never topped up ⇒ zero balance), never null/throws.
 */
export async function getBalance(tgUserId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(balance_credits, 0)::text AS balance_credits
    FROM tg_user_balances
    WHERE tg_user_id = ${tgUserId}::bigint
    LIMIT 1
  `) as unknown as Array<{ balance_credits: string }>;
  return Number(rows[0]?.balance_credits ?? 0);
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
 * External (user-supplied upstream) runs cost us 0 credits → skip the daily-spend
 * guard, the balance debit, and the ledger entry (only the run row is marked
 * completed).
 *
 * D-1: the append-only `tg_ledger_entries` row (the immutable audit truth) is
 * written INSIDE this same `sql.begin`, right after the guarded debit, using the
 * debit's `RETURNING balance_credits` as `balance_after`. Cached balance and
 * ledger can therefore never diverge — they commit or roll back together. The
 * UNIQUE (ref_kind, ref_id, kind) index makes a settle retry idempotent.
 */
export async function settleRun(args: {
  runId: string;
  tgUserId: string;
  agentId: string;
  output: string;
  costCredits: number;
  tokensIn: number;
  tokensOut: number;
  isExternal: boolean;
}): Promise<void> {
  const { runId, tgUserId, agentId, output, costCredits, tokensIn, tokensOut, isExternal } = args;
  // Plain sql.begin → READ COMMITTED (the chosen approach). Use the
  // callback-scoped `sql`, not the module-level one, so queries stay in-tx.
  await sql.begin(async (sql) => {
    await sql`
      UPDATE agent_runs
      SET status = 'completed',
          output = ${output},
          cost_credits = ${costCredits},
          tokens_in = ${tokensIn},
          tokens_out = ${tokensOut},
          completed_at = NOW()
      WHERE id = ${runId}::uuid
    `;

    if (isExternal) return; // user pays their own provider — nothing to debit

    // R0-3: atomic guarded daily-spend increment (kills the 4× TOCTOU).
    const daily = (await sql`
      UPDATE agents
      SET spent_today_credits = spent_today_credits + ${costCredits}
      WHERE id = ${agentId}::uuid
        AND spent_today_credits + ${costCredits} <= daily_budget_credits
      RETURNING id::text
    `) as unknown as Array<{ id: string }>;
    if (daily.length === 0) throw new Error('budget_exceeded_daily_settle');

    // R0-2: guarded balance debit on the live spendable balance (integer cents).
    const debit = (await sql`
      UPDATE tg_user_balances
      SET balance_credits = balance_credits - ${costCredits},
          updated_at = NOW()
      WHERE tg_user_id = ${tgUserId}::bigint
        AND balance_credits >= ${costCredits}
      RETURNING balance_credits::text
    `) as unknown as Array<{ balance_credits: string }>;
    if (debit.length === 0) throw new InsufficientBalanceError();

    // D-1: append-only ledger entry (run debit) in the SAME tx. delta is the
    // negative of the cost; balance_after is the just-debited cached balance.
    // ON CONFLICT DO NOTHING absorbs an idempotent settle retry (uq_ledger_ref).
    const balanceAfter = debit[0]!.balance_credits;
    await sql`
      INSERT INTO tg_ledger_entries
        (tg_user_id, delta_credits, kind, ref_kind, ref_id, balance_after)
      VALUES
        (${tgUserId}::bigint, ${-costCredits}, 'run_debit', 'agent_run',
         ${runId}::uuid, ${balanceAfter}::bigint)
      ON CONFLICT (ref_kind, ref_id, kind) WHERE ref_id IS NOT NULL DO NOTHING
    `;
  });
}
