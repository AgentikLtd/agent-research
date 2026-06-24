/**
 * Open beat taxonomy — byte-vendored from
 * `@agentik/shared-types/src/engine/trace.ts`; no runtime dep — keep in
 * lockstep.
 *
 * Each agent repo is intentionally STANDALONE (see `src/contracts.ts`): there
 * is no `workspace:*` dependency on shared-types. The canonical reference for
 * this taxonomy is the file above; this mirror carries only the runtime slice
 * (`KNOWN_BEATS` + `isAllowedBeat`) the audit client needs to validate beats
 * before POSTing them to the hub trace route. Sync at every shared-types
 * upgrade.
 *
 * "Open" = a fixed set of KNOWN beats for typo-safety and UI grouping, PLUS an
 * `x-` escape hatch so an agent can emit a bespoke beat without a shared-types
 * bump. Unknown, non-prefixed beats are rejected (catches typos like
 * 'reasonn').
 */

/**
 * The OPEN beat taxonomy. Every string in this set is an allowable beat name.
 * Extend via `x-` custom beats (e.g. `'x-genesys-custom'`) — no shared-types
 * bump required.
 */
export const KNOWN_BEATS: ReadonlySet<string> = new Set([
  // run lifecycle
  'run.started', 'run.completed', 'run.failed', 'run.suspended', 'run.resumed', 'run.cancelled',
  // node lifecycle
  'node.started', 'node.done', 'node.failed', 'node.suspended', 'node.reaped', 'node.skipped',
  // agent reasoning beats (the per-beat Trace, spec §5/§9)
  'reason', 'act', 'observe', 'tool.call', 'tool.result', 'verify', 'backtrack', 'gate.requested',
  // the legacy 11 (preserved so existing agent-research emissions remain valid beats)
  'sources.gathered', 'research.planned', 'research.gathered', 'findings.challenged',
  'brief.synthesized', 'subagent.invoked', 'subagent.completed', 'subagent.denied',
]);

/**
 * Returns true if the beat string is allowable: either a known beat or an
 * `x-`-prefixed custom beat. Rejects empty strings and unknown names to
 * catch typos early.
 */
export function isAllowedBeat(beat: string): boolean {
  if (typeof beat !== 'string' || beat.length === 0) return false;
  if (KNOWN_BEATS.has(beat)) return true;
  return beat.startsWith('x-') && beat.length > 2;
}
