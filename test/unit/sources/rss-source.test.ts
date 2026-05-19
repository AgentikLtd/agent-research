import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createRssSource, createRssSourceAdapter, parseFeed } from '../../../src/sources/rss-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const RSS_2_0 = readFileSync(join(here, '../../fixtures/feed.rss.xml'), 'utf8');

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <entry>
    <title>Atom one</title>
    <link href="https://example.com/atom-1" rel="alternate"/>
    <summary>Summary one</summary>
    <updated>2026-05-12T10:00:00Z</updated>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS 2.0 items', () => {
    const items = parseFeed(RSS_2_0, 'https://example.com/feed.xml');
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe('First post');
    expect(items[0]?.url).toBe('https://example.com/1');
    expect(items[0]?.summary).toBe('Hello world');
    expect(items[0]?.publishedAt).toMatch(/^2026-05-11T/);
    expect(items[1]?.title).toBe('Second & final');
  });

  it('falls back to Atom entries when no <item> blocks present', () => {
    const items = parseFeed(ATOM, 'https://example.com/atom.xml');
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Atom one');
    expect(items[0]?.url).toBe('https://example.com/atom-1');
    expect(items[0]?.summary).toBe('Summary one');
  });

  it('returns empty when neither shape is present', () => {
    const items = parseFeed('<html><body>not a feed</body></html>', 'https://x/');
    expect(items).toHaveLength(0);
  });
});

describe('createRssSource', () => {
  it('surfaces upstream body in non-2xx errors', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      // URL-mock anchoring per harden-http-adapter: refuse anything off the expected path.
      if (!url.endsWith('/missing.xml')) return new Response('wrong path', { status: 500 });
      return new Response('Not Found: feed missing', { status: 404 });
    };
    const source = createRssSource({ fetcher });
    await expect(source.fetchFeed('https://example.com/missing.xml')).rejects.toThrow(
      /404.*Not Found.*feed missing/,
    );
  });

  it('caps items per feed', async () => {
    const manyItems = Array.from({ length: 50 }, (_, i) => i)
      .map(
        (i) =>
          `<item><title>t${String(i)}</title><link>https://x/${String(i)}</link></item>`,
      )
      .join('');
    const xml = `<rss><channel>${manyItems}</channel></rss>`;
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (!url.endsWith('/feed.xml')) return new Response('wrong path', { status: 500 });
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    };
    const source = createRssSource({ fetcher, maxItemsPerFeed: 5 });
    const items = await source.fetchFeed('https://example.com/feed.xml');
    expect(items).toHaveLength(5);
  });

  it('sends a user-agent header', async () => {
    let seenUa = '';
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (!url.endsWith('/feed.xml')) return new Response('wrong path', { status: 500 });
      const headers = new Headers(init?.headers);
      seenUa = headers.get('user-agent') ?? '';
      return new Response('<rss><channel></channel></rss>', { status: 200 });
    };
    const source = createRssSource({ fetcher, userAgent: 'test-ua/1.0' });
    await source.fetchFeed('https://example.com/feed.xml');
    expect(seenUa).toBe('test-ua/1.0');
  });

  it('default user-agent is the research flavour, not briefing', async () => {
    let seenUa = '';
    const fetcher: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seenUa = headers.get('user-agent') ?? '';
      return new Response('<rss><channel></channel></rss>', { status: 200 });
    };
    const source = createRssSource({ fetcher });
    await source.fetchFeed('https://example.com/feed.xml');
    expect(seenUa).toBe('agentik-research/0.1');
  });
});

describe('createRssSourceAdapter', () => {
  it('rebadges sourceId from input and exposes the Phase-5 fetch shape', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (!url.endsWith('/feed.xml')) return new Response('wrong path', { status: 500 });
      return new Response(RSS_2_0, { status: 200 });
    };
    const adapter = createRssSourceAdapter({ fetcher });
    const items = await adapter.fetch({
      url: 'https://example.com/feed.xml',
      sourceId: 'genesys-blog-rss',
    });
    expect(items).toHaveLength(2);
    expect(items.every((it) => it.sourceId === 'genesys-blog-rss')).toBe(true);
  });

  it('honours `since` by filtering older items', async () => {
    const fetcher: typeof fetch = async () => new Response(RSS_2_0, { status: 200 });
    const adapter = createRssSourceAdapter({ fetcher });
    const items = await adapter.fetch({
      url: 'https://example.com/feed.xml',
      sourceId: 'x',
      since: '2026-05-12T00:00:00Z',
    });
    // First item is from 2026-05-11 (filtered out); second is 2026-05-12 (kept).
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Second & final');
  });
});
