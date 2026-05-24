// Vendored from @agentik/memory (repos/studio/packages/memory/src/adapters/episodic.ts).
// Sync at every memory contract bump. DO NOT edit in this repo — edit the
// canonical source in studio and re-vendor.

import type { Pool } from 'pg';
import type { MemoryAdapter } from '../contracts.js';
import { MemoryNotFoundError, MemoryPermissionError } from '../contracts.js';

export interface PostgresEpisodicAdapterConfig {
  readonly pool: Pool;
  readonly schema: string;
  readonly agentName: string;
  readonly tenantId: string;
}

/**
 * Routes /episodic/<conv_id>/turn_<n>.md (and arbitrary /episodic/ paths) to
 * a Postgres table `<schema>.entries(tenant_id, path, content, ...)`.
 *
 * The model uses this through the memory-tool 20250818 interface — view as
 * filesystem; create writes one row keyed by path; strReplace/insert/delete/rename
 * operate on that row's `content` column.
 */
export function createPostgresEpisodicAdapter(config: PostgresEpisodicAdapterConfig): MemoryAdapter {
  const { pool, schema, tenantId } = config;
  // Pre-compute SQL using concatenation so no template expressions appear inside .query() calls.
  const T = schema + '.entries';
  const SQL_SELECT = 'SELECT content FROM ' + T + ' WHERE tenant_id = $1 AND path = $2';
  const SQL_INSERT =
    'INSERT INTO ' + T + ' (tenant_id, path, content) VALUES ($1, $2, $3)' +
    ' ON CONFLICT (tenant_id, path) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()';
  const SQL_UPDATE_CONTENT = 'UPDATE ' + T + ' SET content = $3, updated_at = NOW() WHERE tenant_id = $1 AND path = $2';
  const SQL_DELETE = 'DELETE FROM ' + T + ' WHERE tenant_id = $1 AND path = $2';
  const SQL_RENAME = 'UPDATE ' + T + ' SET path = $3, updated_at = NOW() WHERE tenant_id = $1 AND path = $2';

  const fetchContent = async (path: string): Promise<string> => {
    const r = await pool.query(SQL_SELECT, [tenantId, path]);
    const row = r.rows[0] as { content: string } | undefined;
    if (!row) throw new MemoryNotFoundError(path);
    return row.content;
  };

  return {
    pathPrefix: '/episodic/',

    async view(path, viewRange) {
      const content = await fetchContent(path);
      if (!viewRange) return content;
      const lines = content.split('\n');
      const [start, end] = viewRange;
      return lines.slice(start, end + 1).join('\n');
    },

    async create(path, fileText) {
      await pool.query(SQL_INSERT, [tenantId, path, fileText]);
    },

    async strReplace(path, oldStr, newStr) {
      const current = await fetchContent(path);
      const next = current.replace(oldStr, newStr);
      if (next === current) throw new MemoryPermissionError(path, 'strReplace: oldStr not found');
      await pool.query(SQL_UPDATE_CONTENT, [tenantId, path, next]);
    },

    async insert(path, insertLine, insertText) {
      const current = await fetchContent(path);
      const lines = current.split('\n');
      lines.splice(insertLine, 0, insertText);
      await pool.query(SQL_UPDATE_CONTENT, [tenantId, path, lines.join('\n')]);
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
