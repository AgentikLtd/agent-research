import { describe, it, expect } from 'vitest';
import { createStorageClient } from '../../src/hub/storage-client.js';

describe('createStorageClient', () => {
  it('POSTs to /api/storage/put and returns the uri on success', async () => {
    let captured: { url: string; auth: string | null; body: unknown } = {
      url: '',
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
        auth: headers.get('authorization'),
        body: init?.body ? JSON.parse(init.body as string) : null,
      };
      return new Response(
        JSON.stringify({ ok: true, uri: 'workspace://research/briefs/2026-05-19.md' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const client = createStorageClient({
      hubUrl: 'https://demo.studio.agentik.co.uk',
      token: 'tok',
      fetcher,
    });
    const result = await client.put('research/briefs/2026-05-19.md', '# Brief', {
      contentType: 'text/markdown',
    });
    expect(captured.url).toBe('https://demo.studio.agentik.co.uk/api/storage/put');
    expect(captured.auth).toBe('Bearer tok');
    expect(captured.body).toEqual({
      path: 'research/briefs/2026-05-19.md',
      body: '# Brief',
      contentType: 'text/markdown',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uri).toBe('workspace://research/briefs/2026-05-19.md');
    }
  });

  it('returns ok:false when storage rejects', async () => {
    const fetcher: typeof fetch = async () =>
      new Response('disk full', { status: 507 });
    const client = createStorageClient({ hubUrl: 'http://hub', token: 'tok', fetcher });
    const result = await client.put('path', 'body');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('507');
      expect(result.error.message).toContain('disk full');
    }
  });
});
