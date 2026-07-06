/**
 * Unit tests for the bridge-callback client (AB.7 / ABF-B12, B17).
 *
 * Covers:
 *  1. Allow-list projection: a full RunBriefResult (with recipients + markdown)
 *     → the posted body contains ONLY the four pointer fields; recipients and
 *     markdown are NEVER present.
 *  2. storageUri included only when present.
 *  3. Failed callback shape: status:'failed', empty emailMessageId, zeroed.
 *  4. Retry: a transient failure then a 200 → succeeds; POST attempted twice.
 *  5. All attempts fail → {ok:false, attempts}.
 *  6. No-log-body: on failure the error log carries a token SHA (not the token)
 *     and NO body/result/recipients/storageUri.
 *  7. Grep-gate: the client module source contains no body/result stringify leak.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createBridgeCallbackClient,
  buildCompletedCallback,
  buildFailedCallback,
  projectResultPointer,
} from '../../src/hub/bridge-callback-client.js';

const HUB = 'https://hub.example';
const TOKEN = 'agent-token-xyz';

// A realistic RunBriefResult — carries PII (recipients) + raw body (markdown).
const FULL_RESULT = {
  runId: 'run-1',
  since: '-7d',
  until: 'now',
  angleCount: 4,
  findingCount: 12,
  citationCount: 9,
  recipients: ['ceo@customer.example', 'ops@customer.example'], // PII
  emailMessageId: 'msg-abc',
  storageUri: 'r2://tenant/briefs/2026-07-06.md',
  markdown: '# Confidential brief body\n...secret...', // raw body
  costGbp: 0.42,
  costBySkill: { 'plan-research': 0.1 },
};

describe('projectResultPointer (allow-list, ABF-B12 PII gate)', () => {
  it('emits ONLY the four pointer fields; recipients + markdown are dropped', () => {
    const p = projectResultPointer(FULL_RESULT);
    expect(Object.keys(p).sort()).toEqual(['citationCount', 'costGbp', 'emailMessageId', 'storageUri']);
    expect(p.emailMessageId).toBe('msg-abc');
    expect(p.citationCount).toBe(9);
    expect(p.costGbp).toBe(0.42);
    expect(p.storageUri).toBe('r2://tenant/briefs/2026-07-06.md');
    expect(JSON.stringify(p)).not.toContain('recipients');
    expect(JSON.stringify(p)).not.toContain('markdown');
    expect(JSON.stringify(p)).not.toContain('customer.example');
    expect(JSON.stringify(p)).not.toContain('secret');
  });

  it('omits storageUri when the brief did not archive', () => {
    const p = projectResultPointer({ emailMessageId: 'm', citationCount: 1, costGbp: 0 });
    expect('storageUri' in p).toBe(false);
  });

  it('defensive: malformed result yields a benign zero pointer, never throws', () => {
    const p = projectResultPointer(undefined);
    expect(p).toEqual({ emailMessageId: '', citationCount: 0, costGbp: 0 });
  });
});

describe('buildFailedCallback', () => {
  it('status failed, empty email, zeroed counters, no error field', () => {
    const body = buildFailedCallback('tok-1');
    expect(body).toEqual({
      callbackToken: 'tok-1',
      status: 'failed',
      result: { emailMessageId: '', citationCount: 0, costGbp: 0 },
    });
  });
});

describe('bridge-callback POST (retry, no-log-body)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts an allow-listed body with the agent bearer to the hub endpoint', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const client = createBridgeCallbackClient({ hubUrl: HUB, token: TOKEN, fetcher });
    const out = await client.send(buildCompletedCallback('tok-1', FULL_RESULT));

    expect(out.ok).toBe(true);
    expect(capturedUrl).toBe('https://hub.example/api/engine/bridge-callback');
    expect((capturedInit?.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
    const sentBody = capturedInit?.body as string;
    expect(sentBody).not.toContain('recipients');
    expect(sentBody).not.toContain('markdown');
    expect(sentBody).not.toContain('customer.example');
  });

  it('retries a transient failure, then succeeds on the 200', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('bad', { status: 503 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const client = createBridgeCallbackClient({
      hubUrl: HUB,
      token: TOKEN,
      fetcher,
      sleep: async () => undefined, // no real backoff
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await client.send(buildCompletedCallback('tok-1', FULL_RESULT));

    expect(out.ok).toBe(true);
    expect(calls).toBe(2);
    // The one failed attempt logged a redacted line — verify no PII/token/body.
    const logged = consoleErrorSpy.mock.calls.flat().map((a) => JSON.stringify(a)).join('|');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('recipients');
    expect(logged).not.toContain('customer.example');
    expect(logged).not.toContain('secret');
    expect(logged).toContain('callbackTokenSha');
  });

  it('gives up after maxAttempts and reports ok:false with the attempt count', async () => {
    const fetcher = vi.fn(async () => new Response('down', { status: 500 })) as unknown as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = createBridgeCallbackClient({
      hubUrl: HUB,
      token: TOKEN,
      fetcher,
      sleep: async () => undefined,
      maxAttempts: 3,
    });
    const out = await client.send(buildFailedCallback('tok-1'));
    expect(out).toEqual({ ok: false, attempts: 3 });
  });

  it('never throws on a network error — returns ok:false', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = createBridgeCallbackClient({
      hubUrl: HUB,
      token: TOKEN,
      fetcher,
      sleep: async () => undefined,
      maxAttempts: 2,
    });
    const out = await client.send(buildFailedCallback('tok-1'));
    expect(out.ok).toBe(false);
  });
});

describe('ABF-B17 no-log-body grep-gate', () => {
  it('the client module source never stringifies the body/result into a log', () => {
    const modulePath = fileURLToPath(new URL('../../src/hub/bridge-callback-client.ts', import.meta.url));
    const src = readFileSync(modulePath, 'utf-8');
    // No console.* call may reference `body` or `result` as an argument.
    expect(/console\.\w+\([^)]*\bbody\b/.test(src)).toBe(false);
    expect(/console\.\w+\([^)]*\bresult\b/.test(src)).toBe(false);
    // The raw token must never be logged — only its sha.
    expect(/console\.\w+\([^)]*callbackToken\b(?!Sha)/.test(src)).toBe(false);
  });
});
