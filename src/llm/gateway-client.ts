/**
 * LLM gateway client — POST hub `/api/llm/send` with a per-agent bearer token.
 *
 * Phase-1 contract:
 *   - Request body matches `@agentik/shared-types/gateway` `LlmRequest`
 *     minus `context` (the hub injects tenantId + agentId from the bearer
 *     token — see `repos/studio/apps/hub-ui/src/app/api/llm/send/route.ts`).
 *   - Response is the gateway's `LlmCallResult` — either
 *     `{ ok: true, response: LlmResponse }` or
 *     `{ ok: false, error: { code, message, ... } }`.
 *
 * This client adapts that wire shape to a flatter `LlmSendResult` for
 * skill code: `{ ok: true, content, usage, costGbp?, llmCallId? }` —
 * keeps skill modules from coupling to the gateway's nested envelope.
 *
 * Per memory.md 2026-05-04 cross-repo HTTP adapter rules: fetch throws
 * become `{ ok: false }` results (never re-thrown), and the upstream
 * body is captured in the error message so a hub-side 5xx is
 * diagnosable from the agent log.
 */

import type {
  LlmContentPart,
  LlmCost,
  LlmGenerationParams,
  LlmMessage,
  LlmTool,
  LlmUsage,
} from '../contracts.js';

export interface LlmSendRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly system?: string;
  readonly tools?: ReadonlyArray<LlmTool>;
  readonly params: LlmGenerationParams;
}

export interface LlmSendSuccess {
  readonly ok: true;
  readonly content: ReadonlyArray<LlmContentPart>;
  readonly usage: LlmUsage;
  readonly costGbp?: number;
  readonly llmCallId?: string;
}

export interface LlmSendFailure {
  readonly ok: false;
  readonly error: { readonly code?: string; readonly message: string };
}

export type LlmSendResult = LlmSendSuccess | LlmSendFailure;

export interface GatewayClientDeps {
  readonly hubUrl: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
}

export interface GatewayClient {
  send(req: LlmSendRequest): Promise<LlmSendResult>;
}

/**
 * Wire shape echoed by `/api/llm/send`. Mirrors `LlmCallResult` from
 * `@agentik/llm-gateway` without taking a runtime dep on that package.
 */
interface WireGatewaySuccess {
  readonly ok: true;
  readonly response: {
    readonly id: string;
    readonly content: ReadonlyArray<LlmContentPart>;
    readonly usage: LlmUsage;
    readonly cost?: LlmCost;
  };
}
interface WireGatewayFailure {
  readonly ok: false;
  readonly error: { readonly code?: string; readonly message: string };
}
type WireGatewayResult = WireGatewaySuccess | WireGatewayFailure;

export function createGatewayClient(deps: GatewayClientDeps): GatewayClient {
  const fetcher = deps.fetcher ?? fetch;
  const endpoint = `${deps.hubUrl.replace(/\/$/, '')}/api/llm/send`;
  return {
    async send(req) {
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(req),
        });
      } catch (e) {
        return {
          ok: false,
          error: { message: e instanceof Error ? e.message : String(e) },
        };
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          ok: false,
          error: {
            code: `http_${String(response.status)}`,
            message: `gateway /api/llm/send ${String(response.status)}: ${text}`.trim(),
          },
        };
      }

      let parsed: WireGatewayResult;
      try {
        parsed = (await response.json()) as WireGatewayResult;
      } catch (e) {
        return {
          ok: false,
          error: { message: `gateway response was not JSON: ${e instanceof Error ? e.message : String(e)}` },
        };
      }

      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }

      const out: LlmSendSuccess = {
        ok: true,
        content: parsed.response.content,
        usage: parsed.response.usage,
        ...(parsed.response.cost !== undefined ? { costGbp: parsed.response.cost.amount } : {}),
        ...(parsed.response.id !== undefined && parsed.response.id !== ''
          ? { llmCallId: parsed.response.id }
          : {}),
      };
      return out;
    },
  };
}
