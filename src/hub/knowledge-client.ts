/**
 * Knowledge-query client — calls the hub's agent knowledge endpoint to
 * retrieve operator-uploaded vendor docs for the agent's knowledge base.
 *
 * Endpoint:
 *   POST /api/agents/<agentName>/knowledge/query
 *   Authorizes on the agent SLUG (agentName), NOT the agent UUID.
 *   See studio repo `apps/hub-ui/src/app/api/agents/[id]/knowledge/query/route.ts`.
 *
 * Best-effort: NEVER throws. Any failure (network error, non-200, invalid
 * body) returns `{ chunks: [] }` and emits a console.warn so silent
 * 403s (the GATE-1 failure mode if UUID were used) are diagnosable in logs.
 *
 * GATE-1 invariant: `agentName` MUST be the slug (env.AGENT_NAME, e.g.
 * `research-genesys`), not `AGENT_ID` (a UUID). The hub guards
 * `auth.agentName === params.id` — a UUID would 403 every retrieval.
 *
 * Wired in index.ts (Task B2) from `env.AGENT_NAME` + `env.HUB_AGENT_TOKEN`.
 */

import { z } from 'zod';
import type { KnowledgeQueryHitSlice } from '../contracts.js';

// Re-export so consumers that imported from this module don't break.
export type { KnowledgeQueryHitSlice };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KnowledgeClientDeps {
  readonly hubUrl: string;
  readonly agentName: string; // GATE-1: slug (env.AGENT_NAME), used in the URL path
  readonly token: string; // env.HUB_AGENT_TOKEN — bearer
  readonly fetcher?: typeof fetch; // test seam
}

/** Best-effort: never throws. Non-200 / network error / invalid body → { chunks: [] }. */
export type QueryKnowledge = (args: {
  query: string;
  topK?: number;
}) => Promise<{ chunks: KnowledgeQueryHitSlice[] }>;

// ---------------------------------------------------------------------------
// Zod schema (validates hub response)
// ---------------------------------------------------------------------------

const chunkSchema = z
  .object({
    content: z.string(),
    source_title: z.string(),
    score: z.number(),
  })
  .passthrough();

const responseSchema = z.object({
  chunks: z.array(chunkSchema),
});

const EMPTY: { chunks: KnowledgeQueryHitSlice[] } = { chunks: [] };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createKnowledgeClient(deps: KnowledgeClientDeps): QueryKnowledge {
  const fetcher = deps.fetcher ?? fetch;
  const hub = deps.hubUrl.replace(/\/$/, '');
  // GATE-1: slug in URL, never the UUID
  const url = `${hub}/api/agents/${encodeURIComponent(deps.agentName)}/knowledge/query`;
  const headers = {
    authorization: `Bearer ${deps.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };

  return async function queryKnowledge({ query, topK }) {
    let res: Response;
    try {
      res = await fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          ...(topK !== undefined ? { top_k: topK } : {}),
        }),
      });
    } catch (e) {
      console.warn(
        `[knowledge-client] query failed (non-critical): ${e instanceof Error ? e.message : String(e)}`,
      );
      return EMPTY;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const snippet = body.slice(0, 200);
      console.warn(
        `[knowledge-client] query failed (non-critical): HTTP ${res.status}${snippet ? ` — ${snippet}` : ''}`,
      );
      return EMPTY;
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (e) {
      console.warn(
        `[knowledge-client] query failed (non-critical): response body not valid JSON — ${e instanceof Error ? e.message : String(e)}`,
      );
      return EMPTY;
    }

    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `[knowledge-client] query failed (non-critical): response validation error — ${parsed.error.message}`,
      );
      return EMPTY;
    }

    return { chunks: parsed.data.chunks as KnowledgeQueryHitSlice[] };
  };
}
