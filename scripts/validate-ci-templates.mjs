#!/usr/bin/env node
/**
 * WS33 audit gate 8 — CI-template byte-parity.
 *
 * Asserts that selected CI / config files match the canonical hashes
 * recorded in `.ci-template-hashes.json`. The canonical hashes are
 * pinned by hand; when a template is intentionally updated, the
 * hash is re-recorded as part of the same PR.
 *
 * Gates:
 *   - `.github/workflows/ci.yml` security job (extracted as YAML
 *     fragment by the `securityJobOnly` flag — workflows can diverge
 *     in their `build` job without breaking parity).
 *   - `.github/dependabot.yml` (whole file).
 *
 * Config file `.ci-template-hashes.json`:
 *   {
 *     "files": [
 *       {
 *         "path": ".github/dependabot.yml",
 *         "sha256": "abc...",
 *         "purpose": "Dependabot canonical config — PR-I"
 *       }
 *     ]
 *   }
 *
 * Run from repo root: `node scripts/validate-ci-templates.mjs`.
 * To refresh hashes after an intentional change:
 *   `node scripts/validate-ci-templates.mjs --update`
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const HASHES_PATH = resolve(REPO_ROOT, '.ci-template-hashes.json');

function red(s) {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s) {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s) {
  return `\x1b[33m${s}\x1b[0m`;
}

function loadHashes() {
  if (!existsSync(HASHES_PATH)) {
    console.log(yellow('No .ci-template-hashes.json — gate 8 skipped. Create one with `--update`.'));
    process.exit(0);
  }
  return JSON.parse(readFileSync(HASHES_PATH, 'utf8'));
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Extract the `security:` job text from a workflow YAML by simple
 * indentation-based scan. This is purposefully NOT a YAML parser — we
 * want byte-level diff sensitivity, only the slice does need to track
 * job boundaries.
 */
function extractSecurityJob(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const out = [];
  let inJob = false;
  for (const line of lines) {
    if (/^\s{2}security:/.test(line)) {
      inJob = true;
      out.push(line);
      continue;
    }
    if (inJob) {
      // Stop on the next top-level job (two-space indent + `<name>:` + EOL).
      if (/^\s{2}[a-z][a-z0-9_-]*:\s*$/.test(line) && !/^\s{2}security:/.test(line)) break;
      out.push(line);
    }
  }
  return out.join('\n');
}

/**
 * Read the target file and normalise line endings (CRLF -> LF) before hashing.
 * Windows checkouts present CRLF on disk; Linux CI runners present LF for the
 * same git blob. The byte-parity contract is on the LF-normalised form so that
 * a hash recorded on one platform matches every other platform. `extractSecurityJob`
 * already normalises via split/join; this completes the contract for whole-file
 * comparisons.
 */
function readTarget(entry) {
  const path = resolve(REPO_ROOT, entry.path);
  if (!existsSync(path)) {
    return { ok: false, reason: 'file_missing', actual: null };
  }
  const buf = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  if (entry.securityJobOnly === true) {
    const slice = extractSecurityJob(buf);
    return { ok: true, actual: sha256(slice), slice };
  }
  return { ok: true, actual: sha256(buf) };
}

function update() {
  const cfg = existsSync(HASHES_PATH) ? loadHashes() : { files: [] };
  for (const entry of cfg.files) {
    const { ok, actual } = readTarget(entry);
    if (!ok) {
      console.error(red(`Cannot hash ${entry.path}: file_missing`));
      continue;
    }
    if (entry.sha256 !== actual) {
      console.log(yellow(`Updating ${entry.path}: ${entry.sha256?.slice(0, 12) ?? '<new>'} → ${actual.slice(0, 12)}`));
      entry.sha256 = actual;
    }
  }
  writeFileSync(HASHES_PATH, JSON.stringify(cfg, null, 2) + '\n');
  console.log(green('Hashes refreshed.'));
}

function check() {
  const cfg = loadHashes();
  let failed = false;
  for (const entry of cfg.files) {
    const { ok, reason, actual } = readTarget(entry);
    if (!ok) {
      console.error(red(`AUDIT GATE 8 FAILED — ${entry.path}: ${reason}`));
      failed = true;
      continue;
    }
    if (actual !== entry.sha256) {
      console.error(red(`AUDIT GATE 8 FAILED — ${entry.path} hash drift:`));
      console.error(`  expected: ${entry.sha256}`);
      console.error(`  actual:   ${actual}`);
      console.error(yellow(`  Purpose: ${entry.purpose}`));
      console.error(
        yellow('  If this change is intentional, run `node scripts/validate-ci-templates.mjs --update`.'),
      );
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(green(`Audit gate 8 OK — ${cfg.files.length} CI-template file(s) match canonical hashes.`));
}

const arg = process.argv[2];
if (arg === '--update') {
  update();
} else {
  check();
}
