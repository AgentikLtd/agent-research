/**
 * Integration tests for the async bridge path in handleJsonRpc (AB.7):
 * durable claim (claimAsync) as the dedup authority + heartbeat + the
 * settle-time callback POST.
 *
 * Covers:
 *  1. callbackToken is parsed as a sibling (never folded into args).
 *  2. Async invoke with an idempotencyKey → claimAsync gates it (the durable
 *     store, NOT the skill-name Set): a duplicate SAME-key async fire returns
 *     {accepted:true} (idempotent no-op) and does NOT re-run the brief.
 *  3. Two DIFFERENT keys, same skill → BOTH run (no false skill-name collision).
 *  4. On success settle → a completed callback is POSTed with the allow-listed
 *     pointer (no recipients / markdown).
 *  5. On failure settle → a failed callback is POSTed.
 *  6. No callbackToken supplied → no callback POST (back-compat).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleJsonRpc } from '../../src/index.js';
import { createSkillRegistry } from '../../src/skills/registry.js';
import type { IdempotencyClaim, IdempotencyStore } from '../../src/idempotency/store.js';
import type { BridgeCallbackBody } from '../../src/contracts.js';
import type { BridgeCallbackClient, BridgeCallbackOutcome } from '../../src/hub/bridge-callback-client.js';

const TEST_TOKEN = 'test-token-bridge';

function auth(): string {
  return `Bearer ${TEST_TOKEN}`;
}

function skillsInvoke(skill: string, args: unknown, extra?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'skills.invoke', params: { skill, args, ...extra } });
}

/** Fake async store: claimAsync/heartbeat/complete/release backed by a Map. */
function makeFakeAsyncStore() {
  const rows = new Map<string, { status: 'running' | 'done'; result: unknown }>();
  const store: IdempotencyStore = {
    async claim(): Promise<IdempotencyClaim> { throw new Error('sync unused'); },
    async claimAsync(key: string): Promise<IdempotencyClaim> {
      const existing = rows.get(key);
      if (existing === undefined) { rows.set(key, { status: 'running', result: undefined }); return { kind: 'claimed' }; }
      if (existing.status === 'done') return { kind: 'done', result: existing.result };
      return { kind: 'running' };
    },
    async heartbeat(key: string): Promise<boolean> {
      const r = rows.get(key); return Boolean(r && r.status === 'running');
    },
    async complete(key: string, result: unknown): Promise<void> {
      const r = rows.get(key); if (r && r.status === 'running') { r.status = 'done'; r.result = result; }
    },
    async release(key: string): Promise<void> {
      const r = rows.get(key); if (r && r.status === 'running') rows.delete(key);
    },
    async prune(): Promise<number> { return 0; },
  };
  return { store, rows };
}

function recordingCallback() {
  const bodies: BridgeCallbackBody[] = [];
  const client: BridgeCallbackClient = {
    async send(body: BridgeCallbackBody): Promise<BridgeCallbackOutcome> {
      bodies.push(body);
      return { ok: true };
    },
  };
  return { client, bodies };
}

const settle = () => new Promise((res) => setTimeout(res, 30));

describe('async bridge — callbackToken parse (ABF-B12)', () => {
  it('callbackToken is never folded into the args handed to registry.invoke', async () => {
    const captured: unknown[] = [];
    const registry = createSkillRegistry();
    registry.register({ name: 'run-brief', async invoke(a: unknown) { captured.push(a); return { emailMessageId: 'm' }; } });
    const { store } = makeFakeAsyncStore();
    const { client } = recordingCallback();

    await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN, idempotency: store, bridgeCallback: client },
      auth(),
      skillsInvoke('run-brief', { topic: 'x' }, { mode: 'async', runId: 'r1', idempotencyKey: 'r1:n1', callbackToken: 'cb-1' }),
    );
    await settle();

    expect(captured).toHaveLength(1);
    const args = captured[0] as Record<string, unknown>;
    expect('callbackToken' in args).toBe(false);
    expect('mode' in args).toBe(false);
    expect(args['runId']).toBe('r1'); // runId IS injected (GC-7)
    expect(args['topic']).toBe('x');
  });
});

describe('async bridge — durable claim is the dedup authority (ABF-B5)', () => {
  it('duplicate SAME-key async fire → {accepted:true} idempotent no-op, brief NOT re-run', async () => {
    let runs = 0;
    let resolveSkill!: (v: unknown) => void;
    const skillPromise = new Promise<unknown>((r) => { resolveSkill = r; });
    const registry = createSkillRegistry();
    registry.register({ name: 'run-brief', async invoke() { runs += 1; return skillPromise; } });
    const { store } = makeFakeAsyncStore();
    const { client } = recordingCallback();
    const deps = { registry, expectedToken: TEST_TOKEN, idempotency: store, bridgeCallback: client };

    const r1 = await handleJsonRpc(deps, auth(), skillsInvoke('run-brief', {}, { mode: 'async', runId: 'r1', idempotencyKey: 'r1:n1', callbackToken: 'cb-1' }));
    const b1 = JSON.parse(r1.body) as { result: { accepted: boolean } };
    expect(b1.result.accepted).toBe(true);

    // Duplicate delivery, SAME idempotencyKey, still running → idempotent no-op.
    const r2 = await handleJsonRpc(deps, auth(), skillsInvoke('run-brief', {}, { mode: 'async', runId: 'r1', idempotencyKey: 'r1:n1', callbackToken: 'cb-1' }));
    const b2 = JSON.parse(r2.body) as { result: { accepted: boolean } };
    expect(b2.result.accepted).toBe(true); // NOT false — a dup is a no-op, not an error

    expect(runs).toBe(1); // the paid brief ran exactly once

    resolveSkill({ emailMessageId: 'm' });
    await settle();
  });

  it('two DIFFERENT keys, same skill → BOTH run (no false skill-name collision)', async () => {
    let runs = 0;
    const registry = createSkillRegistry();
    registry.register({ name: 'run-brief', async invoke() { runs += 1; return { emailMessageId: 'm' }; } });
    const { store } = makeFakeAsyncStore();
    const { client } = recordingCallback();
    const deps = { registry, expectedToken: TEST_TOKEN, idempotency: store, bridgeCallback: client };

    const a = await handleJsonRpc(deps, auth(), skillsInvoke('run-brief', {}, { mode: 'async', runId: 'rA', idempotencyKey: 'rA:nA', callbackToken: 'cb-a' }));
    const b = await handleJsonRpc(deps, auth(), skillsInvoke('run-brief', {}, { mode: 'async', runId: 'rB', idempotencyKey: 'rB:nB', callbackToken: 'cb-b' }));
    await settle();

    expect((JSON.parse(a.body) as { result: { accepted: boolean } }).result.accepted).toBe(true);
    expect((JSON.parse(b.body) as { result: { accepted: boolean } }).result.accepted).toBe(true);
    expect(runs).toBe(2);
  });
});

describe('async bridge — settle-time callback POST (ABF-B12, B17)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('success settle → completed callback with allow-listed pointer (no recipients/markdown)', async () => {
    const registry = createSkillRegistry();
    registry.register({
      name: 'run-brief',
      async invoke() {
        return {
          runId: 'r1', since: '-7d', until: 'now', angleCount: 4, findingCount: 10,
          citationCount: 7, recipients: ['ceo@customer.example'], emailMessageId: 'msg-1',
          storageUri: 'r2://t/briefs/x.md', markdown: '# secret body', costGbp: 0.3, costBySkill: {},
        };
      },
    });
    const { store } = makeFakeAsyncStore();
    const { client, bodies } = recordingCallback();

    await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN, idempotency: store, bridgeCallback: client },
      auth(),
      skillsInvoke('run-brief', {}, { mode: 'async', runId: 'r1', idempotencyKey: 'r1:n1', callbackToken: 'cb-1' }),
    );
    await settle();

    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body.callbackToken).toBe('cb-1');
    expect(body.status).toBe('completed');
    expect(Object.keys(body.result).sort()).toEqual(['citationCount', 'costGbp', 'emailMessageId', 'storageUri']);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('recipients');
    expect(serialized).not.toContain('markdown');
    expect(serialized).not.toContain('customer.example');
    expect(serialized).not.toContain('secret body');
  });

  it('failure settle → failed callback POSTed', async () => {
    let rejectSkill!: (e: unknown) => void;
    const p = new Promise<unknown>((_, rej) => { rejectSkill = rej; });
    const registry = createSkillRegistry();
    registry.register({ name: 'run-brief', async invoke() { return p; } });
    const { store, rows } = makeFakeAsyncStore();
    const { client, bodies } = recordingCallback();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN, idempotency: store, bridgeCallback: client },
      auth(),
      skillsInvoke('run-brief', {}, { mode: 'async', runId: 'r1', idempotencyKey: 'r1:n1', callbackToken: 'cb-1' }),
    );
    rejectSkill(new Error('brief blew up'));
    await settle();

    expect(bodies).toHaveLength(1);
    expect(bodies[0].status).toBe('failed');
    expect(bodies[0].callbackToken).toBe('cb-1');
    // Claim released on throw → key free for a real retry.
    expect(rows.has('r1:n1')).toBe(false);
  });

  it('no callbackToken → no callback POST (back-compat)', async () => {
    const registry = createSkillRegistry();
    registry.register({ name: 'run-brief', async invoke() { return { emailMessageId: 'm' }; } });
    const { store } = makeFakeAsyncStore();
    const { client, bodies } = recordingCallback();

    await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN, idempotency: store, bridgeCallback: client },
      auth(),
      skillsInvoke('run-brief', {}, { mode: 'async', runId: 'r1', idempotencyKey: 'r1:n1' }),
    );
    await settle();

    expect(bodies).toHaveLength(0);
  });
});
