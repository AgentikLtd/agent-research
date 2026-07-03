/**
 * Tests for E2.4b — durable idempotency dedup on the SYNCHRONOUS skills.invoke
 * path. Uses a fake in-memory IdempotencyStore (matching the real store's
 * claim/complete/release/prune contract) so these tests don't need a real
 * Postgres connection — see test/integration/idempotency-e2e.test.ts for the
 * real-pg round-trip + concurrency test.
 *
 * Covers:
 *  1. First invoke with a key → claims, calls registry.invoke once, completes,
 *     returns the result.
 *  2. Second invoke with the SAME key → returns the cached result; registry.invoke
 *     is NOT called again.
 *  3. A skill that throws → release() called, error propagates as the existing
 *     JSONRPC_SKILL_ERROR mapping, and a subsequent same-key invoke re-runs.
 *  4. UnknownSkillError still maps to JSONRPC_UNKNOWN_SKILL, and release() is
 *     still called on that path.
 *  5. No idempotencyKey → runs normally, no store calls at all.
 *  6. No store configured → runs normally (graceful degradation).
 *  7. A 'running' collision that never resolves within the bounded poll →
 *     fails closed (a new JSON-RPC error code), and registry.invoke is called
 *     at most the expected number of times (never a silent double-run).
 *  8. A 'running' collision that resolves to 'done' mid-poll → returns the
 *     cached result without a second registry.invoke.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleJsonRpc } from '../../src/index.js';
import { createSkillRegistry, UnknownSkillError } from '../../src/skills/registry.js';
import type { IdempotencyClaim, IdempotencyStore } from '../../src/idempotency/store.js';

const TEST_TOKEN = 'test-token-idempotency';

function auth(): string {
  return `Bearer ${TEST_TOKEN}`;
}

function skillsInvoke(skill: string, args: unknown, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'skills.invoke',
    params: { skill, args, ...extra },
  });
}

function makeRegistry(skillName: string, invokeImpl: (args: unknown) => Promise<unknown>) {
  const registry = createSkillRegistry();
  registry.register({
    name: skillName,
    async invoke(args: unknown) {
      return invokeImpl(args);
    },
  });
  return registry;
}

/** A fake in-memory store mirroring the real makeIdempotencyStore's semantics. */
function makeFakeStore(): IdempotencyStore & {
  rows: Map<string, { status: 'running' | 'done'; result: unknown }>;
} {
  const rows = new Map<string, { status: 'running' | 'done'; result: unknown }>();
  return {
    rows,
    async claim(key: string): Promise<IdempotencyClaim> {
      const existing = rows.get(key);
      if (existing === undefined) {
        rows.set(key, { status: 'running', result: undefined });
        return { kind: 'claimed' };
      }
      if (existing.status === 'done') {
        return { kind: 'done', result: existing.result };
      }
      return { kind: 'running' };
    },
    async complete(key: string, result: unknown): Promise<void> {
      const row = rows.get(key);
      if (row && row.status === 'running') {
        rows.set(key, { status: 'done', result });
      }
    },
    async release(key: string): Promise<void> {
      const row = rows.get(key);
      if (row && row.status === 'running') {
        rows.delete(key);
      }
    },
    async prune(): Promise<number> {
      return 0;
    },
  };
}

describe('idempotency dedup — sync path (E2.4b)', () => {
  it('first invoke with a key claims, calls registry.invoke once, completes, returns result', async () => {
    const store = makeFakeStore();
    const invokeSpy = vi.fn(async (args: unknown) => ({ echoed: (args as { msg: string }).msg }));
    const registry = makeRegistry('echo', invokeSpy);

    const result = await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN, idempotency: store },
      auth(),
      skillsInvoke('echo', { msg: 'hi' }, { idempotencyKey: 'run1:node1' }),
    );

    const body = JSON.parse(result.body) as { result: { echoed: string } };
    expect(body.result.echoed).toBe('hi');
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(store.rows.get('run1:node1')?.status).toBe('done');
  });

  it('second invoke with the SAME key returns the cached result — registry.invoke NOT called again', async () => {
    const store = makeFakeStore();
    const invokeSpy = vi.fn(async (args: unknown) => ({ echoed: (args as { msg: string }).msg }));
    const registry = makeRegistry('echo', invokeSpy);
    const deps = { registry, expectedToken: TEST_TOKEN, idempotency: store };

    const first = await handleJsonRpc(
      deps,
      auth(),
      skillsInvoke('echo', { msg: 'hi' }, { idempotencyKey: 'run1:node1' }),
    );
    const second = await handleJsonRpc(
      deps,
      auth(),
      skillsInvoke('echo', { msg: 'DIFFERENT — must be ignored' }, { idempotencyKey: 'run1:node1' }),
    );

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const firstBody = JSON.parse(first.body) as { result: { echoed: string } };
    const secondBody = JSON.parse(second.body) as { result: { echoed: string } };
    expect(secondBody.result.echoed).toBe(firstBody.result.echoed);
    expect(secondBody.result.echoed).toBe('hi');
  });

  it('a skill that throws releases the claim; error propagates; a subsequent same-key invoke re-runs', async () => {
    const store = makeFakeStore();
    let callCount = 0;
    const invokeSpy = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('paid skill exploded');
      return { ok: true };
    });
    const registry = makeRegistry('paid-skill', invokeSpy);
    const deps = { registry, expectedToken: TEST_TOKEN, idempotency: store };

    const first = await handleJsonRpc(
      deps,
      auth(),
      skillsInvoke('paid-skill', {}, { idempotencyKey: 'run2:node1' }),
    );
    const firstBody = JSON.parse(first.body) as { error?: { code: number; message: string } };
    expect(firstBody.error?.code).toBe(-32000);
    expect(firstBody.error?.message).toContain('paid skill exploded');
    // Claim must have been released, not left 'running'.
    expect(store.rows.has('run2:node1')).toBe(false);

    const second = await handleJsonRpc(
      deps,
      auth(),
      skillsInvoke('paid-skill', {}, { idempotencyKey: 'run2:node1' }),
    );
    const secondBody = JSON.parse(second.body) as { result?: { ok: boolean } };
    expect(secondBody.result?.ok).toBe(true);
    expect(invokeSpy).toHaveBeenCalledTimes(2);
  });

  it('UnknownSkillError still maps to -32001 and releases the claim', async () => {
    const store = makeFakeStore();
    const registry = createSkillRegistry();
    // registry.invoke throws UnknownSkillError for an unregistered name — but
    // claim() has already fired since idempotencyKey is set and skill name is
    // taken as given (dedup doesn't pre-validate skill existence).
    const invokeSpy = vi.spyOn(registry, 'invoke').mockRejectedValue(new UnknownSkillError('ghost-skill'));

    const result = await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN, idempotency: store },
      auth(),
      skillsInvoke('ghost-skill', {}, { idempotencyKey: 'run3:node1' }),
    );

    const body = JSON.parse(result.body) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32001);
    expect(store.rows.has('run3:node1')).toBe(false);
    invokeSpy.mockRestore();
  });

  it('no idempotencyKey → runs normally, no store calls at all', async () => {
    const store = makeFakeStore();
    const claimSpy = vi.spyOn(store, 'claim');
    const invokeSpy = vi.fn(async (args: unknown) => ({ echoed: (args as { msg: string }).msg }));
    const registry = makeRegistry('echo', invokeSpy);

    const result = await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN, idempotency: store },
      auth(),
      skillsInvoke('echo', { msg: 'no-key' }),
    );

    const body = JSON.parse(result.body) as { result: { echoed: string } };
    expect(body.result.echoed).toBe('no-key');
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it('no store configured → runs normally (graceful degradation)', async () => {
    const invokeSpy = vi.fn(async (args: unknown) => ({ echoed: (args as { msg: string }).msg }));
    const registry = makeRegistry('echo', invokeSpy);

    const result = await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN },
      auth(),
      skillsInvoke('echo', { msg: 'no-db' }, { idempotencyKey: 'run4:node1' }),
    );

    const body = JSON.parse(result.body) as { result: { echoed: string } };
    expect(body.result.echoed).toBe('no-db');
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  describe('running collision (bounded poll)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a running collision that never resolves fails closed — never double-runs the skill', async () => {
      const invokeSpy = vi.fn(async () => ({ ok: true }));
      const registry = makeRegistry('paid-skill', invokeSpy);
      // Store that is permanently stuck 'running' for this key (simulates a
      // genuine concurrent duplicate whose original claimant never completes
      // or releases within the poll window).
      const stuckStore: IdempotencyStore = {
        async claim(): Promise<IdempotencyClaim> {
          return { kind: 'running' };
        },
        async complete(): Promise<void> {},
        async release(): Promise<void> {},
        async prune(): Promise<number> {
          return 0;
        },
      };

      const resultPromise = handleJsonRpc(
        { registry, expectedToken: TEST_TOKEN, idempotency: stuckStore },
        auth(),
        skillsInvoke('paid-skill', {}, { idempotencyKey: 'run5:node1' }),
      );

      // Drive the bounded poll to completion (20 attempts * 500ms = 10s).
      await vi.advanceTimersByTimeAsync(20_000);

      const result = await resultPromise;
      const body = JSON.parse(result.body) as { error?: { code: number } };
      expect(body.error?.code).toBe(-32002);
      // The skill must NEVER have been invoked — fail closed, not a silent double-run.
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('a running collision that resolves to done mid-poll returns the cached result, no second invoke', async () => {
      const invokeSpy = vi.fn(async () => ({ ok: true }));
      const registry = makeRegistry('paid-skill', invokeSpy);

      let pollCount = 0;
      const resolvingStore: IdempotencyStore = {
        async claim(): Promise<IdempotencyClaim> {
          pollCount += 1;
          // First call (the initial claim attempt from the handler) → running.
          // Subsequent poll calls → still running twice, then done.
          if (pollCount <= 3) return { kind: 'running' };
          return { kind: 'done', result: { ok: true, fromCache: true } };
        },
        async complete(): Promise<void> {},
        async release(): Promise<void> {},
        async prune(): Promise<number> {
          return 0;
        },
      };

      const resultPromise = handleJsonRpc(
        { registry, expectedToken: TEST_TOKEN, idempotency: resolvingStore },
        auth(),
        skillsInvoke('paid-skill', {}, { idempotencyKey: 'run6:node1' }),
      );

      await vi.advanceTimersByTimeAsync(2_000);

      const result = await resultPromise;
      const body = JSON.parse(result.body) as { result?: { ok: boolean; fromCache?: boolean } };
      expect(body.result?.fromCache).toBe(true);
      expect(invokeSpy).not.toHaveBeenCalled();
    });
  });
});
