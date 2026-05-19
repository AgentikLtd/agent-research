/**
 * Local restatement of consumed `@agentik/shared-types` slices needed
 * by hub + a2a clients. Mirrors the same pattern as
 * `repos/agent-briefing/src/contracts.ts`.
 *
 * Canonical sources:
 *   - `@agentik/shared-types/a2a`
 *
 * Once shared-types is npm-published (Phase 0a follow-up), this file
 * should be replaced with imports and deleted in a single PR per
 * `docs/memory.md` 2026-05-04 entry. Until then, every type below MUST
 * stay structurally compatible with its canonical version.
 *
 * Scoped intentionally narrow for Phase 4 — the gateway-client uses
 * `@agentik/shared-types/gateway` types directly (workspace dep resolves
 * fine in the canonical case). Only the A2A JSON-RPC envelopes are
 * restated here because the email-manager-client uses them via
 * `MessageSendParams` / `MessageSendResult` which are not exported
 * cleanly enough to import standalone until shared-types ships.
 */

// --- a2a (subset) ---

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
