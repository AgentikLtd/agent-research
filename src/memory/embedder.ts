// Vendored from @agentik/memory (repos/studio/packages/memory/src/embedder.ts).
// Sync at every memory contract bump. DO NOT edit in this repo — edit the
// canonical source in studio and re-vendor.

import type { Embedder } from './contracts.js';

/**
 * OpenAI / OpenAI-compatible embedder. Calls the hub's gateway when available;
 * otherwise the provider directly. Used by the semantic adapter to embed on write
 * and by recall() to embed the query string.
 */
export interface OpenAiEmbedderConfig {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createOpenAiEmbedder(config: OpenAiEmbedderConfig): Embedder {
  const f = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  return {
    model: config.model,
    dimensions: config.model.includes('-large') ? 3072 : 1536,

    async embed(text) {
      const res = await f(`${config.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`embed ${res.status}: ${body}`.trim());
      }
      const data = (await res.json()) as { data: ReadonlyArray<{ embedding: readonly number[] }> };
      const e = data.data[0]?.embedding;
      if (!e) throw new Error('embed: empty response');
      return e;
    },
  };
}

/** A null embedder for unit tests that don't exercise vector search. */
export function createNullEmbedder(model = 'null', dimensions = 3): Embedder {
  // eslint-disable-next-line @typescript-eslint/require-await
  return { model, dimensions, embed: async () => Array.from({ length: dimensions }, () => 0) };
}
