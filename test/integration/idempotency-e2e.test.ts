/**
 * E2E integration test for the durable idempotency dedup store (E2.4b).
 *
 * Gated by IDEMPOTENCY_E2E_DATABASE_URL — the entire suite is skipped when
 * the env var is absent so this never runs in unit-test CI (no Postgres
 * service there — expected). Set it to a real Postgres connection string
 * with migration 0005_idempotency.sql applied to exercise the real store
 * end-to-end, mirroring test/integration/memory-e2e-smoke.test.ts's pattern.
 *
 * Schema expected: agent_research_idempotency.completed_results
 * (see migrations/0005_idempotency.sql) PLUS the lease_expires_at column from
 * migrations/0006_idempotency_heartbeat.sql (AB.7 async claim + heartbeat).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { makeIdempotencyStore } from '../../src/idempotency/store.js';

const DATABASE_URL = process.env.IDEMPOTENCY_E2E_DATABASE_URL ?? '';
const skip = DATABASE_URL === '';

describe.skipIf(skip)('idempotency store e2e', () => {
  // Clerk org-style tenant ID — production `tenant_id` is TEXT, not a UUID.
  const tenantId = 'org_3Dm9w429DcZ2cD3J5KQ2Y6NZyY4';
  const pool = new Pool({ connectionString: DATABASE_URL });
  const store = makeIdempotencyStore({ pool, tenantId });

  beforeAll(async () => {
    await pool.query('TRUNCATE agent_research_idempotency.completed_results').catch(() => undefined);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('real claim/complete/lookup round-trip', async () => {
    const key = 'runA:nodeA';

    const claim1 = await store.claim(key, 'run-brief');
    expect(claim1.kind).toBe('claimed');

    // A second claim while still 'running' must NOT re-claim.
    const claim2 = await store.claim(key, 'run-brief');
    expect(claim2.kind).toBe('running');

    await store.complete(key, { markdown: '# Brief', citationCount: 3 });

    const claim3 = await store.claim(key, 'run-brief');
    expect(claim3.kind).toBe('done');
    if (claim3.kind === 'done') {
      expect(claim3.result).toMatchObject({ markdown: '# Brief', citationCount: 3 });
    }
  });

  it('release() after a failure allows a real retry to claim again', async () => {
    const key = 'runB:nodeB';

    const claim1 = await store.claim(key, 'paid-skill');
    expect(claim1.kind).toBe('claimed');

    await store.release(key);

    const claim2 = await store.claim(key, 'paid-skill');
    expect(claim2.kind).toBe('claimed');
  });

  it('a TRUE concurrent race: two claim() calls in parallel — exactly one claimed', async () => {
    const key = 'runC:nodeC';

    const [a, b] = await Promise.all([
      store.claim(key, 'run-brief'),
      store.claim(key, 'run-brief'),
    ]);

    const kinds = [a.kind, b.kind].sort();
    // Exactly one side wins the atomic INSERT ... ON CONFLICT; the other
    // observes 'running' (it hasn't completed yet) or, if the DB round-trip
    // ordering allows, could observe 'done' only if complete() had already
    // run — which it hasn't at this point. So the loser must be 'running'.
    expect(kinds).toEqual(['claimed', 'running']);
  });

  it('prune() removes expired rows', async () => {
    const key = 'runD:nodeD';
    await store.claim(key, 'run-brief');
    await store.complete(key, { ok: true });

    // Force this row to be expired.
    await pool.query(
      "UPDATE agent_research_idempotency.completed_results SET expires_at = now() - INTERVAL '1 day' WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, key],
    );

    const pruned = await store.prune();
    expect(pruned).toBeGreaterThanOrEqual(1);

    // After pruning, claiming the same key must start fresh (not 'done').
    const claimAfterPrune = await store.claim(key, 'run-brief');
    expect(claimAfterPrune.kind).toBe('claimed');
  });

  // --- ASYNC claim + heartbeat + steal-CAS (AB.7) --------------------------

  it('claimAsync: fresh key claims; a live-lease same-key returns running', async () => {
    const key = 'asyncA:nodeA';
    const c1 = await store.claimAsync(key, 'run-brief');
    expect(c1.kind).toBe('claimed');
    const c2 = await store.claimAsync(key, 'run-brief');
    expect(c2.kind).toBe('running'); // lease is live — not stealable
  });

  it('claimAsync: two DIFFERENT keys both claim (no false collision)', async () => {
    const a = await store.claimAsync('asyncB1:n', 'run-brief');
    const b = await store.claimAsync('asyncB2:n', 'run-brief');
    expect(a.kind).toBe('claimed');
    expect(b.kind).toBe('claimed');
  });

  it('steal-CAS: an EXPIRED running lease is reclaimable; a live one is not', async () => {
    const key = 'asyncC:nodeC';
    const first = await store.claimAsync(key, 'run-brief');
    expect(first.kind).toBe('claimed');

    // Live lease → not stealable.
    expect((await store.claimAsync(key, 'run-brief')).kind).toBe('running');

    // Simulate a hard kill: force the lease into the past (no complete/release).
    await pool.query(
      "UPDATE agent_research_idempotency.completed_results SET lease_expires_at = now() - INTERVAL '1 minute' WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, key],
    );

    // Now the expired running claim is stealable.
    const stolen = await store.claimAsync(key, 'run-brief');
    expect(stolen.kind).toBe('claimed');
  });

  it('heartbeat extends the lease; a heartbeated claim is not stealable after the original window', async () => {
    const key = 'asyncD:nodeD';
    await store.claimAsync(key, 'run-brief');

    // Push the lease close to expiry, then heartbeat to extend it.
    await pool.query(
      "UPDATE agent_research_idempotency.completed_results SET lease_expires_at = now() + INTERVAL '1 second' WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, key],
    );
    const beat = await store.heartbeat(key);
    expect(beat).toBe(true);

    // The heartbeat reset lease_expires_at to now()+20min → still not stealable.
    const reclaim = await store.claimAsync(key, 'run-brief');
    expect(reclaim.kind).toBe('running');
  });

  it('heartbeat returns false for a completed row', async () => {
    const key = 'asyncE:nodeE';
    await store.claimAsync(key, 'run-brief');
    await store.complete(key, { emailMessageId: 'm' });
    expect(await store.heartbeat(key)).toBe(false);
  });

  it('claimAsync returns the cached done result after complete()', async () => {
    const key = 'asyncF:nodeF';
    await store.claimAsync(key, 'run-brief');
    await store.complete(key, { emailMessageId: 'm', citationCount: 5 });
    const done = await store.claimAsync(key, 'run-brief');
    expect(done.kind).toBe('done');
    if (done.kind === 'done') {
      expect(done.result).toMatchObject({ emailMessageId: 'm', citationCount: 5 });
    }
  });
});
