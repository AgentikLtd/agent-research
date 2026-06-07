/**
 * agent-research entrypoint — Genesys-flavor by default (via `manifest.yaml`).
 *
 * Boot sequence (Phase 6.2 contract):
 *   1. `loadEnv()` validates required env (zod). Fail fast on missing keys.
 *   2. `initTracing(env.AGENT_NAME, env.OTEL_EXPORTER_OTLP_ENDPOINT)` returns
 *      a tracer handle the process owns for shutdown flushing.
 *   3. **Sandbox check** — unless `SANDBOX_CHECK_SKIP=1`, we hit
 *      `GET ${hubUrl}/api/health`. A non-2xx (or thrown network error) means
 *      the hub is unreachable, which means our /api/llm/send, profile, and
 *      storage calls will all fail; we exit 1 BEFORE accepting traffic rather
 *      than serve a broken JSON-RPC port. (Briefing's richer FS/DNS probe
 *      lives in `src/sandbox-check/`; the research-agent template defers that
 *      to a future hardening pass and uses the lighter health probe per the
 *      Phase 6 plan.)
 *   4. Load `manifest.yaml` once at boot; resolve per-skill models from
 *      `x-agentik/model.per_skill_overrides[skill]` (preferred) or
 *      `x-agentik/model.default` (manifest fallback) or the hardcoded
 *      `anthropic/claude-sonnet-4-6` fallback.
 *   5. Construct the 5 clients (gateway, profile, storage, audit, channel).
 *      Audit defaults to `mode: 'noop'` (the hub doesn't yet expose
 *      `POST /api/audit/emit` — see `src/hub/audit-client.ts` header).
 *      `channel` POSTs to the hub's `/api/channel/dispatch` route which
 *      replaced the old direct A2A hop to email-manager — AgentMail is a
 *      channel adapter, not a specialist's responsibility.
 *   6. Construct the source-adapter map keyed by manifest `sources[*].type`.
 *      `subreddit` aliases to the reddit adapter. `community`, `docs`,
 *      `vendor`, `news` all use the html adapter — they are HTML listing
 *      pages in disguise. Future flavours add adapters here.
 *   7. Register all skills with the registry. Order matters only in that
 *      `run-brief` references the registry; the others are independent.
 *       gather-sources is registered and invoked by run-brief as the Stage 0
 *       community-retrieval step (it also stays independently invokable).
 *   8. Boot an HTTP server on `env.PORT`:
 *        - `GET /health`  → `{ ok: true, agent, version }` (no auth).
 *        - `POST /a2a` → bearer-validate against `env.HUB_AGENT_TOKEN`,
 *          accept `{ jsonrpc: '2.0', id, method: 'skills.invoke',
 *          params: { skill, args } }`, dispatch through the registry, return
 *          a JSON-RPC envelope.
 *
 * Process lifetime: SIGTERM / SIGINT flushes the tracer + closes the
 * server. Skill errors are returned as JSON-RPC error responses (-32000 for
 * skill failures, -32601 for unknown method, -32602 for invalid params,
 * -32700 for non-JSON bodies) — they do NOT crash the process.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import pg from 'pg';

import { loadEnv } from './env.js';
import { initTracing } from './tracing.js';
import { createGatewayClient } from './llm/gateway-client.js';
import { createProfileClient } from './hub/profile-client.js';
import { createStorageClient } from './hub/storage-client.js';
import { createAuditClient } from './hub/audit-client.js';
import { createChannelDispatchClient } from './hub/channel-dispatch-client.js';
import { createRssSourceAdapter } from './sources/rss-source.js';
import { createRedditSourceAdapter } from './sources/reddit-source.js';
import { createHtmlSourceAdapter } from './sources/html-source.js';
import { createSkillRegistry, UnknownSkillError } from './skills/registry.js';
import { createGatherSourcesSkill } from './skills/gather-sources.js';
import { createPlanResearchSkill } from './skills/plan-research.js';
import { createResearchAngleSkill } from './skills/research-angle.js';
import { createChallengeFindingsSkill } from './skills/challenge-findings.js';
import { createSynthesizeBriefSkill } from './skills/synthesize-brief.js';
import { createDispatchBriefSkill } from './skills/dispatch-brief.js';
import { createRunBriefSkill } from './skills/run-brief.js';
import { createConsolidateMemoriesSkill } from './skills/consolidate-memories.js';
import { createOpenAiEmbedder } from './memory/embedder.js';
import { createFastEmbedEmbedder } from './memory/fastembed-embedder.js';
import { createMemoryRouter } from './memory/memory-router.js';
import { createPostgresEpisodicAdapter } from './memory/adapters/episodic.js';
import { createPostgresSemanticAdapter, createPostgresSemanticSearcher } from './memory/adapters/semantic.js';
import { createHttpSharedAdapter } from './memory/adapters/shared.js';
import { createPostgresEpisodicWriter } from './memory/episodic-writer.js';
import type { Embedder, EpisodicWriter, MemoryTool } from './memory/contracts.js';
import type { SemanticSearcher } from './memory/adapters/semantic.js';
import type { SourceAdapter } from './sources/contracts.js';
import type { SkillRegistry } from './skills/registry.js';

const FALLBACK_MODEL = 'anthropic/claude-sonnet-4-6';
const AGENT_VERSION = '0.2.1';

/** JSON-RPC error codes. */
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_SKILL_ERROR = -32000;
const JSONRPC_UNKNOWN_SKILL = -32001;

interface ManifestModelSection {
  readonly default?: string;
  readonly per_skill_overrides?: Readonly<Record<string, string>>;
}

interface ManifestAgentSection {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
}

interface AgentManifest {
  readonly agent: ManifestAgentSection;
  readonly 'x-agentik/model'?: ManifestModelSection;
}

function readManifest(path = 'manifest.yaml'): AgentManifest {
  const text = readFileSync(path, 'utf-8');
  return parseYaml(text) as AgentManifest;
}

/** Resolve a skill's model: per_skill_overrides[skill] → model.default → fallback. */
export function resolveSkillModel(manifest: AgentManifest, skill: string): string {
  const model = manifest['x-agentik/model'];
  const override = model?.per_skill_overrides?.[skill];
  if (typeof override === 'string' && override.length > 0) return override;
  if (typeof model?.default === 'string' && model.default.length > 0) return model.default;
  return FALLBACK_MODEL;
}

/**
 * Probe the hub `/api/health` endpoint. Returns true if reachable + 2xx.
 * Logs the failure cause so operators see "why" in stdout.
 */
async function probeHubHealth(hubUrl: string): Promise<boolean> {
  const endpoint = `${hubUrl.replace(/\/$/, '')}/api/health`;
  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(
        `[sandbox-check] hub /api/health returned ${String(res.status)}: ${body}`.trim(),
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      `[sandbox-check] hub /api/health threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

interface JsonRpcInvokeParams {
  readonly skill: string;
  readonly args?: unknown;
}

function parseInvokeParams(raw: unknown): JsonRpcInvokeParams | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const skill = obj['skill'];
  if (typeof skill !== 'string' || skill.length === 0) return null;
  return { skill, args: obj['args'] };
}

interface JsonRpcEnvelope {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): string {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error['data'] = data;
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error });
}

function jsonRpcSuccess(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Optional `message/send` chat dependencies. When present, the
 * handler dispatches `message/send` calls (used by the studio per-agent
 * chat surface) to the LLM gateway with the agent's persona as the
 * system prompt. When absent, `message/send` falls back to a
 * `unknown method` JSON-RPC error preserving the pre-2026-05-26
 * behaviour.
 *
 * Aligns this agent's A2A surface with agent-runtime's `message/send`
 * contract (memory.md 2026-05-19): `params: { input: string }` →
 * `result: { text: string, role: 'ROLE_AGENT' }`. The literal "ping"
 * short-circuits to a "pong (...)" reply as the universal smoke
 * surface; everything else routes through the gateway.
 */
export interface ChatDeps {
  readonly gateway: { send(req: import('./llm/gateway-client.js').LlmSendRequest): Promise<import('./llm/gateway-client.js').LlmSendResult> };
  readonly model: string;
  readonly systemPrompt: string;
  readonly serviceName: string;
  readonly now: () => string;
}

export interface HandleJsonRpcDeps {
  readonly registry: SkillRegistry;
  readonly expectedToken: string;
  readonly chat?: ChatDeps;
}

export interface JsonRpcHandlerResult {
  readonly status: number;
  readonly body: string;
}

/**
 * Pure JSON-RPC dispatch — exported for the integration test so it can
 * exercise the handler without booting an HTTP server.
 */
export async function handleJsonRpc(
  deps: HandleJsonRpcDeps,
  authHeader: string | undefined,
  rawBody: string,
): Promise<JsonRpcHandlerResult> {
  // Bearer-validate. We do this before parsing the body so malformed payloads
  // from unauthenticated clients can't probe parser behaviour.
  const expected = `Bearer ${deps.expectedToken}`;
  if (authHeader !== expected) {
    return {
      status: 401,
      body: jsonRpcError(null, JSONRPC_INVALID_REQUEST, 'unauthorized'),
    };
  }

  let parsed: JsonRpcEnvelope;
  try {
    parsed = JSON.parse(rawBody) as JsonRpcEnvelope;
  } catch (e) {
    return {
      status: 400,
      body: jsonRpcError(
        null,
        JSONRPC_PARSE_ERROR,
        `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  }

  if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    return {
      status: 400,
      body: jsonRpcError(parsed.id, JSONRPC_INVALID_REQUEST, 'jsonrpc must be "2.0" with a string method'),
    };
  }

  // `message/send` is the universal A2A chat method (agent-runtime
  // parity, memory.md 2026-05-19). Optional — only available when
  // `deps.chat` is wired in `main()`. When chat is configured the
  // handler dispatches to it; otherwise we fall through to the
  // `unknown_method` path so the surface degrades cleanly.
  if (parsed.method === 'message/send') {
    if (!deps.chat) {
      return {
        status: 200,
        body: jsonRpcError(parsed.id, JSONRPC_METHOD_NOT_FOUND, 'message/send not configured'),
      };
    }
    const input =
      typeof (parsed.params as { input?: unknown } | undefined)?.input === 'string'
        ? ((parsed.params as { input: string }).input)
        : '';
    if (input.trim().toLowerCase() === 'ping') {
      return {
        status: 200,
        body: jsonRpcSuccess(parsed.id, {
          text: `pong (${deps.chat.serviceName} @ ${deps.chat.now()})`,
          role: 'ROLE_AGENT',
        }),
      };
    }
    if (input.trim().length === 0) {
      return {
        status: 200,
        body: jsonRpcError(parsed.id, JSONRPC_INVALID_PARAMS, 'params.input must be a non-empty string'),
      };
    }
    const llm = await deps.chat.gateway.send({
      model: deps.chat.model,
      system: deps.chat.systemPrompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      params: { maxOutputTokens: 1024 },
    });
    if (!llm.ok) {
      return {
        status: 200,
        body: jsonRpcError(parsed.id, JSONRPC_SKILL_ERROR, `gateway error: ${llm.error.message}`),
      };
    }
    const text = llm.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    return {
      status: 200,
      body: jsonRpcSuccess(parsed.id, { text, role: 'ROLE_AGENT' }),
    };
  }

  if (parsed.method !== 'skills.invoke') {
    return {
      status: 200,
      body: jsonRpcError(parsed.id, JSONRPC_METHOD_NOT_FOUND, `unknown method: ${parsed.method}`),
    };
  }

  const invoke = parseInvokeParams(parsed.params);
  if (!invoke) {
    return {
      status: 200,
      body: jsonRpcError(
        parsed.id,
        JSONRPC_INVALID_PARAMS,
        'params must be { skill: string, args?: unknown }',
      ),
    };
  }

  try {
    const result = await deps.registry.invoke(invoke.skill, invoke.args);
    return { status: 200, body: jsonRpcSuccess(parsed.id, result) };
  } catch (e) {
    if (e instanceof UnknownSkillError) {
      return {
        status: 200,
        body: jsonRpcError(parsed.id, JSONRPC_UNKNOWN_SKILL, e.message),
      };
    }
    const message = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : 'Error';
    return {
      status: 200,
      body: jsonRpcError(parsed.id, JSONRPC_SKILL_ERROR, message, { kind: name }),
    };
  }
}

async function main(): Promise<void> {
  const env = loadEnv();

  const tracing = initTracing(env.AGENT_NAME, env.OTEL_EXPORTER_OTLP_ENDPOINT);

  const skipSandbox =
    env.SANDBOX_CHECK_SKIP === '1' || env.SANDBOX_CHECK_SKIP === 'true';
  if (!skipSandbox) {
    const ok = await probeHubHealth(env.HUB_BASE_URL);
    if (!ok) {
      console.error('[sandbox-check] hub unreachable — refusing to boot');
      await tracing.shutdown().catch(() => undefined);
      process.exit(1);
    }
  }

  const manifest = readManifest();

  // --- clients (Phase 4) ---
  const gateway = createGatewayClient({
    hubUrl: env.HUB_BASE_URL,
    token: env.HUB_AGENT_TOKEN,
  });
  const profile = createProfileClient({
    hubUrl: env.HUB_BASE_URL,
    agentId: env.AGENT_ID,
    token: env.HUB_AGENT_TOKEN,
  });
  const storage = createStorageClient({
    hubUrl: env.HUB_BASE_URL,
    token: env.HUB_AGENT_TOKEN,
  });
  const audit = createAuditClient({
    hubUrl: env.HUB_BASE_URL,
    agentId: env.AGENT_ID,
    token: env.HUB_AGENT_TOKEN,
    // Trace POSTs go to the per-agent /api/agents/[id]/trace route (DDR-001).
    // Defaults to remote because a token is present in production; noop is the
    // dev fallback when no token is set. Failures (e.g. a 404 pre-roll) are
    // swallowed — audit is non-critical.
  });
  // Channel dispatch — replaces the old email-manager A2A hop. The hub's
  // channel-router resolves the actual adapter (agentmail / web-inbox /
  // telegram …) from the agent's manifest output_channels block.
  const channel = createChannelDispatchClient({
    hubUrl: env.HUB_BASE_URL,
    token: env.HUB_AGENT_TOKEN,
  });

  // --- source adapters (Phase 3) ---
  // Manifest `sources[*].type` values: community, docs, subreddit, vendor, news.
  // - `subreddit` → reddit adapter (URL field carries the sub name).
  // - everything else listed in this manifest is an HTML listing page.
  // - `rss` is wired for future flavours that subscribe to an actual feed.
  const rssAdapter = createRssSourceAdapter();
  const redditAdapter = createRedditSourceAdapter();
  const htmlAdapter = createHtmlSourceAdapter();
  const adapters: Readonly<Record<string, SourceAdapter>> = {
    rss: rssAdapter,
    reddit: redditAdapter,
    subreddit: redditAdapter,
    html: htmlAdapter,
    community: htmlAdapter,
    docs: htmlAdapter,
    vendor: htmlAdapter,
    news: htmlAdapter,
  };

  // --- skills ---
  // gather-sources is registered here; run-brief invokes it as the Stage 0
  // community-retrieval step that seeds every researcher's digest.
  const registry = createSkillRegistry();
  registry.register(createGatherSourcesSkill({ adapters }));
  registry.register(
    createPlanResearchSkill({ gateway, model: resolveSkillModel(manifest, 'plan-research') }),
  );
  registry.register(
    createResearchAngleSkill({ gateway, model: resolveSkillModel(manifest, 'research-angle') }),
  );
  registry.register(
    createChallengeFindingsSkill({
      gateway,
      model: resolveSkillModel(manifest, 'challenge-findings'),
    }),
  );
  registry.register(
    createSynthesizeBriefSkill({
      gateway,
      model: resolveSkillModel(manifest, 'synthesize-brief'),
    }),
  );
  registry.register(createDispatchBriefSkill({ profile, storage, channel, audit }));

  // --- memory substrate (Task 21) ---
  // Requires DATABASE_URL (or TENANT_DATABASE_URL).
  // TENANT_DATABASE_URL takes precedence; DATABASE_URL is the legacy alias.
  // If absent, the memory router + consolidate-memories are both skipped and
  // the agent operates without episodic writes (graceful degradation).
  //
  // Embedder selection:
  //   - If EMBEDDER_BASE_URL + EMBEDDER_API_KEY are both set, use the
  //     OpenAI-compatible embedder (1536-dim, requires external API).
  //   - Otherwise, fall back to the in-process fastembed embedder
  //     (384-dim, BGESmallENV15, ONNX runtime). This is the default
  //     when neither external embedding key is configured — the agent
  //     no longer requires a /v1/embeddings provider.
  //
  // NOTE: the semantic.facts.embedding column must match the embedder's
  // dimensions. Migration 0004 switches the column to vector(384) for the
  // fastembed default; switching back to OpenAI requires re-migrating.
  const dbUrl = env.TENANT_DATABASE_URL ?? env.DATABASE_URL;
  let episodicWriter: EpisodicWriter | undefined;
  let memory: MemoryTool | undefined;
  let semanticSearcher: SemanticSearcher | undefined;
  let embedderForRecall: Embedder | undefined;

  if (dbUrl) {
    const tenantPool = new pg.Pool({ connectionString: dbUrl, max: 5 });
    const useOpenAi = Boolean(env.EMBEDDER_BASE_URL && env.EMBEDDER_API_KEY);
    const embedder: Embedder = useOpenAi
      ? createOpenAiEmbedder({
          model: 'text-embedding-3-small',
          baseUrl: env.EMBEDDER_BASE_URL as string,
          apiKey: env.EMBEDDER_API_KEY as string,
        })
      : await createFastEmbedEmbedder();
    console.info(
      `[boot] embedder: ${useOpenAi ? 'openai-compatible (1536d)' : 'fastembed local (384d)'}`,
    );

    const episodicAdapter = createPostgresEpisodicAdapter({
      pool: tenantPool,
      schema: 'agent_research_episodic',
      agentName: 'genesys-research',
      tenantId: env.TENANT_ID,
    });
    const semanticAdapter = createPostgresSemanticAdapter({
      pool: tenantPool,
      schema: 'agent_research_semantic',
      tenantId: env.TENANT_ID,
      embedder,
    });
    const sharedAdapter = createHttpSharedAdapter({
      hubBaseUrl: env.HUB_BASE_URL,
      bearer: env.HUB_AGENT_TOKEN,
    });

    // Full memory router — used by recall() helper.
    memory = createMemoryRouter({
      episodic: episodicAdapter,
      semantic: semanticAdapter,
      shared: sharedAdapter,
    });

    // SemanticSearcher — used by recall() helper.
    semanticSearcher = createPostgresSemanticSearcher({
      pool: tenantPool,
      schema: 'agent_research_semantic',
    });

    // Embedder reference for recall() — same instance used by the semantic adapter.
    embedderForRecall = embedder;

    // EpisodicWriter — injected into run-brief (Task 21 Step 4).
    episodicWriter = createPostgresEpisodicWriter({
      pool: tenantPool,
      schema: 'agent_research_episodic',
      agentName: 'genesys-research',
      tenantId: env.TENANT_ID,
    });

    // Consolidation cron skill.
    registry.register(createConsolidateMemoriesSkill({
      pool: tenantPool,
      tenantId: env.TENANT_ID,
      gateway,
      embedder,
      model: resolveSkillModel(manifest, 'consolidate-memories'),
    }));

    console.info('[boot] memory router wired (episodic + semantic + shared)');
  } else {
    console.warn('[boot] memory substrate skipped — TENANT_DATABASE_URL / DATABASE_URL not set');
  }

  // run-brief registered after memory block so episodic + recall deps are available.
  // exactOptionalPropertyTypes: spread only when defined.
  registry.register(
    createRunBriefSkill({
      registry,
      profile,
      audit,
      ...(episodicWriter !== undefined ? { episodicWriter } : {}),
      ...(memory !== undefined ? { memory } : {}),
      ...(semanticSearcher !== undefined ? { semanticSearcher } : {}),
      ...(embedderForRecall !== undefined ? { embedder: embedderForRecall } : {}),
      ...(dbUrl ? { tenantId: env.TENANT_ID } : {}),
    }),
  );

  // Wire `message/send` chat support. Model + system prompt are
  // resolved from the manifest's `x-agentik/model.default` and a
  // generic research-agent persona (agent-research is template-shaped
  // so we don't read per-tenant persona at this layer — for ad-hoc
  // user-created agents that's the agent-runtime image's job).
  const chatDeps: ChatDeps = {
    gateway,
    model: resolveSkillModel(manifest, 'message-send'),
    systemPrompt:
      `You are ${env.AGENT_NAME}, a research-specialist agent in the Agentik Studio platform. ` +
      `Your job is to research a topic by gathering and synthesising information from configured sources, ` +
      `then producing a structured brief. When the user chats with you directly, answer their question ` +
      `concisely from your existing knowledge or the topics you've researched before. Keep replies short ` +
      `(2-4 sentences) unless asked to elaborate. Do NOT invent research findings on the fly — for a ` +
      `full briefing, ask the operator to invoke the run-brief skill.`,
    serviceName: env.AGENT_NAME,
    now: (): string => new Date().toISOString(),
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res, registry, env.HUB_AGENT_TOKEN, env.AGENT_NAME, chatDeps).catch(
      (e: unknown) => {
        console.error('[http] unexpected error', e);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      },
    );
  });

  const port = env.PORT;
  server.listen(port, () => {
    console.log(
      `[${env.AGENT_NAME}] listening on :${String(port)} v${AGENT_VERSION}`,
    );
  });

  const shutdown = (signal: string): void => {
    console.log(`[${env.AGENT_NAME}] ${signal} received — shutting down`);
    server.close(() => {
      void tracing
        .shutdown()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: SkillRegistry,
  expectedToken: string,
  agentName: string,
  chat?: ChatDeps,
): Promise<void> {
  const url = req.url ?? '/';
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        agent: agentName,
        version: AGENT_VERSION,
      }),
    );
    return;
  }

  if (req.method === 'POST' && url === '/a2a') {
    const body = await readBody(req);
    const authHeader = req.headers['authorization'];
    const result = await handleJsonRpc(
      { registry, expectedToken, ...(chat ? { chat } : {}) },
      typeof authHeader === 'string' ? authHeader : undefined,
      body,
    );
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(result.body);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', method: req.method, url }));
}

// Run main() only when this module is the process entrypoint. Importing
// `handleJsonRpc` from tests must NOT boot a real server.
const isEntrypoint = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false;
  try {
    // ESM: `import.meta.url` would be ideal but tsconfig is set to module
    // ES2022 with moduleResolution Bundler — we use a process.argv check
    // instead which works under `node dist/index.js`.
    const entry = process.argv[1].replace(/\\/g, '/');
    return entry.endsWith('/index.js') || entry.endsWith('/dist/index.js');
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  void main();
}
