import { describe, it, expect } from 'vitest';
import { createGatewayClient, type LlmSendRequest } from '../../src/llm/gateway-client.js';

const baseReq: LlmSendRequest = {
  model: 'anthropic/claude-haiku-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  system: 'be brief',
  tools: [],
  params: { maxOutputTokens: 256 },
};

describe('createGatewayClient', () => {
  it('POSTs the request to /api/llm/send with the bearer token and unwraps the wire envelope', async () => {
    let captured: { url: string; method: string | undefined; auth: string | null; body: unknown } = {
      url: '',
      method: undefined,
      auth: null,
      body: null,
    };
    const fetcher: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const headers = new Headers(init?.headers);
      captured = {
        url,
        method: init?.method,
        auth: headers.get('authorization'),
        body: init?.body ? JSON.parse(init.body as string) : null,
      };
      return new Response(
        JSON.stringify({
          ok: true,
          response: {
            id: 'msg_42',
            content: [{ type: 'text', text: 'hi back' }],
            usage: { inputTokens: 10, outputTokens: 5 },
            cost: { currency: 'GBP', amount: 0.001 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const client = createGatewayClient({
      hubUrl: 'https://demo.studio.agentik.co.uk',
      token: 'tok_research',
      fetcher,
    });
    const result = await client.send(baseReq);

    expect(captured.url).toBe('https://demo.studio.agentik.co.uk/api/llm/send');
    expect(captured.method).toBe('POST');
    expect(captured.auth).toBe('Bearer tok_research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toEqual([{ type: 'text', text: 'hi back' }]);
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(result.costGbp).toBe(0.001);
      expect(result.llmCallId).toBe('msg_42');
    }
  });

  it('returns ok:false when the fetcher throws', async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const client = createGatewayClient({
      hubUrl: 'http://nowhere.invalid',
      token: 'tok',
      fetcher,
    });
    const result = await client.send(baseReq);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('ECONNREFUSED');
    }
  });
});
