-- Heartbeat lease column for the DURABLE ASYNC idempotency claim (AB.7 /
-- ABF-B5, B6). The async `skills.invoke` path (mode:'async') now claims the
-- hub-supplied idempotencyKey ("${runId}:${nodeId}") in
-- agent_research_idempotency.completed_results BEFORE detaching the brief, and
-- extends a LEASE every ~30s while the detached brief runs.
--
-- Why a dedicated column (not the existing `expires_at`):
--   `expires_at` is the 7-day CACHE-RETENTION / prune window for COMPLETED
--   results — a post-hoc GC deadline, NOT a running-claim deadline. Overloading
--   it for the lease would either (a) evaporate a still-running claim after 7
--   days is meaningless, or (b) force the prune window to shrink to lease size.
--   `lease_expires_at` expresses the RUNNING lease independently: a `running`
--   row whose `lease_expires_at < now()` is a hard-killed brief and is
--   reclaimable via steal-CAS. Completed ('done') rows ignore this column and
--   are pruned by `expires_at` as before.
--
-- Heartbeat/lease sizing (see src/idempotency/store.ts):
--   LEASE            = 20 min  (> genesys p99 run-brief wall-time ~11 min)
--   HEARTBEAT_EVERY  = 30 s
--   Budget coupling (ABF-B6): the HUB reaper's MAX_BRIEF_WALLTIME must be
--   STRICTLY GREATER than LEASE + one heartbeat interval (20m + 30s) so the hub
--   never fails-and-allows-rerun while the agent claim is still live.
--
-- Forward-only, additive. Applied MANUALLY out-of-band (no migration runner in
-- this repo) — an operator apply-step, same as 0001-0005. Its live apply on
-- demo1505's genesys DB is OPERATOR-GATED.
--
-- Backfill: default `now()` is correct — an existing pre-migration 'running'
-- row (there should be none in practice; the async path is net-new) gets a
-- lease that expires immediately, making it steal-CAS reclaimable, which is the
-- safe outcome.

ALTER TABLE agent_research_idempotency.completed_results
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- A reclaim query filters `status='running' AND lease_expires_at < now()`.
CREATE INDEX IF NOT EXISTS completed_results_lease_idx
  ON agent_research_idempotency.completed_results (status, lease_expires_at);
