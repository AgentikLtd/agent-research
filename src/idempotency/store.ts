/**
 * Durable idempotency dedup store for the `skills.invoke` path — SYNC (E2.4b)
 * and ASYNC (AB.7). This is a NEW module — it does NOT touch the vendored
 * memory adapters (`src/memory/adapters/episodic.ts` / `semantic.ts`), which
 * are out of scope and DO-NOT-EDIT.
 *
 * Design:
 *  - Atomic claim via `INSERT ... ON CONFLICT DO NOTHING RETURNING` so two
 *    concurrent duplicate deliveries can't both run the (possibly paid)
 *    skill. This is NOT a naive lookup-then-run-then-store, which races.
 *  - Cache ONLY success: `complete()` marks a row 'done' with its result;
 *    on a skill throw the caller must call `release()` (DELETE) so a
 *    genuine failure does not leave a stale 'running' row blocking a real
 *    retry, and only successful results are ever served from cache.
 *  - `tenant_id` is TEXT. No RLS — tenant isolation is `WHERE tenant_id=$1`
 *    query-level discipline, matching the rest of this repo's Postgres
 *    adapters.
 *  - The schema name is a FIXED constant concatenated into the SQL text
 *    (mirrors `src/memory/adapters/episodic.ts` / `semantic.ts`) — never
 *    interpolated from caller input.
 *
 * ASYNC additions (AB.7 / ABF-B5, B6):
 *  - `claimAsync()` is the durable dedup authority for the async bridge path
 *    (mode:'async'), keyed by the hub-supplied idempotencyKey
 *    ("${runId}:${nodeId}"). It carries a LEASE (`lease_expires_at`, migration
 *    0006) — a `running` claim whose lease has expired is a HARD-KILLED brief
 *    and is reclaimable via a steal-CAS UPDATE (NOT a plain re-INSERT, which
 *    the live PK would block). This is why a TTL-only design is FORBIDDEN: it
 *    would either double-run a slow-alive brief or block a dead one for the
 *    full 7-day `expires_at` window.
 *  - `heartbeat()` extends the lease every ~30s while the detached brief runs.
 *    Heartbeat is MANDATORY — there is NO "heartbeat OR TTL" fork.
 *
 * LEASE / heartbeat sizing (must stay in sync with migration 0006 comment):
 *   LEASE_MS           = 20 min  (> genesys p99 run-brief wall-time ~11 min)
 *   HEARTBEAT_MS       = 30 s
 *   Budget coupling (ABF-B6): the HUB reaper's MAX_BRIEF_WALLTIME must be
 *   STRICTLY GREATER than LEASE_MS + HEARTBEAT_MS (20m + 30s) so the hub never
 *   fails-and-allows-rerun while this agent's claim is still live. The hub side
 *   (AB.6) sizes MAX_BRIEF_WALLTIME to match.
 *
 * ABF-B20 (tenant scoping): the async claim + heartbeat bind the machine's
 * boot `tenant_id` (injected at store construction, `WHERE tenant_id=$1`). This
 * is safe because genesys is ONE Fly-Machine-PER-TENANT — there is no
 * FORCE-RLS backstop on this DB. If genesys ever becomes multi-tenant-per-
 * machine, this idempotency store needs RLS or a schema-per-tenant guarantee
 * before the async claim can be trusted.
 */

import type { Pool } from 'pg';

/** Fixed schema — never derived from caller input. */
const SCHEMA = 'agent_research_idempotency';
const TABLE = SCHEMA + '.completed_results';

/**
 * Async lease duration. A `running` claim is reclaimable via steal-CAS once
 * `lease_expires_at < now()`. 20 min > genesys p99 run-brief wall-time (~11
 * min). See the header note on the hub-reaper budget coupling (ABF-B6).
 */
export const ASYNC_LEASE_MS = 20 * 60 * 1000;

/** Heartbeat cadence: extend the lease this often while the brief runs. */
export const ASYNC_HEARTBEAT_MS = 30 * 1000;

/** LEASE expressed as a Postgres interval literal (server-clock authoritative). */
const LEASE_INTERVAL = "INTERVAL '20 minutes'";

const SQL_CLAIM =
  'INSERT INTO ' + TABLE + ' (tenant_id, idempotency_key, skill, status)' +
  " VALUES ($1, $2, $3, 'running')" +
  ' ON CONFLICT (tenant_id, idempotency_key) DO NOTHING' +
  ' RETURNING idempotency_key';

const SQL_LOOKUP =
  'SELECT status, result FROM ' + TABLE +
  ' WHERE tenant_id = $1 AND idempotency_key = $2 AND expires_at > now()';

const SQL_COMPLETE =
  'UPDATE ' + TABLE +
  " SET status = 'done', result = $3::jsonb, updated_at = now()" +
  " WHERE tenant_id = $1 AND idempotency_key = $2 AND status = 'running'";

const SQL_RELEASE =
  'DELETE FROM ' + TABLE +
  " WHERE tenant_id = $1 AND idempotency_key = $2 AND status = 'running'";

const SQL_PRUNE = 'DELETE FROM ' + TABLE + ' WHERE expires_at < now()';

// --- ASYNC path (AB.7) -----------------------------------------------------

/**
 * Atomic async claim: try to insert a fresh `running` row with a LEASE. On the
 * fresh insert we win the race. `updated_at`/`lease_expires_at` seed the
 * heartbeat clock.
 */
const SQL_CLAIM_ASYNC =
  'INSERT INTO ' + TABLE +
  ' (tenant_id, idempotency_key, skill, status, updated_at, lease_expires_at)' +
  " VALUES ($1, $2, $3, 'running', now(), now() + " + LEASE_INTERVAL + ')' +
  ' ON CONFLICT (tenant_id, idempotency_key) DO NOTHING' +
  ' RETURNING idempotency_key';

/**
 * Steal-CAS: reclaim a `running` row whose lease has EXPIRED (a hard-killed
 * brief). Atomic — only ONE concurrent stealer wins because the UPDATE re-reads
 * the row under a lock and the `lease_expires_at < now()` predicate fails for
 * the loser. Refreshes skill (a different node may hold the same key after a
 * reap) + lease + heartbeat clock. Does NOT touch a live (unexpired) claim, nor
 * a 'done' row.
 */
const SQL_STEAL_ASYNC =
  'UPDATE ' + TABLE +
  ' SET skill = $3, updated_at = now(), lease_expires_at = now() + ' + LEASE_INTERVAL +
  " WHERE tenant_id = $1 AND idempotency_key = $2 AND status = 'running'" +
  ' AND lease_expires_at < now()' +
  ' RETURNING idempotency_key';

/** Lookup used by the async claim conflict branch (mirrors SQL_LOOKUP semantics). */
const SQL_LOOKUP_ASYNC =
  'SELECT status, result, lease_expires_at FROM ' + TABLE +
  ' WHERE tenant_id = $1 AND idempotency_key = $2 AND expires_at > now()';

/**
 * Heartbeat: extend the lease of a still-`running` claim. Returns whether the
 * row was still present + running (rowCount>0). A false return means the claim
 * was completed, released, or stolen — the caller should stop heartbeating.
 */
const SQL_HEARTBEAT =
  'UPDATE ' + TABLE +
  ' SET updated_at = now(), lease_expires_at = now() + ' + LEASE_INTERVAL +
  " WHERE tenant_id = $1 AND idempotency_key = $2 AND status = 'running'";

export interface IdempotencyClaimedResult {
  readonly kind: 'claimed';
}

export interface IdempotencyDoneResult {
  readonly kind: 'done';
  readonly result: unknown;
}

export interface IdempotencyRunningResult {
  readonly kind: 'running';
}

export type IdempotencyClaim =
  | IdempotencyClaimedResult
  | IdempotencyDoneResult
  | IdempotencyRunningResult;

export interface IdempotencyStore {
  /**
   * Atomically claim `key` for `skill`. Returns:
   *  - `{kind:'claimed'}` — this call won the race; the caller must run the
   *    skill and then call `complete()` (on success) or `release()` (on
   *    failure).
   *  - `{kind:'done', result}` — a prior call already completed successfully;
   *    the caller must return `result` verbatim WITHOUT re-running the skill.
   *  - `{kind:'running'}` — a prior call claimed the key and has not yet
   *    completed or failed. The caller should poll (bounded) rather than
   *    run the skill again.
   */
  claim(key: string, skill: string): Promise<IdempotencyClaim>;
  /**
   * Atomic ASYNC claim (AB.7). Like `claim()` but the `running` state carries a
   * LEASE: a prior `running` claim whose lease has EXPIRED is stolen (a
   * hard-killed brief self-clears) and this call wins `{kind:'claimed'}`. A
   * live (unexpired) `running` claim held by another in-flight brief still
   * returns `{kind:'running'}`. A `done` row returns the cached result. Steal
   * is atomic (steal-CAS) so exactly one of N concurrent stealers wins.
   */
  claimAsync(key: string, skill: string): Promise<IdempotencyClaim>;
  /**
   * Extend the LEASE of a still-`running` async claim. Call every
   * `ASYNC_HEARTBEAT_MS` while the detached brief runs. Returns `true` while
   * the row is still present + running; `false` once it is done / released /
   * stolen (the caller should then stop the heartbeat timer).
   */
  heartbeat(key: string): Promise<boolean>;
  /** Mark `key` done with `result` (JSONB-serialisable). No-op if the row is not 'running'. */
  complete(key: string, result: unknown): Promise<void>;
  /** Release a claim after the skill throws, so a real retry can proceed. No-op if not 'running'. */
  release(key: string): Promise<void>;
  /** Delete expired rows. Returns the number of rows removed. Best-effort, called once at boot. */
  prune(): Promise<number>;
}

export interface MakeIdempotencyStoreConfig {
  readonly pool: Pool;
  readonly tenantId: string;
}

export function makeIdempotencyStore(config: MakeIdempotencyStoreConfig): IdempotencyStore {
  const { pool, tenantId } = config;

  return {
    async claim(key: string, skill: string): Promise<IdempotencyClaim> {
      const claimResult = await pool.query(SQL_CLAIM, [tenantId, key, skill]);
      if (claimResult.rowCount !== null && claimResult.rowCount > 0) {
        return { kind: 'claimed' };
      }

      // Conflict — someone already holds (or held) this key. Look it up.
      const lookup = await pool.query(SQL_LOOKUP, [tenantId, key]);
      const row = lookup.rows[0] as { status: 'running' | 'done'; result: unknown } | undefined;

      if (row === undefined) {
        // No live row (either never existed with a non-expired TTL, or it
        // just expired between the failed INSERT and this SELECT). Retry
        // the claim once — if it still conflicts, report running so the
        // caller polls rather than double-running the skill.
        const retryClaim = await pool.query(SQL_CLAIM, [tenantId, key, skill]);
        if (retryClaim.rowCount !== null && retryClaim.rowCount > 0) {
          return { kind: 'claimed' };
        }
        return { kind: 'running' };
      }

      if (row.status === 'done') {
        return { kind: 'done', result: row.result };
      }
      return { kind: 'running' };
    },

    async claimAsync(key: string, skill: string): Promise<IdempotencyClaim> {
      // 1. Fresh insert — wins the race if no row exists yet.
      const claimResult = await pool.query(SQL_CLAIM_ASYNC, [tenantId, key, skill]);
      if (claimResult.rowCount !== null && claimResult.rowCount > 0) {
        return { kind: 'claimed' };
      }

      // 2. Conflict — a row exists. Inspect it.
      const lookup = await pool.query(SQL_LOOKUP_ASYNC, [tenantId, key]);
      const row = lookup.rows[0] as
        | { status: 'running' | 'done'; result: unknown }
        | undefined;

      if (row === undefined) {
        // Row present for the PK but past its 7-day `expires_at` prune window
        // (SQL_LOOKUP_ASYNC filters expired rows out). Retry the insert once;
        // a still-conflicting insert means a concurrent caller just claimed —
        // report running so we never double-run a paid brief.
        const retry = await pool.query(SQL_CLAIM_ASYNC, [tenantId, key, skill]);
        if (retry.rowCount !== null && retry.rowCount > 0) {
          return { kind: 'claimed' };
        }
        return { kind: 'running' };
      }

      if (row.status === 'done') {
        return { kind: 'done', result: row.result };
      }

      // 3. Row is 'running'. Try to STEAL it — succeeds ONLY if its lease has
      // expired (hard-killed brief). Atomic: exactly one concurrent stealer
      // wins; a live claim's predicate fails and we fall through to 'running'.
      const stolen = await pool.query(SQL_STEAL_ASYNC, [tenantId, key, skill]);
      if (stolen.rowCount !== null && stolen.rowCount > 0) {
        return { kind: 'claimed' };
      }
      return { kind: 'running' };
    },

    async heartbeat(key: string): Promise<boolean> {
      const r = await pool.query(SQL_HEARTBEAT, [tenantId, key]);
      return r.rowCount !== null && r.rowCount > 0;
    },

    async complete(key: string, result: unknown): Promise<void> {
      await pool.query(SQL_COMPLETE, [tenantId, key, JSON.stringify(result)]);
    },

    async release(key: string): Promise<void> {
      await pool.query(SQL_RELEASE, [tenantId, key]);
    },

    async prune(): Promise<number> {
      const r = await pool.query(SQL_PRUNE);
      return r.rowCount ?? 0;
    },
  };
}
