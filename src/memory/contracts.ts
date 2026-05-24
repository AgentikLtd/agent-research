// Vendored from @agentik/memory (repos/studio/packages/memory/src/contracts.ts).
// Sync at every memory contract bump. DO NOT edit in this repo — edit the
// canonical source in studio and re-vendor.

/**
 * @agentik/memory contracts.
 * Implements the Anthropic memory-tool 20250818 client-side interface,
 * routing by path prefix to per-agent (Postgres) and tenant-shared (HTTP) backends.
 */

/** The Anthropic memory-tool 20250818 contract — verbatim. */
export interface MemoryTool {
  view(path: string, viewRange?: readonly [number, number]): Promise<string>;
  create(path: string, fileText: string): Promise<void>;
  strReplace(path: string, oldStr: string, newStr: string): Promise<void>;
  insert(path: string, insertLine: number, insertText: string): Promise<void>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

/** Errors mirror POSIX semantics so the model's filesystem mental model holds. */
export class MemoryNotFoundError extends Error {
  readonly code = 'ENOENT' as const;
  constructor(public readonly path: string) {
    super(`ENOENT: no memory file at ${path}`);
  }
}

export class MemoryPermissionError extends Error {
  readonly code = 'EACCES' as const;
  constructor(public readonly path: string, public readonly reason: string) {
    super(`EACCES: cannot write ${path}: ${reason}`);
  }
}

export class MemoryPreconditionError extends Error {
  readonly code = 'EPRECONDITION' as const;
  constructor(public readonly path: string, public readonly expectedSha256: string, public readonly actualSha256: string) {
    super(`EPRECONDITION: ${path}: expected sha256 ${expectedSha256}, got ${actualSha256}`);
  }
}

/** A single durable fact extracted by the consolidation cron. */
export interface SemanticFact {
  id: string;
  path: string;
  text: string;
  topicTags: readonly string[];
  embedding: readonly number[];
  relevanceScore: number;
  sourceEpisodicIds: readonly string[];
  createdAt: Date;
  updatedAt: Date;
}

/** An episodic row written by the runner side-effect API. */
export interface EpisodicTurn {
  id: string;
  conversationId: string;
  skillId: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  spanId: string;
  tokensIn: number;
  tokensOut: number;
  costGbp: number;
  createdAt: Date;
}

/** Side-effect API used by the runner outside the tool surface. */
export interface EpisodicWriter {
  appendTurn(args: Omit<EpisodicTurn, 'id' | 'createdAt'>): Promise<string>;
}

/** Embedding helper used by the semantic adapter + consolidation. */
export interface Embedder {
  embed(text: string): Promise<readonly number[]>;
  readonly model: string;
  readonly dimensions: number;
}

/** Adapter interface — one per storage tier. */
export interface MemoryAdapter extends MemoryTool {
  readonly pathPrefix: string;
}

/** Router config — composed in the agent's index.ts at boot. */
export interface MemoryRouterConfig {
  readonly episodic: MemoryAdapter;
  readonly semantic: MemoryAdapter;
  readonly shared: MemoryAdapter;
}
