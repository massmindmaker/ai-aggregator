---
phase: 14-contest-marketplace-admin
plan: 07
type: execute
wave: 3
depends_on: [14-02, 14-03, 14-04, 14-05, 14-06]
files_modified: []
autonomous: false
requirements:
  - REQ-CONTEST-001
  - REQ-CONTEST-002
  - REQ-CONTEST-003
  - REQ-CONTEST-005
  - REQ-PAYOUT-001
  - REQ-PAYOUT-002
  - REQ-PAYOUT-003
  - REQ-PAYOUT-004
  - REQ-KYC-001
  - REQ-KYC-002
  - REQ-KYC-003
tags: [phase14, deploy, smoke, vps, ssh]
must_haves:
  truths:
    - "Migration 0014 successfully applied on VPS Postgres (idempotent — re-running is no-op)"
    - "GitHub Actions deploy succeeded with apps=web,gateway,worker (worker needed for new crons)"
    - "All four new admin pages return HTTP 200 (or 302 redirect to login when unauth)"
    - "Gateway returns 503 + Retry-After when calling a frozen model"
  artifacts:
    - path: .planning/phases/14-contest-marketplace-admin/14-07-SUMMARY.md
      provides: "Deploy log + smoke results + manual test transcript"
      min_lines: 40
  key_links:
    - from: VPS Postgres
      to: 0014_contest_marketplace.sql
      via: "psql -f migration via SSH tunnel"
      pattern: "ALTER TABLE.*kyc_status"
    - from: prod web (ai-aggregator.ru)
      to: /admin/kyc-queue + /admin/payouts
      via: "HTTPS GET with admin session"
      pattern: "200 OK"
---

<objective>
Apply migration 0014 to production VPS Postgres, deploy web + gateway + worker via GitHub Actions, run smoke verification on the four new admin endpoints + gateway 503 path. This is a manual-checkpoint plan — the user runs the SSH/gh commands.

Purpose: Plans 14-01..14-06 produced files only; nothing is live until applied + deployed + verified. This plan closes the loop.
Output: 14-07-SUMMARY.md with command transcripts + curl results + any DB row counts (e.g., `SELECT COUNT(*) FROM kyc_documents`).
</objective>

<execution_context>
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/workflows/execute-plan.md
@C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/14-contest-marketplace-admin/14-01-SUMMARY.md
@.planning/phases/14-contest-marketplace-admin/14-02-SUMMARY.md
@.planning/phases/14-contest-marketplace-admin/14-03-SUMMARY.md
@.planning/phases/14-contest-marketplace-admin/14-04-SUMMARY.md
@.planning/phases/14-contest-marketplace-admin/14-05-SUMMARY.md
@.planning/phases/14-contest-marketplace-admin/14-06-SUMMARY.md
@docs/superpowers/specs/2026-05-08-phase14-contest-marketplace-workflow-design.md
</context>

<tasks>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 1: Apply migration 0014 to VPS Postgres via SSH tunnel</name>

  <what-built>
    Plans 14-01..14-06 produced `packages/database/migrations/0014_contest_marketplace.sql` (idempotent) and code changes. Production VPS Postgres has not yet seen the new schema.
  </what-built>

  <how-to-verify>
    User runs (from local machine, requires `aiag-vps` SSH alias):

    1. **Open SSH tunnel to VPS Postgres** (in a separate terminal, leave running):
       ```
       ssh -L 5433:127.0.0.1:5432 aiag-vps
       ```

    2. **Apply migration via tunnel** (in another terminal):
       ```
       psql -h 127.0.0.1 -p 5433 -U aiag -d aiag -f packages/database/migrations/0014_contest_marketplace.sql
       ```
       Expected output: a series of `ALTER TABLE`, `CREATE TABLE`, `CREATE INDEX`, `CREATE FUNCTION` notices, no errors.

    3. **Verify idempotency** by re-running the same psql command. Expected: zero errors, all DDLs are no-ops (NOTICE: relation already exists).

    4. **Verify schema** with these probe queries — paste output into the SUMMARY:
       ```sql
       SELECT column_name FROM information_schema.columns
       WHERE table_name='users' AND column_name IN ('kyc_status','kyc_type','bank_details','dob','tax_id');
       -- Expected: 5 rows

       SELECT column_name FROM information_schema.columns
       WHERE table_name='models' AND column_name IN ('author_user_id','status','hosting_strategy','derived_from_contest_id');
       -- Expected: 4 rows

       SELECT to_regclass('kyc_documents'), to_regclass('prize_awards');
       -- Expected: both NOT NULL

       SELECT current_tier_pct(NULL);
       -- Expected: 0.70 (function exists; NULL user → no earnings → tier 1)

       SELECT proname FROM pg_proc WHERE proname='aiag_settle_charge';
       -- Expected: 1 row (function exists, replaced by 0014)
       ```

    5. Reply with full psql output transcript or paste-back of probe query results.
  </how-to-verify>

  <resume-signal>Type "migration applied" with the probe query output, or describe any errors.</resume-signal>
</task>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 2: Trigger GitHub Actions production deploy (web + gateway + worker)</name>

  <what-built>
    Worker now hosts two new crons (closeContestsCron, finalizeEarningsCron). Web has 4 new admin pages + 7 new API routes. Gateway has new model-status-check middleware.
  </what-built>

  <how-to-verify>
    1. **Trigger deploy** from local terminal (requires `gh` CLI authenticated):
       ```
       gh workflow run deploy-production.yml -f ref=master -f apps=web,gateway,worker
       ```

    2. **Watch the run**:
       ```
       gh run list --workflow=deploy-production.yml --limit 1
       gh run watch <run-id>
       ```

    3. **Verify pm2 picked up new release on VPS**:
       ```
       ssh aiag-vps "pm2 list | head -20 &amp;&amp; ls -la /srv/aiag/web/current /srv/aiag/gateway/current /srv/aiag/worker/current"
       ```
       Expected: `current` symlinks point to new release dir matching the deployed commit SHA.

    4. **Verify worker logs show both crons started**:
       ```
       ssh aiag-vps "pm2 logs aiag-worker --lines 50 --nostream | grep -E 'close-contests-cron|finalize-earnings-cron'"
       ```
       Expected: at least one log line per cron with `tick` event scheduled or `worker started`.

    5. Paste the deploy run URL and pm2 status output into the SUMMARY.
  </how-to-verify>

  <resume-signal>Type "deploy ok" with the GH run URL, or describe failures.</resume-signal>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: Smoke test all four admin pages on production</name>

  <what-built>
    /admin/contests/[slug] (publish modal), /admin/payouts (extended), /admin/kyc-queue (new), /admin/models/[slug]/edit (freeze/depublish).
  </what-built>

  <how-to-verify>
    Sign in as admin at https://ai-aggregator.ru/login, then visit each:

    1. **`/admin/contests/[any-slug]`**
       - Page loads (200).
       - Submissions table shows rows (or empty state).
       - For any submission row with rank ≤ 3: click "Опубликовать" → modal opens with 6 fields visible (slug, name, description, hosting_strategy radio×3, cost_rub_override, tags).
       - Cancel modal (do not submit yet — leave for end-to-end test in next milestone).

    2. **`/admin/payouts`** (default `?status=requested`)
       - Page loads (200), shows 4 KPI cards.
       - Filter: change `?status=paid` URL → page reloads with paid rows.
       - If pending row exists: per-row "Approve" / "Reject" buttons visible. Do NOT click — state-mutating, defer.

    3. **`/admin/kyc-queue`**
       - Sidebar nav shows "KYC очередь" link (verify in admin layout).
       - Page loads (200), shows 3 KPI cards (Pending / Approved 7d / Rejected 7d).
       - If no pending docs: empty state «Очередь пуста» renders.

    4. **`/admin/models/[any-slug]/edit`**
       - Page loads (200), shows status badge + Freeze + Depublish buttons.
       - Buttons disabled or styled correctly per current model status.

    5. **Gateway 503 path** — pick any model with `status='live'` (use psql probe from Task 1):
       ```
       psql -h 127.0.0.1 -p 5433 -U aiag -d aiag -c "UPDATE models SET status='frozen', frozen_reason='smoke test' WHERE slug='&lt;test-slug&gt;' RETURNING slug, status"
       ```
       Then curl gateway:
       ```
       curl -i -X POST https://api.ai-aggregator.ru/v1/chat/completions \
         -H 'authorization: Bearer sk_aiag_test_key' \
         -H 'content-type: application/json' \
         -d '{"model":"&lt;test-slug&gt;","messages":[{"role":"user","content":"hi"}]}'
       ```
       Expected: HTTP 503 + header `Retry-After: 3600` + body `{"error":"MODEL_UNAVAILABLE","status":"frozen",...}`.

       Restore model:
       ```
       psql -h 127.0.0.1 -p 5433 -U aiag -d aiag -c "UPDATE models SET status='live', frozen_reason=NULL WHERE slug='&lt;test-slug&gt;'"
       ```
       (No cache — next request to gateway sees the new status immediately. Per B-3 fix: middleware does fresh per-request DB lookup.)

    6. Paste curl output + screenshot path (if taken) into SUMMARY.
  </how-to-verify>

  <resume-signal>Type "smoke ok" with curl output + any anomalies, or describe issues.</resume-signal>
</task>

<task type="auto">
  <name>Task 4: Write 14-07-SUMMARY.md with full deploy transcript</name>
  <files>.planning/phases/14-contest-marketplace-admin/14-07-SUMMARY.md</files>

  <read_first>
    - All previous task outputs in this plan (migration probes, gh run URL, curl results).
    - `C:/Users/боб/.claude/plugins/cache/gsd-plugin/gsd/2.38.7/templates/summary.md` for SUMMARY structure.
  </read_first>

  <action>
Compose `.planning/phases/14-contest-marketplace-admin/14-07-SUMMARY.md` with sections:

1. **Migration applied** — psql command transcript + probe query results.
2. **Deploy** — gh run URL + pm2 status + cron startup log lines.
3. **Smoke results** — per-page result + curl transcript for 503 path.
4. **Open TODOs** (carry-forward to Phase 14b):
   - Author-side flows: /me/contest-wins/[id]/publish, /me/kyc, /me/earnings/payout, /dashboard/earnings extended.
   - Real bank transfer (СБП API).
   - Tax act PDF generator (`tax_act_storage_key` currently NULL).
   - ФНС «Мой налог» integration (chek auto-generation).
   - Presigned URL endpoint for `/api/admin/kyc/[id]/file`.
   - Gateway model-status-check: consider opt-in caching with explicit invalidation if DB load becomes an issue (currently fresh per-request lookup).
   - libsodium application-level encryption for `users.bank_details` (currently raw jsonb).
5. **REQ-IDs covered:** list each requirement ID and where it's implemented.
6. **Phase status update:** mark Phase 14 admin half complete in ROADMAP.md (separate task — note this).

Update `.planning/ROADMAP.md` Phase 14 entry: change Status from `○ DESIGN-READY` to `◆ ADMIN HALF COMPLETE — Phase 14b for author-side flows`. Update Plans count + checkbox list.

Update `.planning/STATE.md` — add Phase 14 admin half to Performance Metrics By Phase table.
  </action>

  <verify>
    <automated>test -f .planning/phases/14-contest-marketplace-admin/14-07-SUMMARY.md &amp;&amp; grep -c "Migration applied\|Deploy\|Smoke" .planning/phases/14-contest-marketplace-admin/14-07-SUMMARY.md | grep -q "[3-9]" &amp;&amp; grep -c "Phase 14" .planning/ROADMAP.md | grep -q "[2-9]"</automated>
  </verify>

  <done>
    SUMMARY.md exists with all 6 sections; ROADMAP + STATE updated.
  </done>
</task>

</tasks>

<verification>
- Migration applied successfully on VPS (idempotent re-run is no-op).
- All four admin pages return 200 on GET.
- Gateway returns 503 + Retry-After for frozen models.
- ROADMAP.md and STATE.md updated.
</verification>

<success_criteria>
1. 0014_contest_marketplace.sql applied on VPS DB `aiag` without errors.
2. GH Actions deploy of web+gateway+worker succeeded.
3. Worker pm2 logs show closeContestsCron + finalizeEarningsCron started.
4. All 4 admin endpoints return 200 with new functionality visible.
5. Gateway 503 path verified end-to-end via curl.
6. SUMMARY.md captures everything; ROADMAP + STATE reflect status change.
</success_criteria>

<output>
This is the closing plan of Phase 14 admin half. Carry-forward TODOs are documented for Phase 14b.
</output>
