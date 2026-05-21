import { describe, it, expect } from 'vitest';
import { createPlanResearchSkill } from '../../src/skills/plan-research.js';
import type { GatewayClient, LlmSendRequest, LlmSendResult } from '../../src/llm/gateway-client.js';

function fakeGateway(result: LlmSendResult): { client: GatewayClient; calls: LlmSendRequest[] } {
  const calls: LlmSendRequest[] = [];
  return { calls, client: { async send(req) { calls.push(req); return result; } } };
}

describe('createPlanResearchSkill', () => {
  it('returns parsed angles and uses the deps model by default', async () => {
    const { client, calls } = fakeGateway({
      ok: true, content: [{ type: 'text', text: '["angle one","angle two"]' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const skill = createPlanResearchSkill({ gateway: client, model: 'anthropic/claude-haiku-4-5-20251001' });
    const out = await skill.invoke({ topic: 'T', since: 's', until: 'u' });
    expect(out.angles).toEqual(['angle one', 'angle two']);
    expect(calls[0]?.model).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(calls[0]?.tools).toBeUndefined();
  });

  it('honours a per-run model override and caps angle count', async () => {
    const { client, calls } = fakeGateway({
      ok: true, content: [{ type: 'text', text: '["a","b","c","d","e","f"]' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const skill = createPlanResearchSkill({ gateway: client, model: 'm' });
    const out = await skill.invoke({ topic: 'T', since: 's', until: 'u', maxAngles: 3, model: 'google/gemini-3.5-flash' });
    expect(out.angles).toHaveLength(3);
    expect(calls[0]?.model).toBe('google/gemini-3.5-flash');
  });
});
