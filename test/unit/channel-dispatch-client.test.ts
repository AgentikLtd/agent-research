import { describe, it, expect } from 'vitest';
import { createChannelDispatchClient } from '../../src/hub/channel-dispatch-client.js';

interface CapturedRequest {
  url: string;
  method: string;
  auth: string | null;
  contentType: string | null;
  body: unknown;
}

function makeCapturingFetcher(
  response: Response | (() => Response | Promise<Response>),
  captured: { value?: CapturedRequest } = {},
): typeof fetch {
  return (async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers = new Headers(init?.headers);
    captured.value = {
      url,
      method: init?.method ?? 'GET',
      auth: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body: init?.body ? JSON.parse(init.body as string) : null,
    };
    return typeof response === 'function' ? await response() : response;
  }) as typeof fetch;
}

describe('createChannelDispatchClient', () => {
  it('success path: returns ok + messageId when status=sent + receiptId present', async () => {
    const captured: { value?: CapturedRequest } = {};
    const fetcher = makeCapturingFetcher(
      new Response(
        JSON.stringify({
          channelId: 'agentmail',
          status: 'sent',
          receiptId: 'msg-123',
          idempotencyKey: 'k1',
          attemptedAt: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
      captured,
    );

    const client = createChannelDispatchClient({
      hubUrl: 'https://demo.studio.agentik.co.uk',
      token: 'tok_research',
      fetcher,
    });
    const result = await client.dispatch({
      eventId: 'scheduled_summary',
      title: 'Weekly brief',
      body: '# Brief body',
      metadata: { recipients: 'a@example.com,b@example.com' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messageId).toBe('msg-123');
      expect(result.channelId).toBe('agentmail');
    }
  });

  it('failure path: returns ok:false with error code+message when status=failed', async () => {
    const fetcher = makeCapturingFetcher(
      new Response(
        JSON.stringify({
          channelId: 'web-inbox',
          status: 'failed',
          error: { code: 'rejected', message: 'oops' },
          idempotencyKey: 'k1',
          attemptedAt: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const client = createChannelDispatchClient({
      hubUrl: 'http://hub',
      token: 'tok',
      fetcher,
    });
    const result = await client.dispatch({
      eventId: 'informational',
      title: 't',
      body: 'b',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rejected');
      expect(result.error.message).toBe('oops');
    }
  });

  it('network error: returns ok:false with code=network_error when fetcher throws', async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error('socket hang up');
    };
    const client = createChannelDispatchClient({
      hubUrl: 'http://hub',
      token: 'tok',
      fetcher,
    });
    const result = await client.dispatch({
      eventId: 'critical',
      title: 't',
      body: 'b',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('network_error');
      expect(result.error.message).toContain('socket hang up');
    }
  });

  it('sets Authorization: Bearer <token> and content-type=application/json', async () => {
    const captured: { value?: CapturedRequest } = {};
    const fetcher = makeCapturingFetcher(
      new Response(
        JSON.stringify({
          channelId: 'web-inbox',
          status: 'sent',
          receiptId: 'r',
          idempotencyKey: 'k',
          attemptedAt: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
      captured,
    );

    const client = createChannelDispatchClient({
      hubUrl: 'https://hub.example/',
      token: 'tok_xyz',
      fetcher,
    });
    await client.dispatch({
      eventId: 'scheduled_summary',
      title: 't',
      body: 'b',
    });

    expect(captured.value?.method).toBe('POST');
    expect(captured.value?.url).toBe('https://hub.example/api/channel/dispatch');
    expect(captured.value?.auth).toBe('Bearer tok_xyz');
    expect(captured.value?.contentType).toBe('application/json');
  });

  it('forwards idempotencyKey as snake_case idempotency_key on the wire', async () => {
    const captured: { value?: CapturedRequest } = {};
    const fetcher = makeCapturingFetcher(
      new Response(
        JSON.stringify({
          channelId: 'agentmail',
          status: 'sent',
          receiptId: 'r',
          idempotencyKey: 'my-key',
          attemptedAt: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
      captured,
    );

    const client = createChannelDispatchClient({
      hubUrl: 'http://hub',
      token: 'tok',
      fetcher,
    });
    await client.dispatch({
      eventId: 'scheduled_summary',
      title: 'Title',
      body: 'Body',
      metadata: { recipients: 'x@y.z' },
      idempotencyKey: 'my-key',
    });

    const body = captured.value?.body as {
      event_id: string;
      payload: { title: string; body: string; metadata?: Record<string, unknown> };
      idempotency_key?: string;
    };
    expect(body.event_id).toBe('scheduled_summary');
    expect(body.payload.title).toBe('Title');
    expect(body.payload.body).toBe('Body');
    expect(body.payload.metadata).toEqual({ recipients: 'x@y.z' });
    expect(body.idempotency_key).toBe('my-key');
    // Camel-case form must NOT leak onto the wire.
    expect(
      (body as unknown as Record<string, unknown>)['idempotencyKey'],
    ).toBeUndefined();
  });
});
