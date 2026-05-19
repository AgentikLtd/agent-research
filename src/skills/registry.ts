/**
 * SkillRegistry — register + look up + invoke deterministic skills.
 *
 * Phase 5 contract:
 *   - A `Skill<TArgs, TResult>` is a function-like object with a stable
 *     `name`, an `invoke(args)` method, and an optional `description`.
 *   - The registry stores skills by name. `register` is idempotent for the
 *     SAME instance but rejects a duplicate name with a different instance.
 *   - `invoke(name, args)` resolves by name and dispatches; an unknown
 *     name throws `UnknownSkillError` so callers can surface a friendly
 *     error rather than `undefined.invoke(...)`.
 *
 * Out of scope for Phase 5: telemetry, retry, args validation. The
 * orchestrator (`run-brief`) layers cross-cutting concerns over the
 * registry — skills themselves stay focused.
 */

export interface Skill<TArgs = unknown, TResult = unknown> {
  readonly name: string;
  readonly description?: string;
  invoke(args: TArgs): Promise<TResult>;
}

/** Lightweight metadata view used by `list()`. */
export interface SkillDescriptor {
  readonly name: string;
  readonly description?: string;
}

export class UnknownSkillError extends Error {
  readonly skillName: string;
  constructor(skillName: string) {
    super(`unknown skill: ${skillName}`);
    this.name = 'UnknownSkillError';
    this.skillName = skillName;
  }
}

export class DuplicateSkillError extends Error {
  readonly skillName: string;
  constructor(skillName: string) {
    super(`skill already registered with a different instance: ${skillName}`);
    this.name = 'DuplicateSkillError';
    this.skillName = skillName;
  }
}

export interface SkillRegistry {
  register<TArgs, TResult>(skill: Skill<TArgs, TResult>): void;
  /** Throws `UnknownSkillError` when `name` is not registered. */
  invoke<TArgs, TResult>(name: string, args: TArgs): Promise<TResult>;
  list(): ReadonlyArray<SkillDescriptor>;
}

export function createSkillRegistry(): SkillRegistry {
  const skills = new Map<string, Skill<unknown, unknown>>();

  return {
    register<TArgs, TResult>(skill: Skill<TArgs, TResult>): void {
      const existing = skills.get(skill.name);
      if (existing !== undefined && existing !== (skill as unknown as Skill<unknown, unknown>)) {
        throw new DuplicateSkillError(skill.name);
      }
      skills.set(skill.name, skill as unknown as Skill<unknown, unknown>);
    },
    async invoke<TArgs, TResult>(name: string, args: TArgs): Promise<TResult> {
      const skill = skills.get(name);
      if (skill === undefined) {
        throw new UnknownSkillError(name);
      }
      const result = await skill.invoke(args);
      return result as TResult;
    },
    list(): ReadonlyArray<SkillDescriptor> {
      const out: SkillDescriptor[] = [];
      for (const skill of skills.values()) {
        out.push(
          skill.description !== undefined
            ? { name: skill.name, description: skill.description }
            : { name: skill.name },
        );
      }
      return out;
    },
  };
}
