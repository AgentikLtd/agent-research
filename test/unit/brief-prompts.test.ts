import { describe, it, expect } from 'vitest';
import {
  buildPlanPrompt, buildResearchPrompt, buildChallengePrompt, buildSynthesisPrompt,
} from '../../src/prompts/brief-prompts.js';
import type { Finding } from '../../src/research/findings.js';

const finding: Finding = {
  claim: 'X shipped', detail: 'd', label: 'GA', confidence: 'high',
  category: 'releases', sources: [{ url: 'https://e.example/a' }], flags: [],
};

describe('brief-prompts', () => {
  it('plan prompt demands community, emerging and contrarian non-obvious angles as JSON', () => {
    const p = buildPlanPrompt({ topic: 'T', since: 's', until: 'u', maxAngles: 4 });
    const sys = p.system.toLowerCase();
    expect(sys).toContain('json');
    expect(sys).toContain('non-obvious');
    expect(sys).toContain('community');
    expect(sys).toContain('emerging');
    expect(sys).toContain('contrarian');
    expect(sys).toContain('announcement');
  });
  it('research prompt instructs web search + JSON findings', () => {
    const p = buildResearchPrompt({ angle: 'A', topic: 'T', since: 's', until: 'u' });
    expect(p.system.toLowerCase()).toContain('search');
    expect(p.system).toContain('claim');
    expect(p.user).toContain('A');
  });
  it('research prompt demands source diversity, community signal and digging deeper', () => {
    const p = buildResearchPrompt({ angle: 'A', topic: 'T', since: 's', until: 'u' });
    const sys = p.system.toLowerCase();
    expect(sys).toContain('diversity');
    expect(sys).toContain('community');
    expect(sys).toContain('comments');
    expect(sys).toContain('headline');
  });
  it('research prompt injects the community digest as untrusted seed data when supplied', () => {
    const p = buildResearchPrompt({
      angle: 'A', topic: 'T', since: 's', until: 'u',
      communityDigest: '- [Thread title](https://reddit.com/x) — r/callcentres',
    });
    expect(p.user).toContain('<community-digest>');
    expect(p.user).toContain('Thread title');
    expect(p.user.toLowerCase()).toContain('untrusted');
  });
  it('research prompt omits the digest block when no digest is supplied', () => {
    const p = buildResearchPrompt({ angle: 'A', topic: 'T', since: 's', until: 'u' });
    expect(p.user).not.toContain('<community-digest>');
  });
  it('challenge prompt demands independent corroboration + verdicts', () => {
    const p = buildChallengePrompt({ topic: 'T', since: 's', until: 'u', findings: [finding] });
    expect(p.system.toLowerCase()).toContain('corroborate');
    expect(p.system).toContain('confirmed');
    expect(p.user).toContain('X shipped');
  });
  it('synthesis prompt bakes in the candid voice + a "## My read" opinion section with no persona', () => {
    const p = buildSynthesisPrompt({
      briefDescription: 'T brief', since: 's', until: 'u', findings: [finding],
    });
    expect(p.system).toContain('## Bottom line');
    expect(p.system).toContain('## My read');
    const sys = p.system.toLowerCase();
    expect(sys).toContain('candour');
    expect(sys).toContain('analyse');
    expect(sys).toContain('significant');
    expect(sys).toContain('overhyped');
    expect(sys).toContain('risky');
    expect(sys).toContain('ignore');
  });
  it('synthesis prompt embeds persona, guardrails, section names, summary + linked sources', () => {
    const p = buildSynthesisPrompt({
      briefDescription: 'T brief', since: 's', until: 'u', findings: [finding],
      persona: { voice: 'Direct.', audience: 'An engineer.', avoid: ['Hype'] },
      guardrails: [{ id: 'g4', rule: 'Label items GA/BETA/ROADMAP/RUMOUR.' }],
      markdownSections: ['headline', 'sources'],
    });
    expect(p.system).toContain('Direct.');
    expect(p.system).toContain('An engineer.');
    expect(p.system).toContain('Hype');
    expect(p.system).toContain('Label items GA/BETA/ROADMAP/RUMOUR.');
    expect(p.system).toContain('headline');
    // Content polish: an executive-summary section is requested up front.
    expect(p.system).toContain('## Bottom line');
    // Content polish: sources are clickable markdown links, not plain text.
    expect(p.system.toLowerCase()).toContain('markdown link');
    expect(p.system).toContain('[Title](URL)');
  });
});
