import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createRedditSource, createRedditSourceAdapter } from '../../../src/sources/reddit-source.js';

const here = dirname(fileURLToPath(import.meta.url));
// Real fixture captured 2026-05-19 with `curl -H 'User-Agent: agentik-research/0.1-fixture'`
// from https://www.reddit.com/r/callcentres/top.json?t=week&limit=10. 10 children.
const REAL_FIXTURE: string = readFileSync(
  join(here, '../../fixtures/reddit-callcentres.json'),
  'utf8',
);

// Synthetic minimal fixture for tests that need a deterministic shape.
const SAMPLE: unknown = {
  kind: 'Listing',
  data: {
    children: [
      {
        kind: 't3',
        data: {
          id: 'a1',
          title: 'Post one',
          permalink: '/r/typescript/comments/a1/post_one/',
          url: 'https://example.com/a1',
          selftext: 'body',
          created_utc: 1_715_000_000,
          score: 42,
          num_comments: 7,
          subreddit: 'typescript',
        },
      },
      {
        kind: 't3',
        data: {
          id: 'a2',
          title: 'Post two',
          permalink: '/r/typescript/comments/a2/post_two/',
          url: 'https://example.com/a2',
          created_utc: 1_715_000_100,
          subreddit: 'typescript',
        },
      },
    ],
  },
};

describe('createRedditSource', () => {
  it('parses Reddit JSON Listing into SourceItems (synthetic)', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      // URL-mock anchoring per harden-http-adapter: match on /r/typescript/ boundary, not substring.
      if (!url.includes('/r/typescript/')) {
        return new Response('wrong sub', { status: 404 });
      }
      return new Response(JSON.stringify(SAMPLE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const source = createRedditSource({ fetcher });
    const items = await source.fetchSubreddit('typescript');
    expect(items).toHaveLength(2);
    expect(items[0]?.sourceId).toBe('r/typescript');
    expect(items[0]?.title).toBe('Post one');
    expect(items[0]?.url).toBe('https://www.reddit.com/r/typescript/comments/a1/post_one/');
    expect(items[0]?.summary).toContain('score=42');
    expect(items[1]?.summary).toBe('score=0, comments=0');
  });

  it('parses a real-world Reddit Listing fixture', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (!url.includes('/r/callcentres/')) {
        return new Response('wrong sub', { status: 404 });
      }
      return new Response(REAL_FIXTURE, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const source = createRedditSource({ fetcher });
    const items = await source.fetchSubreddit('callcentres');
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]?.sourceId).toBe('r/callcentres');
    expect(items[0]?.url).toMatch(/^https:\/\/www\.reddit\.com\/r\/callcentres\//);
    expect(items[0]?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('strips r/ prefix from input', async () => {
    let seenUrl = '';
    const fetcher: typeof fetch = async (input) => {
      seenUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    };
    const source = createRedditSource({ fetcher });
    await source.fetchSubreddit('r/typescript');
    expect(seenUrl).toContain('/r/typescript/');
    expect(seenUrl).not.toContain('/r/r%2Ftypescript/');
  });

  it('normalises a full reddit URL down to the bare subreddit name', async () => {
    let seenUrl = '';
    const fetcher: typeof fetch = async (input) => {
      seenUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    };
    const source = createRedditSource({ fetcher });
    await source.fetchSubreddit('https://www.reddit.com/r/callcentres/');
    expect(seenUrl).toContain('/r/callcentres/top.json');
    expect(seenUrl).not.toContain('reddit.com%2F');
  });

  it('returns [] for empty subreddit input', async () => {
    const source = createRedditSource();
    const items = await source.fetchSubreddit('');
    expect(items).toHaveLength(0);
  });

  it('surfaces upstream body in non-2xx errors', async () => {
    const fetcher: typeof fetch = async () => new Response('rate limited', { status: 429 });
    const source = createRedditSource({ fetcher });
    await expect(source.fetchSubreddit('typescript')).rejects.toThrow(/429.*rate limited/);
  });

  it('rejects malformed responses via zod', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 });
    const source = createRedditSource({ fetcher });
    await expect(source.fetchSubreddit('typescript')).rejects.toThrow();
  });

  it('default user-agent is the research flavour, not briefing', async () => {
    let seenUa = '';
    const fetcher: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seenUa = headers.get('user-agent') ?? '';
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    };
    const source = createRedditSource({ fetcher });
    await source.fetchSubreddit('typescript');
    expect(seenUa).toBe('agentik-research/0.1 (contact: hello@agentik.co.uk)');
    expect(seenUa).not.toContain('briefing');
  });
});

describe('createRedditSourceAdapter', () => {
  it('rebadges sourceId from input and exposes the Phase-5 fetch shape', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (!url.includes('/r/typescript/')) return new Response('wrong sub', { status: 404 });
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    };
    const adapter = createRedditSourceAdapter({ fetcher });
    const items = await adapter.fetch({
      url: 'typescript',
      sourceId: 'genesys-reddit-typescript',
    });
    expect(items).toHaveLength(2);
    expect(items.every((it) => it.sourceId === 'genesys-reddit-typescript')).toBe(true);
  });
});
