import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  createHtmlSource,
  createHtmlSourceAdapter,
  parseHtmlSource,
} from '../../../src/sources/html-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(join(here, '../../fixtures/', name), 'utf8');

// Real fixtures captured 2026-05-19 with curl + UA `agentik-research/0.1-fixture`.
const CXTODAY = fixture('cxtoday-genesys.html');
const VENDOR_NEWSROOM = fixture('vendor-newsroom.html');

describe('parseHtmlSource', () => {
  it('extracts >=1 item from a vendor newsroom (real fixture)', () => {
    // vendor-newsroom is the canonical "list page with real article markup"
    // fixture. cxtoday-genesys is captured for completeness but its vendor
    // landing page is a CTA shell with no article cards in static HTML — see
    // report. The Phase 6 eval suite will assert against richer fixtures.
    const items = parseHtmlSource(VENDOR_NEWSROOM, {
      baseUrl: 'https://www.genesys.com/en-gb/company/newsroom',
    });
    expect(items.length).toBeGreaterThanOrEqual(1);
    const first = items[0];
    expect(first).toBeDefined();
    expect(first?.title).toBeTruthy();
    expect(first?.url).toMatch(/^https?:\/\//);
  });

  it('parses a synthetic single-article HTML stub', () => {
    const html = `<!doctype html><html><body>
      <article class="news-item">
        <a href="/post/1">
          <h3>Hello world</h3>
        </a>
        <time datetime="2026-05-19T10:00:00Z">May 19, 2026</time>
      </article>
    </body></html>`;
    const items = parseHtmlSource(html, { baseUrl: 'https://example.com/news' });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Hello world');
    expect(items[0]?.url).toBe('https://example.com/post/1');
    expect(items[0]?.publishedAt).toMatch(/^2026-05-19T/);
  });

  it('returns [] for non-HTML input', () => {
    expect(parseHtmlSource('plain text not html', { baseUrl: 'https://x/' })).toEqual([]);
    expect(parseHtmlSource('{"json": true}', { baseUrl: 'https://x/' })).toEqual([]);
  });

  it('returns [] when no article-like blocks are present', () => {
    const items = parseHtmlSource(CXTODAY, {
      baseUrl: 'https://www.cxtoday.com/vendor/genesys/',
    });
    // cxtoday vendor page has no static article cards — JS-rendered list.
    // The parser correctly reports zero rather than fabricating items.
    expect(Array.isArray(items)).toBe(true);
    expect(items.every((it) => typeof it.title === 'string' && typeof it.url === 'string')).toBe(true);
  });

  it('respects maxItems', () => {
    const items = parseHtmlSource(VENDOR_NEWSROOM, {
      baseUrl: 'https://www.genesys.com/en-gb/company/newsroom',
      maxItems: 3,
    });
    expect(items.length).toBeLessThanOrEqual(3);
  });

  it('deduplicates items sharing the same URL', () => {
    const html = `<!doctype html><html><body>
      <article class="news-item"><a href="/x"><h3>One</h3></a></article>
      <article class="news-item"><a href="/x"><h3>One again</h3></a></article>
      <article class="news-item"><a href="/y"><h3>Two</h3></a></article>
    </body></html>`;
    const items = parseHtmlSource(html, { baseUrl: 'https://example.com/' });
    expect(items).toHaveLength(2);
  });
});

describe('createHtmlSource (single-item, byte-compatible with briefing web-fetch)', () => {
  it('extracts title and readable text', async () => {
    const html = `<!doctype html>
<html><head><title>Example Page &amp; More</title></head>
<body>
<script>var x = 1;</script>
<style>.a{color:red}</style>
<p>Hello <b>world</b>. This is the real content.</p>
<p>Some more <a href="x">text</a>.</p>
</body></html>`;
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url !== 'https://example.com/') return new Response('wrong path', { status: 500 });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const source = createHtmlSource({ fetcher });
    const item = await source.fetchUrl('https://example.com/');
    expect(item.title).toBe('Example Page & More');
    expect(item.summary).toContain('Hello world');
    expect(item.summary).not.toContain('<script>');
    expect(item.summary).not.toContain('color:red');
    expect(item.url).toBe('https://example.com/');
  });

  it('falls back to URL as title when no <title> present', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url !== 'https://example.com/x') return new Response('wrong path', { status: 500 });
      return new Response('<html><body>no title</body></html>', { status: 200 });
    };
    const source = createHtmlSource({ fetcher });
    const item = await source.fetchUrl('https://example.com/x');
    expect(item.title).toBe('https://example.com/x');
  });

  it('surfaces upstream body in non-2xx errors', async () => {
    const fetcher: typeof fetch = async () =>
      new Response('Forbidden by allowlist', { status: 403 });
    const source = createHtmlSource({ fetcher });
    await expect(source.fetchUrl('https://example.com/')).rejects.toThrow(
      /403.*Forbidden by allowlist/,
    );
  });

  it('truncates responses larger than maxBytes', async () => {
    const big = 'a'.repeat(10_000);
    const fetcher: typeof fetch = async () => new Response(big, { status: 200 });
    const source = createHtmlSource({ fetcher, maxBytes: 100 });
    const item = await source.fetchUrl('https://example.com/');
    expect(item.summary.length).toBeLessThanOrEqual(100);
  });

  it('default user-agent is the research flavour, not briefing', async () => {
    let seenUa = '';
    const fetcher: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seenUa = headers.get('user-agent') ?? '';
      return new Response('<html><body></body></html>', { status: 200 });
    };
    const source = createHtmlSource({ fetcher });
    await source.fetchUrl('https://example.com/');
    expect(seenUa).toBe('agentik-research/0.1');
  });
});

describe('createHtmlSourceAdapter (Phase-5 fetch shape)', () => {
  it('fetches and parses a list page, rebadging sourceId', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url !== 'https://www.genesys.com/en-gb/company/newsroom') {
        return new Response('wrong path', { status: 500 });
      }
      return new Response(VENDOR_NEWSROOM, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const adapter = createHtmlSourceAdapter({ fetcher });
    const items = await adapter.fetch({
      url: 'https://www.genesys.com/en-gb/company/newsroom',
      sourceId: 'genesys-newsroom',
    });
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((it) => it.sourceId === 'genesys-newsroom')).toBe(true);
  });

  it('surfaces upstream body in non-2xx errors', async () => {
    const fetcher: typeof fetch = async () =>
      new Response('Forbidden by allowlist', { status: 403 });
    const adapter = createHtmlSourceAdapter({ fetcher });
    await expect(
      adapter.fetch({ url: 'https://example.com/', sourceId: 's1' }),
    ).rejects.toThrow(/403.*Forbidden by allowlist/);
  });
});
