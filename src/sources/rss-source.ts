/**
 * Source: copied 2026-05-19 from AgentikLtd/agent-briefing/src/sources/rss-source.ts.
 * Diverges over time as the research-agent template's needs evolve.
 *
 * Phase-5 adapter shape: `createRssSourceAdapter(deps)` returns a
 * SourceAdapter with `fetch({ url, sourceId, since }): Promise<SourceItem[]>`.
 * The legacy `createRssSource` + `parseFeed` exports are kept verbatim so
 * existing parser tests stay valid and so callers that only need the parser
 * (e.g. eval fixture replay) can use it directly.
 */
import type { SourceAdapter, SourceFetchInput, SourceItem } from './contracts.js';

export interface RssSourceDeps {
  readonly fetcher?: typeof fetch;
  readonly userAgent?: string;
  readonly maxItemsPerFeed?: number;
}

export interface RssSource {
  fetchFeed(feedUrl: string): Promise<ReadonlyArray<SourceItem>>;
}

const DEFAULT_UA = 'agentik-research/0.1';

export function createRssSource(deps: RssSourceDeps = {}): RssSource {
  const fetcher = deps.fetcher ?? fetch;
  const ua = deps.userAgent ?? DEFAULT_UA;
  const cap = deps.maxItemsPerFeed ?? 20;

  return {
    async fetchFeed(feedUrl) {
      const res = await fetcher(feedUrl, {
        headers: { 'user-agent': ua, accept: 'application/rss+xml,application/atom+xml,application/xml;q=0.9' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`rss-source ${feedUrl} failed: ${String(res.status)} ${body}`.trim());
      }
      const xml = await res.text();
      const items = parseFeed(xml, feedUrl).slice(0, cap);
      return items;
    },
  };
}

/**
 * Phase-5 contract adapter. `input.url` is the feed URL; `input.sourceId`
 * overrides the parser's default sourceId (which is the feed URL). `input.since`
 * is honoured by filtering items whose `publishedAt` is empty or older.
 */
export function createRssSourceAdapter(deps: RssSourceDeps = {}): SourceAdapter {
  const inner = createRssSource(deps);
  return {
    async fetch(input: SourceFetchInput): Promise<ReadonlyArray<SourceItem>> {
      const items = await inner.fetchFeed(input.url);
      const rebadged = items.map((it) => ({ ...it, sourceId: input.sourceId }));
      if (!input.since) return rebadged;
      const cutoff = Date.parse(input.since);
      if (Number.isNaN(cutoff)) return rebadged;
      return rebadged.filter((it) => {
        if (!it.publishedAt) return true; // keep when unknown — caller may dedupe
        const t = Date.parse(it.publishedAt);
        return Number.isNaN(t) ? true : t >= cutoff;
      });
    },
  };
}

// --- Parsing ---

const ITEM_RE = /<item\b[\s\S]*?<\/item>/gi;
const ENTRY_RE = /<entry\b[\s\S]*?<\/entry>/gi;

export function parseFeed(xml: string, feedUrl: string): ReadonlyArray<SourceItem> {
  const items: SourceItem[] = [];
  for (const block of xml.matchAll(ITEM_RE)) {
    const parsed = parseRssItem(block[0], feedUrl);
    if (parsed) items.push(parsed);
  }
  if (items.length === 0) {
    for (const block of xml.matchAll(ENTRY_RE)) {
      const parsed = parseAtomEntry(block[0], feedUrl);
      if (parsed) items.push(parsed);
    }
  }
  return items;
}

function parseRssItem(block: string, feedUrl: string): SourceItem | null {
  const title = extractTagText(block, 'title');
  const link = extractTagText(block, 'link');
  const description = extractTagText(block, 'description');
  const pubDate = extractTagText(block, 'pubDate');
  if (!title || !link) return null;
  return {
    sourceId: feedUrl,
    title: decodeEntities(title).trim(),
    url: link.trim(),
    summary: stripTags(decodeEntities(description ?? '')).trim(),
    publishedAt: normaliseDate(pubDate ?? ''),
  };
}

function parseAtomEntry(block: string, feedUrl: string): SourceItem | null {
  const title = extractTagText(block, 'title');
  const linkHref = extractAtomLinkHref(block);
  const summary = extractTagText(block, 'summary') ?? extractTagText(block, 'content');
  const updated = extractTagText(block, 'updated') ?? extractTagText(block, 'published');
  if (!title || !linkHref) return null;
  return {
    sourceId: feedUrl,
    title: decodeEntities(title).trim(),
    url: linkHref.trim(),
    summary: stripTags(decodeEntities(summary ?? '')).trim(),
    publishedAt: normaliseDate(updated ?? ''),
  };
}

function extractTagText(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = re.exec(block);
  if (!match) return null;
  const inner = match[1] ?? '';
  return stripCdata(inner);
}

function extractAtomLinkHref(block: string): string | null {
  const match = /<link\b[^>]*\bhref="([^"]+)"/i.exec(block);
  return match?.[1] ?? null;
}

function stripCdata(s: string): string {
  return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function normaliseDate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}
