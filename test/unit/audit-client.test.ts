import { describe, it, expect } from 'vitest';
import { createAuditClient } from '../../src/hub/audit-client.js';

describe('createAuditClient', () => {
  it('noop mode writes a structured log line and never throws', async () => {
    const logged: { line: string; detail: unknown }[] = [];
    const client = createAuditClient({
      hubUrl: 'http://hub',
      token: 'tok',
      // mode defaults to 'noop'
      logger: (line, detail) => logged.push({ line, detail }),
    });
    await client.emit({
      eventType: 'research.brief_published',
      payload: { briefId: 'b_1', tenantId: 't_x' },
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]?.line).toContain('research.brief_published');
    expect(logged[0]?.detail).toEqual({ briefId: 'b_1', tenantId: 't_x' });
  });

  it('remote mode POSTs to /api/audit/emit with the bearer token', async () => {
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
      hubUrl: 'http://hub',
      token: 'tok',
      mode: 'remote',
      fetcher,
    });
    await client.emit({ eventType: 'research.brief_published', payload: { briefId: 'b_1' } });
    expect(captured.url).toBe('http://hub/api/audit/emit');
    expect(captured.method).toBe('POST');
    expect(captured.auth).toBe('Bearer tok');
    expect(captured.body).toEqual({
      eventType: 'research.brief_published',
      payload: { briefId: 'b_1' },
    });
  });
});
