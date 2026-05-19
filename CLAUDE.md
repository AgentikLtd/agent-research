# Module: agent-research

## Scope

Research specialist agent template — first flavor: **Genesys Cloud research**. Aggregates and synthesises information from arbitrary research sources (HTTP APIs, MCP servers, knowledge corpora) into structured research outputs. PRD §4.6 (research-agent surface).

The repo is designed as a **template** — the Genesys flavor is the seed, and the §14 recipe below explains how to fork in a new flavor (e.g. legal-research, finance-research) without forking the repo itself.

DOES NOT crawl the open web unrestricted — every fetch must be on a per-tenant allowlist. DOES NOT cross tenant boundaries. DOES NOT call LLM providers directly — all completions go through the studio hub's `/api/llm/send`.

## Public interface

A2A server endpoints (port `4003`):
- `POST /a2a` — JSON-RPC 2.0 (architecture's A2A protocol from `@agentik/shared-types/a2a`)
- `GET /health`
- `GET /metrics`

Outbound A2A calls (initially):
- `agent-email-manager` (deliver a research brief — calls the `draft-email` skill, NOT a direct send).

## Dependencies

- A2A + LLM-gateway types — **vendored** under `src/contracts.ts` (mirrors `agent-briefing`'s standalone pattern). NOT a workspace dep. Sync at every `@agentik/shared-types` upgrade; see `src/contracts.ts` §Update log.
- `@anthropic-ai/sdk` (typing only — actual completions are proxied through the studio hub's LLM gateway).
- HTTP fetch (research sources) — all calls go through the studio's egress allowlist; each adapter follows the workspace `harden-http-adapter` checklist.
- OpenTelemetry (OTLP HTTP exporter for the studio's collector).

## Conventions

- Each **research source** lives as a hardened HTTP adapter under `src/sources/`. Zod-validated bodies, upstream body in errors, URL-mock anchoring, `.env.example` parity.
- Each **skill** lives as `.md` under `skills/` (procedural memory) plus optional `.ts` under `src/skills/` (deterministic implementations).
- The **manifest.yaml** declares skills, sources, output channels, budget caps. Validated locally with `node ../../scripts/validate-manifest.mjs` until shared-types is npm-published.
- Port `4003` is fixed (avoids hub `3000`, email-manager `4001`, briefing `4002`).
- Node `22`, TS `5`, pnpm `9.14.4`. Vitest for unit + integration tests. Evals live under `test/evals/` and run via `pnpm eval`.

## §14 Template extensibility — how to add a new flavor

This repo is a **template**, not a single agent. The Genesys-cloud flavor is the seed. To add a new flavor (e.g. `legal-research`, `finance-research`) WITHOUT forking the repo:

1. **Add a sources subdirectory** under `src/sources/<flavor>/` — each source is one hardened HTTP adapter (zod-validated, upstream-body-in-error, URL-mock anchored).
2. **Add a prompts subdirectory** under `src/prompts/<flavor>/` — at minimum, a system-prompt + a synthesis-prompt per skill.
3. **Add skill definitions** under `skills/<flavor>/*.md` (procedural memory) — and matching deterministic implementations under `src/skills/<flavor>/*.ts` only when the skill has a non-LLM kernel.
4. **Extend manifest.yaml** with a new `flavors:` entry naming the flavor + the sources/prompts/skills paths it activates.
5. **Add an eval suite** under `test/evals/<flavor>/` — at minimum 10 tasks with a baseline scorecard. ADR-0008 (eval-driven quality required per agent) is binding.
6. **Add `.env.example` entries** for any flavor-specific credentials — and verify with `pnpm run validate-egress` (when wired in Phase 6).
7. **Open a PR** with the new flavor isolated to its own subdirectory under each of (sources / prompts / skills / evals) — no cross-flavor edits unless the manifest schema itself needs widening.

Flavors are **co-tenanted at runtime** — a tenant enables which flavors it wants via the install saga, and the agent boots only the activated flavor sets.

## Common tasks

- Add a research source → write the hardened HTTP adapter under `src/sources/<flavor>/`, run `harden-http-adapter` skill before PR.
- Add a skill → workspace `add-skill-to-agent` skill (will need a flavor-aware adaptation in Phase 6).
- Validate manifest after edits → `node ../../scripts/validate-manifest.mjs`.
- Run dev: `pnpm start` (after Phase 6 lands `src/index.ts`).
- Run evals: `pnpm eval`.

## Drift risks (template-specific)

- **Cross-flavor pollution.** A skill in flavor A should NEVER reach into flavor B's prompts/sources. The CI rule is enforced by directory-scoped lint — keep flavor subdirectories pure.
- **Manifest-schema drift.** Adding a flavor often tempts the contributor to widen the manifest schema; that change MUST go through `shared-types` (with a coordinated PR via `cross-repo-reviewer`), not via a local schema override.
- **Egress allowlist drift.** New sources mean new domains. The studio's egress allowlist + `.env.example` MUST be updated in the same PR — otherwise the saga will deploy a tenant that can't reach the new source.
- **Prompt-drift across flavors.** Don't share prompts across flavors via a shared module; if two flavors converge on a common system prompt, that's a signal to extract a *base* prompt the flavors compose, not a shared mutable file.
- **CRLF line endings in CI templates.** Memory.md 2026-05-14 — Windows-recorded hashes vs Linux checkout. If we ever vendor `.ci-template-hashes.json`, normalise to LF on write.

## Boundaries

- DOES NOT call LLM providers directly. Use the hub's `/api/llm/send` (via the LLM client in `src/llm/` — Phase 6).
- DOES NOT call AgentMail directly. Delivery is via `agent-email-manager` A2A.
- DOES NOT cross tenant boundaries. Every adapter receives a `tenant_id` and every span/log/audit carries it.
- DOES NOT mutate shared-types. Schema changes go via `cross-repo-reviewer`.

## Files to load for context

- `../../docs/cookbook.md` — workspace cookbook (topic-organised index of patterns).
- `../../docs/memory.md` — workspace chronological ledger of lessons.
- `../agent-briefing/CLAUDE.md` — sibling specialist; reference for the canonical specialist-agent shape.
- The skill(s) you're editing under `skills/` + `src/skills/`.
- `src/contracts.ts` (vendored A2A + gateway slices) instead of `@agentik/shared-types/*`.
- `../docs/prd.md` §4.6 (research-agent scope) and `../docs/architecture.md` Appendix D (manifest schema).

## Files NOT to load

- Other agents' source (consume vendored slices in `src/contracts.ts` only).
- Studio's source.
- `node_modules/`, `dist/`, `.turbo/`, `coverage/`.
- `.env*` (except `.env.example`).
- `*.tsbuildinfo`.

## Recent ADRs

- ADR-0001 — LLM provider abstraction (consumed via studio gateway).
- ADR-0002 — Multi-repo strategy (`studio` central container).
- ADR-0007 — Knowledge Sources as per-agent RAG corpus (research agent will be the first heavy consumer).
- ADR-0008 — Eval-driven quality required per agent (binding for every flavor).
- ADR-0010 — Concierge with separate Verifier subagent (Verifier consumes this agent's eval scorecards).
- ADR-0011 — Feedback loop closes to eval suite.
- ADR-0012 — Filesystem sandbox commitment (boot-time `sandbox-check`).
- ADR-0013 — Runtime image versioning + upgrade strategy.

## Status (refresh date in-place when editing)

- **Phase 1 (scaffold-only)** — 2026-05-19: package.json, configs, Dockerfile, CI workflows, CLAUDE.md committed. NO source files yet; Phase 6 lands `src/index.ts`, manifest.yaml, the Genesys-flavor adapters, and the eval suite.

## Open issues / blockers

- Manifest CI validation step deferred to Phase 6 (validator script lives under workspace `scripts/validate-manifest.mjs` and is invoked locally; CI hook still TODO).
- Audit-gates CI job references `scripts/audit-prod.mjs`, `scripts/validate-env-drift.mjs`, `scripts/validate-ci-templates.mjs` which are NOT vendored yet — Phase 2 work copies these from the briefing repo.
