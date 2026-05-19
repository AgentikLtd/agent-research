import { describe, it, expect } from 'vitest';
import {
  createComposeBriefSkill,
  LlmGatewayError,
} from '../../src/skills/compose-brief.js';
import type {
  GatewayClient,
  LlmSendRequest,
  LlmSendResult,
} from '../../src/llm/gateway-client.js';
import type { SourceItem } from '../../src/sources/contracts.js';

const items: ReadonlyArray<SourceItem> = [
  {
    sourceId: 'rss-genesys',
    title: 'Genesys announces new analytics dashboard',
    url: 'https://genesys.example/news/1',
    publishedAt: '2026-05-18T10:00:00Z',
    summary: 'A new dashboard surfaces queue health.',
  },
  {
    sourceId: 'r/callcentres',
    title: 'AMA with a Genesys solution architect',
    url: 'https://reddit.com/r/callcentres/ama',
    publishedAt: '2026-05-17T15:00:00Z',
  },
];

function fakeGateway(result: LlmSendResult): {
  client: GatewayClient;
  calls: LlmSendRequest[];
} {
  const calls: LlmSendRequest[] = [];
  const client: GatewayClient = {
    async send(req) {
      calls.push(req);
      return result;
    },
  };
  return { client, calls };
}

describe('createComposeBriefSkill', () => {
  it('returns markdown + citationCount from a successful gateway response', async () => {
    const { client, calls } = fakeGateway({
      ok: true,
      content: [
        {
          type: 'text',
          text: '# Weekly Genesys brief\n\nThe new dashboard ships [1]. AMA highlights queue routing [2]. Also [1] confirms beta access.',
        },
      ],
      usage: { inputTokens: 200, outputTokens: 100 },
      costGbp: 0.012,
      llmCallId: 'call_42',
    });

    const skill = createComposeBriefSkill({ gateway: client });
    const result = await skill.invoke({
      model: 'anthropic/claude-sonnet-4-5',
      briefDescription: 'Genesys Cloud weekly research',
      items,
      since: '2026-05-12T00:00:00Z',
      until: '2026-05-19T00:00:00Z',
    });

    expect(result.markdown).toContain('# Weekly Genesys brief');
    expect(result.citationCount).toBe(3); // [1], [2], [1]
    expect(result.llmCallId).toBe('call_42');
    expect(result.costGbp).toBe(0.012);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe('anthropic/claude-sonnet-4-5');
    expect(calls[0]?.params.maxOutputTokens).toBe(8000);
    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.system).toContain('research analyst');
    expect(calls[0]?.messages[0]?.role).toBe('user');
  });

  it('throws LlmGatewayError when the gateway returns ok:false', async () => {
    const { client } = fakeGateway({
      ok: false,
      error: { code: 'http_503', message: 'gateway /api/llm/send 503: upstream unavailable' },
    });

    const skill = createComposeBriefSkill({ gateway: client });
    await expect(
      skill.invoke({
        model: 'anthropic/claude-sonnet-4-5',
        briefDescription: 'x',
        items,
        since: '2026-05-12T00:00:00Z',
        until: '2026-05-19T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(LlmGatewayError);

    await expect(
      skill.invoke({
        model: 'anthropic/claude-sonnet-4-5',
        briefDescription: 'x',
        items,
        since: '2026-05-12T00:00:00Z',
        until: '2026-05-19T00:00:00Z',
      }),
    ).rejects.toThrow(/upstream unavailable/);
  });
});
