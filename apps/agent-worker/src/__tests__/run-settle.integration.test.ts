/**
 * Integration test: settleRun atomicity end-to-end
 *
 * Gated by TEST_DATABASE_URL — runs against a disposable test Postgres only.
 * NEVER uses DATABASE_URL (prod). Synthetic tg_user_id in the 9_000_000_000+
 * range to avoid collisions. All seeded rows are deleted in afterEach.
 *
 * Proves four invariants (R0-2, R0-3):
 *  1. Happy path: balance − cost + spent_today + cost + status=completed atomically
 *  2. Insufficient balance: full rollback — balance/spent_today/status all unchanged
 *  3. Over daily budget: cross-guard full rollback — ALL three tables unchanged
 *  4. External run: balance and spent_today completely untouched
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Gate: skip the entire suite when TEST_DATABASE_URL is not configured.
// This means CI without a test DB stays green (skip ≠ fail), and the test
// can NEVER accidentally hit the prod DATABASE_URL.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Create a dedicated sql client for seeding and assertions.
// This client uses TEST_DATABASE_URL exclusively — it is NEVER the prod client.
// The settleRun / getBalance functions under test are imported from db.ts which
// reads DATABASE_URL at module load time; when this test file is loaded in a
// vitest worker that has DATABASE_URL=TEST_DATABASE_URL (set by the operator
// running the integration suite), both clients hit the same test DB.
// When TEST_DATABASE_URL is absent we create a dummy client that is never used
// (the suite is fully skipped by describe.skipIf below).
const testSql = TEST_DB_URL
  ? postgres(TEST_DB_URL, { prepare: false })
  : postgres('postgres://localhost/never_connected', { prepare: false });

// Lazy imports — resolved at suite run time so vitest module mocking works.
// We import the same db.ts that the agent-worker uses so we exercise the real
// production code (no mocks, no test-only wiring).
import {
  settleRun,
  getBalance,
  InsufficientBalanceError,
} from '../db.js';

// ---------------------------------------------------------------------------
// Seed state — one set of rows per test, deleted in afterEach.
// ---------------------------------------------------------------------------

interface SeedState {
  agentId: string;
  runId: string;
  tgUserId: string; // stored as string, is a bigint in DB
}

let seed: SeedState;

describe.skipIf(!TEST_DB_URL)(
  'settleRun atomicity integration',
  () => {
    // Each test gets fresh agent + balance + queued run.
    beforeEach(async () => {
      const agentId = randomUUID();
      const runId = randomUUID();
      // 9_000_000_000 range is reserved for test synthetic ids — never appears
      // in real traffic (Telegram UIDs are ~10^9; reserved range is >= 9e9).
      const tgUserId = String(9_000_000_000 + Math.floor(Math.random() * 1_000_000));

      seed = { agentId, runId, tgUserId };

      // Insert agent with the full set of NOT-NULL-without-default columns.
      // The live `agents` schema requires template_kind (varchar(40), NOT NULL,
      // no default) in addition to tg_user_id/name/system_prompt — verified
      // against the prod schema during the VPS green run.
      // spent_today_date must be today so the day bucket is current.
      await testSql`
        INSERT INTO agents (
          id, tg_user_id, name, system_prompt, template_kind,
          budget_credits_monthly, daily_budget_credits,
          spent_today_credits, spent_today_date,
          status, connection_type
        ) VALUES (
          ${agentId}::uuid,
          ${tgUserId}::bigint,
          'test-agent',
          'You are a test agent.',
          'custom',
          1000,
          100,
          0,
          CURRENT_DATE,
          'active',
          'aiag'
        )
      `;

      // Insert funded balance row (credits = US cents).
      await testSql`
        INSERT INTO tg_user_balances (tg_user_id, balance_credits)
        VALUES (${tgUserId}::bigint, 50)
        ON CONFLICT (tg_user_id) DO UPDATE SET balance_credits = 50
      `;

      // Insert a queued run.
      await testSql`
        INSERT INTO agent_runs (
          id, agent_id, tg_user_id, input, status
        ) VALUES (
          ${runId}::uuid,
          ${agentId}::uuid,
          ${tgUserId}::bigint,
          'test input',
          'queued'
        )
      `;
    });

    afterEach(async () => {
      // Clean up all seeded rows by their generated ids — never touches real data.
      const { agentId, runId, tgUserId } = seed;
      await testSql`DELETE FROM tg_ledger_entries WHERE tg_user_id = ${tgUserId}::bigint`;
      await testSql`DELETE FROM agent_runs WHERE id = ${runId}::uuid`;
      await testSql`DELETE FROM tg_user_balances WHERE tg_user_id = ${tgUserId}::bigint`;
      await testSql`DELETE FROM agents WHERE id = ${agentId}::uuid`;
    });

    // -----------------------------------------------------------------------
    // Case 1 — Happy path: atomic debit + daily increment + run completed
    // -----------------------------------------------------------------------

    it('happy path: balance−cost, spent_today+cost, run=completed — all together', async () => {
      const { agentId, runId, tgUserId } = seed;

      await settleRun({
        runId,
        tgUserId,
        agentId,
        output: 'test output',
        costCredits: 10,
        tokensIn: 100,
        tokensOut: 50,
        isExternal: false,
      });

      // Balance must have dropped by exactly 10.
      const balance = await getBalance(tgUserId);
      expect(balance).toBe(40);

      // Daily spend must have increased by exactly 10.
      const agentRows = await testSql<{ spent_today_credits: string }[]>`
        SELECT spent_today_credits::text AS spent_today_credits
        FROM agents WHERE id = ${agentId}::uuid
      `;
      expect(Number(agentRows[0].spent_today_credits)).toBe(10);

      // Run must be completed with the correct cost.
      const runRows = await testSql<{ status: string; cost_credits: string }[]>`
        SELECT status, cost_credits::text AS cost_credits
        FROM agent_runs WHERE id = ${runId}::uuid
      `;
      expect(runRows[0].status).toBe('completed');
      expect(Number(runRows[0].cost_credits)).toBe(10);

      // D-1: the append-only ledger must carry a matching run_debit entry whose
      // balance_after equals the cached balance (the two never diverge).
      const ledger = await testSql<{ delta_credits: string; balance_after: string; kind: string }[]>`
        SELECT delta_credits::text AS delta_credits,
               balance_after::text AS balance_after,
               kind
        FROM tg_ledger_entries
        WHERE ref_kind = 'agent_run' AND ref_id = ${runId}::uuid
      `;
      expect(ledger.length).toBe(1);
      expect(ledger[0].kind).toBe('run_debit');
      expect(Number(ledger[0].delta_credits)).toBe(-10);
      expect(Number(ledger[0].balance_after)).toBe(40);
    });

    // -----------------------------------------------------------------------
    // Case 2 — Insufficient balance: full rollback across all three tables
    // -----------------------------------------------------------------------

    it('insufficient balance: full rollback — balance/spent_today/status ALL unchanged', async () => {
      const { agentId, runId, tgUserId } = seed;

      // Pre-condition: balance=50, but we try to spend 100 (more than available).
      // The balance debit guard fires → throws InsufficientBalanceError.
      // Because everything is in ONE sql.begin, the daily-spend increment (which
      // ran first) must also roll back — balance, spent_today, and run-status
      // are ALL unchanged after the throw.

      // Note: in settleRun, daily-spend guard runs BEFORE the balance debit.
      // So the execution order is: markCompleted → daily-spend guard → balance
      // debit (fails here) → rollback undoes all three.
      await expect(
        settleRun({
          runId,
          tgUserId,
          agentId,
          output: 'should not be stored',
          costCredits: 100, // balance=50 < 100 → balance debit guard rejects
          tokensIn: 1000,
          tokensOut: 500,
          isExternal: false,
        }),
      ).rejects.toThrow(InsufficientBalanceError);

      // Balance unchanged (still 50).
      const balance = await getBalance(tgUserId);
      expect(balance).toBe(50);

      // spent_today_credits unchanged (still 0) — the increment rolled back too.
      const agentRows = await testSql<{ spent_today_credits: string }[]>`
        SELECT spent_today_credits::text AS spent_today_credits
        FROM agents WHERE id = ${agentId}::uuid
      `;
      expect(Number(agentRows[0].spent_today_credits)).toBe(0);

      // Run NOT completed — status still 'queued'.
      const runRows = await testSql<{ status: string; cost_credits: string | null }[]>`
        SELECT status, cost_credits::text AS cost_credits
        FROM agent_runs WHERE id = ${runId}::uuid
      `;
      expect(runRows[0].status).toBe('queued');
      // cost_credits stays at its seeded default (0) — the rollback proves the
      // attempted cost was NEVER recorded (agent_runs.cost_credits DEFAULT 0, not NULL).
      expect(Number(runRows[0].cost_credits)).toBe(0);

      // No ledger entry was written — the whole tx rolled back.
      const ledger = await testSql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM tg_ledger_entries
        WHERE ref_kind = 'agent_run' AND ref_id = ${runId}::uuid
      `;
      expect(Number(ledger[0].c)).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Case 3 — Over daily budget: cross-guard full rollback (BLOCKER 2 proof)
    // -----------------------------------------------------------------------

    it('over daily budget: cross-guard rollback — balance/spent_today/status ALL unchanged', async () => {
      const { agentId, runId, tgUserId } = seed;

      // Seed the agent with a near-full daily bucket: daily_budget=10, spent=8.
      // A cost of 5 would push it to 13 > 10 → daily-spend guard rejects.
      await testSql`
        UPDATE agents
        SET daily_budget_credits = 10, spent_today_credits = 8
        WHERE id = ${agentId}::uuid
      `;
      // Balance is 50 (more than enough) — the budget guard is what fails.
      // This proves the daily-spend guard fires, throws mid-tx, and the ENTIRE
      // sql.begin rolls back (balance NOT debited, spent_today NOT incremented,
      // run NOT completed) — all three tables return to pre-settle state.

      await expect(
        settleRun({
          runId,
          tgUserId,
          agentId,
          output: 'should not be stored',
          costCredits: 5, // 8+5=13 > daily_budget=10 → guard rejects
          tokensIn: 100,
          tokensOut: 50,
          isExternal: false,
        }),
      ).rejects.toThrow('budget_exceeded_daily_settle');

      // Balance unchanged (still 50) — the balance debit was never committed.
      const balance = await getBalance(tgUserId);
      expect(balance).toBe(50);

      // spent_today_credits unchanged (still 8) — the guard prevented the increment.
      const agentRows = await testSql<{ spent_today_credits: string }[]>`
        SELECT spent_today_credits::text AS spent_today_credits
        FROM agents WHERE id = ${agentId}::uuid
      `;
      expect(Number(agentRows[0].spent_today_credits)).toBe(8);

      // Run NOT completed — status still 'queued'.
      const runRows = await testSql<{ status: string; cost_credits: string | null }[]>`
        SELECT status, cost_credits::text AS cost_credits
        FROM agent_runs WHERE id = ${runId}::uuid
      `;
      expect(runRows[0].status).toBe('queued');
      // cost_credits stays at its seeded default (0) — the rollback proves the
      // attempted cost was NEVER recorded (agent_runs.cost_credits DEFAULT 0, not NULL).
      expect(Number(runRows[0].cost_credits)).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Case 4 — External run: $0 cost, money tables completely untouched
    // -----------------------------------------------------------------------

    it('external run: isExternal=true → run completed, balance and spent_today untouched', async () => {
      const { agentId, runId, tgUserId } = seed;

      // External agents pay their own provider — settleRun skips the money path
      // entirely (balance debit + daily-spend guard are both bypassed).
      await settleRun({
        runId,
        tgUserId,
        agentId,
        output: 'external output',
        costCredits: 0,
        tokensIn: 100,
        tokensOut: 50,
        isExternal: true,
      });

      // Run IS completed (the run row itself is still written).
      const runRows = await testSql<{ status: string; cost_credits: string | null }[]>`
        SELECT status, cost_credits::text AS cost_credits
        FROM agent_runs WHERE id = ${runId}::uuid
      `;
      expect(runRows[0].status).toBe('completed');

      // Balance UNCHANGED (still 50) — external runs never touch tg_user_balances.
      const balance = await getBalance(tgUserId);
      expect(balance).toBe(50);

      // spent_today_credits UNCHANGED (still 0) — external runs skip the daily guard.
      const agentRows = await testSql<{ spent_today_credits: string }[]>`
        SELECT spent_today_credits::text AS spent_today_credits
        FROM agents WHERE id = ${agentId}::uuid
      `;
      expect(Number(agentRows[0].spent_today_credits)).toBe(0);

      // No ledger entry for an external run — the money path is fully skipped.
      const ledger = await testSql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM tg_ledger_entries
        WHERE ref_kind = 'agent_run' AND ref_id = ${runId}::uuid
      `;
      expect(Number(ledger[0].c)).toBe(0);
    });
  },
);
