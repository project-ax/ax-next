# HANDOFF — dem-memory temporal-reasoning fix

You are taking over a work-in-progress in an existing worktree. Read this fully
before touching code; every claim below was verified against the working tree
immediately before this handoff was written.

## Context

`dem-memory/` (worktree `/Users/vpulim/dev/ai/ax-next-dem`, branch `dem-memory`)
is a standalone implementation of the Decoupled Epistemic Memory design
(`/Users/vpulim/Downloads/dem.md`): bi-temporal SQLite storage (better-sqlite3 +
sqlite-vec `vec0` + FTS5), four epistemic networks, four-channel recall fused by
Reciprocal Rank Fusion, Cohere cross-encoder reranking, single-pass grounded
synthesis with `[DATA_ABSENT]` abstention.

It is a **standalone npm sub-project** — deliberately NOT a member of the pnpm
workspace (`pnpm-workspace.yaml` doesn't cover it, root eslint ignores it via a
scoped `dem-memory/**` entry). Use `npm`, not `pnpm`, inside `dem-memory/`.

Current state: `npm run typecheck` clean, `npm test` **47/47 passing**, LongMemEval-S
smoke at **86.7-93.3% (26-28/30)** on the full production stack, with
**temporal-reasoning at 7-8/8** (was 3/8). The temporal fix is done; see
"Temporal grounding" below for what it was and what it was NOT.

## Run the benchmark

```bash
cd /Users/vpulim/dev/ai/ax-next-dem/dem-memory
set -a; source /Users/vpulim/dev/ai/ax-next/.env.walk; set +a
export GOOGLE_CLOUD_PROJECT=canopy-ai-498321   # bench also auto-reads gcloud config
npx tsx bench/run.ts --n 30 --stack production
```

- Env keys live in `/Users/vpulim/dev/ai/ax-next/.env.walk` (OPENROUTER_API_KEY,
  COHERE_API_KEY). NEVER copy that file into the repo or echo its values.
- `--stack production|vertex|stub`. production = Vertex `text-embedding-005`
  (384-dim, task-aware) + Cohere `rerank-v4.0-pro`. vertex = Vertex + lexical
  reranker. stub = deterministic hash embedder + lexical (zero creds).
- Model: `z-ai/glm-5.3-flash:nitro` via OpenRouter with
  `reasoning: { effort: "minimal" }`; judge is `x-ai/grok-4.3` (same as the
  in-repo Strata bench — keep it for comparability).
- Results append to `bench/results/run-<date>-<stack>.jsonl` and RESUME on rerun
  (rows with verdict `error` are retried, good rows skipped).
- Caches (gitignored): `bench/cache/extraction.json` (1,365 extracted sessions,
  keyed by session id + content hash — the dominant cost lever) and
  `bench/cache/embeddings.json` (~90MB, sha1(task:text) → 384d vector).
  With warm caches, a full n=30 run is ~8 minutes and costs cents.

## Verified benchmark results (same 30 stratified samples, same judge)

| stack | file | TOTAL |
|---|---|---|
| stub | `bench/results/run-2026-09-16.jsonl` | 15/30 (50.0%) |
| vertex | `bench/results/run-2026-09-16-vertex.jsonl` | 17/30 (56.7%) |
| **production** | `bench/results/run-2026-09-16-production.jsonl` | **24/30 (80.0%), 0 errors** |

| run | config | TOTAL | temporal |
|---|---|---|---|
| `run-2026-09-16-production.jsonl` | baseline | 24/30 (80.0%) | 3/8 |
| `v2-asof/` | asOf + chronological sort | 25/30 (83.3%) | 7/8 |
| `v3-rank/` | asOf, rank order (shipped) | 28/30 (93.3%) | 8/8 |
| `v3-repeat/` | identical re-run of `v3-rank` | 26/30 (86.7%) | 7/8 |

**Read the last two rows together.** Two runs of the *same* code gave 28/30 and
26/30: four questions flip between identical runs, so the noise floor on n=30 is
about ±2. The durable claim is not "93.3%" — it is that **4 of the 5 temporal
questions that used to fail are now correct in both runs** (`d01c6aa8`,
`0bc8ad92`, `gpt4_e072b769`, `5e1b23de`), the 5th (`gpt4_d6585ce9`) is flaky, and
none of the 3 that already passed regressed. Against the in-repo Strata baseline
of 76.0% @ n=500, this is still a smoke — don't overclaim.

## Hard-won gotchas (all recorded in `.claude/memory/decisions.md` — read the 2026-09-16 entries)

1. **npm install recipe**: `npm install --ignore-scripts` then
   `npm rebuild better-sqlite3 esbuild`. (sharp's install script raced its
   platform optional-deps; transformers.js is already gone from the stack.)
2. **Cohere model id**: `rerank-v4.0` 404s. The real ids are `rerank-v4.0-pro`
   and `rerank-v4.0-fast` (verified via `GET /v1/models?endpoint=rerank`).
   Library default is `rerank-v4.0-pro` (`src/models/reranker.ts`).
3. **Vertex project id**: `GoogleAuth.getProjectId()` CANNOT infer a project from
   USER ADC credentials (`application_default_credentials.json` has no
   project_id). `bench/run.ts` `ensureVertexProject()` falls back to parsing
   `~/.config/gcloud/configurations/config_default`. The embedder retries
   429/5xx (4 attempts, exponential backoff) — keep that.
4. **GLM extraction needs an EXPLICIT JSON shape line** in the extraction prompt
   (`buildExtractionPrompt` in `src/engine/retain.ts`) — prose-only rules made it
   emit facts missing `network`. `bench/extraction.ts` also coerces primitive
   `subject`/`predicate`/`object` values (`coerceFactStrings`) and retries with
   the schema + the invalid output echoed.
5. **The reflect prompt must demand DIRECT answers**: the original abstention
   directive made GLM hedge recallable answers to death (0/2 preference). Current
   wording in `src/engine/reflect.ts` `buildReflectSystemPrompt`: answer directly
   when the table bears on the question; `[DATA_ABSENT]` only when nothing does.
   Don't regress this.
6. **Invalidation closes only still-active records** (`valid_end` = infinity
   sentinel `9999-12-31T23:59:59.999Z`), NOT the design doc's literal
   `valid_end > valid_start` predicate — that would rewrite closed intervals.
   Pinned by `tests/temporal-invalidation.test.ts`
   ("re-invalidation never rewrites previously closed intervals"). Don't weaken.
7. **The question date is an `asOf`, not a `temporalAnchor`** — see below. Passing
   it as an anchor filters the candidate set and costs answers.
8. Tests are HERMETIC (hash embedder, lexical reranker, canned extractors, no
   network). Keep it that way — new retrieval features need deterministic tests.
8. Per AGENTS.md: write `.claude/memory/` updates ONLY in this worktree (never
   the shared main checkout), and fold them into your final commit. Never commit
   in `/Users/vpulim/dev/ai/ax-next` (the shared checkout).

## Temporal grounding — what the fix was (2026-09-16)

`/Users/vpulim/Downloads/fix_temporal.md` prescribed four fixes. **Three of the
four were aimed at causes this codebase did not have.** Before building any of
them, `bench/diagnose-temporal.ts` was used to dump the exact evidence table each
failing question was answered from. That is the tool to reach for first if
temporal regresses again:

```bash
npx tsx bench/diagnose-temporal.ts --ids 5e1b23de,gpt4_d6585ce9 --stack production
```

What it showed, per failing question:

| question | gold fact in the table? | actual cause |
|---|---|---|
| `5e1b23de` | yes, **rank 1**, correctly dated `2023-11-01` | no reference date in the prompt |
| `gpt4_e072b769` | yes, correctly dated `2023-04-16` | no reference date in the prompt |
| `gpt4_d6585ce9` | yes, rank 6, `2023-04-15 …with parents` | no reference date → "last Saturday" unresolvable |
| `0bc8ad92` | yes, ranks 1/5/6, `2022-10-22` | had the fact, computed "~4 months"; gold 5 — arithmetic |
| `d01c6aa8` | **only without the anchor** | `temporalAnchor` filtered out `"in the US…past five years"` (32−5=27) |

So the binding constraints were, in order:

1. **The evaluation timestamp never reached the prompt.** `reflect` took a
   `temporalAnchor`, used it as a SQL validity filter, and discarded it. Three of
   the five misses say so in their own answer text ("the table doesn't contain
   any information establishing how many weeks ago that was relative to the
   current date"). The 3 temporal questions that passed at baseline are exactly
   the 3 that don't need to know what "today" is.
2. **The date column read as storage bookkeeping.** `Validity Interval` /
   `2023-11-01 to infinity` is not a sentence about when something happened, and
   GLM at minimal effort treated it accordingly — answering `[DATA_ABSENT]`,
   "doesn't specify when that occurred", about a row whose date was right there.
   It is now a `When` column: `2023-11-01 (Wed, 3 months ago)`.
3. **`asOf` and `temporalAnchor` were one option doing two jobs.** See the README
   table. The bench now passes the question date as `asOf` for *every* question
   type, and nothing as `temporalAnchor`.

### What was deliberately NOT built, and why

- **Query-time temporal parsing** (doc Fix 2) — no failing question needed a
  parsed date range. The anchor is known to the caller; the CLI defaults it to
  the wall clock. Build it when a question fails for want of it.
- **Entity-balanced retrieval for comparative queries** (doc Fixes 2b/3) — the
  one comparative question in the set (`gpt4_93f6379c`, "which group did I join
  first") passed at baseline and still passes. No evidence to act on.
- **Re-grounding the extraction prompt** (doc Fixes 1/3) — measured instead of
  assumed: across all 16,804 cached facts, 67% carry exactly their session date
  and every gold-bearing fact in the five failures was dated correctly. There IS
  noise (16.5% dated >1 day in the future, ~1% wild outliers), but it was not
  what broke these questions, and re-extracting 1,974 sessions is the single most
  expensive thing you can do here. If you do change the extraction prompt, the
  fact cache now fingerprints it (`PROMPT_FINGERPRINT` in `bench/extraction.ts`)
  and re-extracts instead of silently serving facts from the old prompt.
- **Chronological evidence ordering** (doc Fix 4a) — built, measured, reverted.
  It cost 2 knowledge-update answers (`5831f84d` summed 12+10+15 across
  successive values of the same fact) because a "what is it now" question reads
  row 1 as the answer, and oldest-first puts a superseded value there. Rank order
  is the default; `compileEvidenceTable({ chronological: true })` still exists.

### Two prompt sentences that cost answers — don't reintroduce them

An intermediate version of directive 6 said the elapsed time "is already computed
for you" and to "never answer that the table lacks dates". Both overclaim:

- deltas are computed **relative to today only**, never between two rows — with
  that sentence in, `8c18457d` answered "17 days" for a Mar 8 → Mar 15 gap;
- "never answer that the table lacks dates" also suppressed a **correct**
  abstention (`f685340e_abs`, an unanswerable question, went from
  `abstained-correctly` to a confident wrong answer).

The shipped wording says every row is dated, that you must subtract two rows
yourself, and that only the distance from today is precomputed.

### Residual

`gpt4_d6585ce9` is the one flaky temporal question. Both dates resolve correctly
now ("Last Saturday was 2023-04-15"); the failure mode is that **two** facts
share that date — a Queen concert "with parents" and a Brooklyn music festival —
and it sometimes picks the wrong one. That is disambiguation among same-dated
rows, not date resolution. `single-session-preference` `d6233ab6` abstains in 4
of 5 runs across every stack including both baselines: a coin-flip question, not
a regression.

### File map
```
dem-memory/
├── src/
│   ├── index.ts                  facade (createDemMemory), stack resolution
│   ├── types.ts                  zod schemas, EmbeddingFn(task), INFINITY_SENTINEL
│   ├── db/{client,schema.sql,memory-repository}.ts
│   ├── graph/co-occurrence-graph.ts
│   ├── models/{embeddings,reranker}.ts   Vertex embedder, Cohere/lexical reranker
│   ├── engine/{retain,recall,reflect}.ts the three engines
│   └── cli.ts
├── bench/
│   ├── {llm,extraction}.ts        OpenRouter client, GLM extractor + fact cache
│   ├── harness.ts                 corpus/stack/cache/selection shared by both runners
│   ├── run.ts                     LongMemEval-S scoring run
│   └── diagnose-temporal.ts       dump the evidence table a question actually sees
├── tests/                         47 passing, hermetic
├── scripts/verify-db.ts           vec0/FTS5 smoke
└── README.md
```
