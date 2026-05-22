#!/usr/bin/env node
/**
 * eval-models.mjs — operator-run model bake-off for genesys-research.
 *
 * For each model in the shortlist, runs `run-brief` `--runs` times against a
 * deployed tenant (default demo1505), collects each brief's markdown, scores
 * it with an LLM-as-judge call against the 6-dimension rubric, and prints +
 * writes a scorecard (mean + variance per dimension, observed cost per run).
 *
 * This is NOT a CI gate. It does live web-search runs that cost real money and
 * exercise the live tenant. The deterministic suite (test/evals/brief.eval.test.ts)
 * stays the ADR-0008 binding eval.
 *
 * Usage:
 *   HUB_OPERATOR_TOKEN=... OPENROUTER_API_KEY=... \
 *     node scripts/eval-models.mjs --slug=demo1505 --agent-id=<id>
 *
 * Flags:
 *   --slug=<name>        Tenant slug. Default: demo1505.
 *   --agent-id=<id>      REQUIRED (unless --dry-run). genesys-research agent_id.
 *   --models=a,b,c       CSV model slugs. Default: the spec §9 shortlist.
 *   --runs=<n>           Runs per model (consistency check). Default: 3.
 *   --judge-model=<slug> LLM-as-judge model. Default: anthropic/claude-sonnet-4-6.
 *   --hub=<url>          Hub base URL. Default: https://<slug>.studio.agentik.co.uk.
 *   --out=<path>         Scorecard output. Default: scripts/eval-scorecard.md.
 *   --dry-run            Print the plan + estimated scope and exit (no env, no calls).
 *   --help               Print usage and exit.
 *
 * Required env (real run): HUB_OPERATOR_TOKEN (invoke-skill), OPENROUTER_API_KEY (judge).
 */
import { argv, env, exit } from 'node:process';
import { writeFileSync } from 'node:fs';

const DEFAULT_MODELS = [
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-haiku-4-5',
  'minimax/minimax-m2',
  'deepseek/deepseek-v4-flash',
  'google/gemini-3.5-flash',
];

/** 6-dimension scoring rubric — spec §9. Each dimension is scored 1-5. */
const RUBRIC = [
  ['source_diversity', 'Distinct domains; community/practitioner sources present; vendor not dominant.'],
  ['depth_of_analysis', 'Interprets and connects findings into themes vs. flatly aggregating them.'],
  ['opinion', 'Explicit, grounded significant / overhyped / risky / ignore calls.'],
  ['voice', 'Consistent candid-advisor voice; writes with conviction and personality.'],
  ['citation_integrity', 'Every claim cited; sources real and clickable; counts intact.'],
  ['factual_grounding', 'Claims trace to findings; nothing invented; conflicts preserved.'],
];
const PASS_BAR = 4.0; // mean overall to "clear the bar" (spec §9 decision rule).

function parseArgs() {
  const out = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq < 0) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function usage() {
  console.log(`eval-models.mjs — operator-run model bake-off for genesys-research.

Usage:
  HUB_OPERATOR_TOKEN=... OPENROUTER_API_KEY=... \\
    node scripts/eval-models.mjs --slug=demo1505 --agent-id=<id>

Flags:
  --slug=<name>        Tenant slug (default demo1505)
  --agent-id=<id>      REQUIRED unless --dry-run
  --models=a,b,c       CSV model slugs (default: spec §9 shortlist)
  --runs=<n>           Runs per model (default 3)
  --judge-model=<slug> Judge model (default anthropic/claude-sonnet-4-6)
  --hub=<url>          Hub base URL (default https://<slug>.studio.agentik.co.uk)
  --out=<path>         Scorecard path (default scripts/eval-scorecard.md)
  --dry-run            Print the plan and exit
  --help               This message`);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const variance = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
};

const args = parseArgs();
if (args.help) { usage(); exit(0); }

const slug = args.slug ?? 'demo1505';
const models = (args.models ? String(args.models).split(',') : DEFAULT_MODELS).map((s) => s.trim()).filter(Boolean);
const runs = Number(args.runs ?? 3);
const judgeModel = args['judge-model'] ?? 'anthropic/claude-sonnet-4-6';
const hub = (args.hub ?? `https://${slug}.studio.agentik.co.uk`).replace(/\/$/, '');
const outPath = args.out ?? 'scripts/eval-scorecard.md';
const agentId = args['agent-id'];

if (args['dry-run']) {
  console.log('--- eval-models.mjs DRY RUN ---');
  console.log(`tenant:        ${slug}  (${hub})`);
  console.log(`models (${models.length}):  ${models.join(', ')}`);
  console.log(`runs/model:    ${runs}`);
  console.log(`judge model:   ${judgeModel}`);
  console.log(`run-brief calls: ${models.length * runs}  (each = one live web-search pipeline run)`);
  console.log(`judge calls:     ${models.length * runs}  (each = one ${judgeModel} call)`);
  console.log('COST: every run-brief call is a real, billed, multi-search pipeline run');
  console.log('against the live tenant. Reconcile model slugs against the Spec B catalogue');
  console.log('before a real run. No calls were made.');
  exit(0);
}

if (!agentId) { console.error('--agent-id=<id> is required (or use --dry-run)'); usage(); exit(2); }
const operatorToken = env.HUB_OPERATOR_TOKEN;
const openrouterKey = env.OPENROUTER_API_KEY;
if (!operatorToken) { console.error('env HUB_OPERATOR_TOKEN is required'); exit(2); }
if (!openrouterKey) { console.error('env OPENROUTER_API_KEY is required (LLM-as-judge)'); exit(2); }

/** Invoke run-brief on the deployed agent; returns { markdown, citationCount, costGbp }. */
async function runBrief(model) {
  const res = await fetch(`${hub}/api/agents/${agentId}/invoke-skill`, {
    method: 'POST',
    headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ skill: 'run-brief', args: { model, returnMarkdown: true } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`invoke-skill http_${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  // The invoke-skill route may unwrap the JSON-RPC envelope or pass it through —
  // probe the common shapes defensively.
  const result = body?.result?.result ?? body?.result ?? body;
  if (!result || typeof result.markdown !== 'string') {
    throw new Error(`run-brief returned no markdown: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return {
    markdown: result.markdown,
    citationCount: Number(result.citationCount ?? 0),
    costGbp: typeof result.costGbp === 'number' ? result.costGbp : null,
  };
}

/** LLM-as-judge: score one brief 1-5 on each rubric dimension. */
async function judge(markdown) {
  const system = [
    'You are a strict, consistent evaluator of research briefs. Score the brief',
    'below from 1 (poor) to 5 (excellent) on each dimension. Be calibrated and',
    'unsentimental. Output ONLY a JSON object: { "scores": { <dim>: <int 1-5>, ... },',
    '"rationale": "<two sentences>" }. The dimensions and what each means:',
    ...RUBRIC.map(([k, d]) => `- ${k}: ${d}`),
  ].join('\n');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${openrouterKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: judgeModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Brief to score:\n\n${markdown}` },
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`judge http_${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const text = body?.choices?.[0]?.message?.content ?? '';
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error(`judge returned no JSON: ${text.slice(0, 300)}`);
  return JSON.parse(m[0]);
}

const dims = RUBRIC.map(([k]) => k);
const scorecard = [];

for (const model of models) {
  console.error(`\n=== ${model} (${runs} runs) ===`);
  const perDim = Object.fromEntries(dims.map((d) => [d, []]));
  const overalls = [];
  const costs = [];
  let failures = 0;
  for (let i = 0; i < runs; i++) {
    try {
      console.error(`  run ${i + 1}/${runs}: run-brief…`);
      const brief = await runBrief(model);
      if (brief.costGbp !== null) costs.push(brief.costGbp);
      console.error(`  run ${i + 1}/${runs}: judging…`);
      const verdict = await judge(brief.markdown);
      const runScores = [];
      for (const d of dims) {
        const s = Number(verdict?.scores?.[d]);
        if (Number.isFinite(s)) { perDim[d].push(s); runScores.push(s); }
      }
      overalls.push(mean(runScores));
      console.error(`  run ${i + 1}/${runs}: overall ${mean(runScores).toFixed(2)}`);
    } catch (e) {
      failures++;
      console.error(`  run ${i + 1}/${runs}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  scorecard.push({
    model,
    failures,
    overall: mean(overalls),
    overallVar: variance(overalls),
    perDim: Object.fromEntries(dims.map((d) => [d, { mean: mean(perDim[d]), var: variance(perDim[d]) }])),
    meanCostGbp: costs.length ? mean(costs) : null,
  });
}

// --- scorecard ---
const lines = [];
lines.push(`# genesys-research model bake-off — ${new Date().toISOString().slice(0, 10)}`);
lines.push('');
lines.push(`Tenant: ${slug} · runs/model: ${runs} · judge: ${judgeModel}`);
lines.push('');
lines.push(`| Model | Overall (var) | ${dims.join(' | ')} | Cost/run £ | Fails |`);
lines.push(`|---|---|${dims.map(() => '---').join('|')}|---|---|`);
for (const r of scorecard) {
  const cells = dims.map((d) => `${r.perDim[d].mean.toFixed(2)}`);
  lines.push(
    `| ${r.model} | ${r.overall.toFixed(2)} (${r.overallVar.toFixed(2)}) | ${cells.join(' | ')} | ` +
    `${r.meanCostGbp === null ? 'n/a' : r.meanCostGbp.toFixed(4)} | ${r.failures} |`,
  );
}
lines.push('');
const cleared = scorecard
  .filter((r) => r.failures === 0 && r.overall >= PASS_BAR)
  .sort((a, b) => a.overallVar - b.overallVar);
lines.push(
  cleared.length
    ? `**Decision rule (≥ ${PASS_BAR} overall, low variance):** candidates clearing the bar — ` +
      `${cleared.map((r) => `${r.model} (${r.overall.toFixed(2)}, var ${r.overallVar.toFixed(2)})`).join('; ')}. ` +
      `Pick the cheapest of these against the Spec B catalogue price.`
    : `**Decision rule:** no model cleared ${PASS_BAR} overall with zero failures — inspect the table.`,
);

const report = lines.join('\n') + '\n';
writeFileSync(outPath, report);
console.log('\n' + report);
console.log(`scorecard written to ${outPath}`);
exit(0);
