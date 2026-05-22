import { describe, it, expect } from 'vitest';
import { createResearchAngleSkill } from '../../src/skills/research-angle.js';
import type { GatewayClient, LlmSendRequest, LlmSendResult } from '../../src/llm/gateway-client.js';

const findingJson = JSON.stringify([{
  claim: 'X shipped', detail: 'd', label: 'GA', confidence: 'high',
  category: 'releases', sources: [{ url: 'https://e.example/a' }], flags: [],
}]);

function fakeGateway(result: LlmSendResult): { client: GatewayClient; calls: LlmSendRequest[] } {
  const calls: LlmSendRequest[] = [];
  return { calls, client: { async send(req) { calls.push(req); return result; } } };
}

describe('createResearchAngleSkill', () => {
  it('offers the web_search tool and returns parsed findings', async () => {
    const { client, calls } = fakeGateway({
      ok: true, content: [{ type: 'text', text: findingJson }],
      usage: { inputTokens: 10, outputTokens: 5 }, costGbp: 0.06,
    });
    const skill = createResearchAngleSkill({ gateway: client, model: 'anthropic/claude-sonnet-4-6', webSearchMaxResults: 6 });
    const out = await skill.invoke({ angle: 'A', topic: 'T', since: 's', until: 'u' });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.claim).toBe('X shipped');
    expect(calls[0]?.tools).toEqual([{ kind: 'server', tool: 'web_search', maxResults: 6 }]);
  });

  it('throws when the gateway fails (run-brief drops the angle)', async () => {
    const { client } = fakeGateway({ ok: false, error: { code: 'http_503', message: 'upstream down' } });
    const skill = createResearchAngleSkill({ gateway: client, model: 'm' });
    await expect(skill.invoke({ angle: 'A', topic: 'T', since: 's', until: 'u' }))
      .rejects.toThrow(/upstream down/);
  });

  it('requests a token budget with headroom for thinking-model reasoning', async () => {
    // A verbose research call reached 94% of the old 16k cap on Gemini 3.5
    // Flash; a thinking model's reasoning shares this budget with the
    // Finding[] JSON, so a truncated angle silently fails parseFindings.
    const { client, calls } = fakeGateway({
      ok: true, content: [{ type: 'text', text: findingJson }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const skill = createResearchAngleSkill({ gateway: client, model: 'google/gemini-3.5-flash' });
    await skill.invoke({ angle: 'A', topic: 'T', since: 's', until: 'u' });
    expect(calls[0]?.params.maxOutputTokens).toBeGreaterThanOrEqual(24000);
  });
});
