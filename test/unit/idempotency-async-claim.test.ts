/**
 * Unit tests for the DURABLE ASYNC claim + heartbeat + steal-CAS (AB.7 /
 * ABF-B5, B6) on the idempotency store, using a fake in-memory store that
 * mirrors the real Postgres semantics (lease clock + steal-on-expiry). The
 * real-Postgres round-trip lives in test/integration/idempotency-e2e.test.ts.
 *
 * Covers:
 *  1. claimAsync on a fresh key → {kind:'claimed'}.
 *  2. TWO DIFFERENT keys (different "${runId}:${nodeId}") → BOTH claimed (no
 *     false collision — the bug the skill-name Set had).
 *  3. A second claimAsync with the SAME key while the lease is LIVE → running
 *     (idempotent no-op at the caller — brief NOT re-run).
 *  4. Steal-CAS: a 'running' claim whose lease EXPIRED is reclaimable → the
 *     next claimAsync returns {kind:'claimed'} (hard-killed brief self-clears).
 *  5. A live (unexpired) lease is NOT stealable.
 *  6. heartbeat() extends the lease (a claim that WOULD have expired stays
 *     un-stealable after a heartbeat).
 *  7. heartbeat() returns false once the row is done / released.
 *  8. complete() → a later claimAsync returns the cached {kind:'done', result}.
 */
import { describe, it, expect } from 'vitest';
import { ASYNC_LEASE_MS } from '../../src/idempotency/store.js';
import type { IdempotencyClaim, IdempotencyStore } from '../../src/idempotency/store.js';

/**
 * Fake store mirroring the real makeIdempotencyStore ASYNC semantics with a
 * virtual clock, so we can fast-forward past a lease without real time.
 */
function makeFakeAsyncStore() {
  let clock = 0;
  const rows = new Map<
    string,
    { status: 'running' | 'done'; result: unknown; skill: string; leaseExpiresAt: number }
  >();

  const store: IdempotencyStore = {
    async claim(): Promise<IdempotencyClaim> {
      throw new Error('sync claim not used in async tests');
    },
    async claimAsync(key: string, skill: string): Promise<IdempotencyClaim> {
      const existing = rows.get(key);
      if (existing === undefined) {
        rows.set(key, { status: 'running', result: undefined, skill, leaseExpiresAt: clock + ASYNC_LEASE_MS });
        return { kind: 'claimed' };
      }
      if (existing.status === 'done') {
        return { kind: 'done', result: existing.result };
      }
      // running — steal only if the lease has expired.
      if (existing.leaseExpiresAt < clock) {
        rows.set(key, { status: 'running', result: undefined, skill, leaseExpiresAt: clock + ASYNC_LEASE_MS });
        return { kind: 'claimed' };
      }
      return { kind: 'running' };
    },
    async heartbeat(key: string): Promise<boolean> {
      const row = rows.get(key);
      if (row && row.status === 'running') {
        row.leaseExpiresAt = clock + ASYNC_LEASE_MS;
        return true;
      }
      return false;
    },
    async complete(key: string, result: unknown): Promise<void> {
      const row = rows.get(key);
      if (row && row.status === 'running') {
        row.status = 'done';
        row.result = result;
      }
    },
    async release(key: string): Promise<void> {
      const row = rows.get(key);
      if (row && row.status === 'running') rows.delete(key);
    },
    async prune(): Promise<number> {
      return 0;
    },
  };

  return { store, advance: (ms: number) => { clock += ms; } };
}

describe('durable async claim (AB.7)', () => {
  it('claimAsync on a fresh key → claimed', async () => {
    const { store } = makeFakeAsyncStore();
    const c = await store.claimAsync('runA:node1', 'run-brief');
    expect(c.kind).toBe('claimed');
  });

  it('two DIFFERENT keys both claim — no false skill-name collision', async () => {
    const { store } = makeFakeAsyncStore();
    const a = await store.claimAsync('runA:node1', 'run-brief');
    const b = await store.claimAsync('runB:node2', 'run-brief'); // same skill, different key
    expect(a.kind).toBe('claimed');
    expect(b.kind).toBe('claimed');
  });

  it('same key while lease is LIVE → running (idempotent no-op, not re-run)', async () => {
    const { store } = makeFakeAsyncStore();
    const first = await store.claimAsync('runA:node1', 'run-brief');
    const second = await store.claimAsync('runA:node1', 'run-brief');
    expect(first.kind).toBe('claimed');
    expect(second.kind).toBe('running');
  });

  it('steal-CAS: an EXPIRED running lease is reclaimable (hard-killed brief self-clears)', async () => {
    const { store, advance } = makeFakeAsyncStore();
    const first = await store.claimAsync('runA:node1', 'run-brief');
    expect(first.kind).toBe('claimed');

    // Simulate a hard kill: no complete/release, and the lease elapses.
    advance(ASYNC_LEASE_MS + 1);

    const reclaim = await store.claimAsync('runA:node1', 'run-brief');
    expect(reclaim.kind).toBe('claimed'); // stolen
  });

  it('a LIVE (unexpired) lease is NOT stealable', async () => {
    const { store, advance } = makeFakeAsyncStore();
    await store.claimAsync('runA:node1', 'run-brief');
    advance(ASYNC_LEASE_MS - 1000); // still within the lease
    const reclaim = await store.claimAsync('runA:node1', 'run-brief');
    expect(reclaim.kind).toBe('running');
  });

  it('heartbeat extends the lease — a claim that would have expired stays un-stealable', async () => {
    const { store, advance } = makeFakeAsyncStore();
    await store.claimAsync('runA:node1', 'run-brief');

    // Advance most of the way, then heartbeat to extend.
    advance(ASYNC_LEASE_MS - 1000);
    const beat = await store.heartbeat('runA:node1');
    expect(beat).toBe(true);

    // Advance past what WOULD have been the original expiry — but the heartbeat
    // moved it forward, so it is still un-stealable.
    advance(2000);
    const reclaim = await store.claimAsync('runA:node1', 'run-brief');
    expect(reclaim.kind).toBe('running');
  });

  it('heartbeat returns false once the row is done / released', async () => {
    const { store } = makeFakeAsyncStore();
    await store.claimAsync('runA:node1', 'run-brief');
    await store.complete('runA:node1', { emailMessageId: 'm1' });
    expect(await store.heartbeat('runA:node1')).toBe(false);

    await store.claimAsync('runB:node2', 'run-brief');
    await store.release('runB:node2');
    expect(await store.heartbeat('runB:node2')).toBe(false);
  });

  it('complete() → a later claimAsync returns the cached done result', async () => {
    const { store } = makeFakeAsyncStore();
    await store.claimAsync('runA:node1', 'run-brief');
    await store.complete('runA:node1', { emailMessageId: 'm1', citationCount: 3 });
    const again = await store.claimAsync('runA:node1', 'run-brief');
    expect(again.kind).toBe('done');
    if (again.kind === 'done') {
      expect(again.result).toMatchObject({ emailMessageId: 'm1', citationCount: 3 });
    }
  });
});
