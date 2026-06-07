import { describe, it, expect } from 'vitest';
import { createAuditClient } from '../../src/hub/audit-client.js';

describe('createAuditClient', () => {
  it('defaults to remote when a token is present and POSTs the trace wire shape', async () => {
    let captured: { url: string; method: string | undefined; auth: string | null; body: unknown } = {
      url: '',
      method: undefined,
      auth: null,
      body: null,
    };
    const fetcher: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const headers = new Headers(init?.headers);
      captured = {
        url,
        method: init?.method,
        auth: headers.get('authorization'),
        body: init?.body ? JSON.parse(init.body as string) : null,
      };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createAuditClient({
      hubUrl: 'http://h',
      token: 't',
      agentId: 'a1',
      fetcher,
    });
    await client.emit({
      eventType: 'research.planned',
      payload: { runId: '11111111-1111-4111-8111-111111111111', angleCount: 3 },
    });
    expect(captured.url).toBe('http://h/api/agents/a1/trace');
    expect(captured.method).toBe('POST');
    expect(captured.auth).toBe('Bearer t');
    expect(captured.body).toEqual({
      run_id: '11111111-1111-4111-8111-111111111111',
      event_type: 'research.planned',
      detail: { runId: '11111111-1111-4111-8111-111111111111', angleCount: 3 },
    });
  });

  it('noop mode (no token) writes a structured log line and never calls the fetcher', async () => {
    const logged: { line: string; detail: unknown }[] = [];
    let fetcherCalled = false;
    const fetcher: typeof fetch = async () => {
      fetcherCalled = true;
      return new Response('{}', { status: 200 });
    };
    const client = createAuditClient({
      hubUrl: 'http://h',
      token: '',
      agentId: 'a1',
      fetcher,
      logger: (line, detail) => logged.push({ line, detail }),
    });
    await client.emit({
      eventType: 'research.brief_published',
      payload: { briefId: 'b_1', tenantId: 't_x' },
    });
    expect(fetcherCalled).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.line).toContain('[audit:noop]');
    expect(logged[0]?.line).toContain('research.brief_published');
    expect(logged[0]?.detail).toEqual({ briefId: 'b_1', tenantId: 't_x' });
  });

  it('remote mode swallows a non-ok response and logs [audit:remote-failed]', async () => {
    const logged: { line: string; detail: unknown }[] = [];
    const fetcher: typeof fetch = async () => new Response('bad', { status: 400 });
    const client = createAuditClient({
      hubUrl: 'http://h',
      token: 't',
      agentId: 'a1',
      fetcher,
      logger: (line, detail) => logged.push({ line, detail }),
    });
    await expect(
      client.emit({
        eventType: 'research.planned',
        payload: { runId: '11111111-1111-4111-8111-111111111111' },
      }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.line).toContain('[audit:remote-failed]');
  });

  it('remote mode swallows a thrown fetcher and logs [audit:remote-threw]', async () => {
    const logged: { line: string; detail: unknown }[] = [];
    const fetcher: typeof fetch = async () => {
      throw new Error('network down');
    };
    const client = createAuditClient({
      hubUrl: 'http://h',
      token: 't',
      agentId: 'a1',
      fetcher,
      logger: (line, detail) => logged.push({ line, detail }),
    });
    await expect(
      client.emit({
        eventType: 'research.planned',
        payload: { runId: '11111111-1111-4111-8111-111111111111' },
      }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]?.line).toContain('[audit:remote-threw]');
  });
});
