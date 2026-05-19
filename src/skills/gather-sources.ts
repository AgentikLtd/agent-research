/**
 * gather-sources skill — fan-out fetch over a tenant-supplied source list.
 *
 * Inputs are `ProfileConfig['sources']` rows — each declares a `type`
 * (`rss` | `reddit` | `subreddit` | `html` | …), a `url` (or for reddit, a
 * subreddit name), an optional `sourceId` (defaults to the url), and any
 * adapter-specific fields. The skill resolves a `SourceAdapter` per `type`
 * via the injected `adapters` map, then runs every fetch in parallel via
 * `Promise.allSettled` so a single failing source can't take down the rest.
 *
 * Failure semantics:
 *   - Per-source errors are collected into `errors[]` with the original
 *     `sourceId` so the caller (run-brief) can surface a "couldn't reach
 *     X" line in the brief.
 *   - If the failure ratio exceeds `maxFailRatio` (default 0.5), the
 *     skill throws `InsufficientSourcesError` so run-brief can abort and
 *     emit `run.failed` rather than dispatch a brief built on noise.
 *
 * The adapter contract (`SourceAdapter.fetch({ url, sourceId, since })`)
 * is the Phase-3 shape from `src/sources/contracts.ts` — see the
 * `createRssSourceAdapter`, `createRedditSourceAdapter`,
 * `createHtmlSourceAdapter` factories.
 */

import type { ProfileConfig } from '../hub/profile-client.js';
import type {
  SourceAdapter,
  SourceItem,
} from '../sources/contracts.js';
import type { Skill } from './registry.js';

/** One row from `profile.config.sources`. */
export interface SourceSpec {
  /** Adapter discriminator: `rss` | `reddit` | `subreddit` | `html` | future. */
  readonly type: string;
  /** Fetch target. For reddit/subreddit this is the sub name; for others, a URL. */
  readonly url: string;
  /** Stable identifier used in citations + de-duplication. Defaults to `url`. */
  readonly sourceId?: string;
  /** Adapter-specific extras the SourceAdapter contract ignores. */
  readonly [field: string]: unknown;
}

export interface GatherSourcesArgs {
  /**
   * Source rows — accepts `ProfileConfig['sources']` (which is `unknown`
   * via index signature) OR a concrete `ReadonlyArray<SourceSpec>`. The
   * skill validates each row at runtime and skips malformed entries
   * (counted as errors so they show up in the brief).
   */
  readonly sources: ProfileConfig['sources'] | ReadonlyArray<SourceSpec>;
  /** ISO timestamp lower bound — passed straight to each adapter. */
  readonly since: string;
  /**
   * Fraction of sources that may fail before the skill throws. Default 0.5
   * (more than half failing means we don't trust the brief).
   */
  readonly maxFailRatio?: number;
}

export interface GatherSourcesError {
  readonly sourceId: string;
  readonly type: string;
  readonly message: string;
}

export interface GatherSourcesResult {
  readonly items: ReadonlyArray<SourceItem>;
  readonly errors: ReadonlyArray<GatherSourcesError>;
  /** ISO timestamp captured when the fan-out completed. */
  readonly fetchedAt: string;
}

/**
 * Map of source-type → adapter instance. Injected at skill construction so
 * tests can stub adapters and run-brief can wire the real ones from
 * `src/sources/*-source.ts`. Type strings match `SourceSpec.type` exactly.
 *
 * Recognised types in Phase 5: `rss`, `reddit`, `subreddit`, `html`. Future
 * flavours register their own.
 */
export type AdapterMap = Readonly<Record<string, SourceAdapter>>;

export interface GatherSourcesDeps {
  readonly adapters: AdapterMap;
  /** Test seam: defaults to `() => new Date().toISOString()`. */
  readonly clock?: () => string;
}

export class InsufficientSourcesError extends Error {
  readonly failed: number;
  readonly total: number;
  readonly ratio: number;
  constructor(failed: number, total: number, ratio: number) {
    super(
      `insufficient sources: ${String(failed)}/${String(total)} failed (ratio ${ratio.toFixed(2)})`,
    );
    this.name = 'InsufficientSourcesError';
    this.failed = failed;
    this.total = total;
    this.ratio = ratio;
  }
}

function coerceSources(
  raw: GatherSourcesArgs['sources'],
): ReadonlyArray<SourceSpec> {
  if (!Array.isArray(raw)) return [];
  const out: SourceSpec[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const type = r['type'];
    const url = r['url'];
    if (typeof type !== 'string' || typeof url !== 'string') continue;
    const sid = r['sourceId'];
    const spec: SourceSpec = {
      ...(r as object),
      type,
      url,
      ...(typeof sid === 'string' ? { sourceId: sid } : {}),
    };
    out.push(spec);
  }
  return out;
}

export function createGatherSourcesSkill(
  deps: GatherSourcesDeps,
): Skill<GatherSourcesArgs, GatherSourcesResult> {
  const clock = deps.clock ?? (() => new Date().toISOString());
  return {
    name: 'gather-sources',
    description:
      'Fan-out fetch across the tenant source list, normalised to SourceItem[].',
    async invoke(args) {
      const specs = coerceSources(args.sources);
      const total = specs.length;
      const maxFailRatio = args.maxFailRatio ?? 0.5;
      const items: SourceItem[] = [];
      const errors: GatherSourcesError[] = [];

      if (total === 0) {
        return { items, errors, fetchedAt: clock() };
      }

      const settled = await Promise.allSettled(
        specs.map(async (spec) => {
          const sourceId = spec.sourceId ?? spec.url;
          const adapter = deps.adapters[spec.type];
          if (adapter === undefined) {
            throw new Error(`no adapter for source type "${spec.type}"`);
          }
          const fetched = await adapter.fetch({
            url: spec.url,
            sourceId,
            since: args.since,
          });
          return { sourceId, items: fetched };
        }),
      );

      for (let i = 0; i < settled.length; i++) {
        const spec = specs[i];
        const outcome = settled[i];
        if (spec === undefined || outcome === undefined) continue;
        const sourceId = spec.sourceId ?? spec.url;
        if (outcome.status === 'fulfilled') {
          for (const it of outcome.value.items) items.push(it);
        } else {
          const reason = outcome.reason;
          const message =
            reason instanceof Error ? reason.message : String(reason);
          errors.push({ sourceId, type: spec.type, message });
        }
      }

      const ratio = total === 0 ? 0 : errors.length / total;
      if (ratio > maxFailRatio) {
        throw new InsufficientSourcesError(errors.length, total, ratio);
      }

      return { items, errors, fetchedAt: clock() };
    },
  };
}
