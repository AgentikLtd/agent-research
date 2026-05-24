import { describe, expect, it, vi } from 'vitest';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { runConsolidate } from '../../src/skills/consolidate-memories.js';
import { createNullEmbedder } from '../../src/memory/embedder.js';
import type { GatewayClient, LlmSendResult } from '../../src/llm/gateway-client.js';

function mockPool(seq: ReadonlyArray<QueryResultRow[]>): Pool {
  let i = 0;
  return {
    query: vi.fn(async () => ({ rows: seq[i++] ?? [], command: 'SELECT', rowCount: 0 }) as unknown as QueryResult),
  } as unknown as Pool;
}

function mockGateway(result: LlmSendResult): GatewayClient {
  return { send: vi.fn(async () => result) };
}

describe('runConsolidate', () => {
  it('skips when no episodic rows in the window', async () => {
    const pool = mockPool([[]]);
    const gateway = mockGateway({ ok: true, content: [], usage: { inputTokens: 0, outputTokens: 0 } });
    const r = await runConsolidate({ pool, tenantId: 't1', gateway, embedder: createNullEmbedder('null', 1536), model: 'deepseek/deepseek-v4-pro' });
    expect(r.written).toBe(0);
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('writes high-confidence facts to semantic', async () => {
    const pool = mockPool([
      [{ id: 'e1', path: '/episodic/c/t.md', content: 'agent saw new Genesys feature', role: 'assistant', skill_id: 'synthesize-brief', created_at: new Date() }],
      // INSERT fact row
      [],
      // SELECT for rebuildSemanticIndex
      [{ path: '/semantic/genesys/genesys-announced-ai-studio-at-ec-2026.md', summary: 'Genesys announced AI Studio at EC 2026-05' }],
      // INSERT index row
      [],
    ]);
    const gateway = mockGateway({
      ok: true,
      content: [{ type: 'text', text: JSON.stringify({ facts: [{ text: 'Genesys announced AI Studio at EC 2026-05', topic_tags: ['genesys', 'ai-studio'], confidence: 0.9, source_episodic_ids: ['e1'] }] }) }],
      usage: { inputTokens: 100, outputTokens: 50 },
      costGbp: 0.02,
    });
    const r = await runConsolidate({ pool, tenantId: 't1', gateway, embedder: createNullEmbedder('null', 1536), model: 'deepseek/deepseek-v4-pro' });
    expect(r.written).toBe(1);
    expect(r.cost).toBeLessThan(0.20);
  });

  it('aborts when cost exceeds cap', async () => {
    const pool = mockPool([[{ id: 'e1', path: '/episodic/c/t.md', content: 'x', role: 'assistant', skill_id: 'synthesize-brief', created_at: new Date() }]]);
    const gateway = mockGateway({ ok: true, content: [{ type: 'text', text: '{"facts":[]}' }], usage: { inputTokens: 1, outputTokens: 1 }, costGbp: 0.30 });
    await expect(runConsolidate({ pool, tenantId: 't1', gateway, embedder: createNullEmbedder('null', 1536), model: 'deepseek/deepseek-v4-pro' })).rejects.toThrow(/cost £0.3000 exceeded cap/);
  });
});
