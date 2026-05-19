import { describe, it, expect } from 'vitest';
import { createRunBriefSkill } from '../../src/skills/run-brief.js';
import {
  createSkillRegistry,
  type Skill,
} from '../../src/skills/registry.js';
import type {
  GatherSourcesArgs,
  GatherSourcesResult,
} from '../../src/skills/gather-sources.js';
import type {
  ComposeBriefArgs,
  ComposeBriefResult,
} from '../../src/skills/compose-brief.js';
import type {
  DispatchBriefArgs,
  DispatchBriefResult,
} from '../../src/skills/dispatch-brief.js';
import type {
  AgentProfile,
  ProfileClient,
} from '../../src/hub/profile-client.js';
import type { AuditClient, AuditEvent } from '../../src/hub/audit-client.js';

function fakeProfileClient(profile: AgentProfile): ProfileClient {
  return {
    async get() {
      return profile;
    },
    async getTenantSettings() {
      return { tenant_id: profile.tenant_id, operator_email: 'ops@example.com' };
    },
    invalidate() {},
  };
}

function recordingAudit(): { client: AuditClient; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    client: {
      async emit(event) {
        events.push(event);
      },
    },
  };
}

describe('createRunBriefSkill', () => {
  it('chains gather-sources → compose-brief → dispatch-brief and emits run.started + run.completed audits', async () => {
    const registry = createSkillRegistry();

    const fakeGather: Skill<GatherSourcesArgs, GatherSourcesResult> = {
      name: 'gather-sources',
      async invoke(_args) {
        return {
          items: [
            {
              sourceId: 'rss-genesys',
              title: 'Genesys release',
              url: 'https://genesys.example/release',
              publishedAt: '2026-05-18T10:00:00Z',
            },
          ],
          errors: [],
          fetchedAt: '2026-05-19T00:00:00.000Z',
        };
      },
    };
    const fakeCompose: Skill<ComposeBriefArgs, ComposeBriefResult> = {
      name: 'compose-brief',
      async invoke(args) {
        expect(args.model).toBe('anthropic/claude-sonnet-4-5');
        expect(args.items).toHaveLength(1);
        return {
          markdown: '# Brief\n\nSomething happened [1].',
          citationCount: 1,
          llmCallId: 'call_42',
          costGbp: 0.01,
        };
      },
    };
    const fakeDispatch: Skill<DispatchBriefArgs, DispatchBriefResult> = {
      name: 'dispatch-brief',
      async invoke(args) {
        expect(args.subject).toBe('Genesys Weekly — 2026-05-19');
        expect(args.body).toBe('# Brief\n\nSomething happened [1].');
        expect(args.date).toBe('2026-05-19');
        return {
          recipients: ['ops@example.com'],
          storageUri: 'workspace://genesys-research/briefs/2026-05-19.md',
          emailMessageId: 'gmail_msg_42',
          dryRun: false,
        };
      },
    };

    registry.register(fakeGather);
    registry.register(fakeCompose);
    registry.register(fakeDispatch);

    const profile: AgentProfile = {
      agent_id: 'agent_research_1',
      agent_name: 'genesys-research',
      tenant_id: 'demo1505',
      config: {
        sources: [
          { type: 'rss', url: 'https://genesys.example/feed.xml', sourceId: 'rss-genesys' },
        ],
        output: {
          destination_subject_prefix: 'Genesys Weekly',
        },
      },
    };
    const audit = recordingAudit();

    const skill = createRunBriefSkill({
      registry,
      profile: fakeProfileClient(profile),
      audit: audit.client,
      modelDefault: 'anthropic/claude-sonnet-4-5',
      clock: () => new Date('2026-05-19T00:00:00.000Z'),
      newId: () => 'run-uuid-1',
    });

    const result = await skill.invoke({});
    expect(result.runId).toBe('run-uuid-1');
    expect(result.model).toBe('anthropic/claude-sonnet-4-5');
    expect(result.until).toBe('2026-05-19T00:00:00.000Z');
    // default -72h
    expect(result.since).toBe('2026-05-16T00:00:00.000Z');
    expect(result.itemCount).toBe(1);
    expect(result.citationCount).toBe(1);
    expect(result.recipients).toEqual(['ops@example.com']);
    expect(result.emailMessageId).toBe('gmail_msg_42');
    expect(result.storageUri).toBe('workspace://genesys-research/briefs/2026-05-19.md');

    const types = audit.events.map((e) => e.eventType);
    expect(types).toContain('run.started');
    expect(types).toContain('sources.gathered');
    expect(types).toContain('llm.invoked');
    expect(types).toContain('run.completed');
    expect(types).not.toContain('run.failed');

    const started = audit.events.find((e) => e.eventType === 'run.started');
    expect(started?.payload['runId']).toBe('run-uuid-1');
    expect(started?.payload['model']).toBe('anthropic/claude-sonnet-4-5');
    expect(started?.payload['since']).toBe('2026-05-16T00:00:00.000Z');
    expect(started?.payload['until']).toBe('2026-05-19T00:00:00.000Z');

    const completed = audit.events.find((e) => e.eventType === 'run.completed');
    expect(completed?.payload['runId']).toBe('run-uuid-1');
    expect(completed?.payload['emailMessageId']).toBe('gmail_msg_42');
  });
});
