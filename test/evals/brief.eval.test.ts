/**
 * Opt-in eval — calls the REAL hub LLM gateway with a deterministic synthetic
 * source corpus and asserts the composed brief meets ADR-0008's two
 * minimums:
 *
 *   1. At least 3 inline `[n]` citations — failing this means
 *      compose-brief is producing prose with no source attribution.
 *   2. At least 3 of the {GA, BETA, ROADMAP, RUMOUR} labels mandated by
 *      guardrail g4 in the manifest's `x-agentik/defaults.profile.config.
 *      guardrails`. The synthetic corpus contains items obviously hitting
 *      each label, so the model has the material to satisfy this.
 *
 * Why "opt-in":
 *   - The test runs against the real `/api/llm/send` route on the hub,
 *     which means real provider spend.
 *   - CI must never accidentally pay for an eval. `describe.skipIf`
 *     short-circuits the entire suite when `HUB_BASE_URL` or
 *     `HUB_AGENT_TOKEN` are absent — the test is skipped, not failed.
 *   - Run locally with:
 *       HUB_BASE_URL=https://demo1505.studio.agentik.co.uk \
 *       HUB_AGENT_TOKEN=<dev token> \
 *       pnpm test test/evals/brief.eval
 *
 * Vitest config excludes `test/evals/**` from the default test run
 * (see vitest.config.ts), so `pnpm test` (no path) does NOT pick this up.
 * Pass a path argument as shown above to opt in.
 *
 * Timeout 60s: a Sonnet/Opus call on ~12 source items with the structured
 * prompt typically runs in 5-20s; 60s leaves headroom for cold-start
 * provider latency.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import { createGatewayClient } from '../../src/llm/gateway-client.js';
import { createComposeBriefSkill } from '../../src/skills/compose-brief.js';
import type { SourceItem } from '../../src/sources/contracts.js';

const HUB_BASE_URL = process.env['HUB_BASE_URL'] ?? '';
const HUB_AGENT_TOKEN = process.env['HUB_AGENT_TOKEN'] ?? '';
const MODEL = process.env['EVAL_MODEL'] ?? 'anthropic/claude-sonnet-4-6';

const LABEL_REGEX = /\b(GA|BETA|ROADMAP|RUMOUR)\b/g;
const CITATION_REGEX = /\[(\d+)\]/g;

const fixturesPath = (() => {
  // import.meta.url is the test file URL; fixtures live alongside this file.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'fixtures', 'synthetic-items.json');
})();

function loadFixture(): ReadonlyArray<SourceItem> {
  const raw = readFileSync(fixturesPath, 'utf-8');
  return JSON.parse(raw) as ReadonlyArray<SourceItem>;
}

describe.skipIf(!HUB_BASE_URL || !HUB_AGENT_TOKEN)(
  'eval — compose-brief against real gateway',
  () => {
    it(
      'produces ≥3 citations and ≥3 GA|BETA|ROADMAP|RUMOUR labels',
      async () => {
        const items = loadFixture();
        expect(items.length).toBeGreaterThanOrEqual(10);

        const gateway = createGatewayClient({
          hubUrl: HUB_BASE_URL,
          token: HUB_AGENT_TOKEN,
        });
        const skill = createComposeBriefSkill({ gateway });

        const result = await skill.invoke({
          model: MODEL,
          briefDescription:
            'Twice-weekly intelligence brief on Genesys Cloud CX — feature releases, market shifts, practitioner signal, vendor strategy.',
          items,
          since: '2026-05-05T00:00:00.000Z',
          until: '2026-05-19T00:00:00.000Z',
          maxOutputTokens: 4000,
          extraInstructions:
            'Label every item with one of: GA, BETA, ROADMAP, RUMOUR. Cite every claim with an inline [n].',
        });

        // Capture the brief in the test output for diagnosis when the
        // assertion below fails — a Vitest `expect.fail` would lose the body.
        // eslint-disable-next-line no-console
        console.log(
          '--- composed brief (first 2KB) ---\n',
          result.markdown.slice(0, 2048),
        );

        expect(result.citationCount).toBeGreaterThanOrEqual(3);

        const citationMatches = result.markdown.match(CITATION_REGEX) ?? [];
        expect(citationMatches.length).toBeGreaterThanOrEqual(3);

        const labelMatches = result.markdown.match(LABEL_REGEX) ?? [];
        expect(labelMatches.length).toBeGreaterThanOrEqual(3);
      },
      60_000,
    );
  },
);
