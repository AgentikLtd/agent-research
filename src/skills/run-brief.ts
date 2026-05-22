/**
 * run-brief orchestrator — the research pipeline.
 *
 *   gather-sources → seed a community digest from the configured sources
 *   plan-research  → decompose the topic into research angles
 *   research-angle → one autonomous web researcher per angle (parallel)
 *   challenge-findings → adversarial verification of the merged findings
 *   synthesize-brief   → final styled markdown document
 *   dispatch-brief     → deliver via the hub channel-router
 *
 * Degradation: gather-sources failure → empty digest (soft-degrade); plan failure → a single topic angle; a failed research angle is
 * dropped (allSettled); zero findings overall → abort; challenge failure → use
 * the un-adjudicated findings. synthesize/dispatch failures propagate. Every
 * stage boundary emits an audit event; a throw emits `run.failed` first.
 *
 * Model precedence per pipeline skill: `run-brief` arg `model` →
 * `agent_profiles.config.model` → the skill's manifest default (in its deps).
 */
import { randomUUID } from 'node:crypto';
import type { AuditClient } from '../hub/audit-client.js';
import type { AgentProfile, ProfileClient } from '../hub/profile-client.js';
import type {
  GuardrailConfig,
  PersonaConfig,
  PrioritySource,
} from '../prompts/brief-prompts.js';
import type { Finding } from '../research/findings.js';
import { InsufficientSourcesError } from './gather-sources.js';
import type { GatherSourcesArgs, GatherSourcesResult } from './gather-sources.js';
import type { SourceItem } from '../sources/contracts.js';
import type { PlanResearchArgs, PlanResearchResult } from './plan-research.js';
import type { ResearchAngleArgs, ResearchAngleResult } from './research-angle.js';
import type { ChallengeFindingsArgs, ChallengeFindingsResult } from './challenge-findings.js';
import type { SynthesizeBriefArgs, SynthesizeBriefResult } from './synthesize-brief.js';
import type { DispatchBriefArgs, DispatchBriefResult } from './dispatch-brief.js';
import type { Skill, SkillRegistry } from './registry.js';

const RELATIVE_RE = /^-(\d+)([hmd])$/;
const DEFAULT_MAX_ANGLES = 4;
const DEFAULT_ANGLE_CONCURRENCY = 3;
// Digest size cap: 40 items × ~200-char summaries ≈ a few thousand tokens —
// bounded seed context for each research-angle prompt, not a second corpus.
const DIGEST_MAX_ITEMS = 40;
const DIGEST_SUMMARY_MAX_CHARS = 200;

export interface RunBriefArgs {
  /** Absolute ISO timestamp OR a relative `-Nh|-Nm|-Nd` string. Defaults to `-72h`. */
  readonly since?: string;
  /** If true, dispatch-brief skips storage + email and returns synthetic ids. */
  readonly dryRun?: boolean;
  /**
   * Per-run model override applied to every pipeline skill — for A/B trials
   * (e.g. `google/gemini-3.5-flash`). Overrides `config.model` and the
   * per-skill manifest defaults.
   */
  readonly model?: string;
  /** When true, include the synthesised brief markdown in the result (for the eval harness). */
  readonly returnMarkdown?: boolean;
}

export interface RunBriefResult {
  readonly runId: string;
  readonly since: string;
  readonly until: string;
  readonly angleCount: number;
  readonly findingCount: number;
  readonly citationCount: number;
  readonly recipients: ReadonlyArray<string>;
  readonly emailMessageId: string;
  readonly storageUri?: string;
  /** Present only when the caller passed `returnMarkdown: true`. */
  readonly markdown?: string;
}

export interface RunBriefDeps {
  readonly registry: SkillRegistry;
  readonly profile: ProfileClient;
  readonly audit: AuditClient;
  /** Test seam: defaults to `() => new Date()`. */
  readonly clock?: () => Date;
  /** Test seam: defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Max research angles. Defaults to 4. */
  readonly maxAngles?: number;
  /** Parallel research-angle calls in flight. Defaults to 3. */
  readonly angleConcurrency?: number;
}

type Stage = 'gather' | 'plan' | 'research' | 'challenge' | 'synthesize' | 'dispatch';

function resolveSince(raw: string | undefined, now: Date): string {
  const input = raw ?? '-72h';
  const m = RELATIVE_RE.exec(input);
  if (m) {
    const amount = Number(m[1]);
    const unit = m[2];
    const ms = unit === 'h' ? amount * 3600e3 : unit === 'm' ? amount * 60e3 : amount * 86400e3;
    return new Date(now.getTime() - ms).toISOString();
  }
  const t = Date.parse(input);
  return Number.isNaN(t)
    ? new Date(now.getTime() - 72 * 3600e3).toISOString()
    : new Date(t).toISOString();
}

function pickString(obj: unknown, key: string): string | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}
function config(profile: AgentProfile): Record<string, unknown> {
  return (profile['config'] ?? {}) as Record<string, unknown>;
}
function pickBriefDescription(profile: AgentProfile): string {
  const output = (config(profile)['output'] ?? {}) as Record<string, unknown>;
  return (
    pickString(config(profile), 'description') ??
    pickString(profile, 'description') ??
    pickString(output, 'destination_subject_prefix') ??
    `${profile.agent_name} research brief`
  );
}
function pickSubjectPrefix(profile: AgentProfile): string {
  const output = (config(profile)['output'] ?? {}) as Record<string, unknown>;
  return pickString(output, 'destination_subject_prefix') ?? 'Brief';
}
function pickModel(profile: AgentProfile): string | undefined {
  return pickString(config(profile), 'model');
}
function pickExtraInstructions(profile: AgentProfile): string | undefined {
  return pickString(config(profile), 'steer') ?? pickString(config(profile), 'extra_instructions');
}
function pickPersona(profile: AgentProfile): PersonaConfig | undefined {
  const raw = config(profile)['persona'];
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const voice = typeof r['voice'] === 'string' ? r['voice'] : undefined;
  const audience = typeof r['audience'] === 'string' ? r['audience'] : undefined;
  const avoid = Array.isArray(r['avoid'])
    ? r['avoid'].filter((x): x is string => typeof x === 'string')
    : undefined;
  return {
    ...(voice !== undefined ? { voice } : {}),
    ...(audience !== undefined ? { audience } : {}),
    ...(avoid !== undefined ? { avoid } : {}),
  };
}
function pickGuardrails(profile: AgentProfile): readonly GuardrailConfig[] | undefined {
  const raw = config(profile)['guardrails'];
  if (!Array.isArray(raw)) return undefined;
  const out: GuardrailConfig[] = [];
  for (const row of raw) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r['rule'] !== 'string') continue;
    out.push({ rule: r['rule'], ...(typeof r['id'] === 'string' ? { id: r['id'] } : {}) });
  }
  return out.length > 0 ? out : undefined;
}
function pickMarkdownSections(profile: AgentProfile): readonly string[] | undefined {
  const output = (config(profile)['output'] ?? {}) as Record<string, unknown>;
  const raw = output['markdown_sections'];
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}
function pickPrioritySources(profile: AgentProfile): readonly PrioritySource[] | undefined {
  const raw = config(profile)['sources'];
  if (!Array.isArray(raw)) return undefined;
  const out: PrioritySource[] = [];
  for (const row of raw) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    out.push({
      ...(typeof r['id'] === 'string' ? { id: r['id'] } : {}),
      ...(typeof r['label'] === 'string' ? { label: r['label'] } : {}),
      ...(typeof r['url'] === 'string' ? { url: r['url'] } : {}),
      ...(typeof r['focus'] === 'string' ? { focus: r['focus'] } : {}),
      ...(typeof r['credibility'] === 'string' ? { credibility: r['credibility'] } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Raw `config.sources` array — passed straight to gather-sources, which validates each row. */
function pickRawSources(profile: AgentProfile): readonly unknown[] {
  const raw = config(profile)['sources'];
  return Array.isArray(raw) ? raw : [];
}

/**
 * Compact a SourceItem[] into a token-bounded digest string: most-recent
 * first, capped at DIGEST_MAX_ITEMS, summaries truncated. Empty input -> "".
 */
function buildCommunityDigest(items: readonly SourceItem[]): string {
  if (items.length === 0) return '';
  const sorted = [...items].sort((a, b) =>
    (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''),
  );
  return sorted.slice(0, DIGEST_MAX_ITEMS).map((it) => {
    const title = it.title.trim() || it.url;
    const summary = it.summary?.trim()
      ? ` · ${it.summary.trim().slice(0, DIGEST_SUMMARY_MAX_CHARS)}`
      : '';
    return `- [${title}](${it.url}) — ${it.sourceId} · ${it.publishedAt}${summary}`;
  }).join('\n');
}

/** Concurrency-limited map with allSettled semantics — a rejection never rejects the batch. */
async function settledPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      const item = items[idx];
      if (item === undefined) continue;
      try {
        results[idx] = { status: 'fulfilled', value: await fn(item) };
      } catch (e) {
        results[idx] = { status: 'rejected', reason: e };
      }
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function createRunBriefSkill(deps: RunBriefDeps): Skill<RunBriefArgs, RunBriefResult> {
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const maxAngles = deps.maxAngles ?? DEFAULT_MAX_ANGLES;
  const angleConcurrency = deps.angleConcurrency ?? DEFAULT_ANGLE_CONCURRENCY;

  return {
    name: 'run-brief',
    description: 'Orchestrate plan → research → challenge → synthesize → dispatch.',
    async invoke(args) {
      const runId = newId();
      const now = clock();
      const until = now.toISOString();
      const since = resolveSince(args.since, now);
      const dateYmd = until.slice(0, 10);
      let stage: Stage = 'gather';

      await deps.audit.emit({ eventType: 'run.started', payload: { runId, since, until } });

      try {
        const profile = await deps.profile.get();
        const topic = pickBriefDescription(profile);
        const modelOverride = args.model ?? pickModel(profile);
        const prioritySources = pickPrioritySources(profile);

        stage = 'gather';
        // --- Stage 0: gather community sources ---
        // Soft-degrade: a retrieval failure logs + audits degraded:true and the
        // pipeline continues with an empty digest (researchers fall back to
        // web_search only). A retrieval failure must NEVER abort the run.
        let communityDigest = '';
        try {
          const gathered = await deps.registry.invoke<GatherSourcesArgs, GatherSourcesResult>(
            'gather-sources',
            { sources: pickRawSources(profile) as GatherSourcesArgs['sources'], since },
          );
          communityDigest = buildCommunityDigest(gathered.items);
          await deps.audit.emit({
            eventType: 'sources.gathered',
            payload: {
              runId,
              itemCount: gathered.items.length,
              sourceErrors: gathered.errors.length,
              degraded: false,
            },
          });
        } catch (e) {
          console.warn(
            `[run-brief] gather-sources failed, continuing with an empty community digest: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          const sourceErrors = e instanceof InsufficientSourcesError ? e.failed : 0;
          await deps.audit.emit({
            eventType: 'sources.gathered',
            payload: { runId, itemCount: 0, sourceErrors, degraded: true },
          });
        }

        // withModel injects the per-run model override. Typed as a Record spread
        // to avoid exactOptionalPropertyTypes errors on the individual skill Args types.
        function withModel<A extends Record<string, unknown>>(a: A): A {
          return modelOverride !== undefined ? ({ ...a, model: modelOverride } as A) : a;
        }

        // --- Stage 1: plan ---
        stage = 'plan';
        let angles: readonly string[];
        try {
          const planned = await deps.registry.invoke<PlanResearchArgs, PlanResearchResult>(
            'plan-research',
            withModel({
              topic, since, until, maxAngles,
              ...(prioritySources !== undefined ? { prioritySources } : {}),
            }),
          );
          angles = planned.angles.length > 0 ? planned.angles.slice(0, maxAngles) : [topic];
        } catch (e) {
          // degrade — research the whole topic as one angle. Log it: a
          // silent degrade looks identical to a model that simply returned
          // one angle, which makes plan-stage issues invisible.
          console.warn(
            `[run-brief] plan-research failed, degrading to a single angle: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          angles = [topic];
        }
        await deps.audit.emit({
          eventType: 'research.planned',
          payload: { runId, angleCount: angles.length, angles },
        });

        // --- Stage 2: parallel research ---
        stage = 'research';
        const settled = await settledPool(angles, angleConcurrency, (angle) =>
          deps.registry.invoke<ResearchAngleArgs, ResearchAngleResult>(
            'research-angle',
            withModel({
              angle, topic, since, until,
              ...(prioritySources !== undefined ? { prioritySources } : {}),
              ...(communityDigest.length > 0 ? { communityDigest } : {}),
            }),
          ),
        );
        const rawFindings: Finding[] = [];
        let angleFailures = 0;
        settled.forEach((r, idx) => {
          if (r.status === 'fulfilled') {
            rawFindings.push(...r.value.findings);
            return;
          }
          angleFailures += 1;
          // Log the cause. A failed research angle was previously only counted
          // — its `reason` discarded — making research-stage failures opaque in
          // the logs, even though every other degrade path warns its cause.
          // (memory.md 2026-05-21 "always log a degrade".)
          const reason = r.reason;
          console.warn(
            `[run-brief] research-angle ${idx + 1}/${settled.length} failed ` +
              `(${(angles[idx] ?? '').slice(0, 80)}): ` +
              `${reason instanceof Error ? reason.message : String(reason)}`,
          );
        });
        await deps.audit.emit({
          eventType: 'research.gathered',
          payload: { runId, findingCount: rawFindings.length, angleFailures },
        });
        if (rawFindings.length === 0) {
          throw new Error('research produced no findings from any angle');
        }

        // --- Stage 3: challenge / verify ---
        stage = 'challenge';
        let adjudicated: readonly Finding[] = rawFindings;
        try {
          const challenged = await deps.registry.invoke<
            ChallengeFindingsArgs,
            ChallengeFindingsResult
          >('challenge-findings', withModel({ findings: rawFindings, topic, since, until }));
          adjudicated = challenged.findings;
        } catch (e) {
          // degrade — synthesise un-adjudicated findings.
          console.warn(
            `[run-brief] challenge-findings failed, using un-adjudicated findings: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          adjudicated = rawFindings;
        }
        const verdicts = { confirmed: 0, disputed: 0, unverified: 0 };
        for (const f of adjudicated) {
          if (f.verdict === 'confirmed') verdicts.confirmed += 1;
          else if (f.verdict === 'disputed') verdicts.disputed += 1;
          else verdicts.unverified += 1;
        }
        await deps.audit.emit({
          eventType: 'findings.challenged',
          payload: { runId, findingCount: adjudicated.length, ...verdicts },
        });

        // --- Stage 4: synthesize ---
        stage = 'synthesize';
        const persona = pickPersona(profile);
        const guardrails = pickGuardrails(profile);
        const markdownSections = pickMarkdownSections(profile);
        const extra = pickExtraInstructions(profile);
        const composed = await deps.registry.invoke<SynthesizeBriefArgs, SynthesizeBriefResult>(
          'synthesize-brief',
          withModel({
            findings: adjudicated, briefDescription: topic, since, until,
            ...(persona !== undefined ? { persona } : {}),
            ...(guardrails !== undefined ? { guardrails } : {}),
            ...(markdownSections !== undefined ? { markdownSections } : {}),
            ...(extra !== undefined ? { extraInstructions: extra } : {}),
          }),
        );
        await deps.audit.emit({
          eventType: 'brief.synthesized',
          payload: {
            runId,
            citationCount: composed.citationCount,
            ...(composed.costGbp !== undefined ? { costGbp: composed.costGbp } : {}),
            ...(composed.llmCallId !== undefined ? { llmCallId: composed.llmCallId } : {}),
          },
        });

        // --- Stage 5: dispatch ---
        stage = 'dispatch';
        const dispatched = await deps.registry.invoke<DispatchBriefArgs, DispatchBriefResult>(
          'dispatch-brief',
          {
            subject: `${pickSubjectPrefix(profile)} — ${dateYmd}`,
            body: composed.markdown,
            date: dateYmd,
            ...(args.dryRun === true ? { dryRun: true } : {}),
          },
        );

        const result: RunBriefResult = {
          runId, since, until,
          angleCount: angles.length,
          findingCount: adjudicated.length,
          citationCount: composed.citationCount,
          recipients: dispatched.recipients,
          emailMessageId: dispatched.emailMessageId,
          ...(dispatched.storageUri !== undefined ? { storageUri: dispatched.storageUri } : {}),
          ...(args.returnMarkdown === true ? { markdown: composed.markdown } : {}),
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
        await deps.audit.emit({
          eventType: 'run.failed',
          payload: { runId, stage, message: e instanceof Error ? e.message : String(e) },
        });
        throw e;
      }
    },
  };
}
