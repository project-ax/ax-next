# HANDOFF — dem-memory

You are taking over a work-in-progress. Read this fully before touching code. Every
number and file path below was verified against the working tree immediately before
this was written.

## Context

`dem-memory/` is a standalone implementation of the Decoupled Epistemic Memory design
(`/Users/vpulim/Downloads/dem.md`): bi-temporal SQLite storage (better-sqlite3 +
sqlite-vec `vec0` + FTS5), four epistemic networks, four-channel recall fused by
Reciprocal Rank Fusion, Cohere cross-encoder reranking, single-pass grounded synthesis
with `[DATA_ABSENT]` abstention.

- **Worktree:** `/Users/vpulim/dev/ai/ax-next-dem`, branch `dem-memory`.
- **Never commit in `/Users/vpulim/dev/ai/ax-next`** — that is the shared main checkout.
- It is a **standalone npm sub-project**, deliberately NOT a pnpm workspace member
  (`pnpm-workspace.yaml` doesn't cover it; root `eslint.config.mjs` ignores it via a
  scoped `dem-memory/**` entry). Use **`npm`, not `pnpm`**, inside `dem-memory/`.

**Four commits on the branch, none pushed, no PR:**

```
485f7732 n=100 vs Strata: 82.0% to its 76.0%, and the lead is one question type
196ef6fd retain: one malformed date cost a whole batch of memories
abc3efa1 bench: the sampler was picking the easiest questions, and the answer model was welded to the extractor
46934d9f dem-memory: the temporal misses were prompt failures, and the question date is not an anchor
```

**Current state:** `npm run typecheck` clean, `npm run build` clean, `npm test`
**54/54 passing** across 6 files. LongMemEval-S **82.0% at n=100** against the Strata
e2e baseline's **76.0%** on the same 100 questions.

## Run the benchmark

```bash
cd /Users/vpulim/dev/ai/ax-next-dem/dem-memory
set -a; source /Users/vpulim/dev/ai/ax-next/.env.walk; set +a
export GOOGLE_CLOUD_PROJECT=canopy-ai-498321   # bench also auto-reads gcloud config

# the two arms that produced the numbers below
npx tsx bench/run.ts --n 100 --stack production --sampler spaced \
  --extract-concurrency 10 --out-dir bench/results/n100-glm
npx tsx bench/run.ts --n 100 --stack production --sampler spaced \
  --answer-model anthropic/claude-sonnet-4.6 --answer-effort none \
  --out-dir bench/results/n100-sonnet

# re-express any results file in Strata's metrics
npx tsx bench/compare-strata.ts bench/results/n100-sonnet/*.jsonl
```

- Keys live in `/Users/vpulim/dev/ai/ax-next/.env.walk` (`OPENROUTER_API_KEY`,
  `COHERE_API_KEY`). **Never copy that file into the repo or echo its values.**
- `--stack production|vertex|stub`. production = Vertex `text-embedding-005` (384-dim,
  task-aware) + Cohere `rerank-v4.0-pro`; vertex = Vertex + lexical reranker; stub =
  hash embedder + lexical, zero creds.
- Default answer + extract model `z-ai/glm-5.3-flash:nitro` with
  `reasoning: { effort: "minimal" }`. Judge `x-ai/grok-4.3` — **keep the judge fixed**,
  it is what makes these numbers comparable to Strata's.
- `--answer-model` / `--answer-effort` vary the answerer without touching extraction.
  `--answer-effort none` omits the `reasoning` field entirely (Anthropic doesn't take
  GLM's effort values).
- Results append to `<out-dir>/run-<date>-<stack>.jsonl` and **RESUME**: rows with
  verdict `error` are retried, good rows skipped. Use a fresh `--out-dir` per config or
  you will silently score the old one.
- **Caches (gitignored):** `bench/cache/extraction.json` (5,467 sessions, 10.4 MB — the
  dominant cost lever) and `bench/cache/embeddings.json` (357 MB, sha1(task:text) →
  384d). Extraction cache keys are `sessionId:fingerprint:contentHash`, where the
  fingerprint covers the extraction **prompt and model**, so changing either
  re-extracts instead of silently serving stale facts.
- **Timing/cost with warm caches:** n=100 answer-only ≈ 15 min, ~$0.50 of Sonnet.
  Cold extraction for a new n=100 sample ≈ 1.5 h and ~$2.20.

## Against Strata (n=100, same questions, same judge)

`--sampler spaced` reproduces the Strata e2e bench's stratified selection exactly: same
type mix, 5 `_abs`, median 47 sessions/question against its reported 47.8 avg, and all 3
TASK-368 known-bad-gold ids present — which is what makes its "76.0%, or 79.0% excluding
3" arithmetic land on these same rows. Baseline:
`/Users/vpulim/dev/ai/ax-next/docs/plans/2026-09-14-memory-strata-e2e-report.md`.

Strata answers with `claude-sonnet-4-6` and uses GLM only to extract and plan, so the
matched arm answers with Sonnet too. The GLM arm is dem-memory's own cheap-answerer config.

| question_type | n | Strata | dem (sonnet-4.6) | delta | dem (GLM flash) |
|---|---|---|---|---|---|
| temporal-reasoning | 27 | 59.3% | **92.6%** | **+33.3** | 88.9% |
| single-session-preference | 6 | 66.7% | **100.0%** | +33.3 | 83.3% |
| knowledge-update | 15 | 80.0% | 80.0% | 0.0 | 80.0% |
| single-session-user | 14 | 100.0% | 100.0% | 0.0 | 92.9% |
| multi-session | 27 | 85.2% | 74.1% | **-11.1** | 81.5% |
| single-session-assistant | 11 | 63.6% | 45.5% | **-18.1** | 45.5% |
| **TOTAL** | 100 | **76.0%** | **82.0%** | **+6.0** | **81.0%** |
| TOTAL excl. known-bad-gold | 97 | 79.0% | 84.5% | +5.5 | 83.5% |

Abstention is identical across all three: correct-refusal 80.0%, hallucination 20.0%
(the same 5 `_abs` questions, the same one slipping through). False-refusal is lower
here (6.3% sonnet / 8.4% GLM vs 9.5%).

**How much of this to believe.** The +6.0 total is **1.6 SE** (SE 3.8pp at n=100) —
suggestive, not a decisive system win. The temporal +33.3 is **6.6 SE** (SE 5.0pp at
n=27), is decisive, and carries +9.0 of that +6.0 on its own. Strip temporal out and
dem-memory is behind. **Quote the per-type row, not the headline.**

**One asymmetry to state out loud.** Strata's number is its real product pipeline
(observer → inbox → consolidator decay/cluster/dedup/promote → docs → injection +
agentic `memory_search`, ~2 tool calls/question, $7.28/100). This bench ingests every
session directly with no consolidation step to survive, and answers single-pass from a
15-row table. Fair system-to-system on the benchmark; **not** evidence that
dem-memory's ingestion holds up under a consolidation regime.

## Next work, in value order

### 1. `single-session-assistant` 45.5% — assistant-content extraction

The weak type, and the clearest lever anywhere in this project.

- It is **identical (45.5%) in both answer arms**, so the failure is ingestion/retrieval,
  not synthesis.
- 5 of its 11 are `abstain-miss` — the fact never reached memory at all.
- **Strata has already solved this exact problem**: its 2026-08-02 assistant-content
  extraction moved that same type **25.9% → 83.3%**, and dragged temporal-reasoning up
  +9.1 as an unforecast side effect. See
  `/Users/vpulim/dev/ai/ax-next/.claude/memory/context.md` (2026-08-02 entry) and
  `.superpowers/sdd/2026-07-29-assistant-content-extraction-plan/`.
- Start by dumping what actually reaches the table for the 5 abstain-miss rows
  (`bench/diagnose-temporal.ts --ids ...`, see below) before changing the prompt.
- This is an extraction-prompt change, so it **will** invalidate the fact cache by
  design. Budget a full re-extract: ~1.5 h, ~$2.20 at n=100.

### 2. `multi-session` 74.1% (80.0% excluding known-bad-gold)

Second-largest gap, but no known lever and no diagnosis yet. Two of its 27 are
known-bad-gold. Worth a `diagnose` pass over its failures before theorising — the GLM
arm scores 81.5% here vs Sonnet's 74.1%, which is odd enough to be worth understanding
on its own (it is the only type where the cheaper answerer does better).

### 3. Residual temporal: same-date disambiguation

`gpt4_d6585ce9` is the one flaky temporal question. Date resolution now works ("Last
Saturday was 2023-04-15"); it fails by picking the wrong one of **two** facts sharing
that date (a Queen concert "with parents" vs a Brooklyn music festival). That is
disambiguation among same-dated rows, not temporal grounding.

### 4. Known extraction noise (measured, not yet acted on)

Across 16,804 cached facts: 67.0% carry exactly their session date, **16.5% are dated
>1 day in the future** (mostly legitimate planned events), **~1% are wild outliers**
(p100 314 years off). `retain()` now skips unparseable dates rather than dying, but
absurd-yet-parseable years still land in the table. Not known to cost any answer.

### 5. Still unbuilt, still no evidence for them

Query-time temporal parsing and entity-balanced retrieval for comparative queries — see
"What was deliberately NOT built" below. Don't build these on the strength of the design
doc alone; wait for a failing question that needs them.

## The debugging tool you actually want

`bench/diagnose-temporal.ts` is misleadingly named: with `--ids` it dumps the **exact
evidence table** any question is answered from, for any type, using the warm caches and
**no answer or judge calls** (so it is free and fast).

```bash
npx tsx bench/diagnose-temporal.ts --ids 7161e7e2,gpt4_d6585ce9 --stack production
```

Reach for this **before** theorising about retrieval. It is what proved the temporal
misses were prompt failures rather than recall gaps, against a handoff and a design doc
that both said otherwise.

## Hard-won gotchas

1. **npm install recipe:** `npm install --ignore-scripts`, then
   `npm rebuild better-sqlite3 esbuild`. (sharp's install script raced its platform
   optional-deps; transformers.js is already gone from the stack.)
2. **Cohere model id:** `rerank-v4.0` 404s. The real ids are `rerank-v4.0-pro` and
   `rerank-v4.0-fast` (verified via `GET /v1/models?endpoint=rerank`). Library default
   is `rerank-v4.0-pro` (`src/models/reranker.ts`).
3. **Vertex project id:** `GoogleAuth.getProjectId()` CANNOT infer a project from USER
   ADC credentials. `bench/harness.ts` `ensureVertexProject()` falls back to parsing
   `~/.config/gcloud/configurations/config_default`. The embedder retries 429/5xx
   (4 attempts, exponential backoff) — keep that.
4. **GLM extraction needs an EXPLICIT JSON shape line** in `buildExtractionPrompt`
   (`src/engine/retain.ts`) — prose-only rules made it emit facts missing `network`.
   `bench/extraction.ts` also coerces primitive `subject`/`predicate`/`object` values
   and retries with the schema plus the invalid output echoed.
5. **The reflect prompt must demand DIRECT answers.** The original abstention directive
   made GLM hedge recallable answers to death. Don't regress it — and don't over-correct
   either; see "Two prompt sentences that cost answers" below.
6. **Invalidation closes only still-active records** (`valid_end` = infinity sentinel
   `9999-12-31T23:59:59.999Z`), NOT the design doc's literal `valid_end > valid_start`
   predicate, which would rewrite closed intervals. Pinned by
   `tests/temporal-invalidation.test.ts`. Don't weaken.
7. **The question date is an `asOf`, not a `temporalAnchor`.** Passing it as an anchor
   filters the candidate set and costs answers. See the README table.
8. **`--sampler` changes what you are measuring.** `spaced` is comparable to Strata;
   `shortest` is the old easy-slice picker, kept only so the 2026-09-16 n=30 runs stay
   reproducible. **Never compare a number from one sampler to a number from the other.**
9. **Variance is large at small n.** Two runs of identical code at n=30 gave 28/30 and
   26/30 — 4 questions flip between identical runs. Re-run the same config before
   attributing any single-question flip to a change. At n=100, SE is ~3.8pp.
10. **Tests are HERMETIC** (hash embedder, lexical reranker, canned extractors, no
    network). Keep it that way — new retrieval features need deterministic tests.
11. **Memory discipline:** write `.claude/memory/` updates ONLY in this worktree and
    fold them into the same commit as the work.

## Temporal grounding — what the fix was (2026-09-16)

`/Users/vpulim/Downloads/fix_temporal.md` prescribed four fixes. **Three of the four
were aimed at causes this codebase did not have.** `bench/diagnose-temporal.ts` showed
the gold fact PRESENT and correctly dated in 4 of the 5 failures — `5e1b23de` had it at
**rank 1** and still answered `[DATA_ABSENT]`. The 3 temporal questions that passed at
baseline are exactly the 3 that never need to know what "today" is.

What actually broke them:

1. **The evaluation timestamp never reached the prompt.** `reflect` took a
   `temporalAnchor`, used it as a SQL validity filter, and discarded it. Three misses
   said so in their own answer text.
2. **The date column read as storage bookkeeping.** `Validity Interval` /
   `2023-11-01 to infinity` is not a sentence about when something happened. It is now a
   `When` column: `2023-11-01 (Wed, 3 months ago)`.
3. **`asOf` and `temporalAnchor` were one option doing two jobs.** `temporalAnchor`
   filters (time travel); `asOf` only grounds the prompt. Passing the question date as an
   anchor evicted `"in the US…past five years"` (32−5=27) and cost `d01c6aa8`.
4. **Elapsed time is computed in TypeScript**, not asked of the model.

### What was deliberately NOT built, and why

- **Query-time temporal parsing** (doc Fix 2) — no failing question needed a parsed date
  range. The CLI defaults `asOf` to the wall clock.
- **Entity-balanced retrieval for comparative queries** (doc Fixes 2b/3) — the one
  comparative question (`gpt4_93f6379c`) passed at baseline and still passes.
- **Re-grounding the extraction prompt** (doc Fixes 1/3) — measured instead of assumed;
  see "Known extraction noise" above. Every gold-bearing fact in the five failures was
  dated correctly.
- **Chronological evidence ordering** (doc Fix 4a) — built, measured, reverted. It cost 2
  knowledge-update answers (`5831f84d` summed 12+10+15 across successive values of the
  same fact) because a "what is it now" question reads row 1 as the answer, and
  oldest-first puts a superseded value there. Rank order is the default;
  `compileEvidenceTable({ chronological: true })` still exists.

### Two prompt sentences that cost answers — don't reintroduce them

An intermediate directive said the elapsed time "is already computed for you" and to
"never answer that the table lacks dates". Both overclaim:

- deltas are computed **relative to today only**, never between two rows — with that
  sentence in, `8c18457d` answered "17 days" for a Mar 8 → Mar 15 gap;
- the anti-abstention absolute flipped `f685340e_abs`, an unanswerable question, from
  `abstained-correctly` to a confident wrong answer.

The shipped wording says every row is dated, that you must subtract two rows yourself,
and that only the distance from today is precomputed.

## Earlier runs on the OLD easy-slice sampler (not comparable to anything above)

`--sampler shortest` allocated by type and then took the k shortest haystacks, putting
all 30 questions of an n=30 sample at the 3rd percentile (median, max 9th) of the corpus
haystack-size distribution.

| run | file | TOTAL | temporal |
|---|---|---|---|
| baseline | `run-2026-09-16-production.jsonl` | 24/30 | 3/8 |
| asOf + chronological | `v2-asof/` | 25/30 | 7/8 |
| asOf, rank order | `v3-rank/` | 28/30 | 8/8 |
| identical re-run | `v3-repeat/` | 26/30 | 7/8 |

## File map

```
dem-memory/
├── src/
│   ├── index.ts                  facade (createDemMemory), stack resolution
│   ├── types.ts                  zod schemas, RecallOptions (asOf vs temporalAnchor)
│   ├── db/{client,schema.sql,memory-repository}.ts
│   ├── graph/co-occurrence-graph.ts
│   ├── models/{embeddings,reranker}.ts   Vertex embedder, Cohere/lexical reranker
│   ├── engine/
│   │   ├── retain.ts             extraction prompt, fact validation, invalidation
│   │   ├── recall.ts             4 channels -> RRF -> rerank
│   │   └── reflect.ts            When column, relativeTime, prompt, synthesis
│   └── cli.ts                    REPL; `ask`/`recall` default asOf to the wall clock
├── bench/
│   ├── harness.ts                corpus, stacks, caches, stratifiedSample/pickShortest
│   ├── extraction.ts             GLM extractor + prompt/model-fingerprinted fact cache
│   ├── llm.ts                    OpenRouter client (effort "none" omits reasoning)
│   ├── run.ts                    scoring run
│   ├── diagnose-temporal.ts      dump the evidence table a question actually sees
│   └── compare-strata.ts         re-express results in Strata's metrics
├── tests/                        54 passing, hermetic
├── scripts/verify-db.ts          vec0/FTS5 smoke
└── README.md
```

## Where the reasoning is written down

`/Users/vpulim/dev/ai/ax-next-dem/.claude/memory/decisions.md` — the 2026-09-16 entries
carry the full rationale, the rejected alternatives, and the measurements behind every
claim here. `patterns.md` has the two reusable lessons (dump the prompt before
theorising about retrieval; compute in code the arithmetic you'd otherwise ask a cheap
model to do).
