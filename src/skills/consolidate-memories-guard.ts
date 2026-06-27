/**
 * No-op guard for the consolidate-memories skill.
 *
 * The cron scheduler resolves skill ids from the registry unconditionally.
 * The real `createConsolidateMemoriesSkill` requires a live Postgres pool,
 * gateway client, and embedder — none of which are available when
 * TENANT_DATABASE_URL / DATABASE_URL is unset.  Without this guard the
 * daily 03:00 cron fires and immediately throws `UnknownSkillError`.
 *
 * Registration strategy (src/index.ts):
 *   - `dbUrl` set   → register the REAL skill (keeps the existing path).
 *   - `dbUrl` unset → register THIS guard (log + return cleanly; cron satisfiable).
 */

import type { Skill } from './registry.js';

export function createNoopConsolidateMemoriesSkill(): Skill<
  Record<string, never>,
  { written: number; cost: number; skipped: string[] }
> {
  return {
    name: 'consolidate-memories',
    description:
      'Extract durable facts from episodic transcripts and write them to semantic memory.',
    invoke(_args) {
      console.info(
        '[consolidate-memories] skipped — no memory DB configured (TENANT_DATABASE_URL / DATABASE_URL not set)',
      );
      return Promise.resolve({ written: 0, cost: 0, skipped: ['no-db'] });
    },
  };
}
