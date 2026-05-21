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

const DEFAULT_WEB_SEARCH_MAX_RESULTS = 6;
// 16000: a verbose angle's Finding[] JSON exceeded the old 6000 cap and was
// truncated mid-structure, failing parseFindings. Findings are also bounded
// to <=8 in the prompt; 16000 leaves ample headroom.
const DEFAULT_MAX_OUTPUT_TOKENS = 16000;

export interface ResearchAngleArgs {
  readonly angle: string;
  readonly topic: string;
  readonly since: string;
  readonly until: string;
  readonly prioritySources?: readonly PrioritySource[];
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
  /** Web results pulled per search; falls back to 6. */
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
