import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/env.js';

const baseEnv = {
  AGENT_ID: 'agent_123',
  AGENT_NAME: 'research-genesys',
  TENANT_ID: 'tenant_abc',
  HUB_BASE_URL: 'https://demo.studio.agentik.co.uk',
  HUB_AGENT_TOKEN: 'tok_abcdef',
};

describe('loadEnv', () => {
  it('parses a complete env with sensible defaults', () => {
    const env = loadEnv({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(env.AGENT_ID).toBe('agent_123');
    expect(env.AGENT_NAME).toBe('research-genesys');
    expect(env.TENANT_ID).toBe('tenant_abc');
    expect(env.HUB_BASE_URL).toBe('https://demo.studio.agentik.co.uk');
    expect(env.HUB_AGENT_TOKEN).toBe('tok_abcdef');
    expect(env.PORT).toBe(4003);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.SANDBOX_CHECK_SKIP).toBeUndefined();
  });

  it('throws a descriptive error when AGENT_NAME is missing', () => {
    const incomplete = { ...baseEnv } as Record<string, string>;
    delete incomplete.AGENT_NAME;
    expect(() => loadEnv(incomplete as NodeJS.ProcessEnv)).toThrowError(/AGENT_NAME/);
  });
});
