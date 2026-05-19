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
import type { EmailManagerClient } from '../../src/a2a/email-manager-client.js';
import type { AuditClient } from '../../src/hub/audit-client.js';

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

function fakeEmail(
  result: Awaited<ReturnType<EmailManagerClient['draftEmail']>>,
  capture?: { to?: ReadonlyArray<string>; subject?: string },
): EmailManagerClient {
  return {
    async draftEmail(args) {
      if (capture) {
        capture.to = args.to;
        capture.subject = args.subject;
      }
      return result;
    },
  };
}

function fakeAudit(): AuditClient {
  return {
    async emit() {},
  };
}

describe('createDispatchBriefSkill', () => {
  it('happy path: writes to storage then queues email and returns both ids', async () => {
    const profile = makeProfile();
    const tenant: TenantSettings = {
      tenant_id: 'demo1505',
      operator_email: 'ops@example.com',
    };
    const storageCapture: { path?: string; body?: string } = {};
    const emailCapture: { to?: ReadonlyArray<string>; subject?: string } = {};

    const skill = createDispatchBriefSkill({
      profile: fakeProfileClient(profile, tenant),
      storage: fakeStorage(
        { ok: true, uri: 'workspace://genesys-research/briefs/2026-05-19.md' },
        storageCapture,
      ),
      email: fakeEmail({ ok: true, messageId: 'gmail_msg_42' }, emailCapture),
      audit: fakeAudit(),
    });

    const result = await skill.invoke({
      subject: 'Genesys Cloud Weekly Brief — 2026-05-19',
      body: '# Brief body',
      date: '2026-05-19',
    });

    expect(result.dryRun).toBe(false);
    expect(result.storageUri).toBe('workspace://genesys-research/briefs/2026-05-19.md');
    expect(result.emailMessageId).toBe('gmail_msg_42');
    expect(result.recipients).toEqual(['ops@example.com', 'analyst@example.com']);
    expect(storageCapture.path).toBe('genesys-research/briefs/2026-05-19.md');
    expect(storageCapture.body).toBe('# Brief body');
    expect(emailCapture.to).toEqual(['ops@example.com', 'analyst@example.com']);
    expect(emailCapture.subject).toBe('Genesys Cloud Weekly Brief — 2026-05-19');
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
    const skill = createDispatchBriefSkill({
      profile: fakeProfileClient(profile, tenant),
      storage: fakeStorage({ ok: true, uri: 'workspace://x' }),
      email: fakeEmail({ ok: true, messageId: 'mid' }),
      audit: fakeAudit(),
    });

    const result = await skill.invoke({
      subject: 's',
      body: 'b',
      date: '2026-05-19',
    });
    expect(result.recipients).toEqual(['ops@example.com', 'analyst@example.com']);
  });

  it('throws DispatchError(no_recipients) when both sources are empty', async () => {
    const profile = makeProfile({
      config: { output: { additional_recipients: [] } },
    });
    const tenant: TenantSettings = { tenant_id: 'demo1505' }; // no operator_email
    const skill = createDispatchBriefSkill({
      profile: fakeProfileClient(profile, tenant),
      storage: fakeStorage({ ok: true, uri: 'workspace://x' }),
      email: fakeEmail({ ok: true, messageId: 'mid' }),
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

  it('dryRun: returns synthetic ids without calling storage or email', async () => {
    const profile = makeProfile();
    const tenant: TenantSettings = {
      tenant_id: 'demo1505',
      operator_email: 'ops@example.com',
    };
    let storageCalled = false;
    let emailCalled = false;
    const skill = createDispatchBriefSkill({
      profile: fakeProfileClient(profile, tenant),
      storage: {
        async put() {
          storageCalled = true;
          return { ok: true, uri: 'should-not-be-called' };
        },
      },
      email: {
        async draftEmail() {
          emailCalled = true;
          return { ok: true, messageId: 'should-not-be-called' };
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
    expect(emailCalled).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.storageUri).toBe('dryrun://genesys-research/briefs/2026-05-19.md');
    expect(result.emailMessageId).toMatch(/^dryrun-message-/);
  });
});
