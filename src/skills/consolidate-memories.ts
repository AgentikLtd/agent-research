// Instantiated from studio-memory-substrate template for genesys-research.
// Schemas: agent_research_semantic (semantic), agent_research_episodic (episodic).

import type { Pool } from 'pg';
import type { GatewayClient } from '../llm/gateway-client.js';
import type { Embedder } from '../memory/contracts.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Skill } from './registry.js';

const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '../memory/consolidate-prompt.md');

export interface ConsolidateMemoriesDeps {
  pool: Pool;
  tenantId: string;
  gateway: GatewayClient;
  embedder: Embedder;
  model: string;
  maxCostGbp?: number;
}

interface ProposedFact { text: string; topic_tags: string[]; confidence: number; source_episodic_ids: string[] }

export async function runConsolidate(deps: ConsolidateMemoriesDeps): Promise<{ written: number; cost: number; skipped: string[] }> {
  const cap = deps.maxCostGbp ?? 0.20;

  const episodic = await deps.pool.query(
    `SELECT id, path, content, role, skill_id, created_at
     FROM agent_research_episodic.entries
     WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY created_at ASC`,
    [deps.tenantId],
  );
  if (episodic.rows.length === 0) return { written: 0, cost: 0, skipped: [] };

  const systemPrompt = readFileSync(PROMPT_PATH, 'utf8');
  const userPayload = JSON.stringify(episodic.rows.map((r) => ({
    id: r.id, role: r.role, skill: r.skill_id, content: String(r.content).slice(0, 4000),
  })));

  const response = await deps.gateway.send({
    model: deps.model,
    system: systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: `Episodic transcripts (JSON):\n${userPayload}` }] }],
    params: { maxOutputTokens: 4000 },
    skill: 'consolidate-memories',
  });

  if (!response.ok) {
    throw new Error(`consolidate-memories: gateway error: ${response.error.message}`);
  }

  const rawText = response.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');

  const costGbp = response.costGbp ?? 0;

  if (costGbp > cap) {
    throw new Error(`consolidate-memories: cost £${costGbp.toFixed(4)} exceeded cap £${cap.toFixed(2)}`);
  }

  let parsed: { facts: ProposedFact[] };
  try {
    const raw = rawText.match(/\{[\s\S]*\}/)?.[0] ?? '{"facts":[]}';
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`consolidate-memories: parse failed: ${(err as Error).message}`);
  }

  const skipped: string[] = [];
  let written = 0;
  for (const f of parsed.facts) {
    if (f.confidence < 0.6) { skipped.push(`low-confidence: ${f.text.slice(0, 60)}`); continue; }
    if (containsLikelyPii(f.text)) { skipped.push(`pii-suspected: ${f.text.slice(0, 60)}`); continue; }
    const emb = await deps.embedder.embed(f.text);
    const embStr = `[${emb.join(',')}]`;
    const path = `/semantic/${slugify(f.topic_tags[0] ?? 'misc')}/${slugify(f.text.slice(0, 40))}.md`;
    await deps.pool.query(
      `INSERT INTO agent_research_semantic.facts (tenant_id, path, content, topic_tags, embedding, embedding_model, relevance_score, source_episodic_ids)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8)
       ON CONFLICT (tenant_id, path) DO UPDATE
       SET content = EXCLUDED.content, embedding = EXCLUDED.embedding,
           topic_tags = EXCLUDED.topic_tags, relevance_score = EXCLUDED.relevance_score,
           source_episodic_ids = EXCLUDED.source_episodic_ids, updated_at = NOW()`,
      [deps.tenantId, path, f.text, f.topic_tags, embStr, deps.embedder.model, f.confidence, f.source_episodic_ids],
    );
    written++;
  }

  await rebuildSemanticIndex(deps);

  return { written, cost: costGbp, skipped };
}

async function rebuildSemanticIndex(deps: ConsolidateMemoriesDeps): Promise<void> {
  const rows = await deps.pool.query(
    `SELECT path, LEFT(content, 120) AS summary FROM agent_research_semantic.facts WHERE tenant_id = $1 ORDER BY path`,
    [deps.tenantId],
  );
  const indexBody = ['# Semantic memory — index\n', ...rows.rows.map((r) => `- [\`${r.path}\`](${r.path}) — ${r.summary}`)].join('\n');
  const idxEmb = await deps.embedder.embed('semantic memory index');
  const idxEmbStr = `[${idxEmb.join(',')}]`;
  await deps.pool.query(
    `INSERT INTO agent_research_semantic.facts (tenant_id, path, content, topic_tags, embedding, embedding_model, relevance_score, source_episodic_ids)
     VALUES ($1, '/semantic/INDEX.md', $2, ARRAY['__index__'], $3::vector, $4, 1.0, '{}')
     ON CONFLICT (tenant_id, path) DO UPDATE
     SET content = EXCLUDED.content, embedding = EXCLUDED.embedding, updated_at = NOW()`,
    [deps.tenantId, indexBody, idxEmbStr, deps.embedder.model],
  );
}

export interface CreateConsolidateMemoriesSkillDeps {
  pool: Pool;
  tenantId: string;
  gateway: GatewayClient;
  embedder: Embedder;
  model: string;
  maxCostGbp?: number;
}

export function createConsolidateMemoriesSkill(
  deps: CreateConsolidateMemoriesSkillDeps,
): Skill<Record<string, never>, { written: number; cost: number; skipped: string[] }> {
  return {
    name: 'consolidate-memories',
    description: 'Extract durable facts from episodic transcripts and write them to semantic memory.',
    invoke: (_args) => runConsolidate(deps),
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
}

function containsLikelyPii(text: string): boolean {
  const emailRx = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  const phoneRx = /(\+?\d[\d\s-]{7,}\d)/;
  return emailRx.test(text) || phoneRx.test(text);
}
