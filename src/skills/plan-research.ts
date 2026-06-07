/**
 * plan-research skill — decompose a research topic into focused angles.
 * One cheap LLM call, no web search. On a parse failure it throws; run-brief
 * degrades to a single angle (the topic itself).
 */
import type { LlmContentPart } from '../contracts.js';
import type { GatewayClient } from '../llm/gateway-client.js';
import { buildPlanPrompt, type PrioritySource } from '../prompts/brief-prompts.js';
import { parseAngles } from '../research/findings.js';
import type { Skill } from './registry.js';

const DEFAULT_MAX_ANGLES = 4;
/**
 * The plan stage emits a tiny payload (a handful of angle strings), but a
 * thinking model — e.g. Gemini 3.5 Flash — spends reasoning tokens against
 * this same budget. The original 1000-token cap left no headroom: reasoning
 * consumed it and the visible angles JSON truncated mid-string. 8000 clears a
 * flash model's reasoning overhead; the sibling stages (research/challenge/
 * synthesize) already budget 12k–24k for the identical reason.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;

export interface PlanResearchArgs {
  readonly topic: string;
  readonly since: string;
  readonly until: string;
  readonly prioritySources?: readonly PrioritySource[];
  readonly maxAngles?: number;
  /** Per-run model override; falls back to the skill's deps model. */
  readonly model?: string;
  /**
   * Optional block prepended to the system prompt — used by run-brief to
   * inject the recall() context block before the model sees the planning task.
   */
  readonly systemPromptPrefix?: string;
  /**
   * Replaces the overridable planning-role span of the system prompt
   * (DDR-001 Phase 6). Distinct from systemPromptPrefix: prefix PREPENDS recall
   * context, override REPLACES the role const. The fixed JSON output-format tail
   * is always preserved. When both are present the prefix wraps the
   * override-composed prompt: `prefix\n\n[override ?? DEFAULT_ROLE, tail]`.
   */
  readonly systemPromptOverride?: string;
}

export interface PlanResearchResult {
  readonly angles: readonly string[];
  readonly llmCallId?: string;
  readonly costGbp?: number;
}

export interface PlanResearchDeps {
  readonly gateway: GatewayClient;
  /** Manifest-resolved default model for this skill. */
  readonly model: string;
}

export class PlanResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanResearchError';
  }
}

function firstText(content: ReadonlyArray<LlmContentPart>): string {
  return content.filter((p) => p.type === 'text').map((p) => p.text).join('');
}

export function createPlanResearchSkill(
  deps: PlanResearchDeps,
): Skill<PlanResearchArgs, PlanResearchResult> {
  return {
    name: 'plan-research',
    description: 'Decompose a research topic into focused, rounded research angles.',
    async invoke(args) {
      const maxAngles = args.maxAngles ?? DEFAULT_MAX_ANGLES;
      const prompt = buildPlanPrompt(
        {
          topic: args.topic,
          since: args.since,
          until: args.until,
          maxAngles,
          ...(args.prioritySources !== undefined ? { prioritySources: args.prioritySources } : {}),
        },
        args.systemPromptOverride !== undefined
          ? { systemPromptOverride: args.systemPromptOverride }
          : undefined,
      );
      const system = args.systemPromptPrefix
        ? `${args.systemPromptPrefix}\n\n${prompt.system}`
        : prompt.system;
      const result = await deps.gateway.send({
        model: args.model ?? deps.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        params: { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
        skill: 'plan-research',
      });
      if (!result.ok) {
        throw new PlanResearchError(`plan-research gateway failure: ${result.error.message}`);
      }
      const angles = parseAngles(firstText(result.content)).slice(0, maxAngles);
      return {
        angles,
        ...(result.llmCallId !== undefined ? { llmCallId: result.llmCallId } : {}),
        ...(result.costGbp !== undefined ? { costGbp: result.costGbp } : {}),
      };
    },
  };
}
