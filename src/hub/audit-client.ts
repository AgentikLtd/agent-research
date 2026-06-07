/**
 * Audit client — emits a run-trace event for a skill / action.
 *
 * As of DDR-001 the hub exposes a per-agent trace route
 * `POST /api/agents/[id]/trace` (token-tenant scoped, exact event_type
 * allowlist, `run_id` must be a UUID, `detail` capped ~8KB). This client
 * posts run-trace events there, mapping each `AuditEvent` to the trace
 * wire shape `{ run_id, event_type, detail }` (the `runId` is lifted out
 * of `event.payload`).
 *
 * Two modes:
 *   1. `mode: 'remote'`: POSTs to `${hubUrl}/api/agents/${agentId}/trace`
 *      with a `Bearer` token. This is the default whenever a token is
 *      present (i.e. in production).
 *   2. `mode: 'noop'`: the dev fallback when no token is present — the
 *      client never issues a network call and writes a structured
 *      `console.warn` so the event is at least preserved in the agent
 *      stdout (which the hub aggregates). This lets skill code call
 *      `audit.emit(...)` unconditionally.
 *
 * Failures in remote mode are swallowed (logged via console.warn) —
 * audit is non-critical to the agent's primary path; we never let a
 * non-2xx on the trace route (e.g. a 404 before the route rolls) blow
 * up a successful skill.
 */

export interface AuditEvent {
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AuditClient {
  emit(event: AuditEvent): Promise<void>;
}

export interface AuditClientDeps {
  readonly hubUrl: string;
  readonly token: string;
  readonly agentId: string;
  readonly mode?: 'noop' | 'remote';
  readonly fetcher?: typeof fetch;
  /** Test seam; defaults to `console.warn`. */
  readonly logger?: (line: string, detail?: unknown) => void;
}

export function createAuditClient(deps: AuditClientDeps): AuditClient {
  const mode = deps.mode ?? (deps.token ? 'remote' : 'noop');
  const log = deps.logger ?? ((line, detail) => console.warn(line, detail));
  const fetcher = deps.fetcher ?? fetch;
  const endpoint = `${deps.hubUrl.replace(/\/$/, '')}/api/agents/${deps.agentId}/trace`;

  if (mode === 'noop') {
    return {
      async emit(event) {
        log(`[audit:noop] ${event.eventType}`, event.payload);
      },
    };
  }

  return {
    async emit(event) {
      try {
        const runId = typeof event.payload['runId'] === 'string' ? event.payload['runId'] : '';
        const body = JSON.stringify({
          run_id: runId,
          event_type: event.eventType,
          detail: event.payload,
        });
        const res = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          log(
            `[audit:remote-failed] ${event.eventType} → ${String(res.status)} ${text}`.trim(),
            event.payload,
          );
        }
      } catch (e) {
        log(
          `[audit:remote-threw] ${event.eventType}: ${e instanceof Error ? e.message : String(e)}`,
          event.payload,
        );
      }
    },
  };
}
