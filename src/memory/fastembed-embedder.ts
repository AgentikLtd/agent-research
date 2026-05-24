// Agent-local. NOT vendored from @agentik/memory — this module pulls a local
// ONNX model via `fastembed` so the agent doesn't need an external
// /v1/embeddings API. The OpenAI-compatible embedder in `./embedder.ts` is
// still vendored and used as the fallback when EMBEDDER_API_KEY is set.
//
// Why local: the workspace has OpenRouter + Anthropic keys only; neither
// proxies /v1/embeddings. Running ONNX in-process via fastembed avoids the
// dependency on any external embedding provider.
//
// Model choice: BGESmallENV15 (BAAI/bge-small-en-v1.5, 384 dimensions).
// - Top of the MTEB leaderboard for its size class.
// - 384 dims keeps the semantic table small (vector(384)) — see 0004 migration.
// - Quantised ONNX weights → low RAM (~120MB) and CPU-only inference.
// - The default model in fastembed-js.

import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import type { Embedder } from './contracts.js';

export interface FastEmbedEmbedderConfig {
  /** Override the cache directory the ONNX weights are extracted into. */
  readonly cacheDir?: string;
  /** Override the model (default BGESmallENV15 = 384-dim). */
  readonly model?: EmbeddingModel;
  /** Override the dimensions advertised by `Embedder.dimensions`. Must match `model`. */
  readonly dimensions?: number;
  /** Optional fetch impl swap for tests — fastembed itself doesn't fetch, so this is currently unused. */
  readonly showDownloadProgress?: boolean;
}

/** Module-singleton — FlagEmbedding loads its ONNX model lazily; we cache it across boots. */
let cachedModel: FlagEmbedding | undefined;
let cachedKey: string | undefined;

async function getModel(
  model: EmbeddingModel,
  cacheDir: string | undefined,
  showProgress: boolean,
): Promise<FlagEmbedding> {
  const key = `${model}::${cacheDir ?? ''}`;
  if (cachedModel && cachedKey === key) return cachedModel;
  cachedModel = await FlagEmbedding.init({
    model: model as Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>,
    ...(cacheDir !== undefined ? { cacheDir } : {}),
    showDownloadProgress: showProgress,
  });
  cachedKey = key;
  return cachedModel;
}

/**
 * Build an in-process embedder backed by fastembed's ONNX runtime.
 *
 * Async because the model has to download (first run only) and tokenizer
 * + ONNX session init are async. Callers `await` this at boot.
 *
 * The returned Embedder's `embed()` is sync per the contract but defers to
 * fastembed's `AsyncGenerator<number[][]>` under the hood — we collect the
 * first batch's first vector and return it.
 */
export async function createFastEmbedEmbedder(
  config: FastEmbedEmbedderConfig = {},
): Promise<Embedder> {
  const model = config.model ?? EmbeddingModel.BGESmallENV15;
  const dimensions = config.dimensions ?? 384;
  const showProgress = config.showDownloadProgress ?? false;

  const flag = await getModel(model, config.cacheDir, showProgress);
  const modelName = `fastembed-${String(model)}`;

  return {
    model: modelName,
    dimensions,

    async embed(text: string): Promise<readonly number[]> {
      // fastembed batches; we always pass a single-element array. Batch size
      // of 1 avoids padding-induced jitter on the embedding values.
      const batches = flag.embed([text], 1);
      for await (const batch of batches) {
        const first = batch[0];
        if (!first) continue;
        return first;
      }
      throw new Error('fastembed: no embedding returned for input');
    },
  };
}
