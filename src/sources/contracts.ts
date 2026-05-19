/**
 * Common shape every research source normalises to.
 *
 * Sources MUST NOT leak provider-specific fields. Skills (Phase 5) consume only
 * this shape, so each new source (rss, reddit, html, future: hacker-news,
 * lobsters, github-trending, …) plugs in by mapping its native records to
 * SourceItem.
 *
 * The Phase 5 `createXxxSourceAdapter(deps)` factory contract returns an object
 * exposing `fetch({ url, sourceId, since }): Promise<SourceItem[]>`. `since` is
 * an optional lower bound on `publishedAt`; sources that cannot honour it may
 * return everything they retrieved and let the caller filter.
 */
export interface SourceItem {
  readonly sourceId: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly summary?: string;
}

export interface SourceFetchInput {
  readonly url: string;
  readonly sourceId: string;
  readonly since?: string;
}

export interface SourceAdapter {
  fetch(input: SourceFetchInput): Promise<ReadonlyArray<SourceItem>>;
}
