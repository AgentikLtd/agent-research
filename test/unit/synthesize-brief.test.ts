import { describe, it, expect } from 'vitest';
import { createSynthesizeBriefSkill, SynthesizeBriefError } from '../../src/skills/synthesize-brief.js';
import type { GatewayClient, LlmSendRequest, LlmSendResult } from '../../src/llm/gateway-client.js';
import type { Finding } from '../../src/research/findings.js';

const findings: readonly Finding[] = [{
  claim: 'X shipped', detail: 'd', label: 'GA', confidence: 'high',
  category: 'releases', sources: [{ url: 'https://e.example/a' }], flags: [], verdict: 'confirmed',
}];

function fakeGateway(result: LlmSendResult): { client: GatewayClient; calls: LlmSendRequest[] } {
  const calls: LlmSendRequest[] = [];
  return { calls, client: { async send(req) { calls.push(req); return result; } } };
}

describe('createSynthesizeBriefSkill', () => {
  it('returns markdown + citationCount; no web_search tool offered', async () => {
    const { client, calls } = fakeGateway({
      ok: true,
      content: [{ type: 'text', text: '# Brief\n\nX shipped [1].\n\n## Sources\n1. X — https://e.example/a' }],
      usage: { inputTokens: 100, outputTokens: 60 }, costGbp: 0.2, llmCallId: 'c1',
    });
    const skill = createSynthesizeBriefSkill({ gateway: client, model: 'anthropic/claude-opus-4-7' });
    const out = await skill.invoke({
      findings, briefDescription: 'T brief', since: 's', until: 'u',
      guardrails: [{ id: 'g4', rule: 'Label items.' }], markdownSections: ['headline', 'sources'],
    });
    expect(out.markdown).toContain('# Brief');
    expect(out.citationCount).toBe(1);
    expect(calls[0]?.tools).toBeUndefined();
    expect(calls[0]?.system).toContain('Label items.');
  });

  it('throws SynthesizeBriefError on gateway failure', async () => {
    const { client } = fakeGateway({ ok: false, error: { code: 'http_503', message: 'down' } });
    const skill = createSynthesizeBriefSkill({ gateway: client, model: 'm' });
    await expect(skill.invoke({ findings, briefDescription: 'b', since: 's', until: 'u' }))
      .rejects.toBeInstanceOf(SynthesizeBriefError);
  });

  it('requests a token budget with headroom for a long brief plus reasoning', async () => {
    // The synthesis call hit finish_reason 'length' on Gemini 3.5 Flash — a
    // thinking model spends reasoning tokens against the same budget, and the
    // brief is the longest artifact in the pipeline. 12k truncated it.
    const { client, calls } = fakeGateway({
      ok: true, content: [{ type: 'text', text: '# Brief' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const skill = createSynthesizeBriefSkill({ gateway: client, model: 'google/gemini-3.5-flash' });
    await skill.invoke({ findings, briefDescription: 'b', since: 's', until: 'u' });
    expect(calls[0]?.params.maxOutputTokens).toBeGreaterThanOrEqual(32000);
  });
});
