#!/usr/bin/env node
/**
 * WS33 audit gate 7 — `.env.example` ↔ env-getter drift.
 *
 * For each `.env.example` file at known paths, parse the keys.
 * For each canonical env-getter file (or env.ts), scrape `process.env[...]`
 * reads. Assert the sets match.
 *
 * Drift directions:
 *   - in .env.example but NOT read anywhere → dead docs
 *   - read but NOT in .env.example → silent production landmine
 *
 * Repo-specific config in `.env-drift.json`:
 *   {
 *     "checks": [
 *       {
 *         "envExample": "apps/hub-ui/.env.example",
 *         "getters": [
 *           "apps/hub-ui/src/lib/tenant.ts",
 *           "apps/hub-ui/src/lib/sources/factory.ts"
 *         ],
 *         "ignoreKeys": ["NODE_ENV", "NEXT_PHASE"],
 *         "direction": "both"
 *       }
 *     ]
 *   }
 *
 * `direction` options:
 *   - "both" (default) — fail on either drift direction.
 *   - "silent-landmines-only" — only fail on "read in code but not
 *     in .env.example". Use this for workspace-wide .env.example files
 *     that document keys read in OTHER repos (e.g. studio root which
 *     documents AGENTMAIL_API_KEY etc. read by channel adapters).
 *
 * Run from repo root: `node scripts/validate-env-drift.mjs`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const CONFIG_PATH = resolve(REPO_ROOT, '.env-drift.json');

function red(s) {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s) {
  return `\x1b[32m${s}\x1b[0m`;
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.log(green('No .env-drift.json — gate 7 skipped.'));
    process.exit(0);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function parseEnvExample(path) {
  if (!existsSync(path)) return new Set();
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const keys = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function parseGetterFile(path) {
  if (!existsSync(path)) return new Set();
  const src = readFileSync(path, 'utf8');
  const keys = new Set();
  // Match `process.env['KEY']`, `process.env["KEY"]`, `process.env.KEY`
  const re = /process\.env\s*(?:\.([A-Z_][A-Z0-9_]*)\b|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    keys.add(match[1] ?? match[2]);
  }
  return keys;
}

function main() {
  const config = loadConfig();
  let failed = false;

  for (const check of config.checks ?? []) {
    const envExamplePath = resolve(REPO_ROOT, check.envExample);
    const documented = parseEnvExample(envExamplePath);
    const used = new Set();
    for (const getterPath of check.getters ?? []) {
      const fullPath = resolve(REPO_ROOT, getterPath);
      for (const key of parseGetterFile(fullPath)) used.add(key);
    }
    const ignore = new Set(check.ignoreKeys ?? []);

    const direction = check.direction ?? 'both';
    const onlyInExample = [...documented].filter((k) => !used.has(k) && !ignore.has(k));
    const onlyInGetters = [...used].filter((k) => !documented.has(k) && !ignore.has(k));

    const checkOnlyInExample = direction === 'both';
    const hasFailure = onlyInGetters.length > 0 || (checkOnlyInExample && onlyInExample.length > 0);

    if (hasFailure) {
      failed = true;
      console.error(red(`AUDIT GATE 7 FAILED for ${check.envExample}:`));
      if (onlyInGetters.length > 0) {
        console.error(red(`  Used in code but NOT in .env.example (silent landmine):`));
        for (const k of onlyInGetters) console.error(`    - ${k}`);
      }
      if (checkOnlyInExample && onlyInExample.length > 0) {
        console.error(red(`  In .env.example but NOT read in code (dead docs):`));
        for (const k of onlyInExample) console.error(`    - ${k}`);
      }
    }
  }

  if (failed) process.exit(1);
  console.log(green(`Audit gate 7 OK — env drift checks pass for ${config.checks?.length ?? 0} target(s).`));
}

main();
