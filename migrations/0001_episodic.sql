-- Per-agent episodic memory.
-- Replace `__AGENT_SCHEMA__` with the agent's schema (e.g. agent_research_episodic).

CREATE SCHEMA IF NOT EXISTS agent_research_episodic;

CREATE TABLE agent_research_episodic.entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  path            TEXT NOT NULL,
  content         TEXT NOT NULL,
  conversation_id TEXT,
  skill_id        TEXT,
  turn_index      INT,
  role            TEXT CHECK (role IN ('user','assistant','tool')),
  tool_name       TEXT,
  span_id         TEXT,
  tokens_in       INT NOT NULL DEFAULT 0,
  tokens_out      INT NOT NULL DEFAULT 0,
  cost_gbp        NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, path)
);

CREATE INDEX entries_tenant_conv_idx ON agent_research_episodic.entries (tenant_id, conversation_id, turn_index);
CREATE INDEX entries_tenant_skill_created_idx ON agent_research_episodic.entries (tenant_id, skill_id, created_at DESC);
