import { describe, it, expect } from 'vitest';
import {
  createSkillRegistry,
  UnknownSkillError,
  type Skill,
} from '../../src/skills/registry.js';

describe('createSkillRegistry', () => {
  it('registers a skill and invokes it by name returning the typed result', async () => {
    const greet: Skill<{ name: string }, { greeting: string }> = {
      name: 'greet',
      description: 'returns a greeting',
      async invoke(args) {
        return { greeting: `hello, ${args.name}` };
      },
    };
    const registry = createSkillRegistry();
    registry.register(greet);

    const result = await registry.invoke<{ name: string }, { greeting: string }>(
      'greet',
      { name: 'world' },
    );
    expect(result).toEqual({ greeting: 'hello, world' });

    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('greet');
    expect(listed[0]?.description).toBe('returns a greeting');
  });

  it('throws UnknownSkillError when invoking a name that was never registered', async () => {
    const registry = createSkillRegistry();
    await expect(registry.invoke('does-not-exist', {})).rejects.toBeInstanceOf(
      UnknownSkillError,
    );
    await expect(registry.invoke('does-not-exist', {})).rejects.toThrow(
      /does-not-exist/,
    );
  });
});
