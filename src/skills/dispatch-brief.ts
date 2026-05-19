/**
 * dispatch-brief skill — persist the brief and queue an email draft.
 *
 * Orchestrates three Phase-4 clients:
 *   1. `ProfileClient` — fetches the agent's own profile (for the
 *      additional-recipients list) and the tenant settings (for
 *      `operator_email`).
 *   2. `StorageClient` — writes the markdown body via the hub's
 *      `/api/storage/put` route. The put is best-effort: a failure
 *      surfaces as a warning but does NOT abort the dispatch — the email
 *      is the user-visible artefact and is allowed to ship without an
 *      archived copy if storage is degraded.
 *   3. `EmailManagerClient` — invokes the email-manager's `draft-email`
 *      skill via the hub-proxy /invoke-skill route.
 *
 * Recipient resolution (the strict step):
 *   tenant.operator_email ∪ profile.config.output.additional_recipients
 *   deduped, trimmed, empty strings filtered. If the resulting list is
 *   empty the skill throws `DispatchError('no_recipients')` — sending a
 *   brief to no one is always a bug, never silent.
 *
 * Storage namespace (template-extensibility — CLAUDE.md §14):
 *   Do NOT hardcode `genesys/`. The path is derived in this order:
 *     1. `profile.config.output.storage_namespace` (string)         — explicit override.
 *     2. `<agent_name>` from the profile (e.g. `genesys-research`)  — default; lets each
 *        flavour land its briefs under its own folder without a manifest edit.
 *   Final path: `<namespace>/briefs/<YYYY-MM-DD>.md`.
 *
 * Dry-run (`dryRun: true`):
 *   Skips storage + email entirely and returns synthetic ids so the
 *   orchestrator can validate the wiring + emit audit events without
 *   producing tenant-visible artefacts. Used by the integration test
 *   and by the eval suite warm-up step.
 */

import type { AuditClient } from '../hub/audit-client.js';
import type {
  AgentProfile,
  ProfileClient,
  TenantSettings,
} from '../hub/profile-client.js';
import type { StorageClient } from '../hub/storage-client.js';
import type { EmailManagerClient } from '../a2a/email-manager-client.js';
import type { Skill } from './registry.js';

export interface DispatchBriefArgs {
  /** Brief subject line — the orchestrator builds this from output config + date. */
  readonly subject: string;
  /** Final markdown body produced by compose-brief. */
  readonly body: string;
  /** ISO date used to name the stored artefact (`<date>.md`). */
  readonly date: string;
  /** If true, skip storage + email and return synthetic ids. */
  readonly dryRun?: boolean;
}

export interface DispatchBriefResult {
  readonly recipients: ReadonlyArray<string>;
  readonly storageUri?: string;
  readonly storageWarning?: string;
  readonly emailMessageId: string;
  readonly dryRun: boolean;
}

export type DispatchErrorKind = 'no_recipients' | 'email_failed' | 'profile_failed';

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
  readonly email: EmailManagerClient;
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
    description: 'Persist the brief to storage and queue an email draft via the email-manager.',
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

      // 2. Email draft — required.
      const emailResult = await deps.email.draftEmail({
        to: recipients,
        subject: args.subject,
        body: args.body,
      });
      if (!emailResult.ok) {
        throw new DispatchError(
          'email_failed',
          `dispatch-brief email-manager draftEmail failed: ${emailResult.error.message}`,
          emailResult.error.code,
        );
      }

      const result: DispatchBriefResult = {
        recipients,
        emailMessageId: emailResult.messageId,
        dryRun: false,
        ...(storageUri !== undefined ? { storageUri } : {}),
        ...(storageWarning !== undefined ? { storageWarning } : {}),
      };
      return result;
    },
  };
}
