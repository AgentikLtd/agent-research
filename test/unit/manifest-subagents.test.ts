import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import Ajv from 'ajv';
import {
  buildPlanPrompt,
  buildResearchPrompt,
  buildChallengePrompt,
  buildSynthesisPrompt,
} from '../../src/prompts/brief-prompts.js';

interface SubagentDef {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly system_prompt: string;
  readonly tool_overrides?: readonly string[];
  readonly enabled?: boolean;
  readonly fan_out?: boolean;
}
interface SubagentsExtension {
  readonly subagents: readonly SubagentDef[];
  readonly delegation?: {
    readonly enabled?: boolean;
    readonly max_subagent_calls?: number;
    readonly max_concurrent_workers?: number;
  };
}

function here(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function loadManifest(): Record<string, unknown> {
  const raw = readFileSync(resolve(here(), '../../manifest.yaml'), 'utf-8');
  return parseYaml(raw) as Record<string, unknown>;
}

function subagentsExt(m: Record<string, unknown>): SubagentsExtension {
  return m['x-agentik/subagents'] as SubagentsExtension;
}

function persona(ext: SubagentsExtension, id: string): SubagentDef {
  const p = ext.subagents.find((s) => s.id === id);
  if (!p) throw new Error(`persona ${id} missing`);
  return p;
}

describe('manifest x-agentik/subagents (DDR-001)', () => {
  const ext = subagentsExt(loadManifest());

  it('declares the four pipeline personas with correct ids + tool_overrides', () => {
    expect(ext.subagents.map((s) => s.id).sort()).toEqual([
      'plan',
      'research',
      'synthesizer',
      'verifier',
    ]);
    expect(persona(ext, 'plan').tool_overrides).toEqual([]);
    expect(persona(ext, 'research').tool_overrides).toEqual(['web_search']);
    expect(persona(ext, 'verifier').tool_overrides).toEqual(['web_search']);
    expect(persona(ext, 'synthesizer').tool_overrides).toEqual([]);
    expect(ext.delegation).toMatchObject({
      enabled: true,
      max_subagent_calls: 8,
      max_concurrent_workers: 3,
    });
  });

  it('validates against the shared-types SubagentsExtension schema', () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(here(), '../../../shared-types/schemas/manifest/manifest.schema.json'),
        'utf-8',
      ),
    ) as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: false });
    // Register the whole schema so `$ref: #/definitions/SubagentDef` resolves,
    // then pull the SubagentsExtension subschema by ref.
    ajv.addSchema(schema, 'manifest');
    const validate = ajv.getSchema('manifest#/definitions/SubagentsExtension');
    if (!validate) throw new Error('SubagentsExtension definition not found in schema');
    const ok = validate(ext);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  // The crux: a seeded persona's system_prompt, used as systemPromptOverride,
  // reproduces the live default prompt byte-for-byte.
  it('plan system_prompt reproduces the default plan prompt (maxAngles=4)', () => {
    const i = { topic: 'X', since: 'S', until: 'U', maxAngles: 4 } as const;
    const seeded = buildPlanPrompt(i, {
      systemPromptOverride: persona(ext, 'plan').system_prompt,
    }).system;
    expect(seeded).toBe(buildPlanPrompt(i).system);
  });

  it('research system_prompt reproduces the default research prompt', () => {
    const i = { angle: 'a', topic: 'X', since: 'S', until: 'U' } as const;
    expect(
      buildResearchPrompt(i, {
        systemPromptOverride: persona(ext, 'research').system_prompt,
      }).system,
    ).toBe(buildResearchPrompt(i).system);
  });

  it('verifier system_prompt reproduces the default challenge prompt', () => {
    const i = { topic: 'X', since: 'S', until: 'U', findings: [] } as const;
    expect(
      buildChallengePrompt(i, {
        systemPromptOverride: persona(ext, 'verifier').system_prompt,
      }).system,
    ).toBe(buildChallengePrompt(i).system);
  });

  it('synthesizer system_prompt reproduces the default synthesis prompt', () => {
    const i = { briefDescription: 'X', since: 'S', until: 'U', findings: [] } as const;
    expect(
      buildSynthesisPrompt(i, {
        systemPromptOverride: persona(ext, 'synthesizer').system_prompt,
      }).system,
    ).toBe(buildSynthesisPrompt(i).system);
  });
});
