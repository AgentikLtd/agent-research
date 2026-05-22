import { describe, it, expect } from 'vitest';
import { createChallengeFindingsSkill } from '../../src/skills/challenge-findings.js';
import type { GatewayClient, LlmSendRequest, LlmSendResult } from '../../src/llm/gateway-client.js';
import type { Finding } from '../../src/research/findings.js';

const raw: Finding = {
  claim: 'X shipped', detail: 'd', label: 'GA', confidence: 'high',
  category: 'releases', sources: [{ url: 'https://e.example/a' }], flags: [],
};
const adjudicated = JSON.stringify([{ ...raw, verdict: 'confirmed' }]);

function fakeGateway(result: LlmSendResult): { client: GatewayClient; calls: LlmSendRequest[] } {
  const calls: LlmSendRequest[] = [];
  return { calls, client: { async send(req) { calls.push(req); return result; } } };
}

describe('createChallengeFindingsSkill', () => {
  it('offers web_search and returns adjudicated findings with verdicts', async () => {
    const { client, calls } = fakeGateway({
      ok: true, content: [{ type: 'text', text: adjudicated }],
      usage: { inputTokens: 10, outputTokens: 5 }, costGbp: 0.04,
    });
    const skill = createChallengeFindingsSkill({ gateway: client, model: 'anthropic/claude-sonnet-4-6' });
    const out = await skill.invoke({ findings: [raw], topic: 'T', since: 's', until: 'u' });
    expect(out.findings[0]?.verdict).toBe('confirmed');
    expect(calls[0]?.tools?.[0]).toMatchObject({ kind: 'server', tool: 'web_search' });
    expect(calls[0]?.messages[0]?.content[0]).toMatchObject({ type: 'text' });
  });

  it('defaults web_search to 10 results when none is configured', async () => {
    const { client, calls } = fakeGateway({
      ok: true, content: [{ type: 'text', text: adjudicated }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const skill = createChallengeFindingsSkill({ gateway: client, model: 'm' });
    await skill.invoke({ findings: [raw], topic: 'T', since: 's', until: 'u' });
    expect(calls[0]?.tools?.[0]).toMatchObject({ tool: 'web_search', maxResults: 10 });
  });
});
