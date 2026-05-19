/**
 * Profile client — fetches the agent's own `agent_profile` row plus
 * the tenant-wide `TenantSettings` from the hub. Both calls use the
 * per-agent bearer token (validated by `agent_tokens`).
 *
 * Endpoints:
 *   GET /api/agents/<agentId>/profile  → returns the `agent_profiles` row.
 *     Confirmed shape: see studio repo
 *     `apps/hub-ui/src/app/api/agents/[id]/profile/route.ts`.
 *     401 → unauthorized, 404 → not-found (also returned for
 *     cross-tenant attempts so callers can't probe).
 *   GET /api/tenant/settings           → returns the `TenantSettings`
 *     object. This route is part of the Phase 1.5 / 2 work plan and
 *     may not yet be live; the client falls through to the same
 *     ProfileFetchError shape so the calling skill code can switch on
 *     `error.kind` and degrade gracefully.
 *
 * In-process LRU-style cache (per resource id), default TTL 60s.
 * Refresh-on-expiry is reactive, not proactive — no background timer.
 *
 * Test seams: `fetcher` (override `fetch`), `clock` (override `Date.now`).
 */

export interface AgentProfile {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly tenant_id: string;
  // The hub returns the full row — we leave the rest open so we
  // don't recapitulate the schema here. Callers that need typed
  // access widen the interface in their own module.
  readonly [field: string]: unknown;
}

export interface ProfileConfig {
  readonly maxOutputTokens?: number;
  readonly defaultModel?: string;
  readonly [field: string]: unknown;
}

export interface TenantSettings {
  readonly tenant_id?: string;
  readonly llm?: {
    readonly defaultModel?: string;
    readonly providerPreference?: ReadonlyArray<string>;
    readonly [field: string]: unknown;
  };
  readonly [field: string]: unknown;
}

export type ProfileFetchErrorKind =
  | 'profile_missing'
  | 'auth_invalid'
  | 'tenant_settings_missing'
  | 'fetch_failed';

export class ProfileFetchError extends Error {
  readonly kind: ProfileFetchErrorKind;
  readonly status?: number;
  readonly body?: string;
  constructor(
    kind: ProfileFetchErrorKind,
    message: string,
    opts?: { readonly status?: number; readonly body?: string },
  ) {
    super(message);
    this.name = 'ProfileFetchError';
    this.kind = kind;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.body !== undefined) this.body = opts.body;
  }
}

export interface ProfileClientDeps {
  readonly hubUrl: string;
  readonly agentId: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
  readonly clock?: () => number;
  /** Cache lifetime in ms; default 60_000. Set to 0 to disable. */
  readonly cacheTtlMs?: number;
}

export interface ProfileClient {
  /** Fetch this agent's own profile. Cached for `cacheTtlMs`. */
  get(): Promise<AgentProfile>;
  /** Fetch the tenant-wide settings. Cached for `cacheTtlMs`. */
  getTenantSettings(): Promise<TenantSettings>;
  /** Drop both cache entries — useful after a known mutation. */
  invalidate(): void;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly fetchedAtMs: number;
}

export function createProfileClient(deps: ProfileClientDeps): ProfileClient {
  const fetcher = deps.fetcher ?? fetch;
  const clock = deps.clock ?? Date.now;
  const ttl = deps.cacheTtlMs ?? 60_000;
  const hub = deps.hubUrl.replace(/\/$/, '');

  let profileCache: CacheEntry<AgentProfile> | undefined;
  let settingsCache: CacheEntry<TenantSettings> | undefined;

  const headers = {
    authorization: `Bearer ${deps.token}`,
    accept: 'application/json',
  };

  async function fetchProfile(): Promise<AgentProfile> {
    const url = `${hub}/api/agents/${encodeURIComponent(deps.agentId)}/profile`;
    let res: Response;
    try {
      res = await fetcher(url, { headers });
    } catch (e) {
      throw new ProfileFetchError(
        'fetch_failed',
        `profile fetch threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (res.status === 401) {
      const body = await res.text().catch(() => '');
      throw new ProfileFetchError('auth_invalid', `profile fetch unauthorized: ${body}`, {
        status: 401,
        body,
      });
    }
    if (res.status === 404) {
      const body = await res.text().catch(() => '');
      throw new ProfileFetchError(
        'profile_missing',
        `profile for ${deps.agentId} not found`,
        { status: 404, body },
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProfileFetchError(
        'fetch_failed',
        `profile fetch ${String(res.status)}: ${body}`.trim(),
        { status: res.status, body },
      );
    }
    return (await res.json()) as AgentProfile;
  }

  async function fetchSettings(): Promise<TenantSettings> {
    const url = `${hub}/api/tenant/settings`;
    let res: Response;
    try {
      res = await fetcher(url, { headers });
    } catch (e) {
      throw new ProfileFetchError(
        'fetch_failed',
        `tenant settings fetch threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (res.status === 401) {
      const body = await res.text().catch(() => '');
      throw new ProfileFetchError(
        'auth_invalid',
        `tenant settings unauthorized: ${body}`,
        { status: 401, body },
      );
    }
    if (res.status === 404) {
      const body = await res.text().catch(() => '');
      throw new ProfileFetchError(
        'tenant_settings_missing',
        'tenant settings endpoint returned 404 — route may not yet be live',
        { status: 404, body },
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProfileFetchError(
        'fetch_failed',
        `tenant settings fetch ${String(res.status)}: ${body}`.trim(),
        { status: res.status, body },
      );
    }
    return (await res.json()) as TenantSettings;
  }

  function fresh<T>(entry: CacheEntry<T> | undefined): T | undefined {
    if (entry === undefined) return undefined;
    if (ttl === 0) return undefined;
    if (clock() - entry.fetchedAtMs > ttl) return undefined;
    return entry.value;
  }

  return {
    async get() {
      const cached = fresh(profileCache);
      if (cached !== undefined) return cached;
      const value = await fetchProfile();
      profileCache = { value, fetchedAtMs: clock() };
      return value;
    },
    async getTenantSettings() {
      const cached = fresh(settingsCache);
      if (cached !== undefined) return cached;
      const value = await fetchSettings();
      settingsCache = { value, fetchedAtMs: clock() };
      return value;
    },
    invalidate() {
      profileCache = undefined;
      settingsCache = undefined;
    },
  };
}
