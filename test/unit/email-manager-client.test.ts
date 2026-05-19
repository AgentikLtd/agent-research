import { describe, it, expect } from 'vitest';
import { createEmailManagerClient } from '../../src/a2a/email-manager-client.js';

describe('createEmailManagerClient', () => {
  it('POSTs the JSON-RPC message/send envelope via the hub proxy and returns messageId', async () => {
    let captured: { url: string; auth: string | null; body: unknown } = {
      url: '',
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
        auth: headers.get('authorization'),
        body: init?.body ? JSON.parse(init.body as string) : null,
      };
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          result: {
            role: 'ROLE_AGENT',
            parts: [{ data: { messageId: 'gmail_msg_42', draftId: 'draft_42' } }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const client = createEmailManagerClient({
      hubUrl: 'https://demo.studio.agentik.co.uk',
      token: 'tok_research',
      emailManagerAgentId: 'agent_email_mgr',
      fetcher,
    });
    const result = await client.draftEmail({
      to: ['user@example.com'],
      subject: 'Weekly research brief',
      body: '# Brief\n...',
    });

    expect(captured.url).toBe(
      'https://demo.studio.agentik.co.uk/api/agents/agent_email_mgr/invoke-skill',
    );
    expect(captured.auth).toBe('Bearer tok_research');
    const body = captured.body as {
      jsonrpc: string;
      method: string;
      params: {
        message: { parts: { data: Record<string, unknown> }[] };
        configuration: { metadata: Record<string, string> };
      };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('message/send');
    expect(body.params.configuration.metadata['skill']).toBe('draft-email');
    expect(body.params.message.parts[0]?.data['to']).toBe('user@example.com');
    expect(body.params.message.parts[0]?.data['subject']).toBe('Weekly research brief');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toBe('gmail_msg_42');
    }
  });

  it('returns ok:false when the hub proxy rejects', async () => {
    const fetcher: typeof fetch = async () =>
      new Response('invoke-skill route not yet deployed', { status: 404 });
    const client = createEmailManagerClient({
      hubUrl: 'http://hub',
      token: 'tok',
      emailManagerAgentId: 'agent_email_mgr',
      fetcher,
    });
    const result = await client.draftEmail({
      to: ['someone@example.com'],
      subject: 's',
      body: 'b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('http_404');
      expect(result.error.message).toContain('404');
      expect(result.error.message).toContain('invoke-skill route not yet deployed');
    }
  });
});
