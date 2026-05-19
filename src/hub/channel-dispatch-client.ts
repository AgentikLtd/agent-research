/**
 * Outbound channel dispatch client — agent → hub `/api/channel/dispatch`.
 *
 * Replaces the older email-manager A2A hop. Architecture rationale:
 *   - AgentMail is a CHANNEL, not a specialist agent's responsibility.
 *     The hub's channel-router resolves which adapter handles a given
 *     `event_id` (agentmail / web-inbox / telegram / …) by consulting
 *     the calling agent's manifest `output_channels` block, which the
 *     install saga lands into `agent_profiles.config`.
 *   - The dispatch route already exists, requires bearer auth, and
 *     enforces a strict zod schema on the request body. We mirror that
 *     schema here in TS so the wire shape is unambiguous.
 *
 * Wire request (POST ${hubUrl}/api/channel/dispatch):
 *   {
 *     "event_id": "informational" | "scheduled_summary" | "action_required" | "critical",
 *     "payload": {
 *       "title": string,
 *       "body":  string,
 *       "metadata"?: Record<string, string | number | boolean | null>
 *     },
 *     "idempotency_key"?: string
 *   }
 *
 * Recipient handling: the channel-dispatch schema does NOT allow array
 * values inside metadata. dispatch-brief comma-joins recipients into
 * `metadata.recipients` and the channel adapter splits on the hub side.
 *
 * Response (the route returns the channel-router's DeliveryResult verbatim):
 *   { channelId, idempotencyKey, status: 'delivered'|'accepted'|'sent'|'skipped'|'failed',
 *     receiptId?, error?: { code, message, ... }, attemptedAt }
 *
 *   Mapping to this client's two-variant return:
 *     - status ∈ { delivered, accepted, sent } AND receiptId present
 *         → { ok: true, messageId: receiptId, channelId }
 *     - otherwise (failed / skipped / no receipt)
 *         → { ok: false, error: { code, message } } where the code falls
 *           back to `status_${status}` if the route omitted `error`.
 *
 *   Network errors map to `{ ok: false, error: { code: 'network_error', ... } }`.
 *   Non-2xx HTTP responses map to `{ ok: false, error: { code: 'http_<status>', ... } }`.
 */

export type ChannelEventId =
  | 'informational'
  | 'scheduled_summary'
  | 'action_required'
  | 'critical';

export type ChannelMetadataValue = string | number | boolean | null;

export interface ChannelDispatchArgs {
  readonly eventId: ChannelEventId;
  readonly title: string;
  readonly body: string;
  readonly metadata?: Readonly<Record<string, ChannelMetadataValue>>;
  readonly idempotencyKey?: string;
}

export type ChannelDispatchResult =
  | {
      readonly ok: true;
      readonly messageId: string;
      readonly channelId: string;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface ChannelDispatchClient {
  dispatch(args: ChannelDispatchArgs): Promise<ChannelDispatchResult>;
}

export interface ChannelDispatchClientDeps {
  readonly hubUrl: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
}

interface DispatchResponseShape {
  readonly channelId?: unknown;
  readonly status?: unknown;
  readonly receiptId?: unknown;
  readonly messageId?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

const SUCCESS_STATUSES = new Set(['delivered', 'accepted', 'sent']);

export function createChannelDispatchClient(
  deps: ChannelDispatchClientDeps,
): ChannelDispatchClient {
  const fetcher = deps.fetcher ?? fetch;
  const endpoint = `${deps.hubUrl.replace(/\/$/, '')}/api/channel/dispatch`;

  return {
    async dispatch(args) {
      const wire: Record<string, unknown> = {
        event_id: args.eventId,
        payload: {
          title: args.title,
          body: args.body,
          ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
        },
        ...(args.idempotencyKey !== undefined
          ? { idempotency_key: args.idempotencyKey }
          : {}),
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
          error: {
            code: 'network_error',
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          ok: false,
          error: {
            code: `http_${String(res.status)}`,
            message:
              `channel/dispatch ${String(res.status)}: ${text}`.trim(),
          },
        };
      }

      let json: DispatchResponseShape;
      try {
        json = (await res.json()) as DispatchResponseShape;
      } catch (e) {
        return {
          ok: false,
          error: {
            code: 'invalid_response',
            message: `channel/dispatch returned non-JSON: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }

      const status = typeof json.status === 'string' ? json.status : '';
      const channelId =
        typeof json.channelId === 'string' ? json.channelId : 'unknown';
      // Be liberal in what we accept: the spec'd field is `receiptId` but
      // older route revisions or test stubs may use `messageId`.
      const receipt =
        typeof json.receiptId === 'string' && json.receiptId.length > 0
          ? json.receiptId
          : typeof json.messageId === 'string' && json.messageId.length > 0
            ? json.messageId
            : undefined;

      if (SUCCESS_STATUSES.has(status) && receipt !== undefined) {
        return { ok: true, messageId: receipt, channelId };
      }

      const errCode =
        json.error && typeof json.error.code === 'string'
          ? json.error.code
          : `status_${status || 'unknown'}`;
      const errMessage =
        json.error && typeof json.error.message === 'string'
          ? json.error.message
          : `status_${status || 'unknown'}`;
      return { ok: false, error: { code: errCode, message: errMessage } };
    },
  };
}
