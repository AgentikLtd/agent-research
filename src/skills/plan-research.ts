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

export interface PlanResearchArgs {
  readonly topic: string;
  readonly since: string;
  readonly until: string;
  readonly prioritySources?: readonly PrioritySource[];
  readonly maxAngles?: number;
  /** Per-run model override; falls back to the skill's deps model. */
  readonly model?: string;
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
      const prompt = buildPlanPrompt({
        topic: args.topic,
        since: args.since,
        until: args.until,
        maxAngles,
        ...(args.prioritySources !== undefined ? { prioritySources: args.prioritySources } : {}),
      });
      const result = await deps.gateway.send({
        model: args.model ?? deps.model,
        system: prompt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        params: { maxOutputTokens: 1000 },
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
