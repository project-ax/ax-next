# `@ax/memory-strata` phase roadmap

**Date:** 2026-05-10. **Owner:** Vinay. **Status:** Phase 1 drafted, Phase 2+ skeletal.

This is the master sequencing doc for Strata. The design doc (`memory-strata-design.md`) covers *what* gets built; this doc covers *when*, *in what order*, and *what triggers each phase*. Phase 1 has its own impl plan (`2026-05-10-memory-strata-phase-1-impl.md`); later phases will get their own plans when triggered.

The Progressive Enhancement Path in the design doc lists Levels 0–6. This roadmap groups levels into shippable phases.

## Phase order at a glance

```
Phase 1  →  Phase 2  →  Phase 3  →  Phase 4  →  Phase 5+
(L0+L1)     (L2+L4)     (eval+L3?)   (L5+L6+KV)   (earned features)
sequential, each phase ships before the next starts
```

Phase 5+ items are *independent of each other* and pulled in by friction, not pre-scheduled.

---

## Phase 1 — Hot tier + Observer

**Levels:** 0 + 1.

**Ships:** `@ax/memory-strata` plugin; `memory/system/{agent,user,session}.md` seeded per agent; Observer subscribes to `chat:end`, writes facts to `memory/inbox/`; sensitive-content gate (regex) before any inbox write; wired into CLI + k8s preset.

**Does NOT ship:** retrieval, Consolidator, `recent.md` regeneration, eval harness, vectors, KV-cache assembly, multi-tenant scoping, Curator-as-patch.

**Trigger:** ready now. Plan: `2026-05-10-memory-strata-phase-1-impl.md`.

**Done when:** the 8-step acceptance criteria in the Phase 1 impl plan all pass against a kind cluster.

---

## Phase 2 — BM25 retrieval + Consolidator + `recent.md`

**Levels:** 2 + 4 + the `recent.md` regeneration described in the design doc.

**Ships:**
- BM25 indexer over the agent's `memory/` tree (SQLite FTS5). NO vector path yet — that's Phase 3's decision.
- Consolidator runs at `chat:end` (or on a debounce): clusters inbox observations by subject, deduplicates against existing docs, applies supersession links, promotes high-confidence (≥0.7) facts from `inbox/` to `docs/`, regenerates `system/recent.md`.
- Memory tool surface for the agent: `memory_search` (returns summaries), `memory_read_section`, `memory_note` (manual save). Summary-first injection at retrieval time.
- **memsearch decision resolved:** port the BM25 + RRF retriever to TypeScript, OR run memsearch as a Python sidecar. This phase forces the decision because it can't ship retrieval without an implementation.

**Trigger:** Phase 1 has been in production long enough for `inbox/` to fill in real workloads (probably 1–2 weeks of dogfooding). The Consolidator design benefits from looking at real inbox data before committing to clustering heuristics.

**Done when:**
- Agent can ask `memory_search("who is John?")` and get summaries from `docs/entities/people/john-doe.md`
- `memory_read_section` drills into a specific `##` header
- `inbox/` no longer grows unbounded (Consolidator runs and clears)
- `system/recent.md` is regenerated and reflects current state
- Two-week soak test in kind cluster shows no memory bloat or runaway LLM costs

**Open at start of Phase 2:** memsearch port-vs-sidecar (resolve in Phase 2's handoff brief).

---

## Phase 3 — Eval harness + vector-vs-no-vector spike — **PARTIAL 2026-05-13** (A/B/C done; Config D queued)

**Levels:** **7 — OUT** (vectors). The c137-revised design (May 2026) renumbered the levels: what the original roadmap called "Level 3 = vectors" is now Level 7. The c137-revised design also added a **Config D (structured / map-only, c137-style)** to the spike configurations; Config D is *not* exercised in this round and is the open work for the follow-up spike. Level 3 in the new numbering is the Retrieval Orchestrator (the engine behind Config D).

**Shipped (A/B/C only):**
- LongMemEval-S harness in `packages/memory-strata/test/bench/` (Phase 3A, PR #65; Phase 3B harness polish in PR #66)
- LoCoMo loader fixed in Phase 3B; not exercised in the binding run (queued as cross-corpus corroboration follow-up — see Phase 5+).
- Internal project-memory eval scaffolded; not exercised in the binding run (synthetic-derived; directional only).
- Three-config head-to-head: BM25-only (A) vs BM25+zerank-2 (B) vs BM25+zembed-1+RRF (C).
- **Decision on vectors (Config C / Level 7): OUT.** On 100-Q LongMemEval-S (Sonnet 4.6 agent, Grok 4.3 judge): A = **22.0%**, B = 19.6%, C = **13.0%**. C loses to A by 9 points — outside the design's ≥5-point binding band (tightened from ≥3 by the c137 prior) by 4 points. B *also* loses to A by 2.4 points, which alters Phase 4's reranker priority (see below). Report: `docs/plans/2026-05-13-memory-strata-vector-spike-report.md`.

**Deferred (Config D + abstention metric):**
- Config D (Retrieval Orchestrator + `system/map.md`, c137-style) was added to the spike configurations after the c137 revision (also 2026-05-13). It needs a per-sample map generator, a cheap-LLM orchestration stage, an XML-op executor, and an abstention-aware judge prompt. Filed as a separate spike; not in PR #66.

**Originally-stated trigger:** Phase 2 retrieval has been running for ≥1 week. The actual binding run happened sooner (Phase 2 had only just shipped) — authorized as a deviation, with the understanding that the public benchmarks are not gated on dogfooding. Internal-corpus runs are queued for when real dogfooded memory data is available.

**Done — confirmed against the original done-when:**
- Benchmarks runnable on demand: `pnpm --filter @ax/memory-strata bench`. ✓
- Head-to-head report committed: `docs/plans/2026-05-13-memory-strata-vector-spike-report.md`. ✓
- Vector decision made + design doc updated to match. ✓ (`docs/plans/memory-strata-design.md` Progressive Enhancement Path Level 3 now reads "OUT".)

---

## Phase 4 — Warm tier + KV-cache assembly (reranker deprioritized)

**Levels:** 5 + KV-cache section of the design doc. (Level 6 reranker deprioritized — see "Trigger" below.)

**Ships:**
- Warm-tier LRU cache (~100 docs in memory) + Promoter for access-pattern optimization
- Cache-aware prompt segmentation per the design doc's "KV Cache Optimization for Strata" section: static persona → slowly-changing system files → recent observations → retrieved snippets → conversation, in a layout that maximizes Anthropic prompt-cache hit rate
- Token-budget overflow enforcement: when hot-tier exceeds 2500-token cap, Consolidator compresses in priority order

**Trigger:** Phase 3 settled the retrieval shape — **BM25-only**, no vectors, no RRF fusion layer. The Phase 3B spike also surfaced that the Level-6 LLM reranker (zerank-2 over truncated bodies) underperformed BM25-only by 2.4 accuracy points and 4.4 recall@5 points on LongMemEval-S, at ~6× the latency. **Level 6 reranker is deprioritized for Phase 4** — no rerank work happens until either (a) a different reranker (different model, different scoring surface) shows promise in a re-spike, or (b) production telemetry shows BM25 recall is the bottleneck (per-Q gold-doc misses concentrated in queries where rerank would help). Phase 4 proceeds with warm-tier + KV-cache only.

Other Phase 4 entry conditions unchanged: (a) when prompt-cache hit rate is measurably below 70% in production, OR (b) when retrieval latency p95 exceeds 200ms.

**Done when:**
- Prompt-cache hit rate ≥80% on the eval corpus
- Retrieval p95 ≤150ms (BM25-only, no reranker)
- Hot-tier overflow test forces compression and verifies oldest `session.md` paragraphs go first

---

## Phase 5+ — Earned features (independent, friction-driven)

These are not sequenced. Each ships when its friction is concretely present, per the v2 plugin philosophy ("no speculative plugins"). Re-trigger conditions are stated so we don't relitigate.

| Feature | Trigger to start | Notes |
|---|---|---|
| **Multi-tenant memory scoping** | When ax-next opens to multi-tenant beyond per-agent isolation, OR when user requests memory shared across their own agents | Workspace isolation is sufficient until then. Likely adds a `scope` frontmatter field + retrieval filter. |
| **Curator-as-patch pipeline** | (a) User-facing memory governance is requested, OR (b) we see real bad-observation incidents, OR (c) cross-agent memory sharing lands | Design doc §"Future: Curator-as-Patch Pipeline" specifies the target shape. |
| **Bring-your-own embedding provider** | Phase 3 dropped vectors; this lane is dormant. Reopen only if Level 3 is re-spiked and lands "IN". | Pluggable embedding hook. |
| **Reranker (Level 6) re-spike** | (a) Production BM25 telemetry shows recall is the gating issue (lots of correct-doc-not-in-top-10 cases), AND (b) a candidate reranker (different model, different scoring surface — e.g., score against full bodies, or use a different family) is available to evaluate against `zerank-2`-over-truncated-bodies. The Phase 3B run found `zerank-2` over 2000-char body excerpts lost to BM25-only by 2.4 points on LongMemEval-S. Don't re-litigate without new evidence. | Use the existing `test/bench/` harness; report into the same dated-report shape. |
| **Memory replay / time-travel queries** | When a user asks "what did the agent know on date X?" | Frontmatter already has `valid_from`/`valid_to`/`event_time`/`recorded_at` from Phase 1 design — the data is captured; only the query layer is missing. |
| **Cross-agent memory sharing** | Explicit user request only | Adds a real safety surface; the Curator pipeline is likely a prerequisite. |

---

## Sequencing rules

- **Phases 1–4 are strictly sequential.** Each one's acceptance criteria must pass before the next phase's plan is written.
- **No half-wired phases.** Each phase wires its new functionality into CLI + k8s preset in the same PR (CLAUDE.md invariant 3).
- **Boundary review on every new hook.** Especially relevant in Phase 2 (Consolidator + memory-tool surface) and Phase 4 (KV-cache assembly may add hooks).
- **Friction-driven for Phase 5+.** No work starts on Phase 5+ items until their trigger conditions are met. If a Phase 5+ item creeps into a Phase 2/3/4 plan, push back.
- **The "is this load-bearing at MVP?" check** runs at the start of every phase plan, per `feedback_yagni_check_in_plans.md`.

## Risks / open questions tracked here, not in phase plans

- **Observer cost at scale.** Phase 1 uses the agent's primary model for extraction. If observer cost becomes a meaningful share of agent cost, Phase 2 should add a configurable smaller-model option (haiku-class). Track Observer LLM-token spend during the Phase 1 dogfooding window.
- **Memory growth pathologies.** Long-running agents may accumulate inbox bloat if the Consolidator's confidence threshold is wrong. Phase 2's two-week soak test exists for exactly this. If it fails, Phase 2 may need an additional inbox-aging policy beyond the existing 14-day expiry.
- **Vector decision is binding — settled 2026-05-13.** Phase 3B locked in Level 3 OUT. Strata production indexers stay BM25-only. Reversing would require a re-spike that contradicts the existing data, not a casual reopen.
- **Phase 4 KV-cache discipline assumes Anthropic-only.** If we add non-Anthropic LLM providers (`@ax/llm-openrouter`, `@ax/llm-openai`), the cache-aware layout may not transfer. Re-evaluate when that lands.
