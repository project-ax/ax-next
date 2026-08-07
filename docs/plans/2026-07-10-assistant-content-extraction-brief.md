# Assistant-content extraction — @ax/memory-strata

**Date:** 2026-07-10
**Purpose:** Session brief — design + build the highest-EV remaining LongMemEval lever. Paste the body into a fresh session to execute.

READ FIRST: `docs/plans/2026-07-08-memory-strata-postrollup-e2e-analysis.md` (the measurement that produced this — read the FINAL n=500 section and the root cause). Optional background: `docs/plans/2026-07-07-longmemeval-next-levers-brief.md` (the prior brief; **its WS1–WS5 are now largely superseded — see "What this replaces"**).

Use superpowers skills (**brainstorming BEFORE any design/build**, systematic-debugging, TDD, subagent-driven-development). Follow CLAUDE.md invariants + the Bug Fix Policy. **Invoke the `security-checklist` skill** — this change stores more model output into memory that is later re-injected into a system prompt (see Guardrails).

## Current state (measured, on `fix/bench-final-session-inbox-stranding`)

n=500 BM25 on the **fixed** harness (`bm25-full-fixed.jsonl`, 488 scored, ~$143):

| Type | score | |
|---|---|---|
| single-session-user | 84.3% (59/70) | |
| single-session-preference | 70.0% (21/30) | |
| knowledge-update | 69.6% (48/69) | |
| temporal-reasoning | 68.9% (91/132) | |
| **multi-session** | **67.7% (90/133)** | ✅ gate ≥65% PASS |
| **single-session-assistant** | **25.9% (14/54)** | ⚠️ **the target** |
| **OVERALL** | **66.2%** | |
| correct-refusal | 88.0% (22/25) | ✅ gate ≥83% PASS |

Both gates already pass. This lever is about the **overall** number, not the gate.

## The problem

`single-session-assistant` asks what the **assistant** said in a past session ("remind me what color the Plesiosaur was", "what was the 7th job on that list", "what were CITGO's refining processes"). **35 of its 40 failures are abstentions** — **49% of ALL false refusals in the run** (71 total, 14.5% rate).

Signature: memory holds the **topic** but not the **content**:
> "I can see we **did discuss** a children's book about dinosaurs, but I don't have that detail."
> "My memory **confirms we discussed** CITGO's three refineries (Lake Charles, Lemont, Corpus Christi) — but…"

**Root cause is prompt-level, NOT input** (`packages/memory-strata/src/observer.ts`):
- `formatTranscript` (**line ~146**) *does* include assistant turns — the extraction LLM sees them.
- `EXTRACTION_PROMPT_SYSTEM` (**line ~66**) is wholly user-centric: *"durable facts … likely to still matter to **this user**: preferences, decisions, deadlines, identities, project state."*
- The factType taxonomy (**line ~178**) — `entity | preference | decision | episode | general` — has **no slot for assistant-provided content**.

So the model reads the assistant's answer and dutifully writes *"User is writing a children's book about dinosaurs,"* discarding *"the Plesiosaur had a blue scaly body."*

**Prize:** lift 25.9% → 70% (parity with every other type) = **+24 questions = +4.9pp overall (66.2% → 71.1%)**. At 84% (best-type parity): +6.4pp.

## MEASUREMENT TRAP — read before planning any run

**The first `single-session-assistant` question is at sample position 434.** `--sample 100` (the cheap default) and even `--sample 400` contain **ZERO** of them — the corpus is ordered in type blocks (user 70 → multi 133 → preference 30 → temporal 132 → knowledge-update 69 → **assistant 54**).

Consequences:
- A `--sample 100` run **cannot measure this lever at all**. Do not use it as the before/after.
- The honest options: (a) full `--full` n=500 (~$143, many hours), or (b) **add a question-type / id filter to the bench CLI** so you can run just the 54 assistant questions (~$15, ~40min). **(b) is strongly recommended** — build it first, it pays for itself immediately and makes iteration affordable.
- Whatever you add must not change existing run semantics (it's a new opt-in flag). Land it with a unit test.

## Design questions to brainstorm (do NOT skip to code)

1. **Taxonomy:** new `factType`/category for assistant content (e.g. `answer`/`reference`), or reuse `general` with a different subject convention? A NEW doc category costs **4 edits** (`paths.ts`, `doc-store.ts`, `doc-id.ts` `VALID_CATEGORIES` ~line 17, `types.ts`) + a `recent.md` exclusion decision + `ENUMERABLE_CATEGORIES` consideration (`consolidator.ts` ~line 44) — the same pattern the `rollup` category followed. Cheapest viable option wins.
2. **What qualifies as durable assistant content?** Recommendations, named entities, lists/enumerations, specific values the user may later ask to recall — vs. transient phrasing, hedges, chit-chat. The current prompt's "durable" bar is the model to extend, not replace.
3. **Attribution:** must a stored assistant fact record that *the assistant* said it (vs. the user asserting it)? Getting this wrong risks answering "you told me X" when the *user* said X (and vice versa) — the doctors/Alex-ribs misattribution family already seen in failures.
4. **Volume/bloat:** assistant turns are far longer than user turns. What stops memory from doubling in size and degrading BM25 precision for every other type? (Confidence bar, per-turn cap, dedup against the user-side fact.)
5. **Retrieval shape:** do these facts need to be searchable the same way, or does the answer-agent need a hint that assistant-said content exists? (`memory_search` descriptor wording is a cheap lever.)
6. **Is this genuinely useful, or benchmark-gaming?** State the position explicitly. ("What did you recommend last time?" is a real product need — but say so, and design for the product case, not the judge.)

## Guardrails (regressions to watch)

- **correct-refusal is currently 88.0% (22/25) and must stay ≥83%.** More stored content = more chances to answer an unanswerable question. Measure it.
- **Precision of other types must not drop.** More docs/facts can dilute BM25 for user/multi-session/temporal. The full-run type table above is the before-picture — compare per-type, not just overall.
- **Security (invariant 5 + `security-checklist`):** assistant output is *model output* = untrusted content. Storing more of it into `docs/` means more untrusted text re-injected into a system prompt each turn — precisely the exfiltration channel `promotion.ts`'s I11 sensitive-gate exists to close. Confirm both gates still apply on the new path (write-time I7 in `observer.ts` line ~3, promote-time I11 in `promotion.ts` line ~67), and consider whether assistant content needs a *stricter* filter than user content.
- **Don't store assistant speculation as fact** — the assistant hedges, guesses, and is sometimes wrong; memory shouldn't launder that into a durable "fact".

## Bench mechanics (every paid run)

```bash
cd ~/dev/ai/ax-next
git checkout fix/bench-final-session-inbox-stranding   # has the stranding fix — REQUIRED, main under-measures
pnpm --filter @ax/memory-strata build                  # CRITICAL: bench imports via dist/; stale dist = silent wrong result
set -a; source .env.walk; set +a
unset XAI_API_KEY                                      # BM25 path (the default/winning path). Set = orchestrator.
pnpm --filter @ax/memory-strata bench --mode e2e --full --cap 200 --resume <unique-label>
```

- Models: answer **Sonnet 4.6**, extraction/Observer **Haiku 4.5**, judge **grok-4.3**, planner **grok-4-fast-non-reasoning** (orchestrator path only).
- Baseline to diff: `~/.cache/ax-memory-bench/longmemeval-s-e2e/bm25-full-fixed.jsonl`. Keys: `questionId, questionType, unanswerable, verdict, judgeReason, toolCalls, question, goldAnswer, agentAnswer`.
- Report path is **date-stamped and clobbers** same-day — the JSONL is the source of truth; copy the report aside.
- **Never trust a type score until its sample fills** — this run repeatedly showed weak-looking types de-noising upward (temporal 62.5%→68.9%, knowledge-update 64.7%→69.6%). At n≈50+ per type, treat ±1 question as ~2pt.
- Diagnostics to reuse (in `test/bench/`): `repro-orch-retrieval.ts` (kept workspace + traced planner + bullseye search), `repro-count-diag.ts` (class instances in docs vs search vs answer), `repro-reconsolidate.ts` (re-run one consolidation pass on a kept workspace). These are how every root cause here was found — **prefer a kept-workspace repro over speculation**.
- Filtered repo test gate: `pnpm -r --filter '!@ax/credential-proxy' --filter '!ax-next' test` (known-unrelated failures: credential-proxy undici, one conversations race, Docker-dependent suites).

## What this replaces

The prior brief's sequencing is superseded by measurement:
- **WS2 reflect/rollup** — already merged (TASK-199→201); exonerated as a regression cause; neutral-to-positive.
- **WS3 multi-hop** — its target types de-noised to ~69% (knowledge-update, temporal). No longer an outlier. Secondary.
- **WS4 extraction robustness** — parse-error loss was NOT the bottleneck. *Note the irony:* this brief IS an extraction lever, just a different one (taxonomy/prompt scope, not parse repair).
- **WS5 hybrid dense/embeddings** — no evidence lexical mismatch is the wall; would aggravate the overcount side of aggregation. Do not build on current evidence.
- **Aggregation-counting** — gate already passes; diagnosis showed undercount = capture gap, overcount = gold-ambiguous boundary reasoning (low ceiling). De-prioritized.

## Deliverables

1. A **cheap targeted measurement path** (type/id filter) + unit test — before any lever work.
2. Brainstormed + written design doc for the extraction change, reviewed before implementation.
3. TDD implementation (a fixture that currently drops assistant content and passes after).
4. Before/after on the **54 assistant questions**, plus a **full n=500** confirmation that per-type scores and correct-refusal did not regress.
5. Updated `.claude/memory/` + the analysis doc with what the lever actually bought.
