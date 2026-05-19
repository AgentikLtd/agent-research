/**
 * dispatch-brief skill — persist the brief and dispatch it through the
 * hub's channel-router.
 *
 * Orchestrates three Phase-4 clients:
 *   1. `ProfileClient` — fetches the agent's own profile (for the
 *      additional-recipients list) and the tenant settings (for
 *      `operator_email`).
 *   2. `StorageClient` — writes the markdown body via the hub's
 *      `/api/storage/put` route. The put is best-effort: a failure
 *      surfaces as a warning but does NOT abort the dispatch — the
 *      delivered brief is the user-visible artefact and is allowed to
 *      ship without an archived copy if storage is degraded.
 *   3. `ChannelDispatchClient` — POSTs to the hub's `/api/channel/dispatch`
 *      with `event_id: 'scheduled_summary'`. The hub's channel-router
 *      resolves the actual channel adapter (agentmail / web-inbox /
 *      telegram …) by consulting the agent's manifest `output_channels`
 *      block (landed into `agent_profiles.config` by the install saga).
 *
 *      Architecture note: this replaces the prior email-manager A2A
 *      hop. AgentMail is a CHANNEL, not a specialist's responsibility;
 *      email-manager owns Gmail draft/triage, not transactional sends.
 *
 * Recipient resolution (the strict step):
 *   tenant.operator_email ∪ profile.config.output.additional_recipients
 *   deduped, trimmed, empty strings filtered. If the resulting list is
 *   empty the skill throws `DispatchError('no_recipients')` — sending a
 *   brief to no one is always a bug, never silent. (We preserve this
 *   preflight even though web-inbox would technically accept zero
 *   recipients; an operator with no destination configured has not
 *   actually opted in to receiving the brief.)
 *
 *   Recipients flow over the wire as `metadata.recipients` —
 *   comma-joined because the channel-dispatch schema forbids array
 *   values inside metadata (flat key→string|number|boolean|null). The
 *   AgentMail / web-inbox adapter splits on the hub side.
 *
 * Storage namespace (template-extensibility — CLAUDE.md §14):
 *   Do NOT hardcode `genesys/`. The path is derived in this order:
 *     1. `profile.config.output.storage_namespace` (string)         — explicit override.
 *     2. `<agent_name>` from the profile (e.g. `genesys-research`)  — default.
 *   Final path: `<namespace>/briefs/<YYYY-MM-DD>.md`.
 *
 * Dry-run (`dryRun: true`):
 *   Skips storage + channel dispatch entirely and returns synthetic ids
 *   so the orchestrator can validate the wiring + emit audit events
 *   without producing tenant-visible artefacts.
 */

import type { AuditClient } from '../hub/audit-client.js';
import type { ChannelDispatchClient } from '../hub/channel-dispatch-client.js';
import type {
  AgentProfile,
  ProfileClient,
  TenantSettings,
} from '../hub/profile-client.js';
import type { StorageClient } from '../hub/storage-client.js';
import type { Skill } from './registry.js';

export interface DispatchBriefArgs {
  /** Brief subject line — the orchestrator builds this from output config + date. */
  readonly subject: string;
  /** Final markdown body produced by compose-brief. */
  readonly body: string;
  /** ISO date used to name the stored artefact (`<date>.md`). */
  readonly date: string;
  /** If true, skip storage + channel dispatch and return synthetic ids. */
  readonly dryRun?: boolean;
}

export interface DispatchBriefResult {
  readonly recipients: ReadonlyArray<string>;
  readonly storageUri?: string;
  readonly storageWarning?: string;
  /**
   * Carrier-side message id from whichever channel adapter handled the
   * dispatch. Preserves the old field name so downstream consumers
   * (run-brief, audit emissions) don't need to change.
   */
  readonly emailMessageId: string;
  /** The channel adapter the hub routed to (e.g. 'agentmail', 'web-inbox'). */
  readonly channelId?: string;
  readonly dryRun: boolean;
}

export type DispatchErrorKind =
  | 'no_recipients'
  | 'dispatch_failed'
  | 'profile_failed';

export class DispatchError extends Error {
  readonly kind: DispatchErrorKind;
  readonly detail?: string;
  constructor(kind: DispatchErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'DispatchError';
    this.kind = kind;
    if (detail !== undefined) this.detail = detail;
  }
}

export interface DispatchBriefDeps {
  readonly profile: ProfileClient;
  readonly storage: StorageClient;
  readonly channel: ChannelDispatchClient;
  readonly audit: AuditClient;
  /** Test seam: defaults to `console.warn`. */
  readonly warn?: (line: string, detail?: unknown) => void;
}

function resolveStorageNamespace(profile: AgentProfile): string {
  const config = (profile['config'] ?? {}) as Record<string, unknown>;
  const output = (config['output'] ?? {}) as Record<string, unknown>;
  const explicit = output['storage_namespace'];
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim().replace(/^\/+|\/+$/g, '');
  }
  return profile.agent_name.replace(/^\/+|\/+$/g, '');
}

function resolveRecipients(
  profile: AgentProfile,
  tenant: TenantSettings,
): ReadonlyArray<string> {
  const out: string[] = [];
  const operator = (tenant as Record<string, unknown>)['operator_email'];
  if (typeof operator === 'string') out.push(operator);

  const config = (profile['config'] ?? {}) as Record<string, unknown>;
  const output = (config['output'] ?? {}) as Record<string, unknown>;
  const additional = output['additional_recipients'];
  if (Array.isArray(additional)) {
    for (const r of additional) if (typeof r === 'string') out.push(r);
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const raw of out) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(trimmed);
  }
  return deduped;
}

export function createDispatchBriefSkill(
  deps: DispatchBriefDeps,
): Skill<DispatchBriefArgs, DispatchBriefResult> {
  const warn = deps.warn ?? ((line, detail) => console.warn(line, detail));
  return {
    name: 'dispatch-brief',
    description:
      'Persist the brief to storage and dispatch it via the hub channel-router (event_id=scheduled_summary).',
    async invoke(args) {
      let profile: AgentProfile;
      let tenant: TenantSettings;
      try {
        [profile, tenant] = await Promise.all([
          deps.profile.get(),
          deps.profile.getTenantSettings(),
        ]);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new DispatchError(
          'profile_failed',
          `dispatch-brief profile fetch failed: ${message}`,
          message,
        );
      }

      const recipients = resolveRecipients(profile, tenant);
      if (recipients.length === 0) {
        throw new DispatchError(
          'no_recipients',
          'dispatch-brief: no recipients resolved from tenant.operator_email + profile.config.output.additional_recipients',
        );
      }

      const namespace = resolveStorageNamespace(profile);
      const storagePath = `${namespace}/briefs/${args.date}.md`;

      const isDryRun = args.dryRun === true;
      if (isDryRun) {
        await deps.audit.emit({
          eventType: 'dispatch.dry_run',
          payload: { recipients, storagePath, subject: args.subject },
        });
        return {
          recipients,
          storageUri: `dryrun://${storagePath}`,
          emailMessageId: `dryrun-message-${Date.now().toString(36)}`,
          dryRun: true,
        };
      }

      // 1. Storage put — best-effort.
      let storageUri: string | undefined;
      let storageWarning: string | undefined;
      const putResult = await deps.storage.put(storagePath, args.body, {
        contentType: 'text/markdown',
      });
      if (putResult.ok) {
        storageUri = putResult.uri;
      } else {
        storageWarning = `storage put failed: ${putResult.error.message}`;
        warn(`[dispatch-brief] ${storageWarning}`, { path: storagePath });
      }

      // 2. Channel dispatch — required. Recipients comma-joined because
      // the channel-dispatch metadata schema disallows array values.
      const dispatchResult = await deps.channel.dispatch({
        eventId: 'scheduled_summary',
        title: args.subject,
        body: args.body,
        metadata: {
          recipients: recipients.join(','),
          storage_uri: storageUri ?? '',
        },
      });
      if (!dispatchResult.ok) {
        throw new DispatchError(
          'dispatch_failed',
          `dispatch-brief channel dispatch failed: ${dispatchResult.error.message}`,
          dispatchResult.error.code,
        );
      }

      const result: DispatchBriefResult = {
        recipients,
        emailMessageId: dispatchResult.messageId,
        channelId: dispatchResult.channelId,
        dryRun: false,
        ...(storageUri !== undefined ? { storageUri } : {}),
        ...(storageWarning !== undefined ? { storageWarning } : {}),
      };
      return result;
    },
  };
}
