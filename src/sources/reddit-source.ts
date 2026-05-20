/**
 * Source: copied 2026-05-19 from AgentikLtd/agent-briefing/src/sources/reddit-source.ts.
 * Diverges over time as the research-agent template's needs evolve.
 *
 * User-Agent rebranded from `agentik-briefing-manager/0.1` to
 * `agentik-research/0.1` per the workspace memory directive (Risk 9): every
 * downstream service treats UA as a tenant-identifying signal.
 *
 * Phase-5 adapter shape: `createRedditSourceAdapter(deps)` returns a
 * SourceAdapter with `fetch({ url, sourceId, since }): Promise<SourceItem[]>`.
 * The legacy `createRedditSource` factory is kept verbatim so the curl-style
 * `fetchSubreddit('typescript')` call site remains supported.
 */
import { z } from 'zod';
import type { SourceAdapter, SourceFetchInput, SourceItem } from './contracts.js';

export interface RedditSourceDeps {
  readonly fetcher?: typeof fetch;
  readonly userAgent?: string;
  readonly limit?: number;
  readonly window?: 'hour' | 'day' | 'week';
}

export interface RedditSource {
  fetchSubreddit(subreddit: string): Promise<ReadonlyArray<SourceItem>>;
}

// Reddit's JSON endpoint is well-typed enough that zod is straightforward.
// We model only the fields we actually consume.
const PostDataSchema = z.object({
  id: z.string(),
  title: z.string(),
  permalink: z.string(),
  url: z.string().optional(),
  selftext: z.string().optional(),
  created_utc: z.number(),
  score: z.number().optional(),
  num_comments: z.number().optional(),
  subreddit: z.string(),
});
const ChildSchema = z.object({ kind: z.string(), data: PostDataSchema });
const ListingSchema = z.object({
  kind: z.literal('Listing'),
  data: z.object({ children: z.array(ChildSchema) }),
});

const DEFAULT_UA = 'agentik-research/0.1 (contact: hello@agentik.co.uk)';

export function createRedditSource(deps: RedditSourceDeps = {}): RedditSource {
  const fetcher = deps.fetcher ?? fetch;
  const ua = deps.userAgent ?? DEFAULT_UA;
  const limit = deps.limit ?? 10;
  const window = deps.window ?? 'day';

  return {
    async fetchSubreddit(subreddit) {
      // Accept a bare name (`callcentres`), an `r/`-prefixed name, or a
      // full reddit URL (`https://www.reddit.com/r/callcentres/`) — the
      // manifest convention is the bare name, but tolerate the URL form
      // so a mis-specified source degrades to a correct fetch, not a 404.
      const clean = subreddit
        .trim()
        .replace(/^https?:\/\/(www\.)?reddit\.com/i, '')
        .replace(/^\/?r\//i, '')
        .replace(/\/.*$/, '')
        .trim();
      if (!clean) return [];
      const url = `https://www.reddit.com/r/${encodeURIComponent(clean)}/top.json?t=${window}&limit=${String(limit)}`;
      const res = await fetcher(url, { headers: { 'user-agent': ua, accept: 'application/json' } });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `reddit-source r/${clean} failed: ${String(res.status)} ${body}`.trim(),
        );
      }
      const json: unknown = await res.json();
      const parsed = ListingSchema.parse(json);
      return parsed.data.children.map((child) => toSourceItem(child.data, clean));
    },
  };
}

/**
 * Phase-5 contract adapter. `input.url` is treated as the subreddit name
 * (bare, `r/`-prefixed, or a full `reddit.com/r/<sub>` URL — all
 * normalised). `input.sourceId` overrides the default `r/<sub>`
 * sourceId. `input.since` filters items by `publishedAt`.
 */
export function createRedditSourceAdapter(deps: RedditSourceDeps = {}): SourceAdapter {
  const inner = createRedditSource(deps);
  return {
    async fetch(input: SourceFetchInput): Promise<ReadonlyArray<SourceItem>> {
      const items = await inner.fetchSubreddit(input.url);
      const rebadged = items.map((it) => ({ ...it, sourceId: input.sourceId }));
      if (!input.since) return rebadged;
      const cutoff = Date.parse(input.since);
      if (Number.isNaN(cutoff)) return rebadged;
      return rebadged.filter((it) => {
        if (!it.publishedAt) return true;
        const t = Date.parse(it.publishedAt);
        return Number.isNaN(t) ? true : t >= cutoff;
      });
    },
  };
}

function toSourceItem(
  post: z.infer<typeof PostDataSchema>,
  subreddit: string,
): SourceItem {
  const publishedAt = new Date(post.created_utc * 1000).toISOString();
  const score = post.score ?? 0;
  const comments = post.num_comments ?? 0;
  const selftext = (post.selftext ?? '').slice(0, 500);
  const summary = selftext
    ? `${selftext} (score=${String(score)}, comments=${String(comments)})`
    : `score=${String(score)}, comments=${String(comments)}`;
  return {
    sourceId: `r/${subreddit}`,
    title: post.title,
    url: `https://www.reddit.com${post.permalink}`,
    summary,
    publishedAt,
  };
}
