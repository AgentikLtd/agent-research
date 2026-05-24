import { describe, expect, it, vi } from 'vitest';
import { recall } from '../../src/memory/recall.js';
import { createNullEmbedder } from '../../src/memory/embedder.js';
import type { SemanticSearcher } from '../../src/memory/adapters/semantic.js';
import type { MemoryTool } from '../../src/memory/contracts.js';

describe('recall()', () => {
  it('returns empty block when nothing relevant found', async () => {
    const searcher: SemanticSearcher = { topK: vi.fn(async () => []) };
    const sharedView = vi.fn(async () => { throw new Error('not found'); });
    const memory = { view: sharedView } as unknown as MemoryTool;
    const block = await recall({
      topicHint: 'Genesys Q2 update', tenantId: 'org_3Dm9w429DcZ2cD3J5KQ2Y6NZyY4', embedder: createNullEmbedder(),
      semanticSearcher: searcher, memory, topK: 3,
    });
    expect(block).toBe('');
  });

  it('returns a prepend block with semantic + shared facts', async () => {
    const searcher: SemanticSearcher = {
      topK: vi.fn(async () => [{ path: '/semantic/genesys/foo.md', content: 'Genesys announced X.', score: 0.92 }]),
    };
    const memory = {
      view: vi.fn(async (p: string) => p === '/shared/INDEX.md' ? '# index\n- [/shared/runbook.md](/shared/runbook.md) — runbook' : ''),
    } as unknown as MemoryTool;

    const block = await recall({
      topicHint: 'Genesys Q2 update', tenantId: 'org_3Dm9w429DcZ2cD3J5KQ2Y6NZyY4', embedder: createNullEmbedder(),
      semanticSearcher: searcher, memory, topK: 3,
    });
    expect(block).toContain('Relevant prior learnings');
    expect(block).toContain('Genesys announced X');
    expect(block).toContain('/shared/INDEX.md');
  });
});
