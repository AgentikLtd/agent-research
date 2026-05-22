import { describe, it, expect } from 'vitest';
import { createRunBriefSkill } from '../../src/skills/run-brief.js';
import { createSkillRegistry, type Skill } from '../../src/skills/registry.js';
import type { PlanResearchArgs, PlanResearchResult } from '../../src/skills/plan-research.js';
import type { ResearchAngleArgs, ResearchAngleResult } from '../../src/skills/research-angle.js';
import type { ChallengeFindingsArgs, ChallengeFindingsResult } from '../../src/skills/challenge-findings.js';
import type { SynthesizeBriefArgs, SynthesizeBriefResult } from '../../src/skills/synthesize-brief.js';
import type { DispatchBriefArgs, DispatchBriefResult } from '../../src/skills/dispatch-brief.js';
import type { AgentProfile, ProfileClient } from '../../src/hub/profile-client.js';
import type { AuditClient, AuditEvent } from '../../src/hub/audit-client.js';
import type { Finding } from '../../src/research/findings.js';
import type { GatherSourcesArgs, GatherSourcesResult } from '../../src/skills/gather-sources.js';
import { InsufficientSourcesError } from '../../src/skills/gather-sources.js';

const aFinding = (claim: string): Finding => ({
  claim, detail: 'd', label: 'GA', confidence: 'high',
  category: 'releases', sources: [{ url: 'https://e.example/a' }], flags: [],
});

function fakeProfile(profile: AgentProfile): ProfileClient {
  return {
    async get() { return profile; },
    async getTenantSettings() { return { tenant_id: profile.tenant_id, operator_email: 'ops@example.com' }; },
    invalidate() {},
  };
}
function recordingAudit(): { client: AuditClient; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, client: { async emit(e) { events.push(e); } } };
}

function wireRegistry(opts: {
  gather?: Skill<GatherSourcesArgs, GatherSourcesResult>;
  plan?: Skill<PlanResearchArgs, PlanResearchResult>;
  research?: Skill<ResearchAngleArgs, ResearchAngleResult>;
  challenge?: Skill<ChallengeFindingsArgs, ChallengeFindingsResult>;
  synth?: Skill<SynthesizeBriefArgs, SynthesizeBriefResult>;
  dispatch?: Skill<DispatchBriefArgs, DispatchBriefResult>;
  captures?: { research?: ResearchAngleArgs[]; synth?: SynthesizeBriefArgs[] };
}) {
  const registry = createSkillRegistry();
  registry.register(opts.gather ?? {
    name: 'gather-sources',
    async invoke() {
      return { items: [], errors: [], fetchedAt: '2026-05-19T00:00:00.000Z' };
    },
  });
  registry.register(opts.plan ?? {
    name: 'plan-research',
    async invoke() { return { angles: ['angle-1', 'angle-2'] }; },
  });
  registry.register(opts.research ?? {
    name: 'research-angle',
    async invoke(args: ResearchAngleArgs) {
      opts.captures?.research?.push(args);
      return { findings: [aFinding(`finding for ${args.angle}`)] };
    },
  });
  registry.register(opts.challenge ?? {
    name: 'challenge-findings',
    async invoke(args: ChallengeFindingsArgs) {
      return { findings: args.findings.map((f) => ({ ...f, verdict: 'confirmed' as const })) };
    },
  });
  registry.register(opts.synth ?? {
    name: 'synthesize-brief',
    async invoke(args: SynthesizeBriefArgs) {
      opts.captures?.synth?.push(args);
      return { markdown: '# Brief\n\nThing [1].', citationCount: 1 };
    },
  });
  registry.register(opts.dispatch ?? {
    name: 'dispatch-brief',
    async invoke() {
      return { recipients: ['ops@example.com'], emailMessageId: 'm1', dryRun: false };
    },
  });
  return registry;
}

const baseProfile: AgentProfile = {
  agent_id: 'a', agent_name: 'genesys-research', tenant_id: 'demo1505',
  config: {
    persona: { voice: 'Direct.', avoid: ['Hype'], audience: 'Engineer.' },
    guardrails: [{ id: 'g4', rule: 'Label items.' }],
    sources: [{ id: 'cx', label: 'CX Today', url: 'https://cxtoday.com', credibility: 'medium' }],
    output: { destination_subject_prefix: 'Genesys Weekly', markdown_sections: ['headline', 'sources'] },
  },
};

describe('createRunBriefSkill', () => {
  it('runs plan → parallel research → challenge → synthesize → dispatch and audits each stage', async () => {
    const captures = { research: [] as ResearchAngleArgs[], synth: [] as SynthesizeBriefArgs[] };
    const registry = wireRegistry({ captures });
    const audit = recordingAudit();
    const skill = createRunBriefSkill({
      registry, profile: fakeProfile(baseProfile), audit: audit.client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'), newId: () => 'run-1',
    });
    const result = await skill.invoke({});

    expect(result.angleCount).toBe(2);
    expect(result.findingCount).toBe(2);          // one per angle
    expect(result.citationCount).toBe(1);
    expect(result.emailMessageId).toBe('m1');
    expect(captures.research).toHaveLength(2);     // parallel fan-out
    // synthesis received the manifest style config
    expect(captures.synth[0]?.guardrails?.[0]?.rule).toBe('Label items.');
    expect(captures.synth[0]?.markdownSections).toEqual(['headline', 'sources']);

    const types = audit.events.map((e) => e.eventType);
    expect(types).toEqual([
      'run.started', 'sources.gathered', 'research.planned', 'research.gathered',
      'findings.challenged', 'brief.synthesized', 'run.completed',
    ]);
  });

  it('threads a per-run model override into every pipeline skill', async () => {
    const captures = { research: [] as ResearchAngleArgs[], synth: [] as SynthesizeBriefArgs[] };
    const registry = wireRegistry({ captures });
    const skill = createRunBriefSkill({
      registry, profile: fakeProfile(baseProfile), audit: recordingAudit().client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'), newId: () => 'run-1',
    });
    await skill.invoke({ model: 'google/gemini-3.5-flash' });
    expect(captures.research[0]?.model).toBe('google/gemini-3.5-flash');
    expect(captures.synth[0]?.model).toBe('google/gemini-3.5-flash');
  });

  it('degrades plan failure to a single topic angle', async () => {
    const captures = { research: [] as ResearchAngleArgs[] };
    const registry = wireRegistry({
      plan: { name: 'plan-research', async invoke() { throw new Error('plan down'); } },
      captures,
    });
    const skill = createRunBriefSkill({
      registry, profile: fakeProfile(baseProfile), audit: recordingAudit().client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'), newId: () => 'run-1',
    });
    const result = await skill.invoke({});
    expect(result.angleCount).toBe(1);
    expect(captures.research[0]?.angle).toContain('Genesys Weekly');
  });

  it('a failed research angle is dropped, not fatal', async () => {
    let call = 0;
    const registry = wireRegistry({
      research: {
        name: 'research-angle',
        async invoke(args: ResearchAngleArgs) {
          call += 1;
          if (call === 1) throw new Error('angle down');
          return { findings: [aFinding(args.angle)] };
        },
      },
    });
    const skill = createRunBriefSkill({
      registry, profile: fakeProfile(baseProfile), audit: recordingAudit().client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'), newId: () => 'run-1',
    });
    const result = await skill.invoke({});
    expect(result.findingCount).toBe(1);          // only the surviving angle
  });

  it('aborts with run.failed when no angle yields findings', async () => {
    const registry = wireRegistry({
      research: { name: 'research-angle', async invoke() { throw new Error('all down'); } },
    });
    const audit = recordingAudit();
    const skill = createRunBriefSkill({
      registry, profile: fakeProfile(baseProfile), audit: audit.client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'), newId: () => 'run-1',
    });
    await expect(skill.invoke({})).rejects.toThrow();
    expect(audit.events.map((e) => e.eventType)).toContain('run.failed');
  });

  it('degrades challenge failure to un-adjudicated findings', async () => {
    const captures = { synth: [] as SynthesizeBriefArgs[] };
    const registry = wireRegistry({
      challenge: { name: 'challenge-findings', async invoke() { throw new Error('challenge down'); } },
      captures: { synth: captures.synth },
    });
    const skill = createRunBriefSkill({
      registry, profile: fakeProfile(baseProfile), audit: recordingAudit().client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'), newId: () => 'run-1',
    });
    const result = await skill.invoke({});
    expect(result.findingCount).toBe(2);          // research findings still synthesised
    expect(captures.synth[0]?.findings).toHaveLength(2);
  });

  it('Stage 0 gathers sources, builds a digest and threads it into every research angle', async () => {
    const captures = { research: [] as ResearchAngleArgs[], synth: [] as SynthesizeBriefArgs[] };
    const registry = wireRegistry({
      gather: {
        name: 'gather-sources',
        async invoke(): Promise<GatherSourcesResult> {
          return {
            items: [{
              sourceId: 'r/callcentres',
              title: 'Genesys flow editor lag complaints',
              url: 'https://reddit.com/r/callcentres/x',
              publishedAt: '2026-05-18T10:00:00Z',
              summary: 'Operators report editor latency since the May update.',
            }],
            errors: [],
            fetchedAt: '2026-05-19T00:00:00.000Z',
          };
        },
      },
      captures,
    });
    const audit = recordingAudit();
    const skill = createRunBriefSkill({
      registry, profile: fakeProfile(baseProfile), audit: audit.client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'), newId: () => 'run-1',
    });
    await skill.invoke({});
    expect(captures.research[0]?.communityDigest).toContain('Genesys flow editor lag complaints');
    const ev = audit.events.find((e) => e.eventType === 'sources.gathered');
    expect(ev?.payload).toMatchObject({ itemCount: 1, sourceErrors: 0, degraded: false });
  });

  it('Stage 0 soft-degrades when gather-sources throws — empty digest, pipeline still completes', async () => {
    const captures = { research: [] as ResearchAngleArgs[] };
    const registry = wireRegistry({
      gather: { name: 'gather-sources', async invoke(): Promise<GatherSourcesResult> { throw new Error('reddit 403'); } },
      captures,
    });
    const audit = recordingAudit();
    const skill = createRunBriefSkill({
      registry, profile: fakeProfile(baseProfile), audit: audit.client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'), newId: () => 'run-1',
    });
    const result = await skill.invoke({});
    expect(result.findingCount).toBe(2);
    expect(captures.research[0]?.communityDigest).toBeUndefined();
    const ev = audit.events.find((e) => e.eventType === 'sources.gathered');
    expect(ev?.payload).toMatchObject({ degraded: true });
  });

  it('Stage 0 degrade reports the real failed-source count from InsufficientSourcesError', async () => {
    const registry = wireRegistry({
      gather: {
        name: 'gather-sources',
        async invoke(): Promise<GatherSourcesResult> {
          throw new InsufficientSourcesError(3, 4, 0.75);
        },
      },
    });
    const audit = recordingAudit();
    const skill = createRunBriefSkill({
      registry, profile: fakeProfile(baseProfile), audit: audit.client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'), newId: () => 'run-1',
    });
    await skill.invoke({});
    const ev = audit.events.find((e) => e.eventType === 'sources.gathered');
    expect(ev?.payload).toMatchObject({ degraded: true, sourceErrors: 3 });
  });

  it('returns the brief markdown only when returnMarkdown is set', async () => {
    const registry = wireRegistry({});
    const base = {
      registry, profile: fakeProfile(baseProfile), audit: recordingAudit().client,
      clock: () => new Date('2026-05-19T00:00:00.000Z'), newId: () => 'run-1',
    };
    const without = await createRunBriefSkill(base).invoke({});
    expect(without.markdown).toBeUndefined();
    const withMd = await createRunBriefSkill(base).invoke({ returnMarkdown: true });
    expect(withMd.markdown).toBe('# Brief\n\nThing [1].');
  });
});
