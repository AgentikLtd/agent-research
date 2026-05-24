-- Per-agent semantic memory (pgvector).
-- Replace `__AGENT_SCHEMA_SEM__` with the agent's semantic schema
-- (e.g. agent_research_semantic).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS agent_research_semantic;

CREATE TABLE agent_research_semantic.facts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            TEXT NOT NULL,
  path                 TEXT NOT NULL,
  content              TEXT NOT NULL,
  topic_tags           TEXT[] NOT NULL DEFAULT '{}',
  embedding            vector(384),
  embedding_model      TEXT NOT NULL,
  relevance_score      NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (relevance_score BETWEEN 0 AND 1),
  source_episodic_ids  TEXT[] NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, path)
);

CREATE INDEX facts_tenant_relevance_idx ON agent_research_semantic.facts (tenant_id, relevance_score DESC);
CREATE INDEX facts_embedding_cosine_idx ON agent_research_semantic.facts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
