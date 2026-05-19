/**
 * Audit client — emits an audit event for a skill / action.
 *
 * Resolution note: as of 2026-05-19 the hub exposes only `GET /api/audit`
 * (event listing). There is no `POST /api/audit/emit` — sagas write
 * audit rows via Postgres directly through `PostgresAuditSource`.
 *
 * Two modes:
 *   1. `mode: 'noop'` (default): the client never issues a network
 *      call and writes a structured `console.warn` so the event is at
 *      least preserved in the agent stdout (which the hub aggregates).
 *      This lets skill code call `audit.emit(...)` unconditionally
 *      without coupling to whether the Phase 2 audit endpoint has
 *      shipped yet.
 *   2. `mode: 'remote'`: the client POSTs to `${hubUrl}/api/audit/emit`.
 *      Switch to this mode once the route lands.
 *
 * Failures in remote mode are swallowed (logged via console.warn) —
 * audit is non-critical to the agent's primary path; we never let a
 * 5xx on `/api/audit/emit` blow up a successful skill.
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
  readonly mode?: 'noop' | 'remote';
  readonly fetcher?: typeof fetch;
  /** Test seam; defaults to `console.warn`. */
  readonly logger?: (line: string, detail?: unknown) => void;
}

export function createAuditClient(deps: AuditClientDeps): AuditClient {
  const mode = deps.mode ?? 'noop';
  const log = deps.logger ?? ((line, detail) => console.warn(line, detail));
  const fetcher = deps.fetcher ?? fetch;
  const endpoint = `${deps.hubUrl.replace(/\/$/, '')}/api/audit/emit`;

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
        const res = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(event),
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
