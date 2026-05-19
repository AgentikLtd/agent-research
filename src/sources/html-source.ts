/**
 * Source: copied 2026-05-19 from AgentikLtd/agent-briefing/src/sources/web-fetch-source.ts.
 * Renamed `web-fetch-source` → `html-source` to reflect the richer extraction
 * surface (the briefing flavour returned ONE item per URL; the research flavour
 * extracts a LIST of headline+link+date triples from a single page).
 * Diverges over time as the research-agent template's needs evolve.
 *
 * Provides two surfaces:
 *   1. `createHtmlSource(deps)` / `fetchUrl(url)` — single-item readable-text
 *      extraction, byte-compatible with the briefing's `web-fetch-source`.
 *   2. `parseHtmlSource(html, { baseUrl, maxItems? })` — pure parser that
 *      extracts an array of `{ title, url, publishedAt, summary? }` from a
 *      single HTML page. Used by the Phase-5 `createHtmlSourceAdapter` for
 *      vendor-newsroom / community-listing / help-changelog flavours.
 */
import type { SourceAdapter, SourceFetchInput, SourceItem } from './contracts.js';

export interface HtmlSourceDeps {
  readonly fetcher?: typeof fetch;
  readonly userAgent?: string;
  readonly maxBytes?: number;
  readonly maxItems?: number;
}

export interface HtmlSource {
  fetchUrl(targetUrl: string): Promise<SourceItem>;
}

export interface HtmlItem {
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly summary?: string;
}

const DEFAULT_UA = 'agentik-research/0.1';
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_ITEMS = 25;

/**
 * Generic readable-text fetch over the per-tenant allowlist. The hub's egress
 * proxy is the real allowlist gate; this client just retrieves and normalises.
 * It does NOT parse JavaScript-rendered pages — best-effort plain text only.
 */
export function createHtmlSource(deps: HtmlSourceDeps = {}): HtmlSource {
  const fetcher = deps.fetcher ?? fetch;
  const ua = deps.userAgent ?? DEFAULT_UA;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    async fetchUrl(targetUrl) {
      const res = await fetcher(targetUrl, {
        headers: { 'user-agent': ua, accept: 'text/html,text/plain;q=0.9' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `html-source ${targetUrl} failed: ${String(res.status)} ${body}`.trim(),
        );
      }
      const raw = await res.text();
      const truncated = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
      const title = extractHtmlTitle(truncated) ?? targetUrl;
      const summary = htmlToReadableText(truncated).slice(0, 1000);
      return {
        sourceId: targetUrl,
        title,
        url: targetUrl,
        summary,
        publishedAt: '',
      };
    },
  };
}

/**
 * Phase-5 contract adapter. Fetches `input.url` and returns a list of
 * extracted items via `parseHtmlSource`. `input.since` filters by `publishedAt`.
 */
export function createHtmlSourceAdapter(deps: HtmlSourceDeps = {}): SourceAdapter {
  const fetcher = deps.fetcher ?? fetch;
  const ua = deps.userAgent ?? DEFAULT_UA;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxItems = deps.maxItems ?? DEFAULT_MAX_ITEMS;

  return {
    async fetch(input: SourceFetchInput): Promise<ReadonlyArray<SourceItem>> {
      const res = await fetcher(input.url, {
        headers: { 'user-agent': ua, accept: 'text/html,text/plain;q=0.9' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `html-source ${input.url} failed: ${String(res.status)} ${body}`.trim(),
        );
      }
      const raw = await res.text();
      const truncated = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
      const items = parseHtmlSource(truncated, { baseUrl: input.url, maxItems });
      const mapped: SourceItem[] = items.map((it) => ({
        sourceId: input.sourceId,
        title: it.title,
        url: it.url,
        publishedAt: it.publishedAt,
        ...(it.summary ? { summary: it.summary } : {}),
      }));
      if (!input.since) return mapped;
      const cutoff = Date.parse(input.since);
      if (Number.isNaN(cutoff)) return mapped;
      return mapped.filter((it) => {
        if (!it.publishedAt) return true;
        const t = Date.parse(it.publishedAt);
        return Number.isNaN(t) ? true : t >= cutoff;
      });
    },
  };
}

// --- Parsing ---

// An "article block" is one of: a real <article> tag, OR a div/li that carries
// a class hinting at news/post/article content. We deliberately accept any of
// the common WordPress / Bootstrap component patterns since vendor newsrooms
// vary wildly. Each block is parsed independently — if none match, the page is
// not a list page and we return [].
//
// Note: a plain regex cannot match nested same-tag pairs reliably (vendor
// newsrooms nest several `<div>` inside each card). We use ARTICLE_REGEX only
// to locate candidate START positions, then extract the full block by counting
// matching open/close tags in `extractBalancedBlock`.
const ARTICLE_REGEX =
  /<(article|div|li)\b[^>]*\bclass="[^"]*\b(?:news-item|post|article|entry|card-col|news-card|story|teaser)\b[^"]*"/gi;
const TITLE_REGEX = /<h[1-6][^>]*>\s*(?:<a\b[^>]*>)?\s*([^<]{3,300}?)\s*(?:<\/a>)?\s*<\/h[1-6]>/i;
const LINK_REGEX = /<a\b[^>]*\bhref="([^"#?][^"]*)"/i;
const DATE_REGEX_TIME = /<time\b[^>]*\bdatetime="([^"]+)"/i;
const DATE_REGEX_META = /\bdata-(?:date|published|publish-date)="([^"]+)"/i;
const DATE_REGEX_TEXT =
  /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2}|20\d{2}-\d{2}-\d{2}/i;

export interface ParseHtmlOpts {
  readonly baseUrl: string;
  readonly maxItems?: number;
}

export function parseHtmlSource(html: string, opts: ParseHtmlOpts): HtmlItem[] {
  if (!isLikelyHtml(html)) return [];
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const out: HtmlItem[] = [];
  const seenUrls = new Set<string>();
  for (const m of html.matchAll(ARTICLE_REGEX)) {
    if (out.length >= maxItems) break;
    const tag = m[1]?.toLowerCase();
    const startIdx = m.index;
    if (!tag || startIdx === undefined) continue;
    const block = extractBalancedBlock(html, startIdx, tag);
    if (!block) continue;
    const item = parseBlock(block, opts.baseUrl);
    if (!item) continue;
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    out.push(item);
  }
  return out;
}

/**
 * Walks `html` from `startIdx` (the `<` of an opening `<tag …>`) and returns
 * the substring up to and including the matching `</tag>`, counting nested
 * same-named tags. Returns null if no balanced close is found before EOF.
 */
function extractBalancedBlock(html: string, startIdx: number, tag: string): string | null {
  // NB: template-literal `\\b` decodes to backspace at JS parse time and the
  // regex engine then sees `<div<BS>` — silently never matches. Use String.raw
  // to keep the backslashes literal so RegExp sees `\b` as a word boundary.
  const openRe = new RegExp(String.raw`<${tag}\b[^>]*>`, 'gi');
  const closeRe = new RegExp(String.raw`</${tag}\s*>`, 'gi');
  // Self-closing form (<div … />) is not legal HTML for these tags; ignore.
  // Find end of the opening tag.
  const openEnd = html.indexOf('>', startIdx);
  if (openEnd === -1) return null;
  let depth = 1;
  openRe.lastIndex = openEnd + 1;
  closeRe.lastIndex = openEnd + 1;
  while (depth > 0) {
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      closeRe.lastIndex = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      openRe.lastIndex = nextClose.index + nextClose[0].length;
      if (depth === 0) {
        return html.slice(startIdx, nextClose.index + nextClose[0].length);
      }
    }
  }
  return null;
}

function parseBlock(block: string, baseUrl: string): HtmlItem | null {
  const titleMatch = TITLE_REGEX.exec(block);
  const linkMatch = LINK_REGEX.exec(block);
  if (!titleMatch?.[1] || !linkMatch?.[1]) return null;
  const title = decodeEntities(titleMatch[1]).trim();
  if (!title) return null;
  const href = linkMatch[1].trim();
  const url = resolveUrl(href, baseUrl);
  if (!url) return null;
  const publishedAt = extractDate(block);
  return { title, url, publishedAt };
}

function extractDate(block: string): string {
  const m1 = DATE_REGEX_TIME.exec(block);
  if (m1?.[1]) return normaliseDate(m1[1]);
  const m2 = DATE_REGEX_META.exec(block);
  if (m2?.[1]) return normaliseDate(m2[1]);
  const m3 = DATE_REGEX_TEXT.exec(stripTags(block));
  if (m3?.[0]) return normaliseDate(m3[0]);
  return '';
}

function isLikelyHtml(s: string): boolean {
  const head = s.slice(0, 1024).toLowerCase();
  return head.includes('<html') || head.includes('<!doctype html') || head.includes('<body') || /<[a-z][a-z0-9]*\s[\s\S]*?>/.test(head);
}

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractHtmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return null;
  return decodeEntities(match[1]).trim();
}

function htmlToReadableText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function normaliseDate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}
