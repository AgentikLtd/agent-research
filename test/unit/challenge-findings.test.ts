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

  it('defaults web_search to 6 results when none is configured', async () => {
    const { client, calls } = fakeGateway({
      ok: true, content: [{ type: 'text', text: adjudicated }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const skill = createChallengeFindingsSkill({ gateway: client, model: 'm' });
    await skill.invoke({ findings: [raw], topic: 'T', since: 's', until: 'u' });
    expect(calls[0]?.tools?.[0]).toMatchObject({ tool: 'web_search', maxResults: 6 });
  });

  // DDR-001 anti-dead-field proof (Phase 6 Task 6.6): the verifier persona's
  // system_prompt is a LIVE consumed field — it reaches the actual model prompt.
  // Skill-level half of the end-to-end trace (the orchestrator half lives in
  // run-brief.test.ts Test A).
  it('Test B: threads systemPromptOverride into the gateway system prompt, preserving the JSON contract', async () => {
    const { client, calls } = fakeGateway({
      ok: true, content: [{ type: 'text', text: adjudicated }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const skill = createChallengeFindingsSkill({ gateway: client, model: 'm' });
    await skill.invoke({
      findings: [raw], topic: 'X', since: 'S', until: 'U',
      systemPromptOverride: 'SENTINEL_VERIFIER_ROLE_9f3a',
    });
    const system = calls[0]?.system ?? '';
    // The override REPLACES the default role span...
    expect(system).toContain('SENTINEL_VERIFIER_ROLE_9f3a');
    expect(system).not.toContain('You are a skeptical verifier with a web search tool.');
    // ...but the fixed JSON output contract tail is always preserved.
    expect(system).toContain('Output ONLY the full adjudicated JSON array');
  });

  it('Test B (inverse): without an override the default verifier role is used', async () => {
    const { client, calls } = fakeGateway({
      ok: true, content: [{ type: 'text', text: adjudicated }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const skill = createChallengeFindingsSkill({ gateway: client, model: 'm' });
    await skill.invoke({ findings: [raw], topic: 'X', since: 'S', until: 'U' });
    const system = calls[0]?.system ?? '';
    expect(system).toContain('You are a skeptical verifier with a web search tool.');
    expect(system).toContain('Output ONLY the full adjudicated JSON array');
  });
});
