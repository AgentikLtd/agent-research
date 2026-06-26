import { describe, it, expect, vi } from 'vitest';
import {
  createKnowledgeClient,
  type KnowledgeQueryHitSlice,
} from '../../src/hub/knowledge-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetcher(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetcher: typeof fetch;
  calls: () => Array<{ url: string; init?: RequestInit }>;
} {
  const log: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init?) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    log.push({ url, init });
    return await handler(url, init);
  };
  return { fetcher, calls: () => log };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const SLUG = 'research-genesys';
const HUB = 'http://hub';
const TOKEN = 'test-bearer-token';
const EXPECTED_URL = `${HUB}/api/agents/${SLUG}/knowledge/query`;

const SAMPLE_CHUNK: KnowledgeQueryHitSlice = {
  content: '<knowledge source="Vendor Memo">vendor pricing memo</knowledge>',
  source_title: 'Vendor Memo',
  score: 0.88,
};

// ---------------------------------------------------------------------------
// GATE-1: URL uses slug (AGENT_NAME), NOT UUID
// ---------------------------------------------------------------------------

describe('knowledge-client — GATE-1 slug URL', () => {
  it('builds URL from agentName slug, not a UUID', async () => {
    const { fetcher, calls } = makeFetcher(() =>
      okResponse({ chunks: [SAMPLE_CHUNK] }),
    );
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });

    await query({ query: 'vendor pricing' });

    const [call] = calls();
    expect(call.url).toBe(EXPECTED_URL);
    // Explicitly assert it does NOT contain a UUID-shaped segment
    expect(call.url).not.toMatch(
      /\/api\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//,
    );
  });

  it('sends Authorization: Bearer <token> header', async () => {
    const { fetcher, calls } = makeFetcher(() => okResponse({ chunks: [] }));
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    await query({ query: 'test' });
    const headers = calls()[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('sends body with query and top_k (snake_case) when topK provided', async () => {
    const { fetcher, calls } = makeFetcher(() => okResponse({ chunks: [] }));
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    await query({ query: 'vendor pricing', topK: 5 });
    const body = JSON.parse(calls()[0].init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ query: 'vendor pricing', top_k: 5 });
  });

  it('omits top_k from body when topK is undefined', async () => {
    const { fetcher, calls } = makeFetcher(() => okResponse({ chunks: [] }));
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    await query({ query: 'vendor pricing' });
    const body = JSON.parse(calls()[0].init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ query: 'vendor pricing' });
    expect('top_k' in body).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('knowledge-client — success', () => {
  it('returns chunks from a 200 response', async () => {
    const { fetcher } = makeFetcher(() => okResponse({ chunks: [SAMPLE_CHUNK] }));
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    const result = await query({ query: 'vendor pricing' });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].content).toBe(SAMPLE_CHUNK.content);
    expect(result.chunks[0].source_title).toBe('Vendor Memo');
    expect(result.chunks[0].score).toBe(0.88);
  });

  it('returns multiple chunks with correct fields', async () => {
    const chunks: KnowledgeQueryHitSlice[] = [
      { content: '<knowledge>chunk one</knowledge>', source_title: 'Doc A', score: 0.95 },
      { content: '<knowledge>chunk two</knowledge>', source_title: 'Doc B', score: 0.72 },
    ];
    const { fetcher } = makeFetcher(() => okResponse({ chunks }));
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    const result = await query({ query: 'anything' });
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[1].source_title).toBe('Doc B');
  });
});

// ---------------------------------------------------------------------------
// Best-effort: never throws — degrade paths
// ---------------------------------------------------------------------------

describe('knowledge-client — best-effort degrade (never throws)', () => {
  it('returns {chunks:[]} on 403 and emits a WARN with the status code', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetcher } = makeFetcher(
      () =>
        new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    const result = await query({ query: 'test' });
    expect(result).toEqual({ chunks: [] });
    expect(warnSpy).toHaveBeenCalledOnce();
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain('[knowledge-client]');
    expect(warnMsg).toContain('403');
    warnSpy.mockRestore();
  });

  it('returns {chunks:[]} on 500 and includes upstream body in WARN', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetcher } = makeFetcher(
      () =>
        new Response('internal server error', {
          status: 500,
        }),
    );
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    const result = await query({ query: 'test' });
    expect(result).toEqual({ chunks: [] });
    expect(warnSpy).toHaveBeenCalledOnce();
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain('500');
    warnSpy.mockRestore();
  });

  it('returns {chunks:[]} on network throw', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetcher } = makeFetcher(() => {
      throw new Error('ECONNREFUSED');
    });
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    const result = await query({ query: 'test' });
    expect(result).toEqual({ chunks: [] });
    expect(warnSpy).toHaveBeenCalledOnce();
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain('[knowledge-client]');
    expect(warnMsg).toContain('ECONNREFUSED');
    warnSpy.mockRestore();
  });

  it('returns {chunks:[]} when body is valid JSON but wrong shape ({})', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetcher } = makeFetcher(() => okResponse({}));
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    const result = await query({ query: 'test' });
    expect(result).toEqual({ chunks: [] });
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('returns {chunks:[]} when body has chunks with wrong field types', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetcher } = makeFetcher(() =>
      okResponse({ chunks: [{ content: 123, source_title: null, score: 'high' }] }),
    );
    const query = createKnowledgeClient({
      hubUrl: HUB,
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    const result = await query({ query: 'test' });
    expect(result).toEqual({ chunks: [] });
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('strips trailing slash from hubUrl', async () => {
    const { fetcher, calls } = makeFetcher(() => okResponse({ chunks: [] }));
    const query = createKnowledgeClient({
      hubUrl: 'http://hub/',
      agentName: SLUG,
      token: TOKEN,
      fetcher,
    });
    await query({ query: 'test' });
    expect(calls()[0].url).toBe(EXPECTED_URL);
  });
});
