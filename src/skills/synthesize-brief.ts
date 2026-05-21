/**
 * synthesize-brief skill — turn verified, adjudicated findings into the final
 * markdown brief in the operator's defined style. No web search: the brief is
 * synthesised only from findings the challenge stage already verified.
 */
import type { LlmContentPart } from '../contracts.js';
import type { GatewayClient } from '../llm/gateway-client.js';
import {
  buildSynthesisPrompt,
  type GuardrailConfig,
  type PersonaConfig,
} from '../prompts/brief-prompts.js';
import type { Finding } from '../research/findings.js';
import type { Skill } from './registry.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 12000;
const CITATION_REGEX = /\[(\d+)\]/g;

export interface SynthesizeBriefArgs {
  readonly findings: readonly Finding[];
  readonly briefDescription: string;
  readonly since: string;
  readonly until: string;
  readonly persona?: PersonaConfig;
  readonly guardrails?: readonly GuardrailConfig[];
  readonly markdownSections?: readonly string[];
  readonly extraInstructions?: string;
  readonly maxOutputTokens?: number;
  readonly model?: string;
}

export interface SynthesizeBriefResult {
  readonly markdown: string;
  readonly citationCount: number;
  readonly llmCallId?: string;
  readonly costGbp?: number;
}

export interface SynthesizeBriefDeps {
  readonly gateway: GatewayClient;
  readonly model: string;
}

export class SynthesizeBriefError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'SynthesizeBriefError';
    if (code !== undefined) this.code = code;
  }
}

function firstText(content: ReadonlyArray<LlmContentPart>): string {
  return content.filter((p) => p.type === 'text').map((p) => p.text).join('');
}

export function createSynthesizeBriefSkill(
  deps: SynthesizeBriefDeps,
): Skill<SynthesizeBriefArgs, SynthesizeBriefResult> {
  return {
    name: 'synthesize-brief',
    description: 'Synthesise verified findings into the final styled markdown brief.',
    async invoke(args) {
      const prompt = buildSynthesisPrompt({
        findings: args.findings,
        briefDescription: args.briefDescription,
        since: args.since,
        until: args.until,
        ...(args.persona !== undefined ? { persona: args.persona } : {}),
        ...(args.guardrails !== undefined ? { guardrails: args.guardrails } : {}),
        ...(args.markdownSections !== undefined ? { markdownSections: args.markdownSections } : {}),
        ...(args.extraInstructions !== undefined ? { extraInstructions: args.extraInstructions } : {}),
      });
      const result = await deps.gateway.send({
        model: args.model ?? deps.model,
        system: prompt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        params: { maxOutputTokens: args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS },
      });
      if (!result.ok) {
        throw new SynthesizeBriefError(
          `synthesize-brief gateway failure: ${result.error.message}`,
          result.error.code,
        );
      }
      const markdown = firstText(result.content);
      const citationCount = (markdown.match(CITATION_REGEX) ?? []).length;
      return {
        markdown,
        citationCount,
        ...(result.llmCallId !== undefined ? { llmCallId: result.llmCallId } : {}),
        ...(result.costGbp !== undefined ? { costGbp: result.costGbp } : {}),
      };
    },
  };
}
