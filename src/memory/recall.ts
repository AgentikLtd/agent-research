import type { Embedder, MemoryTool } from './contracts.js';
import type { SemanticSearcher } from './adapters/semantic.js';

export interface RecallArgs {
  readonly topicHint: string;
  readonly tenantId: string;
  readonly embedder: Embedder;
  readonly semanticSearcher: SemanticSearcher;
  readonly memory: MemoryTool;
  readonly topK?: number;
}

/**
 * Builds a "Relevant prior learnings" block prepended to a skill's system prompt.
 * Pulls:
 *  - top-K facts from /semantic/ (vector search over the agent's own memory).
 *  - /shared/INDEX.md (if present) — the tenant-wide index built by the
 *    tenant-dreaming pass. We surface the INDEX rather than top-K from /shared/
 *    because the index is the keynote's recommended retrieval pattern.
 *
 * Returns the empty string when nothing useful is available — let the model see
 * no block, not an empty "Relevant prior learnings:" header.
 */
export async function recall(args: RecallArgs): Promise<string> {
  const topK = args.topK ?? 3;

  const queryEmbedding = await args.embedder.embed(args.topicHint);
  const facts = await args.semanticSearcher.topK({
    tenantId: args.tenantId, queryEmbedding, k: topK,
  });

  let sharedIndex = '';
  try {
    sharedIndex = await args.memory.view('/shared/INDEX.md');
  } catch {
    // /shared/INDEX.md may not exist yet — that's fine.
  }

  const semanticPart = facts.length === 0 ? '' : (
    `### From this agent's prior runs\n` +
    facts.map((f) => `- \`${f.path}\` (relevance ${f.score.toFixed(2)}): ${f.content.slice(0, 240)}`).join('\n')
  );
  const sharedPart = sharedIndex ? `### Tenant-shared memory index (/shared/INDEX.md)\n${sharedIndex.slice(0, 1200)}` : '';

  if (!semanticPart && !sharedPart) return '';
  return `## Relevant prior learnings\n\n${semanticPart}\n\n${sharedPart}\n\nUse these as background context. Do not parrot them — extend or refine.\n`;
}
