/**
 * compose-brief skill — turn gathered SourceItem[] into a markdown brief
 * via the hub's LLM gateway.
 *
 * Calls `gateway.send({ model, messages, system, tools: [], params })` and
 * throws `LlmGatewayError` on `ok: false` so the orchestrator (run-brief)
 * gets a typed failure rather than a silent empty brief.
 *
 * Citation counting: a simple `[n]` regex over the assembled markdown.
 * Good enough for Phase 5; a richer eval-time check (does `[3]` actually
 * exist in the source list?) can layer in via the eval suite.
 */

import type { LlmContentPart, LlmMessage } from '../contracts.js';
import type { GatewayClient } from '../llm/gateway-client.js';
import { buildComposePrompt } from '../prompts/compose-brief-prompt.js';
import type { SourceItem } from '../sources/contracts.js';
import type { Skill } from './registry.js';

export interface ComposeBriefArgs {
  readonly model: string;
  readonly briefDescription: string;
  readonly items: ReadonlyArray<SourceItem>;
  readonly since: string;
  readonly until: string;
  readonly maxOutputTokens?: number;
  readonly extraInstructions?: string;
}

export interface ComposeBriefResult {
  readonly markdown: string;
  readonly citationCount: number;
  readonly llmCallId?: string;
  readonly costGbp?: number;
}

export class LlmGatewayError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'LlmGatewayError';
    if (code !== undefined) this.code = code;
  }
}

export interface ComposeBriefDeps {
  readonly gateway: GatewayClient;
}

const CITATION_REGEX = /\[(\d+)\]/g;

function extractMarkdown(content: ReadonlyArray<LlmContentPart>): string {
  const chunks: string[] = [];
  for (const part of content) {
    if (part.type === 'text') chunks.push(part.text);
  }
  return chunks.join('');
}

function countCitations(markdown: string): number {
  const matches = markdown.match(CITATION_REGEX);
  return matches ? matches.length : 0;
}

export function createComposeBriefSkill(
  deps: ComposeBriefDeps,
): Skill<ComposeBriefArgs, ComposeBriefResult> {
  return {
    name: 'compose-brief',
    description: 'Synthesise a markdown brief from SourceItem[] via the hub LLM gateway.',
    async invoke(args) {
      const prompt = buildComposePrompt({
        briefDescription: args.briefDescription,
        items: args.items,
        since: args.since,
        until: args.until,
        ...(args.extraInstructions !== undefined
          ? { extraInstructions: args.extraInstructions }
          : {}),
      });

      const messages: ReadonlyArray<LlmMessage> = [
        { role: 'user', content: [{ type: 'text', text: prompt.user }] },
      ];

      const result = await deps.gateway.send({
        model: args.model,
        messages,
        system: prompt.system,
        tools: [],
        params: { maxOutputTokens: args.maxOutputTokens ?? 8000 },
      });

      if (!result.ok) {
        throw new LlmGatewayError(
          `compose-brief gateway failure: ${result.error.message}`,
          result.error.code,
        );
      }

      const markdown = extractMarkdown(result.content);
      const citationCount = countCitations(markdown);
      const out: ComposeBriefResult = {
        markdown,
        citationCount,
        ...(result.llmCallId !== undefined ? { llmCallId: result.llmCallId } : {}),
        ...(result.costGbp !== undefined ? { costGbp: result.costGbp } : {}),
      };
      return out;
    },
  };
}
