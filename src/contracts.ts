/**
 * Local restatement of consumed `@agentik/shared-types` slices needed by hub +
 * a2a + llm clients. Mirrors the same pattern as
 * `repos/agent-briefing/src/contracts.ts`.
 *
 * Canonical sources:
 *   - `@agentik/shared-types/a2a`     — JSON-RPC + Message/Task shapes
 *   - `@agentik/shared-types/gateway` — LLM gateway request/response shapes
 *
 * Each agent repo is intentionally STANDALONE: there is no `workspace:*`
 * dependency on shared-types. Types below are byte-vendored on the date noted
 * in §Update log; sync at every shared-types upgrade. See workspace
 * `docs/cookbook.md` (topic: contracts-vendored-not-workspace) for the rebase
 * recipe.
 *
 * §Update log
 *   - 2026-05-19 — initial vendor (Phase 6 of agent-research scaffold).
 *                  Sourced from shared-types @ commit on `main`.
 *   - 2026-05-20 — added LlmServerTool + LlmRequestTool (ADR-0018 web_search
 *                  server tool support); LlmRequest.tools widened to
 *                  LlmRequestTool[].
 */

// ---------------------------------------------------------------------------
// a2a (subset) — JSON-RPC 2.0 envelopes + Message/Task model
// Canonical: @agentik/shared-types/a2a
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly method: M;
  readonly params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: R;
}

export interface JsonRpcError {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type MessageRole = 'ROLE_UNSPECIFIED' | 'ROLE_USER' | 'ROLE_AGENT';

export type TaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED';

export interface TextPart {
  readonly text: string;
}
export interface DataPart {
  readonly data: Record<string, unknown>;
}
export type Part = TextPart | DataPart;

export interface Message {
  readonly role: MessageRole;
  readonly parts: ReadonlyArray<Part>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TaskStatus {
  readonly state: TaskState;
  readonly message?: Message;
  readonly timestamp?: string;
}

export interface Task {
  readonly id: string;
  readonly status: TaskStatus;
  readonly history?: ReadonlyArray<Message>;
}

export interface MessageSendConfiguration {
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MessageSendParams {
  readonly message: Message;
  readonly configuration?: MessageSendConfiguration;
}

export type MessageSendResult = Message | Task;

// ---------------------------------------------------------------------------
// gateway (subset) — LLM request/response shapes consumed by gateway-client +
// compose-brief.
// Canonical: @agentik/shared-types/gateway
// ---------------------------------------------------------------------------

/** Roles that a turn can carry. `system` is hoisted out of the array. */
export type LlmRole = 'user' | 'assistant';

/** Plain text part. `cacheControl` is a hint; drivers without prompt-caching ignore it. */
export interface LlmTextPart {
  readonly type: 'text';
  readonly text: string;
  readonly cacheControl?: 'ephemeral';
}

/** Image input — URL or inline base64. */
export interface LlmImagePart {
  readonly type: 'image';
  readonly source:
    | { readonly kind: 'url'; readonly url: string }
    | {
        readonly kind: 'base64';
        readonly mediaType: string;
        readonly data: string;
      };
}

/** Assistant-emitted tool invocation. `id` correlates with the matching tool_result. */
export interface LlmToolUsePart {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** Tool invocation result fed back on the next turn (carried as a `user` part). */
export interface LlmToolResultPart {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  readonly content: string | readonly LlmContentPart[];
  readonly isError?: boolean;
}

/** Discriminated union over content parts. */
export type LlmContentPart =
  | LlmTextPart
  | LlmImagePart
  | LlmToolUsePart
  | LlmToolResultPart;

/** One turn in the conversation. */
export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: readonly LlmContentPart[];
}

/** Tool declaration advertised to the model. */
export interface LlmTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/**
 * Provider-native server tool — runs in-flight, no client round-trip.
 * Mirrors `@agentik/shared-types/gateway` `LlmServerTool` (ADR-0018).
 */
export interface LlmServerTool {
  readonly kind: 'server';
  readonly tool: 'web_search';
  readonly maxResults?: number;
}

/** Either a client tool or a provider server tool. */
export type LlmRequestTool = LlmTool | LlmServerTool;

/** Tool-use hint passed alongside an `LlmRequest`. */
export type LlmToolChoice =
  | { readonly kind: 'auto' }
  | { readonly kind: 'any' }
  | { readonly kind: 'none' }
  | { readonly kind: 'tool'; readonly name: string };

/** Token-budget controls. `maxOutputTokens` is required (every provider needs one). */
export interface LlmGenerationParams {
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
}

/** Tenancy + call-context metadata. Required on every gateway call. */
export interface LlmCallContext {
  readonly tenantId: string;
  readonly agentId: string;
  readonly skillId?: string;
  readonly traceId?: string;
}

/** Opaque provider id (gateway-resolved). */
export type LlmProviderId = string;

/** Token usage echoed in the response. */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
}

/** Cost attribution (ISO 4217). `markupAmount` is the share already in `amount`. */
export interface LlmCost {
  readonly currency: string;
  readonly amount: number;
  readonly markupAmount?: number;
}

/** Which provider actually answered. */
export interface ResolvedProvider {
  readonly providerId: LlmProviderId;
  readonly billedModel: string;
}

export type LlmStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'content_filter'
  | 'other';

/** Final non-streaming response shape. */
export interface LlmResponse {
  readonly id: string;
  readonly resolvedProvider: ResolvedProvider;
  readonly stopReason: LlmStopReason;
  readonly content: readonly LlmContentPart[];
  readonly usage: LlmUsage;
  readonly cost?: LlmCost;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Inbound request envelope. */
export interface LlmRequest {
  readonly context: LlmCallContext;
  readonly model: string;
  readonly providerId?: LlmProviderId;
  readonly messages: readonly LlmMessage[];
  readonly system?: string;
  readonly tools?: readonly LlmRequestTool[];
  readonly toolChoice?: LlmToolChoice;
  readonly params: LlmGenerationParams;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Gateway call result — success carries the response; failure carries error. */
export type LlmCallResult =
  | { readonly ok: true; readonly response: LlmResponse }
  | {
      readonly ok: false;
      readonly error: { readonly code?: string; readonly message: string };
    };
