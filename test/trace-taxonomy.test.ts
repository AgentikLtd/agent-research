import { describe, it, expect } from 'vitest';

import { KNOWN_BEATS, isAllowedBeat } from '../src/trace-taxonomy.js';

/**
 * Frozen literal of the 28 canonical beat names, byte-mirrored from
 * `@agentik/shared-types/src/engine/trace.ts`. This array is the typo-guard:
 * if the vendored `KNOWN_BEATS` drifts from canonical, this test fails.
 */
const CANONICAL_BEATS = [
  // run lifecycle
  'run.started',
  'run.completed',
  'run.failed',
  'run.suspended',
  'run.resumed',
  'run.cancelled',
  // node lifecycle
  'node.started',
  'node.done',
  'node.failed',
  'node.suspended',
  'node.reaped',
  'node.skipped',
  // agent reasoning beats
  'reason',
  'act',
  'observe',
  'tool.call',
  'tool.result',
  'verify',
  'backtrack',
  'gate.requested',
  // the legacy 11 (preserved)
  'sources.gathered',
  'research.planned',
  'research.gathered',
  'findings.challenged',
  'brief.synthesized',
  'subagent.invoked',
  'subagent.completed',
  'subagent.denied',
] as const;

describe('trace-taxonomy KNOWN_BEATS', () => {
  it('has exactly 28 names', () => {
    expect(CANONICAL_BEATS.length).toBe(28);
    expect(KNOWN_BEATS.size).toBe(28);
  });

  it('matches the canonical frozen-literal set verbatim', () => {
    expect(new Set(KNOWN_BEATS)).toEqual(new Set(CANONICAL_BEATS));
    for (const beat of CANONICAL_BEATS) {
      expect(KNOWN_BEATS.has(beat)).toBe(true);
    }
  });
});

describe('isAllowedBeat', () => {
  it('accepts every known beat', () => {
    for (const beat of CANONICAL_BEATS) {
      expect(isAllowedBeat(beat)).toBe(true);
    }
  });

  it('accepts an x- custom beat', () => {
    expect(isAllowedBeat('x-foo')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isAllowedBeat('')).toBe(false);
  });

  it('rejects a typo of a known beat', () => {
    expect(isAllowedBeat('reasonn')).toBe(false);
  });

  it('rejects a bare x- prefix with no suffix', () => {
    expect(isAllowedBeat('x-')).toBe(false);
  });
});
