import { describe, it, expect } from 'vitest';
import {
  createDispatchBriefSkill,
  DispatchError,
} from '../../src/skills/dispatch-brief.js';
import type {
  AgentProfile,
  ProfileClient,
  TenantSettings,
} from '../../src/hub/profile-client.js';
import type { StorageClient } from '../../src/hub/storage-client.js';
import type {
  ChannelDispatchArgs,
  ChannelDispatchClient,
  ChannelDispatchResult,
} from '../../src/hub/channel-dispatch-client.js';
import type { AuditClient, AuditEvent } from '../../src/hub/audit-client.js';

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agent_id: 'agent_research_1',
    agent_name: 'genesys-research',
    tenant_id: 'demo1505',
    config: {
      output: {
        additional_recipients: ['analyst@example.com'],
      },
    },
    ...overrides,
  };
}

function fakeProfileClient(
  profile: AgentProfile,
  tenant: TenantSettings,
): ProfileClient {
  return {
    async get() {
      return profile;
    },
    async getTenantSettings() {
      return tenant;
    },
    invalidate() {},
  };
}

function fakeStorage(
  result: Awaited<ReturnType<StorageClient['put']>>,
  capture?: { path?: string; body?: string },
): StorageClient {
  return {
    async put(path, body) {
      if (capture) {
        capture.path = path;
        capture.body = body;
      }
      return result;
    },
  };
}

function fakeChannel(
  result: ChannelDispatchResult,
  capture?: { args?: ChannelDispatchArgs },
): ChannelDispatchClient {
  return {
    async dispatch(args) {
      if (capture) capture.args = args;
      return result;
    },
  };
}

function fakeAudit(capture?: { events: AuditEvent[] }): AuditClient {
  return {
    async emit(event) {
      if (capture) capture.events.push(event);
    },
  };
}

describe('createDispatchBriefSkill', () => {
  it('happy path: writes to storage then dispatches via channel and returns messageId+channelId', async () => {
    const profile = makeProfile();
    const tenant: TenantSettings = {
      tenant_id: 'demo1505',
      operator_email: 'ops@example.com',
    };
    const storageCapture: { path?: string; body?: string } = {};
    const channelCapture: { args?: ChannelDispatchArgs } = {};

    const skill = createDispatchBriefSkill({
      profile: fakeProfileClient(profile, tenant),
      storage: fakeStorage(
        { ok: true, uri: 'workspace://genesys-research/briefs/2026-05-19.md' },
        storageCapture,
      ),
      channel: fakeChannel(
        { ok: true, messageId: 'mail_msg_42', channelId: 'agentmail' },
        channelCapture,
      ),
      audit: fakeAudit(),
    });

    const result = await skill.invoke({
      subject: 'Genesys Cloud Weekly Brief — 2026-05-19',
      body: '# Brief body',
      date: '2026-05-19',
    });

    expect(result.dryRun).toBe(false);
    expect(result.storageUri).toBe('workspace://genesys-research/briefs/2026-05-19.md');
    expect(result.emailMessageId).toBe('mail_msg_42');
    expect(result.channelId).toBe('agentmail');
    expect(result.recipients).toEqual(['ops@example.com', 'analyst@example.com']);

    // Regression guard for AGK-017 double-nesting: the path is RELATIVE
    // to the token namespace — NO `genesys-research/` prefix. The hub PUT
    // route scopes by the token's namespace, so prepending it here would
    // produce the doubly-nested `genesys-research/genesys-research/...` key.
    expect(storageCapture.path).toBe('briefs/2026-05-19.md');
    expect(storageCapture.body).toBe('# Brief body');
    expect(result.storageWarning).toBeUndefined();

    // Channel dispatch shape: event_id=scheduled_summary, title=subject,
    // body=markdown, recipients comma-joined in metadata.
    expect(channelCapture.args?.eventId).toBe('scheduled_summary');
    expect(channelCapture.args?.title).toBe('Genesys Cloud Weekly Brief — 2026-05-19');
    expect(channelCapture.args?.body).toBe('# Brief body');
    expect(channelCapture.args?.metadata?.['recipients']).toBe(
      'ops@example.com,analyst@example.com',
    );
    expect(channelCapture.args?.metadata?.['storage_uri']).toBe(
      'workspace://genesys-research/briefs/2026-05-19.md',
    );
  });

  it('storage put failure is observable but does NOT abort the dispatch (AGK-017)', async () => {
    const profile = makeProfile();
    const tenant: TenantSettings = {
      tenant_id: 'demo1505',
      operator_email: 'ops@example.com',
    };
    const channelCapture: { args?: ChannelDispatchArgs } = {};
    const auditCapture: { events: AuditEvent[] } = { events: [] };
    const warnLines: Array<{ line: string; detail?: unknown }> = [];

    const skill = createDispatchBriefSkill({
      profile: fakeProfileClient(profile, tenant),
      storage: fakeStorage({
        ok: false,
        error: { code: 'http_500', message: 'gateway /api/storage/put 500: boom' },
      }),
      channel: fakeChannel(
        { ok: true, messageId: 'mail_msg_99', channelId: 'agentmail' },
        channelCapture,
      ),
      audit: fakeAudit(auditCapture),
      warn: (line, detail) => warnLines.push({ line, detail }),
    });

    const result = await skill.invoke({
      subject: 's',
      body: 'b',
      date: '2026-05-19',
    });

    // (a) channel dispatch STILL happened — brief was delivered.
    expect(channelCapture.args?.eventId).toBe('scheduled_summary');
    expect(result.emailMessageId).toBe('mail_msg_99');
    expect(result.dryRun).toBe(false);

    // (b) an audit event was emitted with the path + error.
    const failureEvent = auditCapture.events.find(
      (e) => e.eventType === 'dispatch.storage_put_failed',
    );
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.payload['path']).toBe('briefs/2026-05-19.md');
    expect(failureEvent?.payload['error']).toBe(
      'gateway /api/storage/put 500: boom',
    );

    // (c) the returned result carries the warning signal.
    expect(result.storageWarning).toContain('gateway /api/storage/put 500: boom');
    // storageUri must NOT be set on failure.
    expect(result.storageUri).toBeUndefined();

    // (d) warn was still called.
    expect(warnLines.some((w) => w.line.includes('storage put failed'))).toBe(true);
  });

  it('dedupes recipients across tenant operator_email and profile additional_recipients (case-insensitive)', async () => {
    const profile = makeProfile({
      config: {
        output: {
          additional_recipients: [
            'OPS@example.com', // dup of tenant operator with different case
            'analyst@example.com',
            '   ', // empty after trim — filtered
            '',
            'analyst@example.com', // exact dup
          ],
        },
      },
    });
    const tenant: TenantSettings = {
      tenant_id: 'demo1505',
      operator_email: 'ops@example.com',
    };
    const channelCapture: { args?: ChannelDispatchArgs } = {};
    const skill = createDispatchBriefSkill({
      profile: fakeProfileClient(profile, tenant),
      storage: fakeStorage({ ok: true, uri: 'workspace://x' }),
      channel: fakeChannel(
        { ok: true, messageId: 'mid', channelId: 'agentmail' },
        channelCapture,
      ),
      audit: fakeAudit(),
    });

    const result = await skill.invoke({
      subject: 's',
      body: 'b',
      date: '2026-05-19',
    });
    expect(result.recipients).toEqual(['ops@example.com', 'analyst@example.com']);
    // Comma-joined into metadata — preserves the same deduped order.
    expect(channelCapture.args?.metadata?.['recipients']).toBe(
      'ops@example.com,analyst@example.com',
    );
  });

  it('throws DispatchError(no_recipients) when both sources are empty', async () => {
    const profile = makeProfile({
      config: { output: { additional_recipients: [] } },
    });
    const tenant: TenantSettings = { tenant_id: 'demo1505' }; // no operator_email
    const skill = createDispatchBriefSkill({
      profile: fakeProfileClient(profile, tenant),
      storage: fakeStorage({ ok: true, uri: 'workspace://x' }),
      channel: fakeChannel({ ok: true, messageId: 'mid', channelId: 'web-inbox' }),
      audit: fakeAudit(),
    });

    let thrown: unknown;
    try {
      await skill.invoke({ subject: 's', body: 'b', date: '2026-05-19' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DispatchError);
    expect((thrown as DispatchError).kind).toBe('no_recipients');
  });

  it('dryRun: returns synthetic ids without calling storage or channel', async () => {
    const profile = makeProfile();
    const tenant: TenantSettings = {
      tenant_id: 'demo1505',
      operator_email: 'ops@example.com',
    };
    let storageCalled = false;
    let channelCalled = false;
    const skill = createDispatchBriefSkill({
      profile: fakeProfileClient(profile, tenant),
      storage: {
        async put() {
          storageCalled = true;
          return { ok: true, uri: 'should-not-be-called' };
        },
      },
      channel: {
        async dispatch() {
          channelCalled = true;
          return { ok: true, messageId: 'should-not-be-called', channelId: 'should-not-be-called' };
        },
      },
      audit: fakeAudit(),
    });

    const result = await skill.invoke({
      subject: 's',
      body: 'b',
      date: '2026-05-19',
      dryRun: true,
    });
    expect(storageCalled).toBe(false);
    expect(channelCalled).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.storageUri).toBe('dryrun://briefs/2026-05-19.md');
    expect(result.emailMessageId).toMatch(/^dryrun-message-/);
  });
});
