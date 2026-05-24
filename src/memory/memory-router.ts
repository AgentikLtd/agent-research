// Vendored from @agentik/memory (repos/studio/packages/memory/src/memory-router.ts).
// Sync at every memory contract bump. DO NOT edit in this repo — edit the
// canonical source in studio and re-vendor.

import type { MemoryAdapter, MemoryRouterConfig, MemoryTool } from './contracts.js';
import { MemoryNotFoundError } from './contracts.js';

/**
 * The single MemoryTool surface the LLM sees. Routes by leading path segment to
 * one of three adapters; everything else returns ENOENT.
 *
 * rename across tiers (e.g. moving an episodic file into semantic) is explicitly
 * rejected — promotion between tiers is the consolidation cron's job, not the
 * agent's.
 */
export function createMemoryRouter(config: MemoryRouterConfig): MemoryTool {
  const adapters: readonly MemoryAdapter[] = [config.episodic, config.semantic, config.shared];

  const route = (path: string): MemoryAdapter => {
    for (const a of adapters) {
      if (path.startsWith(a.pathPrefix)) return a;
    }
    throw new MemoryNotFoundError(path);
  };

  return {
    async view(path, range) {
      return route(path).view(path, range);
    },
    async create(path, text) {
      return route(path).create(path, text);
    },
    async strReplace(path, oldStr, newStr) {
      return route(path).strReplace(path, oldStr, newStr);
    },
    async insert(path, line, text) {
      return route(path).insert(path, line, text);
    },
    async delete(path) {
      return route(path).delete(path);
    },
    async rename(oldPath, newPath) {
      const a = route(oldPath);
      const b = route(newPath);
      if (a !== b) throw new Error(`rename across tiers not permitted: ${oldPath} → ${newPath}`);
      return a.rename(oldPath, newPath);
    },
  };
}
