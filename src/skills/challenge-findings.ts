/**
 * challenge-findings skill — the adversarial verifier. Given researcher
 * findings, it independently corroborates or refutes each with web search and
 * returns the full set adjudicated (every finding gets a verdict). Throws on
 * gateway failure or unparseable output — run-brief degrades by using the
 * un-adjudicated findings.
 */
import type { LlmContentPart, LlmServerTool } from '../contracts.js';
import type { GatewayClient } from '../llm/gateway-client.js';
import { buildChallengePrompt } from '../prompts/brief-prompts.js';
import { type Finding, parseFindings } from '../research/findings.js';
import type { Skill } from './registry.js';

const DEFAULT_WEB_SEARCH_MAX_RESULTS = 6;
// 24000: the verifier re-emits every finding adjudicated; over ~30 findings
// the old 8000 cap truncated the JSON, so every run degraded to unverified.
const DEFAULT_MAX_OUTPUT_TOKENS = 24000;

export interface ChallengeFindingsArgs {
  readonly findings: readonly Finding[];
  readonly topic: string;
  readonly since: string;
  readonly until: string;
  readonly model?: string;
}

export interface ChallengeFindingsResult {
  readonly findings: readonly Finding[];
  readonly llmCallId?: string;
  readonly costGbp?: number;
}

export interface ChallengeFindingsDeps {
  readonly gateway: GatewayClient;
  readonly model: string;
  readonly webSearchMaxResults?: number;
}

export class ChallengeFindingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChallengeFindingsError';
  }
}

function firstText(content: ReadonlyArray<LlmContentPart>): string {
  return content.filter((p) => p.type === 'text').map((p) => p.text).join('');
}

export function createChallengeFindingsSkill(
  deps: ChallengeFindingsDeps,
): Skill<ChallengeFindingsArgs, ChallengeFindingsResult> {
  return {
    name: 'challenge-findings',
    description: 'Adversarially verify researcher findings with independent web search.',
    async invoke(args) {
      const prompt = buildChallengePrompt({
        topic: args.topic,
        since: args.since,
        until: args.until,
        findings: args.findings,
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
        throw new ChallengeFindingsError(`challenge-findings gateway failure: ${result.error.message}`);
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
