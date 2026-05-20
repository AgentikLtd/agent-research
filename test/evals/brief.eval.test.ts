import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createGatewayClient } from '../../src/llm/gateway-client.js';
import { createSynthesizeBriefSkill } from '../../src/skills/synthesize-brief.js';
import type { Finding } from '../../src/research/findings.js';

const HUB_BASE_URL = process.env['HUB_BASE_URL'] ?? '';
const HUB_AGENT_TOKEN = process.env['HUB_AGENT_TOKEN'] ?? '';
const MODEL = process.env['EVAL_MODEL'] ?? 'anthropic/claude-opus-4-7';
const LABEL_REGEX = /\b(GA|BETA|ROADMAP|RUMOUR)\b/g;
const CITATION_REGEX = /\[(\d+)\]/g;

function loadFindings(): readonly Finding[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(resolve(here, 'fixtures', 'synthetic-findings.json'), 'utf-8'),
  ) as readonly Finding[];
}

describe.skipIf(!HUB_BASE_URL || !HUB_AGENT_TOKEN)(
  'eval — synthesize-brief against the real gateway',
  () => {
    it('produces ≥3 citations and ≥3 GA|BETA|ROADMAP|RUMOUR labels', async () => {
      const findings = loadFindings();
      expect(findings.length).toBeGreaterThanOrEqual(10);
      const gateway = createGatewayClient({ hubUrl: HUB_BASE_URL, token: HUB_AGENT_TOKEN });
      const skill = createSynthesizeBriefSkill({ gateway, model: MODEL });
      const result = await skill.invoke({
        findings,
        briefDescription: 'Twice-weekly intelligence brief on Genesys Cloud CX.',
        since: '2026-05-05T00:00:00.000Z',
        until: '2026-05-19T00:00:00.000Z',
        guardrails: [
          { id: 'g1', rule: 'Every factual claim carries an inline [n] citation.' },
          { id: 'g4', rule: 'Label every reported item GA, BETA, ROADMAP or RUMOUR.' },
        ],
        markdownSections: ['headline', 'feature_releases', 'market_trends', 'noise_log', 'sources'],
      });
      // eslint-disable-next-line no-console
      console.log('--- brief (first 2KB) ---\n', result.markdown.slice(0, 2048));
      expect(result.citationCount).toBeGreaterThanOrEqual(3);
      expect((result.markdown.match(CITATION_REGEX) ?? []).length).toBeGreaterThanOrEqual(3);
      expect((result.markdown.match(LABEL_REGEX) ?? []).length).toBeGreaterThanOrEqual(3);
    }, 60_000);
  },
);
