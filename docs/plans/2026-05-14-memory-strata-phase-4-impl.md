# Phase 4 — Production Strata Implementation Plan

> **For agentic workers:** This is a **roadmap plan** covering 9 PRs across multiple weeks. Each PR below gets its own step-by-step implementation plan (`docs/plans/YYYY-MM-DD-memory-strata-phase-4-pr-N-*.md`) authored when the PR is picked up, following the same convention as Phase 3C. Use superpowers:subagent-driven-development to execute each per-PR plan.

**Goal:** Build a fully functional Strata memory system — Levels 1-3 of the progressive-enhancement path (hot tier files + map writer + Observer + BM25 indexer + Retrieval Orchestrator) — and run a head-to-head benchmark against Mastra OM on LongMemEval-S using Mastra's published evaluation protocol.

**Architecture:** Plugin-per-component with hook-bus-only communication. Orchestrator is provider-agnostic: a single client invokes `llm:call:*` services and lets whichever `@ax/llm-*` plugin is registered satisfy it. memsearch's BM25 path is ported to TypeScript (port-vs-sidecar decision is settled in this plan — port).

**Tech Stack:** TypeScript, vitest, SQLite FTS5 (via `better-sqlite3`), Anthropic / xAI / OpenAI SDKs (each behind a thin `@ax/llm-*` plugin), no Python sidecar, no vector index, no LLM reranker.

---

## Background

This phase builds on the Phase 3B/3C spike outcomes:

- **Phase 3B (PR #66):** Vectors decided OUT on LongMemEval-S. BM25-only beat BM25+dense+RRF by 9 points. LLM reranker also lost by 2.4 points to BM25-only. Both move to conditional Levels 6/7.
- **Phase 3C (PR #68):** c137-style Retrieval Orchestrator + LLM-rewritten map beat BM25-only by 7.6pp accuracy / 14.2pp recall@5 at n=500. Architecture validated. Latency follow-up showed direct xAI runs Grok 4.1 Fast at p50 ~400ms, viable as a default retrieval path.
- **Housekeeping (post-merge, 2026-05-14):** Design doc § Retriever updated to reflect "BM25 from memsearch + map/orchestrator from c137, no dense/RRF" composition.

The design has been bench-validated component by component; Phase 4 is the production wire-in plus a head-to-head benchmark against Mastra OM, which published its protocol and code openly (https://mastra.ai/research/observational-memory; https://github.com/mastra-ai/mastra/tree/main/explorations/longmemeval).

**Reference docs:**
- Strata design: `docs/plans/memory-strata-design.md` (especially § Adjustments to this design, § "Retrieval Orchestration", § Evaluation Plan, § Progressive Enhancement Path)
- Phase 3C report: `docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md`
- Phase 3B (vectors) report: `docs/plans/2026-05-13-memory-strata-vector-spike-report.md`

---

## Invariants

These are non-negotiable across every Phase 4 PR. They distill the rules CLAUDE.md sets out plus reviewer gaps from Phases 3A/3B/3C. Each PR's per-step plan must enumerate which invariants it touches in the PR description.

- **I1 — No cross-plugin imports.** Plugins talk through hook bus only. Will be enforced by ESLint once scaffolded.
- **I2 — No half-wired plugins.** Each PR's plugin lands fully registered, fully tested, and reachable from the canary acceptance test. No "wire later" PRs.
- **I3 — Capabilities minimized.** Every plugin declares its filesystem paths, network reach, env access, and process spawn explicitly. Strata's plugin gets read/write to a workspace-scoped memory directory and nothing else.
- **I4 — One source of truth per concept.** No state about a memory document lives in two plugins. The filesystem is the source; SQLite FTS5 is a derived index that can be rebuilt from disk.
- **I5 — Bench-driven decisions.** Architecture changes require numbers. Vectors/rerankers do not return without a re-spike that contradicts Phase 3B/3C.
- **I6 — Provider-agnostic orchestrator.** The Retrieval Orchestrator never imports a provider SDK directly; it invokes `llm:call:*` via the hook bus. Same rule for the Observer.
- **I7 — Body-cap tenet preserved in production.** Production retrieval respects `MAX_INJECTED_BODY_CHARS = 2000` and summary-first injection. The bench harness may toggle this for the literature comparison; the production plugin must not.
- **I8 — Untrusted content stays untrusted.** Memory documents are author-controlled but may include user-provided text. Sanitize at injection boundaries; never execute map content as code; treat all `<load doc="...">` paths through a safePath check.
- **I9 — Benchmark continuity.** Every component-shipping PR (PR 6, 7, 8, 9) ends with a bench run that produces a numbered Δ vs the prior run. The headline is PR 9's run; earlier runs catch regressions early.

---

## PR Sequence (9 PRs in 2 rounds)

The two rounds are temporally distinct: Round 1 lays plumbing and establishes a baseline number before any Strata production code exists; Round 2 builds the components and re-benches at each major step.

### Round 1: Plumbing + Baseline

#### PR 1 — `@ax/llm-xai` plugin

**Branch:** `phase-4-pr1-llm-xai`
**Estimated effort:** 1 day

**Scope:**
- New package `packages/llm-xai/` mirroring `packages/llm-anthropic/` shape.
- Registers `llm:call:xai` service hook returning the same `LlmCallOutput` shape.
- Uses direct `https://api.x.ai/v1` endpoint with OpenAI-compatible chat completions API.
- Reads `XAI_API_KEY` from env; refuses to init without one.
- Same transient retry + timeout posture as `llm-anthropic`.
- `models:list-supported` returns at minimum `grok-4-fast-non-reasoning`, `grok-4-fast-reasoning`, `grok-4-3`.

**Acceptance test:**
- Loads via the kind dev preset.
- Vitest: with a stubbed client factory, a `llm:call:xai` invocation returns the expected `LlmCallOutput`.
- Canary: a one-shot bus call against the live API produces a non-empty text completion (gated behind `BENCH_LIVE=1`).

**Dependencies:** none.

**Invariants engaged:** I1, I2, I3 (network → api.x.ai only).

---

#### PR 2 — `@ax/llm-openai` plugin

**Branch:** `phase-4-pr2-llm-openai`
**Estimated effort:** 1 day

**Scope:**
- New package `packages/llm-openai/` mirroring `llm-anthropic`.
- Registers `llm:call:openai` service hook.
- Endpoint `https://api.openai.com/v1`.
- `models:list-supported` includes `gpt-4o`, `gpt-4o-mini`, `gpt-5-mini` (per Mastra's published benchmark, gpt-4o is the LongMemEval-S official agent and gpt-5-mini holds the current record).
- Reads `OPENAI_API_KEY` from env.

**Acceptance test:** same shape as PR 1.

**Dependencies:** PR 1 lands the llm-* plugin shape; this one mirrors it.

**Invariants engaged:** I1, I2, I3.

---

#### PR 3 — Bench Mastra-protocol extensions

**Branch:** `phase-4-pr3-bench-mastra-protocol`
**Estimated effort:** 2-3 days

**Scope:**
- **Vendor LongMemEval's official per-question judge prompts** into `packages/memory-strata/test/bench/longmemeval-judge-prompts.json`. These prompts ship with the dataset (per Mastra's protocol page) and are needed for an apples-to-apples comparison. License: research, same as the dataset itself.
- **Agent client factory** that takes a model name and resolves to the right `@ax/llm-*` plugin via the bus. Replaces the current direct-SDK agent clients in `bench/agent.ts`.
- **Judge client factory** doing the same for the judge model.
- **gpt-4o agent + gpt-4o judge** as the new default for the Mastra-comparable bench (preserves Sonnet 4.6 + Grok-judge as an opt-in for continuity with Phase 3C numbers).
- **Per-category scoring:** Report aggregates LongMemEval's 6 categories (single-session-user, single-session-preference, single-session-assistant, multi-session, knowledge-update, temporal-reasoning) with an unweighted-average headline matching Mastra's protocol.
- **Body-cap toggle:** `--full-body` CLI flag relaxes `MAX_INJECTED_BODY_CHARS` to allow Mastra-style full-session injection. Off by default (preserves Strata's production tenet for the default run).
- **CLI flag `--protocol mastra|strata`** wires the above into a single switch.

**Acceptance test:**
- Vitest: per-category aggregator produces the expected unweighted avg on a synthetic result set.
- Vitest: judge prompt loader handles all 500 questions without missing entries.
- Smoke: 10-question run with `--protocol mastra --model gpt-4o --judge gpt-4o` completes and writes a per-category breakdown.

**Dependencies:** PR 1 (xai), PR 2 (openai).

**Invariants engaged:** I7 (default off), I9 (this is the bench plumbing that makes I9 possible).

---

#### PR 4 — Baseline bench run #1

**Branch:** `phase-4-pr4-baseline-bench-run`
**Estimated effort:** 1 day (mostly run time + cost cap discipline)

**Scope:**
- Run the Phase 3C retrieval path (Config E with Grok orchestrator + LLM-rewritten map) under the Mastra protocol (gpt-4o agent + gpt-4o judge + per-category scoring + body cap on).
- Run the same path with `--full-body` for an "unconstrained" baseline.
- Optionally run Mastra OM's runner against the same haystack sessions using their semantic-recall/combined memory configs, producing a head-to-head row.
- Write `docs/plans/2026-05-DD-memory-strata-phase-4-baseline-bench.md` with the numbers, per-category breakdown, and the Δ vs Mastra's published 84.23% (gpt-4o) / 94.87% (gpt-5-mini).

**Acceptance test:**
- Report file exists with all 6 category rows + unweighted headline.
- Cost stays under the per-run cap (initially $50; tune based on PR 3's smoke).

**Dependencies:** PR 3.

**Headline outcome:** establishes the **floor** number for Phase 4. If Strata-as-Phase-3C-built is already at 50%+ under Mastra's protocol, that's encouraging; if it's at 20%+ even under `--full-body`, retrieval isn't the bottleneck and Phase 4 needs to focus on the Observer.

**Invariants engaged:** I5, I9.

---

### Round 2: Build Strata

#### PR 5 — `@ax/memory-strata` plugin scaffold

**Branch:** `phase-4-pr5-strata-scaffold`
**Estimated effort:** 1-2 days

**Scope:**
- New package `packages/memory-strata/` (the production plugin; lives alongside the existing `packages/memory-strata/` bench-only files).
  - **Note:** the existing `packages/memory-strata/test/bench/` infrastructure stays in place. This PR adds `src/` to that package. The bench harness moves to `packages/memory-strata-bench/` if naming collides; decision deferred to per-PR plan.
- Plugin manifest declaring registered hooks (none yet — scaffold only), called hooks (`memory:hot:read`, `memory:hot:write`, `memory:map:write`, `memory:observer:run`, `memory:retrieve`, `llm:call:*` for orchestrator and observer), subscriptions (turn events for Observer).
- Workspace directory layout: `<workspace>/.strata/docs/{entities,knowledge,episodes,procedures}/` and `<workspace>/.strata/system/`. Creation logic + safePath enforcement.
- Canary acceptance test that loads the plugin into the kind dev preset and verifies the directory layout is created on first run.

**Acceptance test:**
- Plugin loads in kind dev preset; canary test passes.
- Directory layout exists post-load.
- All declared hooks register without error (even though they're no-ops at this stage).

**Dependencies:** PR 1, 2 (so the hook bus already has llm:call:* registered when this lands).

**Invariants engaged:** I1, I2, I3, I8 (safePath).

**Half-wired window:** Opens with this PR. Closes with PR 9. The scaffold is intentionally a no-op until later PRs fill in behavior; the canary acceptance test gates "no-op but reachable."

---

#### PR 6 — Hot tier files + map writer (Level 1a)

**Branch:** `phase-4-pr6-hot-tier-map-writer`
**Estimated effort:** 2-3 days

**Scope:**
- File system layout for `system/agent.md`, `system/user.md`, `system/session.md`, `system/recent.md`, `system/map.md`.
- `memory:hot:read` service hook returning all five concatenated with token-budget checks (default ~3500, hard cap 5000).
- `memory:hot:write` service hook for updating any of the four writable files (not `map.md` — that's regenerated).
- `memory:map:write` service hook that regenerates `system/map.md` from the directory tree:
  - Walk `<workspace>/.strata/docs/`
  - For each `.md`, read frontmatter `summary` field
  - Group by category, sort within category by slug
  - Emit `# Memory Map\n## <category>/\n- <slug>: <summary>` per the bench's `map.ts` convention
  - Soft cap 2k tokens, hard cap 3k (per design)
- File watcher (debounced) that triggers `memory:map:write` whenever a doc under `docs/` changes.

**Acceptance test:**
- Round-trip: write 10 docs in `entities/`, observe `map.md` regenerates with 10 lines under `## entities/`.
- Token budget: a hot-tier read that would exceed 5000 tokens triggers an error (or a compression hook; decide in per-PR plan).
- safePath: `memory:hot:write` rejects paths outside `<workspace>/.strata/`.

**Dependencies:** PR 5.

**Invariants engaged:** I3, I4 (filesystem is truth, map is derived), I8.

**Half-wired window:** still open — the hot tier is now produced but nothing reads it yet.

---

#### PR 7 — Observer (Level 1b)

**Branch:** `phase-4-pr7-observer`
**Estimated effort:** 2-3 days

**Scope:**
- New plugin component subscribing to conversation turn hooks (`thread:turn:complete` or equivalent — check current name).
- Extraction prompt sent via `llm:call:*` (configurable model; default `gpt-4o-mini` for cost, with `grok-4-fast-non-reasoning` as alternate). Per the design's Dual-Sourcing Rule: user-originated content gets full confidence; assistant-originated content gets a 0.5 discount and requires corroboration before promotion.
- Candidate observations write to `<workspace>/.strata/inbox/` as small JSON files keyed by content hash.
- Inbox does **not** auto-promote to canonical docs in this PR (that's the Consolidator's job, deferred).
- For Phase 4 bench compatibility: a one-shot "process this conversation" command that runs the Observer over a LongMemEval-S haystack and dumps observations into the inbox, mirroring Mastra's ingestion-time Observer pass.

**Bench run #2 attached:**
- Re-run PR 4's protocol but with Observer-produced inbox observations injected alongside the haystack docs (or in place of them, depending on per-PR plan).
- Report attached as a follow-up commit to PR 7's branch before merging.

**Acceptance test:**
- Vitest: synthetic conversation produces expected candidate observations with correct origin tags.
- Smoke: process a 5-session LongMemEval-S haystack; inbox contains plausible observations.
- Bench: per-category accuracy in run #2 vs run #1.

**Dependencies:** PR 5, 6, and PR 1/2 for `llm:call:*`.

**Invariants engaged:** I1, I6 (no direct SDK), I8, I9.

**Half-wired window:** narrower now — Observer produces inbox entries but nothing reads them at retrieval time yet (Phase 3C's bench setup uses raw sessions, not inbox).

---

#### PR 8 — BM25 indexer (Level 2)

**Branch:** `phase-4-pr8-bm25-indexer`
**Estimated effort:** 3-5 days

**Scope:**
- Port memsearch's BM25 path to TypeScript. Decision settled here: **TS port, not Python sidecar.** Rationale: BM25 over FTS5 is a small surface (~200 LoC), the existing `packages/memory-strata-index-sqlite/` already does most of this, and the deploy story stays Node-only.
- Verify or extend `packages/memory-strata-index-sqlite/` to cover memsearch's content-hash incremental indexing — re-index only docs whose body hash changed since last run.
- Frontmatter-scoped indexing: index `title`, `tags`, `summary`, `headers`, and `body` as separate FTS5 columns (per the design's "To keep indices lightweight" section).
- `memory:retrieve` service hook taking `{query, top_k, filters?, mode?}` and returning ranked docs.
- File watcher integration: re-index on doc changes (debounced).
- Backfill command: `pnpm --filter @ax/memory-strata index:rebuild` for cold-start corpora.

**Bench run #3 attached:**
- Re-run with the production indexer replacing the bench's ad-hoc Config A driver.
- Verify the production indexer reproduces (or improves on) Config A's n=500 numbers from Phase 3B.

**Acceptance test:**
- Vitest: incremental index correctly detects body changes via content hash.
- Vitest: FTS5 query returns expected docs for known corpus.
- Bench: production indexer ≈ Config A baseline; not significantly worse.

**Dependencies:** PR 5, 6, 7.

**Invariants engaged:** I3 (DB file scoped to workspace), I4 (index is derived from disk), I5 (numbers must hold).

**Half-wired window:** still open — orchestrator hasn't landed yet to drive the indexer.

---

#### PR 9 — Retrieval Orchestrator plugin (Level 3) + headline bench

**Branch:** `phase-4-pr9-orchestrator`
**Estimated effort:** 3-4 days

**Scope:**
- New plugin component (or sub-plugin within `@ax/memory-strata`; decide in per-PR plan).
- Registers `memory:orchestrate` service hook taking `{query}` and returning `{retrievedDocs, ops, followupNeeded}`.
- Reads `system/map.md` via `memory:hot:read`, sends `(map, query)` to `llm:call:xai` (default model `grok-4-fast-non-reasoning`), parses XML response per the bench's `orchestrator.ts` convention.
- Resolves ops:
  - `<load doc="..."/>` → direct file read from `<workspace>/.strata/docs/`
  - `<load doc="..." section="..."/>` → markdown section extraction (this is the section-attribute support the bench currently parses-but-ignores; here we wire it up)
  - `<fts query="..."/>` → `memory:retrieve` call into the BM25 indexer
  - `<followup needed="true"/>` → set the flag in response; agent decides what to do with it (drill-down via `memory_search` tool)
- Latency budget: p50 ≤ 1500ms end-to-end (orchestrator + ops); p95 ≤ 5000ms. Document budget; alarm in tests if exceeded by 2×.

**Bench run #4 — HEADLINE:**
- Full Phase 4 stack against Mastra protocol on LongMemEval-S n=500.
- Per-category breakdown + unweighted-avg headline.
- Δ vs PR 4 baseline (improvement from each Phase 4 component).
- Δ vs Mastra OM (the head-to-head).
- Write `docs/plans/2026-05-DD-memory-strata-phase-4-headline-bench.md`.
- Update design doc § Evaluation Plan with the result row.

**Acceptance test:**
- Vitest: orchestrator XML parser handles all four op shapes including section attribute.
- Vitest: section-attribute load returns only the named section.
- Bench: headline run completes and produces the report.

**Dependencies:** PR 5, 6, 7, 8. **Closes the half-wired window.**

**Invariants engaged:** I1, I2 (closes window), I5, I6, I7 (production default keeps body cap on), I9.

---

## Decision Points

These are decisions deferred from earlier phases that Phase 4 must settle.

- **memsearch port-vs-sidecar:** **Settled here — TS port.** Rationale above (PR 8 scope). Locks the deploy story to Node-only.
- **Body-cap default in production:** **Settled — cap stays on (`MAX_INJECTED_BODY_CHARS = 2000`).** Bench may toggle for literature comparison; production does not. Invariant I7.
- **Observer model:** **Default to `gpt-4o-mini` initially; switchable per per-PR plan.** Mastra uses `gemini-2.5-flash`; we can't easily match without a `@ax/llm-google` plugin, which is out of scope. Phase 4.1 may add a comparison run with gemini-2.5-flash once that plugin exists.

## Decisions Pending (Gated on Bench Outcomes)

- **Consolidator (Level 4):** Currently excluded from Phase 4. **Gate: PR 9's bench result.**
  - If unweighted accuracy ≥ 70%: ship Phase 4 as-is. Level 4 becomes Phase 5 scope.
  - If 40-60%: revisit immediately. Likely Mastra's Reflector contributes more than expected; consider folding Level 4 into Phase 4 before merging PR 9.
  - If < 40%: deeper investigation needed before shipping. The Observer extraction quality is the most likely culprit (it's the Phase 3C learning manifesting); spike an alternative extraction prompt or model.
- **Promoter (Level 5):** Excluded. Warm-tier optimization with no expected accuracy impact. Defer to Phase 5+.
- **Cross-corpus runs (LoCoMo, internal):** Excluded. Gated on per-question concurrency in the bench loop, which Phase 4 inherits but does not fix.

---

## Open Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Observer extraction quality is load-bearing in a way we under-resource | Med | High | Bench run #2 surfaces this immediately; if Δ is small, spike an alternative prompt or model before continuing |
| memsearch's incremental indexing is more complex than 200 LoC | Med | Med | PR 8 scope can spill into 5-7 days; budget accordingly; sidecar fallback if TS port fights us |
| gpt-4o costs explode across the four bench runs at n=500 | Low | Med | Each run is ~$50; cap stays on the meter; can downgrade judge to gpt-4o-mini if needed for the non-headline runs |
| LongMemEval judge prompts aren't actually public or are gated behind dataset license terms we can't meet | Low | High | Verify in PR 3 first thing; if blocked, write our own per-category judge prompts (less ideal but Mastra-comparable enough) |
| Half-wired window stays open past PR 9 (someone tries to ship a partial Phase 4) | Low | High | Invariant I2 + PR 9 acceptance test gates the close; reviewer enforces |
| `@ax/memory-strata` package name collides with the bench-only package | Med | Low | PR 5 resolves via either renaming the bench package or namespacing under `src/`; decision deferred to per-PR plan |
| Mastra's published numbers can't be reproduced locally | Med | Med | Run their runner side-by-side in PR 4 to verify our floor matches their reported floor before drawing conclusions |

---

## Voice & Tone

Plan docs match existing technical-direct convention (see Phase 3C plan). Reports written for these PRs match the CLAUDE.md voice guide (self-deprecating but competent, jokes about paranoia not about security, plain language first).

---

## Execution Handoff

When ready to start PR 1:

1. Create a worktree under `.claude/worktrees/phase-4-pr1-llm-xai/` per `superpowers:using-git-worktrees`.
2. Author the per-PR implementation plan: `docs/plans/2026-05-DD-memory-strata-phase-4-pr1-llm-xai-impl.md` following the same shape as `2026-05-13-memory-strata-phase-3c-config-d-impl.md` (file structure → tasks with TDD code blocks → commit cadence).
3. Use **superpowers:subagent-driven-development** to execute the per-PR plan.
4. After merge, repeat for PR 2.

Each PR's per-PR plan re-affirms which invariants it engages in its PR description, lists its acceptance test, and links the bench run report if applicable.

If PR 4's baseline number suggests Phase 4 scope is wrong (e.g., Strata's retrieval is fundamentally outclassed by Mastra's no-retrieval append-only approach), pause and reassess before starting Round 2.

---

## Out of Scope (Explicitly)

- Consolidator (Level 4) — gated on PR 9 result
- Promoter / warm tier (Level 5) — deferred
- LLM reranker (Level 6) — decided OUT
- Vector embeddings (Level 7) — decided OUT
- LoCoMo benchmark — gated on per-question concurrency
- Cross-judge sweep (GPT-5 judge as a second check on the headline) — Phase 4.1 if the result is close
- `@ax/llm-google` (for gemini-2.5-flash parity with Mastra's Observer) — Phase 4.1
- Multi-tenant workspace scoping for the memory directory — inherits from `@ax/workspace`; no new Phase 4 work
- UI for browsing/editing memory docs — Phase 5+

If a future PR proposes adding any of the above, it gets a fresh design discussion, not a Phase 4 amendment.
