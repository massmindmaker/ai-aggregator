-- 0051_reset_fake_clone_counts.sql
-- Issue #34 (R2 sort=trending honesty): agent_templates.clone_count was manually seeded
-- with drawn-up numbers on prod (Leya=3, Grisha=2 observed) while the real create-count
-- was 0. That column silently drives the "trending" sort on THREE surfaces —
-- dashboard/page.tsx, the "Нанять" tab in agents/page.tsx, and the default sort on
-- /market (apps/tg-miniapp/app/api/tma/templates/route.ts:65, ORDER BY t.clone_count
-- DESC) — so fake numbers were secretly ordering the catalog even after the visible
-- counter was removed from the cards.
--
-- The increment IS honest: both the old …/clone route and its …/create replacement
-- (0031_agent_templates.sql:33 clone_count; apps/tg-miniapp/app/api/tma/templates/[id]/
-- create/route.ts:91 and the removed …/clone/route.ts) stamp the created agent's
-- agents.template_kind = 'tpl:<template-id>' (0018_agents.sql:7, VARCHAR(40); "tpl:" +
-- a UUID is exactly 40 chars, so it is never truncated) in the SAME transaction that
-- bumps clone_count. That column is therefore a real, queryable provenance link — this
-- migration recomputes clone_count from it instead of blind-zeroing, so any template
-- that genuinely was used to create an agent keeps its real count.
--
-- Known gap (documented, not fixed here): agents can be HARD-deleted (DELETE FROM
-- agents, apps/tg-miniapp/app/api/tma/agents/[id]/route.ts:484) and there is no
-- decrement on delete — so a template used to create an agent that was later deleted
-- will undercount by that much after this recompute. That is strictly more honest than
-- the current seeded numbers (which do not correspond to any create event at all, past
-- or present), and matches the increment's own semantics: clone_count counts creations
-- ever made, not agents currently alive. No further correction is possible without a
-- separate immutable creation-event log, which does not exist.
--
-- Apply on prod manually (the app `aiag` role cannot ALTER/UPDATE across tables like
-- this without the right grants — packages/database/CLAUDE.md):
--   sudo -u postgres psql aiag -f 0051_reset_fake_clone_counts.sql
--
-- Scope: ONLY agent_templates.clone_count. No other column, table, or constraint touched.
--
-- Idempotency: recompute-to-an-absolute-value is naturally idempotent — re-running
-- writes the same COUNT(*) again. A second run changes 0 rows' worth of *meaning* even
-- though the UPDATE still executes (no rows are skipped by a guard; the assigned value
-- is simply already correct).

UPDATE agent_templates t
SET clone_count = COALESCE(
  (SELECT COUNT(*) FROM agents a WHERE a.template_kind = 'tpl:' || t.id::text),
  0
);
