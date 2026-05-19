/**
 * Outbound A2A client — research-agent → email-manager `draft-email`.
 *
 * Endpoint resolution (PHASE 4 DEFAULT — see CLAUDE.md §14 + memory.md
 * 2026-05-19):
 *
 *   The research agent does NOT call the email-manager Fly Machine
 *   directly. Instead, it goes through the hub-proxy route
 *   `POST ${hubUrl}/api/agents/<emailManagerAgentId>/invoke-skill`
 *   which the hub forwards over A2A (JSON-RPC 2.0 `message/send`)
 *   to the target agent's container.
 *
 *   Rationale:
 *     - The agent doesn't know the email-manager's machineId / DNS
 *       (`<machineId>.vm.<app>.internal:<port>`). The hub does.
 *     - The hub mints the inter-agent bearer per call, so each agent
 *       carries only its OWN bearer.
 *     - mTLS upgrade (Phase 2) terminates at the hub — agents stay
 *       single-credential.
 *
 *   The hub-proxy route is being added in Phase 2 Task 2.1. Until it
 *   ships, this client receives a 404 and returns the standard
 *   `{ ok: false, error }` shape so skill code can degrade.
 *
 * Alternative path (NOT used by Phase 4): direct A2A to the
 * email-manager's internal Fly DNS. Reserved for Phase 3+ once
 * service-discovery primitives land.
 *
 * Wire request (hub → email-manager) shape:
 *   {
 *     "jsonrpc": "2.0",
 *     "id": "...",
 *     "method": "message/send",
 *     "params": {
 *       "message": { "role": "ROLE_AGENT", "parts": [{ "data": { ... } }] },
 *       "configuration": { "metadata": { "skill": "draft-email" } }
 *     }
 *   }
 *
 * Confirmed by reading `repos/agent-email-manager/src/server/handlers/
 * message-send.ts` (skill-hint lookup at `params.configuration.metadata.skill`).
 *
 * The external interface accepts `to: string[]` to match the Phase 5
 * skill expectations. Inside, we forward a single recipient list to
 * the email-manager (it expects one draft per call); if multiple
 * recipients are needed, the wrapper loops and aggregates messageIds.
 */

import type {
  JsonRpcRequest,
  JsonRpcSuccess,
  JsonRpcError,
  MessageSendParams,
  MessageSendResult,
} from '../contracts.js';

export interface DraftEmailArgs {
  readonly to: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
}

export type DraftEmailResult =
  | { readonly ok: true; readonly messageId: string }
  | { readonly ok: false; readonly error: { readonly code?: string; readonly message: string } };

export interface EmailManagerClientDeps {
  readonly hubUrl: string;
  readonly token: string;
  /** The hub-side agentId of the email-manager (per-tenant). */
  readonly emailManagerAgentId: string;
  readonly fetcher?: typeof fetch;
}

export interface EmailManagerClient {
  draftEmail(args: DraftEmailArgs): Promise<DraftEmailResult>;
}

let counter = 0;
const nextId = (): string =>
  `research-${Date.now().toString(36)}-${(++counter).toString(36)}`;

function extractMessageId(result: MessageSendResult): string | undefined {
  // `MessageSendResult = Message | Task`. The email-manager's draft-email
  // handler returns a Message whose first DataPart carries
  // `{ draftId, messageId, ... }`. Prefer DataPart fields; fall back to a
  // Task's top-level `id` only if no DataPart yielded one.
  if ('parts' in result && result.parts) {
    for (const part of result.parts) {
      if (
        'data' in part &&
        part.data !== null &&
        typeof part.data === 'object'
      ) {
        const data = part.data as Record<string, unknown>;
        for (const key of ['messageId', 'draftId', 'id'] as const) {
          const v = data[key];
          if (typeof v === 'string' && v.length > 0) return v;
        }
      }
    }
  }
  // Task fallback: a `Task` carries a top-level `id`.
  if ('status' in result && 'id' in result && typeof result.id === 'string') {
    return result.id;
  }
  return undefined;
}

export function createEmailManagerClient(
  deps: EmailManagerClientDeps,
): EmailManagerClient {
  const fetcher = deps.fetcher ?? fetch;
  const endpoint = `${deps.hubUrl.replace(/\/$/, '')}/api/agents/${encodeURIComponent(
    deps.emailManagerAgentId,
  )}/invoke-skill`;

  async function draftOne(
    to: string,
    subject: string,
    body: string,
  ): Promise<DraftEmailResult> {
    const params: MessageSendParams = {
      message: {
        role: 'ROLE_AGENT',
        parts: [
          {
            data: {
              to,
              subject,
              body_markdown: body,
            },
          },
        ],
      },
      configuration: { metadata: { skill: 'draft-email' } },
    };
    const wire: JsonRpcRequest<'message/send', MessageSendParams> = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'message/send',
      params,
    };

    let res: Response;
    try {
      res = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(wire),
      });
    } catch (e) {
      return {
        ok: false,
        error: { message: e instanceof Error ? e.message : String(e) },
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: {
          code: `http_${String(res.status)}`,
          message: `email-manager invoke-skill ${String(res.status)}: ${text}`.trim(),
        },
      };
    }

    const json = (await res.json()) as JsonRpcSuccess<MessageSendResult> | JsonRpcError;
    if ('error' in json) {
      return {
        ok: false,
        error: {
          code: `jsonrpc_${String(json.error.code)}`,
          message: `JSON-RPC error ${String(json.error.code)}: ${json.error.message}`,
        },
      };
    }
    const messageId = extractMessageId(json.result);
    if (messageId === undefined) {
      return {
        ok: false,
        error: { message: 'email-manager returned no messageId / draftId' },
      };
    }
    return { ok: true, messageId };
  }

  return {
    async draftEmail(args) {
      if (args.to.length === 0) {
        return { ok: false, error: { message: 'draftEmail: `to` must be non-empty' } };
      }
      if (args.to.length === 1) {
        const recipient = args.to[0];
        if (recipient === undefined) {
          return { ok: false, error: { message: 'draftEmail: `to[0]` was undefined' } };
        }
        return await draftOne(recipient, args.subject, args.body);
      }
      // Multi-recipient: call once per recipient and aggregate messageIds.
      const ids: string[] = [];
      for (const recipient of args.to) {
        const result = await draftOne(recipient, args.subject, args.body);
        if (!result.ok) return result;
        ids.push(result.messageId);
      }
      return { ok: true, messageId: ids.join(',') };
    },
  };
}
