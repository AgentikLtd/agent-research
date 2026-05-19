/**
 * run-brief orchestrator skill — chains gather-sources → compose-brief → dispatch-brief
 * and emits audit events at every stage boundary.
 *
 * Dispatch shape:
 *   - `runId` is generated via `crypto.randomUUID()` per invocation.
 *   - `since` defaults to `-72h`; accepts either a relative `-Nh` / `-Nm` /
 *     `-Nd` string OR an absolute ISO timestamp. Resolved against the
 *     orchestrator's `clock()`.
 *   - `model` resolves to `args.modelOverride ?? deps.modelDefault`. The
 *     manifest-wired default is injected by `src/index.ts` at boot (Phase 6).
 *   - `subject` = `<destination_subject_prefix ?? 'Brief'> — <YYYY-MM-DD>`.
 *
 * Audit events emitted:
 *   - `run.started`     { runId, since, until, model }
 *   - `sources.gathered`{ runId, itemCount, errorCount, fetchedAt }
 *   - `llm.invoked`     { runId, model, citationCount, costGbp?, llmCallId? }
 *   - `run.completed`   { runId, recipients, emailMessageId, storageUri? }
 *   - `run.failed`      { runId, stage, message }  (only on throw)
 *
 * The orchestrator does NOT swallow downstream errors — gather-sources
 * may throw `InsufficientSourcesError`, compose-brief may throw
 * `LlmGatewayError`, dispatch-brief may throw `DispatchError`. Each is
 * re-thrown after an audit `run.failed` event so callers see the typed
 * cause but the audit trail is still complete.
 */

import { randomUUID } from 'node:crypto';
import type { AuditClient } from '../hub/audit-client.js';
import type { AgentProfile, ProfileClient } from '../hub/profile-client.js';
import type { Skill, SkillRegistry } from './registry.js';
import type { GatherSourcesArgs, GatherSourcesResult } from './gather-sources.js';
import type { ComposeBriefArgs, ComposeBriefResult } from './compose-brief.js';
import type { DispatchBriefArgs, DispatchBriefResult } from './dispatch-brief.js';

export interface RunBriefArgs {
  /** Override the manifest-wired default model. */
  readonly modelOverride?: string;
  /** Absolute ISO timestamp OR a relative `-Nh|-Nm|-Nd` string. Defaults to `-72h`. */
  readonly since?: string;
  /** If true, dispatch-brief skips storage + email and returns synthetic ids. */
  readonly dryRun?: boolean;
}

export interface RunBriefResult {
  readonly runId: string;
  readonly since: string;
  readonly until: string;
  readonly model: string;
  readonly itemCount: number;
  readonly errorCount: number;
  readonly citationCount: number;
  readonly recipients: ReadonlyArray<string>;
  readonly emailMessageId: string;
  readonly storageUri?: string;
}

export interface RunBriefDeps {
  readonly registry: SkillRegistry;
  readonly profile: ProfileClient;
  readonly audit: AuditClient;
  /** Default model when args.modelOverride is absent. Wired from manifest at boot. */
  readonly modelDefault: string;
  /** Test seam: defaults to `() => new Date()`. */
  readonly clock?: () => Date;
  /** Test seam: defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
}

const RELATIVE_RE = /^-(\d+)([hmd])$/;

function resolveSince(raw: string | undefined, now: Date): string {
  const input = raw ?? '-72h';
  const match = RELATIVE_RE.exec(input);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    let ms = 0;
    if (unit === 'h') ms = amount * 3600 * 1000;
    else if (unit === 'm') ms = amount * 60 * 1000;
    else if (unit === 'd') ms = amount * 24 * 3600 * 1000;
    return new Date(now.getTime() - ms).toISOString();
  }
  // Fall through: try to parse as ISO.
  const t = Date.parse(input);
  if (Number.isNaN(t)) {
    // Last resort: default 72h back.
    return new Date(now.getTime() - 72 * 3600 * 1000).toISOString();
  }
  return new Date(t).toISOString();
}

function pickString(obj: unknown, key: string): string | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

function pickSources(profile: AgentProfile): unknown {
  const config = (profile['config'] ?? {}) as Record<string, unknown>;
  return config['sources'];
}

function pickBriefDescription(profile: AgentProfile): string {
  const config = (profile['config'] ?? {}) as Record<string, unknown>;
  const desc = pickString(config, 'description') ?? pickString(profile, 'description');
  return desc ?? `${profile.agent_name} research brief`;
}

function pickSubjectPrefix(profile: AgentProfile): string {
  const config = (profile['config'] ?? {}) as Record<string, unknown>;
  const output = (config['output'] ?? {}) as Record<string, unknown>;
  const prefix = pickString(output, 'destination_subject_prefix');
  return prefix ?? 'Brief';
}

function pickExtraInstructions(profile: AgentProfile): string | undefined {
  const config = (profile['config'] ?? {}) as Record<string, unknown>;
  return pickString(config, 'steer') ?? pickString(config, 'extra_instructions');
}

export function createRunBriefSkill(deps: RunBriefDeps): Skill<RunBriefArgs, RunBriefResult> {
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());

  return {
    name: 'run-brief',
    description: 'Orchestrator — gather sources, compose markdown, dispatch via email-manager.',
    async invoke(args) {
      const runId = newId();
      const now = clock();
      const until = now.toISOString();
      const since = resolveSince(args.since, now);
      const model = args.modelOverride ?? deps.modelDefault;
      const dateYmd = until.slice(0, 10);

      await deps.audit.emit({
        eventType: 'run.started',
        payload: { runId, since, until, model },
      });

      let stage: 'gather' | 'compose' | 'dispatch' = 'gather';
      try {
        const profile = await deps.profile.get();
        const sources = pickSources(profile);

        const gathered = await deps.registry.invoke<GatherSourcesArgs, GatherSourcesResult>(
          'gather-sources',
          {
            sources: sources as GatherSourcesArgs['sources'],
            since,
          },
        );
        await deps.audit.emit({
          eventType: 'sources.gathered',
          payload: {
            runId,
            itemCount: gathered.items.length,
            errorCount: gathered.errors.length,
            fetchedAt: gathered.fetchedAt,
          },
        });

        stage = 'compose';
        const composeArgs: ComposeBriefArgs = {
          model,
          briefDescription: pickBriefDescription(profile),
          items: gathered.items,
          since,
          until,
          ...(pickExtraInstructions(profile) !== undefined
            ? { extraInstructions: pickExtraInstructions(profile) as string }
            : {}),
        };
        const composed = await deps.registry.invoke<ComposeBriefArgs, ComposeBriefResult>(
          'compose-brief',
          composeArgs,
        );
        await deps.audit.emit({
          eventType: 'llm.invoked',
          payload: {
            runId,
            model,
            citationCount: composed.citationCount,
            ...(composed.costGbp !== undefined ? { costGbp: composed.costGbp } : {}),
            ...(composed.llmCallId !== undefined ? { llmCallId: composed.llmCallId } : {}),
          },
        });

        stage = 'dispatch';
        const subject = `${pickSubjectPrefix(profile)} — ${dateYmd}`;
        const dispatchArgs: DispatchBriefArgs = {
          subject,
          body: composed.markdown,
          date: dateYmd,
          ...(args.dryRun === true ? { dryRun: true } : {}),
        };
        const dispatched = await deps.registry.invoke<DispatchBriefArgs, DispatchBriefResult>(
          'dispatch-brief',
          dispatchArgs,
        );

        const result: RunBriefResult = {
          runId,
          since,
          until,
          model,
          itemCount: gathered.items.length,
          errorCount: gathered.errors.length,
          citationCount: composed.citationCount,
          recipients: dispatched.recipients,
          emailMessageId: dispatched.emailMessageId,
          ...(dispatched.storageUri !== undefined ? { storageUri: dispatched.storageUri } : {}),
        };

        await deps.audit.emit({
          eventType: 'run.completed',
          payload: {
            runId,
            recipients: dispatched.recipients,
            emailMessageId: dispatched.emailMessageId,
            ...(dispatched.storageUri !== undefined ? { storageUri: dispatched.storageUri } : {}),
          },
        });
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await deps.audit.emit({
          eventType: 'run.failed',
          payload: { runId, stage, message },
        });
        throw e;
      }
    },
  };
}
