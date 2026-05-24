-- Switch semantic embedding column from 1536-dim (OpenAI text-embedding-3-small)
-- to 384-dim (fastembed BGESmallENV15 — the local in-process embedder default).
--
-- The agent now defaults to a local fastembed embedder (`createFastEmbedEmbedder`)
-- so it no longer requires an external /v1/embeddings API key. The OpenAI-compatible
-- embedder is still wired as a fallback when EMBEDDER_API_KEY is set.
--
-- Index must be dropped + recreated for the new vector size — ivfflat indexes
-- are bound to the column's vector dimension.
--
-- Tables are empty on the only deployed tenant (demo1505) so the `USING NULL`
-- recast is safe. If a future tenant migrates from OpenAI to fastembed with
-- existing rows, that's a separate data migration (re-embed all facts) — not
-- covered here.
--
-- Source migration 0002_semantic.sql has ALSO been edited in-place to declare
-- vector(384) from the start, so this migration is a no-op for new tenants.

DROP INDEX IF EXISTS agent_research_semantic.facts_embedding_cosine_idx;

ALTER TABLE agent_research_semantic.facts
  ALTER COLUMN embedding TYPE vector(384) USING NULL;

CREATE INDEX facts_embedding_cosine_idx
  ON agent_research_semantic.facts
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
