// Vendored from @agentik/memory (repos/studio/packages/memory/src/adapters/shared.ts).
// Sync at every memory contract bump. DO NOT edit in this repo — edit the
// canonical source in studio and re-vendor.

import type { MemoryAdapter } from '../contracts.js';
import { MemoryNotFoundError, MemoryPermissionError } from '../contracts.js';

export interface HttpSharedAdapterConfig {
  readonly hubBaseUrl: string;
  readonly bearer: string;
  readonly fetchImpl?: typeof fetch;
  /** Timeout for view calls, ms. Default 5000. */
  readonly timeoutMs?: number;
}

/**
 * Read-only HTTP client for the hub's tenant-shared memory store.
 * Specialist agents see this surface through the memory router; all writes
 * are EACCES (only Concierge + the tenant-dreaming cron mutate /shared/, via
 * the hub's in-process SharedMemoryService — not via this adapter).
 */
export function createHttpSharedAdapter(config: HttpSharedAdapterConfig): MemoryAdapter {
  const f = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 5000;
  const denied = (path: string): never => {
    throw new MemoryPermissionError(path, 'specialist agents are read-only on /shared/; writes go via Concierge or tenant-dreaming');
  };

  return {
    pathPrefix: '/shared/',

    async view(path) {
      const url = config.hubBaseUrl + '/api/shared-memory/read?path=' + encodeURIComponent(path);
      const res = await f(url, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + config.bearer },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) throw new MemoryNotFoundError(path);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(('shared-memory read ' + String(res.status) + ': ' + body).trim());
      }
      const data = (await res.json()) as { content: string };
      return data.content;
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async create(path) { return denied(path); },
    // eslint-disable-next-line @typescript-eslint/require-await
    async strReplace(path) { return denied(path); },
    // eslint-disable-next-line @typescript-eslint/require-await
    async insert(path) { return denied(path); },
    // eslint-disable-next-line @typescript-eslint/require-await
    async delete(path) { return denied(path); },
    // eslint-disable-next-line @typescript-eslint/require-await
    async rename(oldPath) { return denied(oldPath); },
  };
}
