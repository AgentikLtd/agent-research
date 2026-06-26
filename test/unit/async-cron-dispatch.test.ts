/**
 * Tests for Task 1 — async-cron-dispatch (async-cron-dispatch T1)
 *
 * Covers:
 *  1. async ack: slow skill → handler returns {accepted:true,runId} immediately.
 *  2. in-flight guard (GC-4/BF-1): 2nd concurrent async invoke of same skill →
 *     {accepted:false,reason:'already in flight'}; after settle, 3rd accepted.
 *  3. flag isolation (GC-2/BF-2): 'mode'/'runId' at params level → never in
 *     registry.invoke args (except runId IS injected intentionally — no 'mode').
 *  4. sync default (GC-1): no mode → awaits skill, returns real result.
 *  5. run-brief uses injected runId from args.runId.
 *  6. sanitized catch (GC-8/BF-8): detached skill throws → console.error called
 *     with sanitized shape, NOT JSON.stringify of the error.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleJsonRpc } from '../../src/index.js';
import { createSkillRegistry } from '../../src/skills/registry.js';
import { createRunBriefSkill } from '../../src/skills/run-brief.js';
import type { AuditClient, AuditEvent } from '../../src/hub/audit-client.js';
import type { AgentProfile, ProfileClient } from '../../src/hub/profile-client.js';

const TEST_TOKEN = 'test-token-async';

// ---------------------------------------------------------------------------
// Helpers shared across suites
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1. Async ack — handler responds before the skill resolves
// ---------------------------------------------------------------------------

describe('async ack (GC-1 async path)', () => {
  it('returns {accepted:true,runId} without awaiting the slow skill', async () => {
    let resolveSkill!: (v: unknown) => void;
    const skillPromise = new Promise<unknown>((res) => { resolveSkill = res; });
    const registry = makeRegistry('run-brief', () => skillPromise);

    const result = await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN },
      auth(),
      skillsInvoke('run-brief', {}, { mode: 'async', runId: 'uuid-1234' }),
    );

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { result: { accepted: boolean; runId?: string } };
    expect(body.result.accepted).toBe(true);
    expect(body.result.runId).toBe('uuid-1234');

    // Now resolve so we don't leave a dangling promise
    resolveSkill({ done: true });
    // Give microtasks a tick to settle
    await new Promise((res) => setTimeout(res, 0));
  });

  it('returns {accepted:true} without runId when runId not supplied', async () => {
    let resolveSkill!: (v: unknown) => void;
    const skillPromise = new Promise<unknown>((res) => { resolveSkill = res; });
    const registry = makeRegistry('run-brief', () => skillPromise);

    const result = await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN },
      auth(),
      skillsInvoke('run-brief', {}, { mode: 'async' }),
    );

    const body = JSON.parse(result.body) as { result: { accepted: boolean; runId?: unknown } };
    expect(body.result.accepted).toBe(true);
    // runId may be absent or undefined
    expect(body.result.runId).toBeUndefined();

    resolveSkill({});
    await new Promise((res) => setTimeout(res, 0));
  });
});

// ---------------------------------------------------------------------------
// 2. In-flight guard (GC-4/BF-1)
// ---------------------------------------------------------------------------

describe('in-flight guard (GC-4/BF-1)', () => {
  afterEach(() => {
    // Nothing to restore — the inFlight set is module-level and we
    // deliberately let skills settle before each test via awaiting.
  });

  it('1st async invoke → accepted:true; 2nd (same skill, still running) → accepted:false; after settle → 3rd accepted:true', async () => {
    let resolveSkill!: (v: unknown) => void;
    const skillPromise = new Promise<unknown>((res) => { resolveSkill = res; });
    const registry = makeRegistry('run-brief', () => skillPromise);
    const deps = { registry, expectedToken: TEST_TOKEN };

    // 1st invoke — accepted
    const r1 = await handleJsonRpc(deps, auth(), skillsInvoke('run-brief', {}, { mode: 'async', runId: 'r1' }));
    const b1 = JSON.parse(r1.body) as { result: { accepted: boolean } };
    expect(b1.result.accepted).toBe(true);

    // 2nd invoke while 1st is still in flight — rejected
    const r2 = await handleJsonRpc(deps, auth(), skillsInvoke('run-brief', {}, { mode: 'async', runId: 'r2' }));
    const b2 = JSON.parse(r2.body) as { result: { accepted: boolean; reason: string } };
    expect(b2.result.accepted).toBe(false);
    expect(b2.result.reason).toBe('already in flight');

    // Settle the 1st skill
    resolveSkill({ done: true });
    // Wait for .finally() to run
    await new Promise((res) => setTimeout(res, 10));

    // 3rd invoke — accepted again
    let resolveSkill3!: (v: unknown) => void;
    const skill3Promise = new Promise<unknown>((res) => { resolveSkill3 = res; });
    const registry3 = makeRegistry('run-brief', () => skill3Promise);
    const r3 = await handleJsonRpc(
      { registry: registry3, expectedToken: TEST_TOKEN },
      auth(),
      skillsInvoke('run-brief', {}, { mode: 'async', runId: 'r3' }),
    );
    const b3 = JSON.parse(r3.body) as { result: { accepted: boolean } };
    expect(b3.result.accepted).toBe(true);

    resolveSkill3({});
    await new Promise((res) => setTimeout(res, 10));
  });
});

// ---------------------------------------------------------------------------
// 3. Flag isolation (GC-2/BF-2): 'mode' must never be in registry.invoke args
// ---------------------------------------------------------------------------

describe('flag isolation (GC-2/BF-2)', () => {
  it('mode is never in the args handed to registry.invoke; runId IS injected intentionally', async () => {
    const capturedArgs: unknown[] = [];
    const registry = createSkillRegistry();
    registry.register({
      name: 'run-brief',
      async invoke(args: unknown) {
        capturedArgs.push(args);
        return { done: true };
      },
    });

    // Sync path
    await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN },
      auth(),
      skillsInvoke('run-brief', { since: '-24h' }, { mode: 'async', runId: 'run-uuid' }),
    );

    // Wait for detached promise
    await new Promise((res) => setTimeout(res, 10));

    expect(capturedArgs).toHaveLength(1);
    const invokedArgs = capturedArgs[0] as Record<string, unknown>;
    // mode must NOT be in args
    expect('mode' in invokedArgs).toBe(false);
    // runId IS intentionally injected (GC-7)
    expect(invokedArgs['runId']).toBe('run-uuid');
    // original args preserved
    expect(invokedArgs['since']).toBe('-24h');
  });

  it('mode is never in sync-path registry.invoke args either', async () => {
    const capturedArgs: unknown[] = [];
    const registry = createSkillRegistry();
    registry.register({
      name: 'run-brief',
      async invoke(args: unknown) {
        capturedArgs.push(args);
        return { done: true };
      },
    });

    await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN },
      auth(),
      skillsInvoke('run-brief', { since: '-24h' }),
    );

    expect(capturedArgs).toHaveLength(1);
    const invokedArgs = capturedArgs[0] as Record<string, unknown>;
    expect('mode' in invokedArgs).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Sync default (GC-1): no mode → existing synchronous path unchanged
// ---------------------------------------------------------------------------

describe('sync default (GC-1)', () => {
  it('no mode flag → awaits skill and returns real result in jsonrpc result', async () => {
    const registry = makeRegistry('echo', async (args) => {
      return { echoed: (args as { msg: string }).msg };
    });

    const result = await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN },
      auth(),
      skillsInvoke('echo', { msg: 'hello' }),
    );

    const body = JSON.parse(result.body) as { result: { echoed: string } };
    expect(body.result.echoed).toBe('hello');
  });

  it('unknown skill in sync mode → -32001 error, no ack', async () => {
    const registry = createSkillRegistry();

    const result = await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN },
      auth(),
      skillsInvoke('not-registered', {}),
    );

    const body = JSON.parse(result.body) as { error: { code: number } };
    expect(body.error.code).toBe(-32001);
  });

  it('unknown skill in async mode → -32001 error (validated before detach)', async () => {
    const registry = createSkillRegistry();

    const result = await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN },
      auth(),
      skillsInvoke('not-registered', {}, { mode: 'async', runId: 'r1' }),
    );

    const body = JSON.parse(result.body) as { error: { code: number } };
    expect(body.error.code).toBe(-32001);
  });
});

// ---------------------------------------------------------------------------
// 5. run-brief uses injected runId
// ---------------------------------------------------------------------------

function fakeProfile(profile: AgentProfile): ProfileClient {
  return {
    async get() { return profile; },
    async getTenantSettings() { return { tenant_id: profile.tenant_id, operator_email: 'ops@example.com' }; },
    invalidate() {},
  };
}

function recordingAudit(): { client: AuditClient; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, client: { async emit(e) { events.push(e); } } };
}

const baseProfile: AgentProfile = {
  agent_id: 'a', agent_name: 'genesys-research', tenant_id: 'demo1505',
  config: {
    persona: { voice: 'Direct.', avoid: ['Hype'], audience: 'Engineer.' },
    guardrails: [{ id: 'g4', rule: 'Label items.' }],
    sources: [{ id: 'cx', label: 'CX Today', url: 'https://cxtoday.com', credibility: 'medium' }],
    output: { destination_subject_prefix: 'Genesys Weekly', markdown_sections: ['headline', 'sources'] },
  },
};

function wireMinimalRegistry() {
  const registry = createSkillRegistry();
  registry.register({ name: 'gather-sources', async invoke() { return { items: [], errors: [], fetchedAt: '2026-05-19T00:00:00.000Z' }; } });
  registry.register({ name: 'plan-research', async invoke() { return { angles: ['a1'] }; } });
  registry.register({ name: 'research-angle', async invoke() { return { findings: [{ claim: 'c', detail: 'd', label: 'GA', confidence: 'high' as const, category: 'releases', sources: [{ url: 'https://e.example/a' }], flags: [] }] }; } });
  registry.register({ name: 'challenge-findings', async invoke(args: unknown) { const a = args as { findings: unknown[] }; return { findings: a.findings.map((f) => ({ ...(f as object), verdict: 'confirmed' as const })) }; } });
  registry.register({ name: 'synthesize-brief', async invoke() { return { markdown: '# Brief', citationCount: 1 }; } });
  registry.register({ name: 'dispatch-brief', async invoke() { return { recipients: ['ops@example.com'], emailMessageId: 'm1', dryRun: false }; } });
  return registry;
}

describe('run-brief injected runId (GC-7)', () => {
  it('uses args.runId as the run id when present — audit run.started carries it', async () => {
    const audit = recordingAudit();
    const registry = wireMinimalRegistry();
    const skill = createRunBriefSkill({
      registry,
      profile: fakeProfile(baseProfile),
      audit: audit.client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'),
      newId: () => 'generated-uuid',
    });

    const result = await skill.invoke({ runId: 'fixed-uuid-from-hub' } as Parameters<typeof skill.invoke>[0]);

    // The returned runId should be the injected one
    expect(result.runId).toBe('fixed-uuid-from-hub');

    // The run.started audit event should carry the injected runId
    const startedEvent = audit.events.find((e) => e.eventType === 'run.started');
    expect(startedEvent?.payload).toMatchObject({ runId: 'fixed-uuid-from-hub' });

    // run.completed should also carry it
    const completedEvent = audit.events.find((e) => e.eventType === 'run.completed');
    expect(completedEvent?.payload).toMatchObject({ runId: 'fixed-uuid-from-hub' });
  });

  it('mints its own runId when args.runId is absent — no regression', async () => {
    const audit = recordingAudit();
    const registry = wireMinimalRegistry();
    const skill = createRunBriefSkill({
      registry,
      profile: fakeProfile(baseProfile),
      audit: audit.client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'),
      newId: () => 'generated-uuid',
    });

    const result = await skill.invoke({});

    expect(result.runId).toBe('generated-uuid');
    const startedEvent = audit.events.find((e) => e.eventType === 'run.started');
    expect(startedEvent?.payload).toMatchObject({ runId: 'generated-uuid' });
  });
});

// ---------------------------------------------------------------------------
// 6. Sanitized catch (GC-8/BF-8)
// ---------------------------------------------------------------------------

describe('sanitized catch (GC-8/BF-8)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a detached skill that throws → console.error with sanitized shape, not JSON.stringify', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // We need a skill that is registered (passes validation) but throws when invoked.
    // We register it, let the async-ack path detach it, then let it throw.
    let rejectSkill!: (e: unknown) => void;
    const failingSkillPromise = new Promise<unknown>((_, rej) => { rejectSkill = rej; });
    const registry = makeRegistry('run-brief', () => failingSkillPromise);

    // Trigger async dispatch
    const result = await handleJsonRpc(
      { registry, expectedToken: TEST_TOKEN },
      auth(),
      skillsInvoke('run-brief', {}, { mode: 'async', runId: 'r-fail' }),
    );

    // Handler acked immediately
    const body = JSON.parse(result.body) as { result: { accepted: boolean } };
    expect(body.result.accepted).toBe(true);

    // Now let the skill reject
    rejectSkill(new Error('boom — contains sensitive data'));
    // Give microtasks time to process .catch()
    await new Promise((res) => setTimeout(res, 20));

    // console.error should have been called
    expect(consoleErrorSpy).toHaveBeenCalled();

    const callArgs = consoleErrorSpy.mock.calls[0];
    // First arg is the message string
    const firstArg = callArgs?.[0];
    expect(typeof firstArg).toBe('string');
    // Must contain '[a2a] detached skill failed'
    expect(firstArg).toContain('[a2a] detached skill failed');

    // Second arg is the sanitized metadata object
    const meta = callArgs?.[1] as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    if (meta) {
      expect(meta['skill']).toBe('run-brief');
      expect(meta['name']).toBe('Error');
      // message should be truncated/present
      expect(typeof meta['message']).toBe('string');
    }

    // The call must NOT include JSON.stringify of the error object.
    // We verify by checking that no call arg is a JSON string containing all fields.
    const allArgs = consoleErrorSpy.mock.calls.flat().map(String);
    const hasJsonStringified = allArgs.some(
      (a) => a.includes('"stack"') || a.includes('"message"') && a.startsWith('{'),
    );
    expect(hasJsonStringified).toBe(false);

    // Clean up: wait for in-flight to settle (rejected promise → .finally clears set)
    await new Promise((res) => setTimeout(res, 10));
  });
});
