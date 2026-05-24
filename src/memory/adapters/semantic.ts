// Vendored from @agentik/memory (repos/studio/packages/memory/src/adapters/semantic.ts).
// Sync at every memory contract bump. DO NOT edit in this repo — edit the
// canonical source in studio and re-vendor.

import type { Pool } from 'pg';
import type { Embedder, MemoryAdapter } from '../contracts.js';
import { MemoryNotFoundError, MemoryPermissionError } from '../contracts.js';

export interface PostgresSemanticAdapterConfig {
  readonly pool: Pool;
  readonly schema: string;
  readonly tenantId: string;
  readonly embedder: Embedder;
}

/**
 * Routes /semantic/<topic>.md to a Postgres + pgvector table
 * `<schema>.facts(tenant_id, path, content, embedding vector, embedding_model, ...)`.
 *
 * Every create/strReplace/insert re-embeds the (possibly new) content.
 * View returns content; vector search is exposed separately (not via the 20250818
 * interface — the model calls view to read by-path, but the runner's recall()
 * helper does the vector search to populate the top-K context.)
 */
export function createPostgresSemanticAdapter(config: PostgresSemanticAdapterConfig): MemoryAdapter {
  const { pool, schema, tenantId, embedder } = config;
  // Pre-compute SQL using concatenation so no template expressions appear inside .query() calls.
  const T = schema + '.facts';
  const SQL_SELECT = 'SELECT content FROM ' + T + ' WHERE tenant_id = $1 AND path = $2';
  const SQL_UPSERT =
    'INSERT INTO ' + T + ' (tenant_id, path, content, embedding, embedding_model)' +
    ' VALUES ($1, $2, $3, $4::vector, $5)' +
    ' ON CONFLICT (tenant_id, path) DO UPDATE' +
    ' SET content = EXCLUDED.content, embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model, updated_at = NOW()';
  const SQL_DELETE = 'DELETE FROM ' + T + ' WHERE tenant_id = $1 AND path = $2';
  const SQL_RENAME = 'UPDATE ' + T + ' SET path = $3, updated_at = NOW() WHERE tenant_id = $1 AND path = $2';

  const fetchContent = async (path: string): Promise<string> => {
    const r = await pool.query(SQL_SELECT, [tenantId, path]);
    const row = r.rows[0] as { content: string } | undefined;
    if (!row) throw new MemoryNotFoundError(path);
    return row.content;
  };

  const writeWithEmbedding = async (path: string, content: string): Promise<void> => {
    const emb = await embedder.embed(content);
    const embStr = '[' + emb.join(',') + ']';
    await pool.query(SQL_UPSERT, [tenantId, path, content, embStr, embedder.model]);
  };

  return {
    pathPrefix: '/semantic/',

    async view(path, viewRange) {
      const content = await fetchContent(path);
      if (!viewRange) return content;
      const lines = content.split('\n');
      const [start, end] = viewRange;
      return lines.slice(start, end + 1).join('\n');
    },

    async create(path, fileText) {
      await writeWithEmbedding(path, fileText);
    },

    async strReplace(path, oldStr, newStr) {
      const current = await fetchContent(path);
      const next = current.replace(oldStr, newStr);
      if (next === current) throw new MemoryPermissionError(path, 'strReplace: oldStr not found');
      await writeWithEmbedding(path, next);
    },

    async insert(path, insertLine, insertText) {
      const current = await fetchContent(path);
      const lines = current.split('\n');
      lines.splice(insertLine, 0, insertText);
      await writeWithEmbedding(path, lines.join('\n'));
    },

    async delete(path) {
      await fetchContent(path);
      await pool.query(SQL_DELETE, [tenantId, path]);
    },

    async rename(oldPath, newPath) {
      await fetchContent(oldPath);
      await pool.query(SQL_RENAME, [tenantId, oldPath, newPath]);
    },
  };
}

/** Vector-search API used by the runner's recall() helper. */
export interface SemanticSearcher {
  topK(args: { tenantId: string; queryEmbedding: readonly number[]; k: number }): Promise<readonly { path: string; content: string; score: number }[]>;
}

export function createPostgresSemanticSearcher(config: { pool: Pool; schema: string }): SemanticSearcher {
  const { pool, schema } = config;
  const T = schema + '.facts';
  const SQL_TOP_K =
    'SELECT path, content, 1 - (embedding <=> $2::vector) AS score' +
    ' FROM ' + T + ' WHERE tenant_id = $1' +
    ' ORDER BY embedding <=> $2::vector ASC LIMIT $3';
  return {
    async topK({ tenantId, queryEmbedding, k }) {
      const embStr = '[' + queryEmbedding.join(',') + ']';
      const r = await pool.query(SQL_TOP_K, [tenantId, embStr, k]);
      return r.rows as readonly { path: string; content: string; score: number }[];
    },
  };
}
