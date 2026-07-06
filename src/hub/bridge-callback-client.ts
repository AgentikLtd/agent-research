/**
 * Bridge-callback client (AB.7 / ABF-B12, B17) — POSTs a RESULT POINTER back
 * to the hub when a detached async brief settles, so the hub's suspended
 * workflow node can resume.
 *
 * Endpoint: `POST ${hubUrl}/api/engine/bridge-callback`
 * Auth: the agent's OWN `HUB_AGENT_TOKEN` bearer to its OWN known `HUB_BASE_URL`
 *       (no hub-supplied URL — no SSRF surface; same pattern as
 *       storage-client.ts / audit-client.ts).
 *
 * Unlike audit (fire-and-forget), a lost callback means the hub's workflow node
 * never resumes — so this client RETRIES (bounded) on failure. The hub's
 * 200-ack is idempotent (its `resumeWithData` CAS), so a retried callback is
 * safe: at-most-once resume even under at-least-once delivery.
 *
 * ABF-B17 (no-log-body): this module MUST NOT log the request body, `result`,
 * `recipients`, `storageUri`, or `emailMessageId` at ANY level. On error it
 * logs ONLY a redacted shape: `{callbackTokenSha, status, outcome, agentName?}`
 * where callbackTokenSha is a sha256 PREFIX of the token (never the token
 * itself). There is a grep-gate test asserting this module contains no
 * `JSON.stringify(body)` / `console.*(...result...)` leak.
 */

import { createHash } from 'node:crypto';

import type { BridgeCallbackBody, BridgeResultPointer } from '../contracts.js';

/**
 * Positive ALLOW-LIST projection of a settled brief result into the narrow
 * `BridgeResultPointer` wire shape (ABF-B12, PII gate). Constructs a FRESH
 * object with EXACTLY the four allowed fields — it NEVER spreads the input, so
 * `recipients` (email PII) and `markdown` (raw brief body) present on
 * `RunBriefResult` CANNOT leak into the callback body.
 *
 * The input is typed `unknown` because it is whatever `registry.invoke`
 * resolved to on the detached async path. We read the four fields defensively
 * (a malformed result yields a benign zero/empty pointer rather than throwing
 * inside the settle handler).
 */
export function projectResultPointer(result: unknown): BridgeResultPointer {
  const r = (result !== null && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const storageUri = typeof r['storageUri'] === 'string' ? (r['storageUri'] as string) : undefined;
  const pointer: BridgeResultPointer = {
    emailMessageId: typeof r['emailMessageId'] === 'string' ? (r['emailMessageId'] as string) : '',
    citationCount: typeof r['citationCount'] === 'number' ? (r['citationCount'] as number) : 0,
    costGbp: typeof r['costGbp'] === 'number' ? (r['costGbp'] as number) : 0,
    // storageUri is optional-tolerant — include ONLY when present (the brief archived).
    ...(storageUri !== undefined ? { storageUri } : {}),
  };
  return pointer;
}

/** Build the success callback body from a settled `RunBriefResult` (allow-listed). */
export function buildCompletedCallback(
  callbackToken: string,
  result: unknown,
): BridgeCallbackBody {
  return { callbackToken, status: 'completed', result: projectResultPointer(result) };
}

/**
 * Build the failure callback body. No email on failure → empty `emailMessageId`;
 * no citations; cost best-effort 0 (the contract has NO error field — the hub
 * treats `status:'failed'` as terminal and does not read result content).
 */
export function buildFailedCallback(callbackToken: string): BridgeCallbackBody {
  return {
    callbackToken,
    status: 'failed',
    result: { emailMessageId: '', citationCount: 0, costGbp: 0 },
  };
}

export interface BridgeCallbackClientDeps {
  readonly hubUrl: string;
  readonly token: string;
  /** For log correlation only — never the callback token. */
  readonly agentName?: string;
  readonly fetcher?: typeof fetch;
  /** Injectable sleep for deterministic retry tests. Defaults to real setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Max POST attempts (initial + retries). Default 3. */
  readonly maxAttempts?: number;
  /** Base backoff between attempts (ms). Default 500. Grows linearly per attempt. */
  readonly backoffMs?: number;
}

export type BridgeCallbackOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly attempts: number };

export interface BridgeCallbackClient {
  /**
   * POST the callback body, retrying on network error / non-2xx up to
   * `maxAttempts`. Returns `{ok:true}` on first 2xx, else `{ok:false,attempts}`.
   * NEVER throws — a failed callback is reported, not propagated (the detached
   * settle path must not crash the process).
   */
  send(body: BridgeCallbackBody): Promise<BridgeCallbackOutcome>;
}

/** Short, non-reversible token fingerprint for logs (ABF-B17). */
function tokenSha(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createBridgeCallbackClient(
  deps: BridgeCallbackClientDeps,
): BridgeCallbackClient {
  const fetcher = deps.fetcher ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = deps.maxAttempts ?? 3;
  const backoffMs = deps.backoffMs ?? 500;
  const endpoint = `${deps.hubUrl.replace(/\/$/, '')}/api/engine/bridge-callback`;

  return {
    async send(body: BridgeCallbackBody): Promise<BridgeCallbackOutcome> {
      // Redacted log context — NEVER the token, body, or result fields.
      const logCtx: Record<string, unknown> = {
        callbackTokenSha: tokenSha(body.callbackToken),
        status: body.status,
      };
      if (deps.agentName !== undefined) logCtx['agentName'] = deps.agentName;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let failure: string | undefined;
        try {
          const res = await fetcher(endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${deps.token}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify(body),
          });
          if (res.ok) {
            return { ok: true };
          }
          // Drain (and DISCARD) the body — never log it (may echo our payload).
          await res.text().catch(() => '');
          failure = `http_${String(res.status)}`;
        } catch (e) {
          failure = e instanceof Error ? e.name : 'network_error';
        }

        // Redacted per-attempt log: outcome code only, no body/result/token.
        console.error('[bridge-callback] attempt failed', {
          ...logCtx,
          attempt,
          maxAttempts,
          outcome: failure,
        });

        if (attempt < maxAttempts) {
          await sleep(backoffMs * attempt);
        }
      }

      return { ok: false, attempts: maxAttempts };
    },
  };
}
