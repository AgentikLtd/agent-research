/**
 * Integration test — boots the HTTP server with a minimal SkillRegistry
 * carrying a single `echo` skill, then exercises:
 *   - GET /health → 200 with the expected JSON shape.
 *   - POST /jsonrpc without auth → 401, no skill invocation.
 *   - POST /jsonrpc with auth + valid body → 200, skill invocation occurred.
 *
 * The HTTP-server wiring in `src/index.ts` is exercised via
 * `handleJsonRpc` (the pure JSON-RPC dispatcher) for the JSON-RPC paths,
 * and via a tiny inline http.createServer that mirrors the index.ts
 * request-routing logic for the GET /health path. We DELIBERATELY do
 * NOT call `main()` from index.ts — that would require all of env, the
 * hub probe, and the manifest, which is overkill for the bearer + skill
 * contract this test is meant to verify.
 *
 * The reason both code paths are tested rather than just the registry:
 * a future refactor that introduces a third HTTP entrypoint (e.g.
 * `/metrics`) must not regress the bearer guard or accidentally accept
 * an unauthenticated `skills.invoke`. The integration test is the gate.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { handleJsonRpc } from '../../src/index.js';
import { createSkillRegistry, type Skill, type SkillRegistry } from '../../src/skills/registry.js';

interface EchoArgs {
  readonly message: string;
}

interface EchoResult {
  readonly echoed: string;
  readonly invokedAt: string;
}

function createEchoSkill(state: { invocations: number }): Skill<EchoArgs, EchoResult> {
  return {
    name: 'echo',
    description: 'Test seam: returns its `message` arg unchanged.',
    async invoke(args) {
      state.invocations += 1;
      return Promise.resolve({
        echoed: args.message,
        invokedAt: new Date(0).toISOString(),
      });
    },
  };
}

const TEST_TOKEN = 'integration-test-token';
const AGENT_NAME = 'test-research';
const AGENT_VERSION = '0.1.0';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

function buildServer(registry: SkillRegistry): import('node:http').Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = req.url ?? '/';
      if (req.method === 'GET' && url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agent: AGENT_NAME, version: AGENT_VERSION }));
        return;
      }
      if (req.method === 'POST' && url === '/jsonrpc') {
        const body = await readBody(req);
        const authHeader = req.headers['authorization'];
        const result = await handleJsonRpc(
          { registry, expectedToken: TEST_TOKEN },
          typeof authHeader === 'string' ? authHeader : undefined,
          body,
        );
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(result.body);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    })().catch((e: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    });
  });
}

async function startServer(
  registry: SkillRegistry,
): Promise<{ server: import('node:http').Server; baseUrl: string }> {
  const server = buildServer(registry);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server.listen did not return an address');
  }
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

async function stopServer(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe('agent boot — HTTP + JSON-RPC + bearer guard', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  let state: { invocations: number };

  beforeEach(async () => {
    state = { invocations: 0 };
    const registry = createSkillRegistry();
    registry.register(createEchoSkill(state));
    const started = await startServer(registry);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterEach(async () => {
    await stopServer(server);
  });

  it('GET /health returns 200 with the expected envelope', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; agent: string; version: string };
    expect(body.ok).toBe(true);
    expect(body.agent).toBe(AGENT_NAME);
    expect(body.version).toBe(AGENT_VERSION);
  });

  it('POST /jsonrpc without auth returns 401 and does NOT invoke the skill', async () => {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'skills.invoke',
        params: { skill: 'echo', args: { message: 'hi' } },
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('unauthorized');
    expect(state.invocations).toBe(0);
  });

  it('POST /jsonrpc with wrong bearer returns 401', async () => {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'skills.invoke',
        params: { skill: 'echo', args: { message: 'hi' } },
      }),
    });
    expect(res.status).toBe(401);
    expect(state.invocations).toBe(0);
  });

  it('POST /jsonrpc with valid auth + body invokes the skill and returns the result', async () => {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'skills.invoke',
        params: { skill: 'echo', args: { message: 'hello world' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: string;
      result: EchoResult;
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe('req-1');
    expect(body.result.echoed).toBe('hello world');
    expect(state.invocations).toBe(1);
  });

  it('POST /jsonrpc with unknown skill returns -32001 error envelope', async () => {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'skills.invoke',
        params: { skill: 'does-not-exist', args: {} },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('unknown skill');
    expect(state.invocations).toBe(0);
  });

  it('POST /jsonrpc with unknown method returns -32601', async () => {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'skills.list',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it('POST /jsonrpc with non-JSON body returns -32700 parse error', async () => {
    const res = await fetch(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_TOKEN}`,
      },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});
