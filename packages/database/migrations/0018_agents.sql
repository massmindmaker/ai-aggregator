-- Phase 15 / Wave 03 — agents + agent_runs
-- TMA agents CRUD. Run execution is stub here (Wave 04 wires real worker).

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_user_id BIGINT NOT NULL,
  template_kind VARCHAR(40) NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_slug TEXT,
  budget_rub_monthly NUMERIC(12,2) DEFAULT 1000 NOT NULL,
  status VARCHAR(20) DEFAULT 'active' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_tg_user ON agents(tg_user_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tg_user_id BIGINT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  status VARCHAR(20) DEFAULT 'pending' NOT NULL,
  cost_rub NUMERIC(10,4) DEFAULT 0 NOT NULL,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
