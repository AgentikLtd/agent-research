-- Durable idempotency dedup for the synchronous `skills.invoke` path (E2.4b).
--
-- The hub's capability bridge calls skills.invoke with a stable
-- params.idempotencyKey = "${runId}:${nodeId}". A repeated call with the same
-- key (rare duplicate delivery) must return the FIRST call's saved result
-- instead of re-running a (possibly paid) skill. This table is the durable
-- backup lock — it survives process restarts, unlike the module-level
-- `inFlight` Set used by the async path (which is out of scope here).
--
-- Forward-only. Applied MANUALLY out-of-band (no migration runner in this
-- repo) — an operator apply-step, same as 0001-0004.

CREATE SCHEMA IF NOT EXISTS agent_research_idempotency;

CREATE TABLE IF NOT EXISTS agent_research_idempotency.completed_results (
  tenant_id        TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  skill            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done')),
  result           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS completed_results_expires_idx
  ON agent_research_idempotency.completed_results (expires_at);
