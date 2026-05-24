/**
 * E2E smoke test: episodic write → semantic promote → vector search round-trip.
 *
 * Gated by MEMORY_E2E_DATABASE_URL — the entire suite is skipped when the env
 * var is absent so this never runs in unit-test CI. Set it to a real Postgres
 * connection string (with pgvector installed + the memory schemas migrated)
 * to exercise the real adapters end-to-end.
 *
 * Schema tables expected:
 *   agent_research_episodic.entries
 *   agent_research_semantic.facts (with pgvector `embedding vector(N)` column)
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { createPostgresEpisodicWriter } from '../../src/memory/episodic-writer.js';
import {
  createPostgresSemanticAdapter,
  createPostgresSemanticSearcher,
} from '../../src/memory/adapters/semantic.js';
import { createNullEmbedder } from '../../src/memory/embedder.js';

const DATABASE_URL = process.env.MEMORY_E2E_DATABASE_URL ?? '';
const skip = DATABASE_URL === '';

describe.skipIf(skip)('memory e2e smoke', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const pool = new Pool({ connectionString: DATABASE_URL });
  const embedder = createNullEmbedder('null', 1536);
  const writer = createPostgresEpisodicWriter({
    pool,
    schema: 'agent_research_episodic',
    agentName: 'genesys-research',
    tenantId,
  });
  const semantic = createPostgresSemanticAdapter({
    pool,
    schema: 'agent_research_semantic',
    tenantId,
    embedder,
  });
  const searcher = createPostgresSemanticSearcher({
    pool,
    schema: 'agent_research_semantic',
  });

  beforeAll(async () => {
    // Best-effort truncate — if the tables don't exist yet, .catch(() => undefined)
    // prevents a hard failure so the test can report a useful message via the
    // subsequent INSERT/SELECT rather than an opaque beforeAll crash.
    await pool.query('TRUNCATE agent_research_episodic.entries').catch(() => undefined);
    await pool.query('TRUNCATE agent_research_semantic.facts').catch(() => undefined);
  });

  it('round-trip: write episodic → manually promote to semantic → vector search returns it', async () => {
    // 1. Write an episodic turn (simulates what the runner appends after synthesize-brief).
    await writer.appendTurn({
      conversationId: 'c1',
      skillId: 'synthesize-brief',
      turnIndex: 0,
      role: 'assistant',
      content: 'Genesys announced AI Studio at Enterprise Connect 2026.',
      spanId: 'sp1',
      tokensIn: 100,
      tokensOut: 200,
      costGbp: 0.001,
    });

    // 2. Promote to semantic (simulates consolidation cron extracting a durable fact).
    await semantic.create(
      '/semantic/genesys/ai-studio.md',
      'Genesys announced AI Studio at Enterprise Connect 2026.',
    );

    // 3. Vector search with a null embedder (all-zeros vector) — the null embedder
    //    always returns the same vector, so cosine distance is 0 for all rows and the
    //    top-K result is deterministic (first inserted row wins). This verifies the
    //    full adapter stack without a real embedding model.
    const queryEmb = await embedder.embed('Genesys AI Studio');
    const hits = await searcher.topK({ tenantId, queryEmbedding: queryEmb, k: 3 });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toMatch(/AI Studio/);
  });
});
