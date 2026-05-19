import { describe, it, expect } from 'vitest';
import {
  createProfileClient,
  ProfileFetchError,
} from '../../src/hub/profile-client.js';

function makeFetcher(
  routes: Record<string, () => Response | Promise<Response>>,
): { fetcher: typeof fetch; callCount: () => number } {
  let calls = 0;
  const fetcher: typeof fetch = async (input) => {
    calls += 1;
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const handler = routes[url];
    if (!handler) {
      return new Response(`unhandled ${url}`, { status: 599 });
    }
    return await handler();
  };
  return { fetcher, callCount: () => calls };
}

describe('createProfileClient', () => {
  it('returns the profile and tenant settings on success', async () => {
    const { fetcher } = makeFetcher({
      'http://hub/api/agents/agent_1/profile': () =>
        new Response(
          JSON.stringify({
            agent_id: 'agent_1',
            agent_name: 'research',
            tenant_id: 'tenant_x',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      'http://hub/api/tenant/settings': () =>
        new Response(
          JSON.stringify({ tenant_id: 'tenant_x', llm: { defaultModel: 'claude' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    const client = createProfileClient({
      hubUrl: 'http://hub',
      agentId: 'agent_1',
      token: 'tok',
      fetcher,
    });
    const profile = await client.get();
    const settings = await client.getTenantSettings();
    expect(profile.agent_id).toBe('agent_1');
    expect(settings.tenant_id).toBe('tenant_x');
  });

  it('throws ProfileFetchError with kind=profile_missing on 404', async () => {
    const { fetcher } = makeFetcher({
      'http://hub/api/agents/agent_404/profile': () =>
        new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 }),
    });
    const client = createProfileClient({
      hubUrl: 'http://hub',
      agentId: 'agent_404',
      token: 'tok',
      fetcher,
    });
    await expect(client.get()).rejects.toBeInstanceOf(ProfileFetchError);
    try {
      await client.get();
    } catch (e) {
      expect(e).toBeInstanceOf(ProfileFetchError);
      if (e instanceof ProfileFetchError) {
        expect(e.kind).toBe('profile_missing');
        expect(e.status).toBe(404);
      }
    }
  });

  it('caches results for 60s, then refetches', async () => {
    let now = 0;
    const { fetcher, callCount } = makeFetcher({
      'http://hub/api/agents/agent_c/profile': () =>
        new Response(
          JSON.stringify({
            agent_id: 'agent_c',
            agent_name: 'research',
            tenant_id: 'tenant_x',
          }),
          { status: 200 },
        ),
    });
    const client = createProfileClient({
      hubUrl: 'http://hub',
      agentId: 'agent_c',
      token: 'tok',
      fetcher,
      clock: () => now,
      cacheTtlMs: 60_000,
    });
    await client.get();
    expect(callCount()).toBe(1);
    // Within TTL — served from cache.
    now = 30_000;
    await client.get();
    expect(callCount()).toBe(1);
    // After TTL — refetches.
    now = 70_000;
    await client.get();
    expect(callCount()).toBe(2);
  });
});
