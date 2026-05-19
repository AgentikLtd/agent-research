/**
 * Storage client — writes agent-produced artefacts (research briefs,
 * intermediate notes) into the per-tenant workspace via the hub.
 *
 * Endpoint: `POST ${hubUrl}/api/storage/put`
 *
 * Resolution note (Phase 4 default): the hub currently exposes
 * read-side storage routes under `/api/storage/files/...` and the
 * `WorkspaceClient` in `agent-briefing` PUTs to
 * `/api/storage/<relative-path>`, but neither pattern is the
 * canonical write endpoint for agent-produced artefacts in the
 * `agent-research` template. We default to `POST /api/storage/put`
 * with a JSON body of `{ path, body, contentType? }` — the cleanest
 * shape for the storage-MCP backend.
 *
 *   IF the route is not yet wired at runtime, this client returns
 *   `{ ok: false, error: { message: 'gateway /api/storage/put 404 ...' } }`
 *   so callers (skills) can degrade — the put becomes a console
 *   warning and the skill still returns a result that includes the
 *   in-memory body.
 *
 * Per memory.md 2026-05-04 cross-repo HTTP adapter rules.
 */

export interface StoragePutOptions {
  readonly contentType?: string;
}

export type StoragePutResult =
  | { readonly ok: true; readonly uri: string }
  | { readonly ok: false; readonly error: { readonly code?: string; readonly message: string } };

export interface StorageClientDeps {
  readonly hubUrl: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
}

export interface StorageClient {
  put(path: string, body: string, opts?: StoragePutOptions): Promise<StoragePutResult>;
}

interface WireResponse {
  readonly ok?: boolean;
  readonly uri?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export function createStorageClient(deps: StorageClientDeps): StorageClient {
  const fetcher = deps.fetcher ?? fetch;
  const endpoint = `${deps.hubUrl.replace(/\/$/, '')}/api/storage/put`;

  return {
    async put(path, body, opts) {
      let res: Response;
      try {
        res = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            path,
            body,
            ...(opts?.contentType !== undefined ? { contentType: opts.contentType } : {}),
          }),
        });
      } catch (e) {
        return {
          ok: false,
          error: { message: e instanceof Error ? e.message : String(e) },
        };
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          ok: false,
          error: {
            code: `http_${String(res.status)}`,
            message: `gateway /api/storage/put ${String(res.status)}: ${text}`.trim(),
          },
        };
      }

      let parsed: WireResponse;
      try {
        parsed = (await res.json()) as WireResponse;
      } catch (e) {
        return {
          ok: false,
          error: { message: `storage response was not JSON: ${e instanceof Error ? e.message : String(e)}` },
        };
      }

      if (parsed.uri === undefined || parsed.uri === '') {
        return {
          ok: false,
          error: { message: 'storage response missing `uri` field' },
        };
      }
      return { ok: true, uri: parsed.uri };
    },
  };
}
