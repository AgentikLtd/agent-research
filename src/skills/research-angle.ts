/**
 * research-angle skill — one autonomous web researcher for one angle.
 * Offers the web_search server tool; returns structured Finding[].
 * Throws on gateway failure or unparseable output — run-brief runs angles
 * with allSettled semantics so a failed angle simply contributes nothing.
 */
import type { LlmContentPart, LlmServerTool } from '../contracts.js';
import type { GatewayClient } from '../llm/gateway-client.js';
import { buildResearchPrompt, type PrioritySource } from '../prompts/brief-prompts.js';
import { type Finding, parseFindings } from '../research/findings.js';
import type { Skill } from './registry.js';

// 6: web_search results are pulled into the model's context and the agentic
// tool-use loop spends OUTPUT-token budget. Raising this to 10 (briefly tried,
// Spec WA3) made models over-search and exhaust the budget before emitting the
// Finding[] JSON — every angle then failed parseFindings. Reverted to the
// proven 6; search breadth is now bounded by the prompt instead.
const DEFAULT_WEB_SEARCH_MAX_RESULTS = 6;
// 32000: an angle's Finding[] JSON shares this budget with the web-search
// tool-use loop AND a thinking model's reasoning. 24000 (the prior value) was
// exhausted by the search loop before the JSON was emitted; 32000 gives
// headroom for a focused search pass plus the full findings array.
const DEFAULT_MAX_OUTPUT_TOKENS = 32000;

export interface ResearchAngleArgs {
  readonly angle: string;
  readonly topic: string;
  readonly since: string;
  readonly until: string;
  readonly prioritySources?: readonly PrioritySource[];
  /** Stage-0 community digest, injected as seed leads into the prompt. */
  readonly communityDigest?: string;
  readonly model?: string;
}

export interface ResearchAngleResult {
  readonly findings: readonly Finding[];
  readonly llmCallId?: string;
  readonly costGbp?: number;
}

export interface ResearchAngleDeps {
  readonly gateway: GatewayClient;
  readonly model: string;
  /** Web results pulled per search; falls back to 10. */
  readonly webSearchMaxResults?: number;
}

export class ResearchAngleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchAngleError';
  }
}

function firstText(content: ReadonlyArray<LlmContentPart>): string {
  return content.filter((p) => p.type === 'text').map((p) => p.text).join('');
}

export function createResearchAngleSkill(
  deps: ResearchAngleDeps,
): Skill<ResearchAngleArgs, ResearchAngleResult> {
  return {
    name: 'research-angle',
    description: 'Autonomously research one angle with web search; emit Finding[].',
    async invoke(args) {
      const prompt = buildResearchPrompt({
        angle: args.angle,
        topic: args.topic,
        since: args.since,
        until: args.until,
        ...(args.prioritySources !== undefined ? { prioritySources: args.prioritySources } : {}),
        ...(args.communityDigest !== undefined ? { communityDigest: args.communityDigest } : {}),
      });
      const webSearch: LlmServerTool = {
        kind: 'server',
        tool: 'web_search',
        maxResults: deps.webSearchMaxResults ?? DEFAULT_WEB_SEARCH_MAX_RESULTS,
      };
      const result = await deps.gateway.send({
        model: args.model ?? deps.model,
        system: prompt.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        tools: [webSearch],
        params: { maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
      });
      if (!result.ok) {
        throw new ResearchAngleError(`research-angle gateway failure: ${result.error.message}`);
      }
      const findings = parseFindings(firstText(result.content));
      return {
        findings,
        ...(result.llmCallId !== undefined ? { llmCallId: result.llmCallId } : {}),
        ...(result.costGbp !== undefined ? { costGbp: result.costGbp } : {}),
      };
    },
  };
}
