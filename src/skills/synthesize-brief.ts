/**
 * synthesize-brief skill — turn verified, adjudicated findings into the final
 * markdown brief in the operator's defined style. No web search: the brief is
 * synthesised only from findings the challenge stage already verified.
 */
import type { LlmContentPart, LlmRequestTool } from '../contracts.js';
import type { GatewayClient } from '../llm/gateway-client.js';
import type { MemoryTool } from '../memory/contracts.js';
import {
  buildSynthesisPrompt,
  type GuardrailConfig,
  type PersonaConfig,
} from '../prompts/brief-prompts.js';
import type { Finding } from '../research/findings.js';
import type { Skill } from './registry.js';

/**
 * The brief is the pipeline's longest single artifact, and a thinking model
 * (e.g. Gemini 3.5 Flash) spends reasoning tokens against this same budget.
 * The original 12000 truncated the brief mid-document (`finish_reason: length`)
 * — the visible markdown was cut off, dropping later sections and the Sources
 * list, which collapsed the citation count. 32000 clears a flash model's
 * reasoning overhead plus a long, fully-cited brief.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32000;
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
  /**
   * Optional block prepended to the system prompt — used by run-brief to
   * inject the recall() context block before the model sees the synthesis task.
   */
  readonly systemPromptPrefix?: string;
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
  /**
   * Optional memory tool — when present, the Anthropic memory-tool 20250818
   * definition is advertised to the model so it can read prior briefs and
   * durable facts before writing.
   *
   * NOTE (Task 25): the gateway client is a single-shot HTTP proxy to the hub
   * `/api/llm/send`. There is no tool-handler loop here — the model's
   * `tool_use` response blocks would not be consumed, meaning the LLM cannot
   * actually exercise the memory tool in the current architecture. The tool
   * definition is registered so Anthropic's API acknowledges the tool and the
   * model can reason about it; a future multi-turn loop or server-side tool
   * execution will close this gap. See plan §Task 25 DONE_WITH_CONCERNS note.
   */
  readonly memory?: MemoryTool;
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

/**
 * Build the Anthropic memory-tool 20250818 definition.
 * Shape: `{ type: 'memory_20250818', name: 'memory' }` — no inputSchema.
 * Anthropic's API identifies first-party tools by their `type` field.
 */
function buildMemoryToolDef(): LlmRequestTool {
  return { type: 'memory_20250818' as const, name: 'memory' as const };
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
      const system = args.systemPromptPrefix
        ? `${args.systemPromptPrefix}\n\n${prompt.system}`
        : prompt.system;
      // Advertise the memory tool when the memory dep is wired. The gateway
      // is a single-shot HTTP proxy — no tool-handler loop runs here — so the
      // model cannot actually exercise the tool in this call. The definition is
      // registered so Anthropic's API acknowledges it and the model can read
      // the memory paths described in the system prompt; a future multi-turn
      // loop will close this gap (see deps.memory JSDoc).
      const tools: LlmRequestTool[] | undefined =
        deps.memory !== undefined ? [buildMemoryToolDef()] : undefined;
      const result = await deps.gateway.send({
        model: args.model ?? deps.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        params: { maxOutputTokens: args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS },
        ...(tools !== undefined ? { tools } : {}),
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
