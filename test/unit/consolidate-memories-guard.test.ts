import { describe, it, expect } from 'vitest';
import { createNoopConsolidateMemoriesSkill } from '../../src/skills/consolidate-memories-guard.js';

describe('createNoopConsolidateMemoriesSkill', () => {
  it('returns a skill with id "consolidate-memories"', () => {
    const skill = createNoopConsolidateMemoriesSkill();
    expect(skill.name).toBe('consolidate-memories');
  });

  it('invoke() resolves without throwing and returns expected shape', async () => {
    const skill = createNoopConsolidateMemoriesSkill();
    const result = await skill.invoke({});
    expect(result).toMatchObject({ written: 0, cost: 0 });
    expect(Array.isArray(result.skipped)).toBe(true);
  });

  it('invoke() does not require any DB, pool, or gateway (runs without deps)', async () => {
    // If this does not throw, the guard is safe to register in the no-DB branch.
    const skill = createNoopConsolidateMemoriesSkill();
    await expect(skill.invoke({})).resolves.not.toThrow();
  });
});
