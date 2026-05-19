import { describe, it, expect } from 'vitest';
import {
  createGatherSourcesSkill,
  InsufficientSourcesError,
  type AdapterMap,
} from '../../src/skills/gather-sources.js';
import type {
  SourceAdapter,
  SourceFetchInput,
  SourceItem,
} from '../../src/sources/contracts.js';

function fakeAdapter(items: ReadonlyArray<SourceItem>): SourceAdapter {
  return {
    async fetch(_input: SourceFetchInput): Promise<ReadonlyArray<SourceItem>> {
      return items;
    },
  };
}
function failingAdapter(msg: string): SourceAdapter {
  return {
    async fetch(_input: SourceFetchInput): Promise<ReadonlyArray<SourceItem>> {
      throw new Error(msg);
    },
  };
}

describe('createGatherSourcesSkill', () => {
  it('fans out across 3 source types and returns the combined items + fetchedAt', async () => {
    const rssItem: SourceItem = {
      sourceId: 'rss-genesys',
      title: 'Genesys release',
      url: 'https://genesys.example/release',
      publishedAt: '2026-05-18T10:00:00Z',
    };
    const redditItem: SourceItem = {
      sourceId: 'r/callcentres',
      title: 'AMA on contact-center AI',
      url: 'https://reddit.com/r/callcentres/ama',
      publishedAt: '2026-05-18T11:00:00Z',
    };
    const htmlItem: SourceItem = {
      sourceId: 'vendor-news',
      title: 'Vendor newsroom headline',
      url: 'https://vendor.example/news/1',
      publishedAt: '2026-05-18T12:00:00Z',
    };

    const adapters: AdapterMap = {
      rss: fakeAdapter([rssItem]),
      reddit: fakeAdapter([redditItem]),
      html: fakeAdapter([htmlItem]),
    };

    const skill = createGatherSourcesSkill({
      adapters,
      clock: () => '2026-05-19T00:00:00.000Z',
    });

    const result = await skill.invoke({
      sources: [
        { type: 'rss', url: 'https://genesys.example/feed.xml', sourceId: 'rss-genesys' },
        { type: 'reddit', url: 'callcentres', sourceId: 'r/callcentres' },
        { type: 'html', url: 'https://vendor.example/news', sourceId: 'vendor-news' },
      ],
      since: '2026-05-17T00:00:00Z',
    });

    expect(result.fetchedAt).toBe('2026-05-19T00:00:00.000Z');
    expect(result.errors).toEqual([]);
    expect(result.items).toHaveLength(3);
    const ids = result.items.map((it) => it.sourceId).sort();
    expect(ids).toEqual(['r/callcentres', 'rss-genesys', 'vendor-news']);
  });

  it('throws InsufficientSourcesError when every source fails (6/6)', async () => {
    const adapters: AdapterMap = {
      rss: failingAdapter('feed 500'),
      reddit: failingAdapter('reddit rate-limited'),
      html: failingAdapter('html 503'),
    };
    const skill = createGatherSourcesSkill({
      adapters,
      clock: () => '2026-05-19T00:00:00.000Z',
    });

    const sources = [
      { type: 'rss', url: 'https://a/feed.xml', sourceId: 'a' },
      { type: 'rss', url: 'https://b/feed.xml', sourceId: 'b' },
      { type: 'reddit', url: 'sub1', sourceId: 'r/sub1' },
      { type: 'reddit', url: 'sub2', sourceId: 'r/sub2' },
      { type: 'html', url: 'https://h1/news', sourceId: 'h1' },
      { type: 'html', url: 'https://h2/news', sourceId: 'h2' },
    ];

    await expect(skill.invoke({ sources, since: '2026-05-17T00:00:00Z' })).rejects.toBeInstanceOf(
      InsufficientSourcesError,
    );
    await expect(skill.invoke({ sources, since: '2026-05-17T00:00:00Z' })).rejects.toThrow(
      /6\/6/,
    );
  });
});
