/**
 * Zod-validated env loader for the research-agent template.
 *
 * Single chokepoint for every `process.env` read inside the agent's
 * runtime modules (WS33 audit gate 3 — `agentik/no-process-env-outside-env-file`).
 * Required keys throw on `loadEnv()` if unset, so unit tests that never
 * touch env stay green; runtime callers fail-fast with a clear schema
 * error pointing at the missing field.
 *
 * Distinct from the sibling specialists (email-manager / briefing) which
 * use a lazy-getter pattern. The research template uses zod up-front
 * because (a) §14 of CLAUDE.md adds new flavor-specific env keys over
 * time and zod gives us one place to widen, and (b) `loadEnv()` is
 * dependency-injectable so tests can supply a synthetic `raw` instead
 * of mutating `process.env`.
 */

import { z } from 'zod';

const EnvSchema = z.object({
  AGENT_ID: z.string().min(1, 'AGENT_ID is required'),
  AGENT_NAME: z.string().min(1, 'AGENT_NAME is required'),
  TENANT_ID: z.string().min(1, 'TENANT_ID is required'),
  HUB_BASE_URL: z.string().url('HUB_BASE_URL must be a URL'),
  HUB_AGENT_TOKEN: z.string().min(1, 'HUB_AGENT_TOKEN is required'),
  PORT: z.coerce.number().int().positive().default(4003),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SANDBOX_CHECK_SKIP: z
    .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false')])
    .optional(),
  // Memory substrate — required when consolidate-memories skill is active.
  DATABASE_URL: z.string().url().optional(),
  EMBEDDER_BASE_URL: z.string().url().optional(),
  EMBEDDER_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse a raw env block (defaults to `process.env`) into a validated `Env`.
 * Throws `ZodError` with a flattened message listing every missing /
 * malformed field — never a partial object.
 */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`env validation failed: ${issues}`);
  }
  return parsed.data;
}
