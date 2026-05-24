// Vendored from @agentik/memory (repos/studio/packages/memory/src/episodic-writer.ts).
// Sync at every memory contract bump. DO NOT edit in this repo — edit the
// canonical source in studio and re-vendor.

import type { Pool } from 'pg';
import type { EpisodicTurn, EpisodicWriter } from './contracts.js';

export interface PostgresEpisodicWriterConfig {
  readonly pool: Pool;
  readonly schema: string;
  readonly agentName: string;
  readonly tenantId: string;
}

/**
 * Writes a single turn-row to the per-agent episodic table.
 * Path convention: /episodic/<conversation_id>/turn_<index>_<role>.md
 *
 * Called by the runner as a side-effect after every skill invocation — NOT
 * called by the LLM through the memory tool.
 */
export function createPostgresEpisodicWriter(config: PostgresEpisodicWriterConfig): EpisodicWriter {
  const { pool, schema, tenantId } = config;
  // Pre-compute SQL using concatenation so no template expressions appear inside .query() calls.
  const T = schema + '.entries';
  const SQL_INSERT =
    'INSERT INTO ' + T +
    ' (tenant_id, path, content, conversation_id, skill_id, turn_index, role, tool_name, span_id, tokens_in, tokens_out, cost_gbp)' +
    ' VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)' +
    ' RETURNING id';

  return {
    async appendTurn(args) {
      const path = '/episodic/' + args.conversationId + '/turn_' + String(args.turnIndex) + '_' + args.role + '.md';
      const r = await pool.query(SQL_INSERT, [
        tenantId, path, args.content,
        args.conversationId, args.skillId, args.turnIndex, args.role,
        args.toolName ?? null, args.spanId, args.tokensIn, args.tokensOut, args.costGbp,
      ]);
      const row = r.rows[0] as { id: string };
      return row.id;
    },
  };
}

export type { EpisodicTurn };
