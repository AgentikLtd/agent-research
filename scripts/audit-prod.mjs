#!/usr/bin/env node
/**
 * WS33 audit gate 6 — `pnpm audit --prod --audit-level=high` clean.
 *
 * Runs `pnpm audit --prod --audit-level=high --json`, parses the result,
 * intersects with `.audit-allowlist.json`, and:
 *   - FAILS on any advisory NOT in the allow-list.
 *   - FAILS on any allow-list entry whose `expires` date has passed.
 *   - Passes when every advisory is either resolved or actively
 *     allow-listed with a future `expires`.
 *
 * Run from repo root: `node scripts/audit-prod.mjs`.
 *
 * Allow-list shape (`.audit-allowlist.json` at repo root):
 *   {
 *     "advisories": [
 *       {
 *         "advisoryId": "GHSA-xxxx-yyyy-zzzz",
 *         "package": "some-pkg",
 *         "severity": "high",
 *         "reason": "Vulnerable code path not reached — dev only",
 *         "expires": "2026-08-14",
 *         "owner": "you@org"
 *       }
 *     ]
 *   }
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const ALLOW_LIST_PATH = resolve(REPO_ROOT, '.audit-allowlist.json');

function red(s) {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s) {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s) {
  return `\x1b[33m${s}\x1b[0m`;
}

function loadAllowList() {
  if (!existsSync(ALLOW_LIST_PATH)) {
    return { advisories: [] };
  }
  return JSON.parse(readFileSync(ALLOW_LIST_PATH, 'utf8'));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function runAudit() {
  const result = spawnSync('pnpm', ['audit', '--prod', '--audit-level=high', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  // pnpm audit exits non-zero when advisories are found. We parse the
  // JSON regardless — the exit code is the trigger, not the verdict.
  const stdout = result.stdout ?? '';
  if (stdout.length === 0) {
    if (result.status === 0) return { advisories: {} };
    throw new Error(`pnpm audit produced no JSON output (exit ${result.status}). stderr: ${result.stderr ?? ''}`);
  }
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`Failed to parse pnpm audit JSON: ${e.message}\nstdout: ${stdout.slice(0, 500)}`);
  }
}

function extractAdvisoryIds(auditOutput) {
  // pnpm audit JSON shape: `{ advisories: { '<id>': { ... }, ... } }`
  const advisories = auditOutput.advisories ?? {};
  return Object.values(advisories).map((adv) => ({
    advisoryId: adv.github_advisory_id ?? adv.cves?.[0] ?? `${adv.module_name}@${adv.id}`,
    githubAdvisoryId: adv.github_advisory_id,
    package: adv.module_name,
    severity: adv.severity,
    title: adv.title,
    url: adv.url,
  }));
}

function main() {
  const allow = loadAllowList();
  const audit = runAudit();
  const advisories = extractAdvisoryIds(audit);
  const today = todayIso();

  // Validate the allow-list itself first.
  const expiredEntries = allow.advisories.filter((entry) => entry.expires < today);
  if (expiredEntries.length > 0) {
    console.error(red('AUDIT ALLOW-LIST ENTRIES EXPIRED:'));
    for (const entry of expiredEntries) {
      console.error(red(`  - ${entry.advisoryId} (${entry.package}) expired ${entry.expires}`));
    }
    console.error(yellow('\nEither resolve the advisory or renew the allow-list entry with a new `expires` date.'));
    process.exit(1);
  }

  // Check advisories against allow-list.
  const allowedIds = new Set(allow.advisories.map((entry) => entry.advisoryId));
  const unallowed = advisories.filter(
    (adv) => !allowedIds.has(adv.advisoryId) && !allowedIds.has(adv.githubAdvisoryId),
  );

  if (unallowed.length > 0) {
    console.error(red(`AUDIT GATE 6 FAILED — ${unallowed.length} new HIGH+ advisory:`));
    for (const adv of unallowed) {
      console.error(red(`  - ${adv.advisoryId} (${adv.package}, ${adv.severity}): ${adv.title}`));
      if (adv.url) console.error(`    ${adv.url}`);
    }
    console.error(
      yellow(
        '\nResolve the vulnerability (preferred) or add to `.audit-allowlist.json` with a justification, owner, and expires date (90 days for High, 30 for Critical).',
      ),
    );
    process.exit(1);
  }

  console.log(green(`Audit gate 6 OK — ${advisories.length} advisory, all allow-listed.`));
}

main();
