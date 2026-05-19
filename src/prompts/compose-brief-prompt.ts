/**
 * compose-brief prompt template — pure function, no I/O.
 *
 * Builds the `{ system, user }` pair the compose-brief skill passes
 * straight to `GatewayClient.send`. Kept separate from the skill so it
 * can be unit-tested deterministically and so future flavours (legal,
 * finance) can compose alternate templates while reusing the same skill.
 *
 * Citation contract: the user prompt enumerates sources `[1]…[N]` and
 * INSTRUCTS the model to cite by `[n]` exactly. The compose-brief skill
 * counts `[n]` occurrences in the returned markdown to produce a
 * `citationCount`.
 */

import type { SourceItem } from '../sources/contracts.js';

export interface ComposeBriefInputs {
  /** Flavour-specific high-level description, e.g. "Genesys Cloud weekly research". */
  readonly briefDescription: string;
  /** Aggregated, deduped source items. The template assigns `[1]…[N]` in order. */
  readonly items: ReadonlyArray<SourceItem>;
  /** Lower-bound timestamp the gather ran with — appears in the prompt so the model knows the window. */
  readonly since: string;
  /** Upper-bound timestamp (now). */
  readonly until: string;
  /** Optional extra steering — e.g. tenant-specific operator notes from STEER.md. */
  readonly extraInstructions?: string;
}

export interface ComposeBriefPrompt {
  readonly system: string;
  readonly user: string;
}

const DEFAULT_SYSTEM = [
  'You are a research analyst writing a concise weekly brief for an operator.',
  'Write in plain markdown. Lead with a 2-3 sentence "What changed" summary.',
  'Then enumerated themes with one short paragraph each.',
  'Cite every factual claim with [n] referring to the numbered sources at the bottom of the user message.',
  'Do not invent facts. If the sources do not support a claim, omit it.',
  'Keep the whole brief under 1500 words.',
].join(' ');

function formatItem(idx: number, it: SourceItem): string {
  const date = it.publishedAt ? it.publishedAt.slice(0, 10) : 'undated';
  const summary = it.summary ? ` — ${it.summary.replace(/\s+/g, ' ').slice(0, 240)}` : '';
  return `[${String(idx)}] (${date}) ${it.title} <${it.url}>${summary}`;
}

export function buildComposePrompt(inputs: ComposeBriefInputs): ComposeBriefPrompt {
  const numbered = inputs.items.map((it, i) => formatItem(i + 1, it)).join('\n');
  const userParts = [
    `Brief: ${inputs.briefDescription}`,
    `Window: ${inputs.since} → ${inputs.until}`,
    `Source count: ${String(inputs.items.length)}`,
    '',
    'Sources:',
    numbered.length > 0 ? numbered : '(no sources gathered)',
  ];
  if (inputs.extraInstructions && inputs.extraInstructions.trim().length > 0) {
    userParts.push('', 'Operator notes:', inputs.extraInstructions.trim());
  }
  userParts.push(
    '',
    'Write the brief now. Use [n] citations. Markdown only.',
  );
  return {
    system: DEFAULT_SYSTEM,
    user: userParts.join('\n'),
  };
}
