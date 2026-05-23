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
  it('research prompt has a pre-emit diversity check (2026-05-23 bake-off fix)', () => {
    // Qwen3.7 Max and DeepSeek V4 Flash both emitted findings dominated by the
    // vendor's own pages. A pre-emit check forces one diversifying search before
    // returning the JSON array, surfacing the failure at the research stage
    // instead of letting the synthesis stage paper over it.
    const p = buildResearchPrompt({ angle: 'A', topic: 'T', since: 's', until: 'u' });
    const sys = p.system.toLowerCase();
    expect(sys).toContain('pre-emit diversity check');
    expect(sys).toContain('second-level domains');
    expect(sys).toContain('non-vendor sources');
  });
  it('research prompt bounds the search loop and mandates emitting the JSON', () => {
    // Regression guard: an unbounded search instruction made models exhaust the
    // output-token budget before emitting findings (2026-05-22 bake-off pilot).
    const p = buildResearchPrompt({ angle: 'A', topic: 'T', since: 's', until: 'u' });
    const sys = p.system.toLowerCase();
    expect(sys).toContain('budget');
    expect(sys).toContain('3 to 5 searches');
    expect(sys).toContain('total failure');
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
  it('synthesis prompt mandates the 4-verdict structure in "## My read" (2026-05-23 bake-off fix)', () => {
    // Sonnet 4.6 always emitted these four labelled verdicts; mid-tier models
    // (V4 Pro, Haiku, Gemini, Qwen) hit some-not-all depending on luck. Make
    // the structure explicit so every model can comply.
    const p = buildSynthesisPrompt({
      briefDescription: 'T brief', since: 's', until: 'u', findings: [finding],
    });
    expect(p.system).toContain('**What is genuinely significant**');
    expect(p.system).toContain('**What is overhyped**');
    expect(p.system).toContain('**What is genuinely risky right now**');
    expect(p.system).toContain('**What is safe to ignore**');
    expect(p.system.toLowerCase()).toContain('no candidates in');
  });
  it('synthesis prompt enforces structured-backbone-first synthesis (FG=2 hallucination fix)', () => {
    // V4 Pro hit FG=2 in 2/4 n=4 runs — confident prose with no traceable
    // supporting finding. The fix is to require the model to list claim/support
    // pairs FIRST and remove unsupported claims BEFORE writing prose.
    const p = buildSynthesisPrompt({
      briefDescription: 'T brief', since: 's', until: 'u', findings: [finding],
    });
    const sys = p.system.toLowerCase();
    expect(sys).toContain('supporting finding indices');
    expect(sys).toContain('remove every prospective claim with no supporting finding');
    expect(sys).toContain('cannot be traced to a finding');
  });
  it('synthesis prompt declares a full citation protocol (V4 Flash duplicate-source + Gemini broken-numbering fix)', () => {
    const p = buildSynthesisPrompt({
      briefDescription: 'T brief', since: 's', until: 'u', findings: [finding],
    });
    expect(p.system).toContain('CITATION PROTOCOL');
    const sys = p.system.toLowerCase();
    expect(sys).toContain('each unique url gets exactly one source id');
    expect(sys).toContain('reuse its number');
    expect(sys).toContain('no gaps');
    expect(sys).toContain('pre-emit self-check');
  });
  it('synthesis prompt declares the source-flag vocabulary explicitly', () => {
    // Sonnet emitted ⚠️ flags naturally; mid-tier didn't. Make the vocab
    // explicit so non-Anthropic models can comply too.
    const p = buildSynthesisPrompt({
      briefDescription: 'T brief', since: 's', until: 'u', findings: [finding],
    });
    expect(p.system).toContain('SOURCE FLAGS');
    expect(p.system).toContain('⚠️ vendor source');
    expect(p.system).toContain('⚠️ competitor-interest');
    expect(p.system).toContain('⚠️ single-source');
  });
  it('synthesis prompt mandates a noise log and a length envelope', () => {
    const p = buildSynthesisPrompt({
      briefDescription: 'T brief', since: 's', until: 'u', findings: [finding],
    });
    expect(p.system).toContain('## Noise log');
    expect(p.system.toLowerCase()).toContain('length envelope');
    expect(p.system).toContain('10,000–20,000 characters');
  });
  it('synthesis prompt labels claims with NEWS / CONTEXT / RUMOUR time-window', () => {
    const p = buildSynthesisPrompt({
      briefDescription: 'T brief', since: 's', until: 'u', findings: [finding],
    });
    expect(p.system).toContain('NEWS');
    expect(p.system).toContain('CONTEXT');
    expect(p.system).toContain('RUMOUR');
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
