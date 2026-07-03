/**
 * Durable idempotency dedup store for the synchronous `skills.invoke` path
 * (E2.4b). This is a NEW module — it does NOT touch the vendored memory
 * adapters (`src/memory/adapters/episodic.ts` / `semantic.ts`), which are
 * out of scope and DO-NOT-EDIT.
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
 */

import type { Pool } from 'pg';

/** Fixed schema — never derived from caller input. */
const SCHEMA = 'agent_research_idempotency';
const TABLE = SCHEMA + '.completed_results';

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
