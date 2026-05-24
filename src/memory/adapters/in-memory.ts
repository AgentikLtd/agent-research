// Vendored from @agentik/memory (repos/studio/packages/memory/src/adapters/in-memory.ts).
// Sync at every memory contract bump. DO NOT edit in this repo — edit the
// canonical source in studio and re-vendor.

import type { MemoryAdapter } from '../contracts.js';
import { MemoryNotFoundError } from '../contracts.js';

export interface InMemoryAdapterConfig {
  readonly pathPrefix: string;
}

export function createInMemoryAdapter(config: InMemoryAdapterConfig): MemoryAdapter {
  const store = new Map<string, string>();

  const requireExisting = (path: string): string => {
    const v = store.get(path);
    if (v === undefined) throw new MemoryNotFoundError(path);
    return v;
  };

  return {
    pathPrefix: config.pathPrefix,

    // eslint-disable-next-line @typescript-eslint/require-await
    async view(path, viewRange) {
      const text = requireExisting(path);
      if (!viewRange) return text;
      const lines = text.split('\n');
      const [start, end] = viewRange;
      return lines.slice(start, end + 1).join('\n');
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async create(path, fileText) {
      store.set(path, fileText);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async strReplace(path, oldStr, newStr) {
      const text = requireExisting(path);
      store.set(path, text.replace(oldStr, newStr));
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async insert(path, insertLine, insertText) {
      const text = requireExisting(path);
      const lines = text.split('\n');
      lines.splice(insertLine, 0, insertText);
      store.set(path, lines.join('\n'));
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async delete(path) {
      requireExisting(path);
      store.delete(path);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async rename(oldPath, newPath) {
      const text = requireExisting(oldPath);
      store.set(newPath, text);
      store.delete(oldPath);
    },
  };
}
