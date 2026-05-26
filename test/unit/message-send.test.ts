/**
 * Unit tests for the `message/send` A2A handler added 2026-05-26 to
 * close the per-agent chat surface gap. Memory.md 2026-05-19 already
 * documents that agent-runtime implements `message/send`; this
 * specialist agent now matches that contract so the studio per-agent
 * chat surface AND the Concierge `call_agent` tool can reach it.
 *
 * Three test layers:
 *   - "ping" short-circuit returns a synthetic pong without touching the gateway
 *   - empty input → invalid_params 32602
 *   - non-empty input → gateway is called with the correct system prompt + model,
 *     and the gateway's text content surfaces in result.text
 *
 * The `chat` deps are optional on `HandleJsonRpcDeps`. We also cover
 * the back-compat branch where chat is absent — handler returns
 * method_not_found instead of crashing.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleJsonRpc, type ChatDeps } from '../../src/index.js';
import { createSkillRegistry } from '../../src/skills/registry.js';
import type { LlmSendResult } from '../../src/llm/gateway-client.js';

const TOKEN = 'test-token';
const AUTH = `Bearer ${TOKEN}`;

function makeGateway(result: LlmSendResult): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(async () => result) };
}

function makeChat(overrides: Partial<ChatDeps> = {}): ChatDeps {
  const gateway = overrides.gateway ?? makeGateway({
    ok: true,
    content: [{ type: 'text', text: 'hello from the agent' }],
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  return {
    gateway,
    model: 'anthropic/claude-sonnet-4-6',
    systemPrompt: 'You are a test agent. Reply briefly.',
    serviceName: 'test-agent',
    now: () => '2026-05-26T10:00:00.000Z',
    ...overrides,
  };
}

function body(id: number, input: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'message/send', params: { input } });
}

describe('handleJsonRpc message/send', () => {
  it('returns pong without touching the gateway when input is "ping"', async () => {
    const chat = makeChat();
    const res = await handleJsonRpc(
      { registry: createSkillRegistry(), expectedToken: TOKEN, chat },
      AUTH,
      body(1, 'ping'),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.result.text).toContain('pong');
    expect(parsed.result.text).toContain('test-agent');
    expect(parsed.result.role).toBe('ROLE_AGENT');
    expect(chat.gateway.send).not.toHaveBeenCalled();
  });

  it('returns 32602 invalid_params when input is empty', async () => {
    const res = await handleJsonRpc(
      { registry: createSkillRegistry(), expectedToken: TOKEN, chat: makeChat() },
      AUTH,
      body(2, '   '),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe(-32602);
  });

  it('dispatches non-ping input to the gateway with system prompt + model', async () => {
    const gateway = makeGateway({
      ok: true,
      content: [{ type: 'text', text: 'Sure thing.' }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const chat = makeChat({ gateway });
    const res = await handleJsonRpc(
      { registry: createSkillRegistry(), expectedToken: TOKEN, chat },
      AUTH,
      body(3, 'tell me about your last brief'),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.result.text).toBe('Sure thing.');
    expect(parsed.result.role).toBe('ROLE_AGENT');
    expect(gateway.send).toHaveBeenCalledOnce();
    const call = gateway.send.mock.calls[0][0];
    expect(call.model).toBe('anthropic/claude-sonnet-4-6');
    expect(call.system).toBe('You are a test agent. Reply briefly.');
    expect(call.messages[0].content[0].text).toBe('tell me about your last brief');
  });

  it('returns 32000 skill_error when the gateway fails', async () => {
    const gateway = makeGateway({ ok: false, error: { message: 'upstream timeout' } });
    const res = await handleJsonRpc(
      { registry: createSkillRegistry(), expectedToken: TOKEN, chat: makeChat({ gateway }) },
      AUTH,
      body(4, 'hi'),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe(-32000);
    expect(parsed.error.message).toContain('upstream timeout');
  });

  it('returns 32601 method_not_found when chat deps are absent (back-compat)', async () => {
    const res = await handleJsonRpc(
      { registry: createSkillRegistry(), expectedToken: TOKEN },
      AUTH,
      body(5, 'hi'),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe(-32601);
    expect(parsed.error.message).toContain('not configured');
  });
});
