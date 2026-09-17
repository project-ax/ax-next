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

**Ten commits, pushed, open as PR #570** (https://github.com/project-ax/ax-next/pull/570).
Rebased onto `main` twice on 2026-09-17; expect it to drift back to CONFLICTING within hours
because ~15 `auto-ship/*` agents append to `.claude/memory/*.md` continuously. Resolution is
always "keep both sides, upstream first" — they are append-only files.

**Current state:** `npm run typecheck`, `npm run build`, `npm test` all clean —
**103 tests** across 12 files, hermetic.

**THE headline number: LongMemEval-S n=500 (the FULL corpus) = 87.4%**, against the Strata
n=500 reference of 76.0%. SE +/-1.5pp, so +11.4pp is ~7 SE, and it reproduces EXACTLY across
two independent answerers (sonnet-4.6 and glm-5.3-flash both 87.4%; McNemar on the answerer
p=1.000). This is the only number on this project measured at a scale where a single arm is
interpretable — see gotcha 10. Quote this one, not the n=100 ones.

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
- **Caches (gitignored):** `bench/cache/extraction.json` (22 MB — the dominant cost lever)
  and `bench/cache/embeddings.ndjson` (537 MB, one `{"k":sha1(task:text),"v":[384 floats]}`
  per line). Extraction cache keys are `sessionId:fingerprint:contentHash`, where the
  fingerprint covers the extraction **prompt and model**, so changing either
  re-extracts instead of silently serving stale facts.
- **The embedding cache is APPEND-ONLY, and it has to stay that way.** It was one JSON object
  rewritten in full on every flush; at 536,270,828 bytes `JSON.stringify` exceeded V8's
  `MAX_STRING_LENGTH` (536,870,888) and threw `Invalid string length` from inside run.ts's
  per-question try block — 49 of 100 questions scored `error` **after** their work had
  succeeded, and no restart could converge because every flush threw again. Reads go through a
  `Buffer` and slice per line for the same reason (a whole-file `readFileSync(path,"utf8")`
  hits the identical ceiling). The legacy `embeddings.json` (536 MB) is adopted once, then
  never read again — **safe to delete whenever you want the disk back.**
- **Timing/cost with warm caches:** n=100 answer-only ≈ 15 min, ~$0.50 of Sonnet.
  Cold extraction for a new n=100 sample ≈ 1.5 h and ~$2.20.

## Against Strata at n=500 (the full corpus) — QUOTE THIS ONE

`bench/results/n500-sonnet/` and `n500-glm/`. GLM extraction, 15-row evidence (the shipped
default), grok-4.3 judge. Strata reference: its 2026-08-02 n=500 run at 76.0% (BM25-only
retrieval + haiku extraction — an OLDER config than the n=100 orchestrator one below; both
Strata configs land on 76.0% overall, which is what makes the headline comparable at all).

| question_type | n | dem sonnet | dem GLM | Strata |
|---|---|---|---|---|
| temporal-reasoning | 133 | **90.2%** | **90.2%** | 59.3% |
| single-session-assistant | 56 | 91.1% | 89.3% | 63.6% |
| knowledge-update | 78 | 87.2% | 88.5% | 80.0% |
| single-session-preference | 30 | 80.0% | 83.3% | 66.7% |
| single-session-user | 70 | 95.7% | 97.1% | 100.0% |
| multi-session | 133 | 80.5% | 78.9% | 85.2% |
| **TOTAL** | 500 | **87.4%** | **87.4%** | **76.0%** |

**The lead is two types, both with confirmed mechanisms** (temporal grounding; assistant-content
extraction). **Two places dem is WORSE and they matter:**

- `multi-session` 80.5/78.9 vs 85.2 — Strata still wins the largest stratum, in both arms.
- **Abstention: hallucination 36.7% (sonnet) / 26.7% (GLM) vs Strata's 20.0%.** dem buys a low
  false-refusal rate (1.9-2.3% vs 9.5%) by answering more readily, and invents an answer on a
  quarter to a third of unanswerable questions. **For a memory product this is the worst
  failure mode available, and it is the thing to fix before claiming dem is better.**

**The answerer is worth ~nothing: McNemar 19 wins each, p=1.000**, at 30x the cost ($3.16 vs
~$0.10 per 500). Sonnet exists in these runs only to match Strata's answerer.

## Against Strata (n=100, same questions, same judge)

`--sampler spaced` reproduces the Strata e2e bench's stratified selection exactly: same
type mix, 5 `_abs`, median 47 sessions/question against its reported 47.8 avg, and all 3
TASK-368 known-bad-gold ids present — which is what makes its "76.0%, or 79.0% excluding
3" arithmetic land on these same rows. Baseline:
`/Users/vpulim/dev/ai/ax-next/docs/plans/2026-09-14-memory-strata-e2e-report.md`.

Strata answers with `claude-sonnet-4-6` and uses GLM only to extract and plan, so the
matched arm answers with Sonnet too. The GLM arm is dem-memory's own cheap-answerer config.

| question_type | n | Strata | dem sonnet | dem GLM | (pre-fix sonnet) |
|---|---|---|---|---|---|
| temporal-reasoning | 27 | 59.3% | 85.2% | 77.8% | 92.6% |
| single-session-preference | 6 | 66.7% | 83.3% | 83.3% | 100.0% |
| knowledge-update | 15 | 80.0% | 86.7% | 93.3% | 80.0% |
| single-session-user | 14 | 100.0% | 100.0% | 92.9% | 100.0% |
| multi-session | 27 | 85.2% | 88.9% | 77.8% | 74.1% |
| single-session-assistant | 11 | 63.6% | **81.8%** | **81.8%** | 45.5% |
| **TOTAL** | 100 | **76.0%** | **88.0%** | **83.0%** | 82.0% |
| TOTAL excl. known-bad-gold | 97 | 79.0% | 89.7% | 83.5% | 84.5% |

Arms: `bench/results/n100-sonnet-asst/` and `n100-glm-asst/`; the pre-fix arms are
`n100-sonnet/` and `n100-glm/`, same 100 questions, same judge.

**How much of this to believe.** **Quote the REPLICATED row, not the headline and not one
arm.** The two arms are the same 100 questions scored by two independent answerers, which is
this bench's cheapest noise filter — and they disagree a lot:

- **`single-session-assistant` 45.5% → 81.8% is real.** Identical in BOTH arms (5/11 → 9/11),
  the same four questions, each judged correct for the predicted reason. This is the one
  claim here that is safe to make.
- **The overall gain is not.** Sonnet +6.0, GLM +2.0 — and **+0.0 excluding known-bad-gold**.
  McNemar on paired discordant rows: sonnet 12W/6L **p=0.238**, GLM 11W/9L **p=0.824**.
- **`multi-session` +14.8 in the sonnet arm is NOISE** — the GLM arm scores −3.7 on the same
  questions and `36b9f61e` flips in opposite directions in the two arms. Do not quote it.
- Across both arms only **7 wins and 4 losses replicate**; outside the target type the
  replicated flips net to **−1**. That is what a well-aimed lever looks like: it fixes what it
  targeted and is roughly neutral elsewhere.

Use McNemar on discordant pairs, not an unpaired SE: the runs are paired, so an unpaired SE
overstates the uncertainty of a targeted fix and understates how little the off-target rows say.

**One asymmetry to state out loud.** Strata's number is its real product pipeline
(observer → inbox → consolidator decay/cluster/dedup/promote → docs → injection +
agentic `memory_search`, ~2 tool calls/question, $7.28/100). This bench ingests every
session directly with no consolidation step to survive, and answers single-pass from a
15-row table. Fair system-to-system on the benchmark; **not** evidence that
dem-memory's ingestion holds up under a consolidation regime.

## Next work, in value order

### 0. The question that actually decides dem's future: does 87.4% survive CONSOLIDATION?

See "Can dem replace Strata inside ax?" below. dem has never been tested under a regime where
facts must survive decay/dedup/promotion to stay recallable, and that is the whole difference
between a benchmark win and a product. Level 1 there is ~1 day and ~$3 of local computation.

### 0b. READ FIRST: evidence depth and source anchors were both measured, and both are NULL

Do not re-run these. `docs/plans/2026-09-16-evidence-depth-and-source-anchors-report.md` has the
full numbers. Same 100 questions, same judge, same extraction cache:

| answerer | fixed-15 | Path A (fill the budget) | Path B (+ source excerpts) |
|---|---|---|---|
| glm-5.3-flash | 83.0% | 88.0% | 87.0% |
| claude-sonnet-4.6 | 88.0% | **87.0%** | **87.0%** |

Neither replicates (1 of 10 and 1 of 14 flips across the two arms), both cost ~1.9x the
answer-prompt tokens, and `single-session-assistant` is **9/11 in all four GLM configs**. Both
ship OPT-IN and OFF: `DEFAULT_EVIDENCE_ROWS = 15`, `sourceExcerpts: 0`. Bench flags
`--evidence-rows 80` and `--source-excerpts 5` reproduce the arms.

**Model choice, measured: the extractor is worth 57 points and the answerer ~nothing.**
gpt-4.1-nano extraction scores 26.0% where glm-5.3-flash scores 83-88%, on identical questions
and answerer, and nothing recovered it. Sonnet answering costs 30-50x GLM for a difference
inside the noise band. Best value: **glm-5.3-flash on both ends, fixed-15, $0.012/100q**.

### 1. Three REPLICATED temporal-reasoning regressions from the assistant-content change

`single-session-assistant` is **nearly done** — 45.5% → 81.8%, identically in both answer
arms (5/11 → 9/11, the same four questions). See "Assistant-content extraction" below.
Hindsight scores 11/11 on these same 11 rows under dem's own judge
(`docs/plans/2026-09-16-hindsight-differential-report.md`), **but that is NOT a dem ceiling and
should not be read as one** — hindsight passes RAW TRANSCRIPT CHUNKS to its answerer alongside
each fact, so it is not answering from extracted memory the way dem is. See the addendum to
that report. The remaining 2 may still be winnable; they are just not sized by that number.
What the change left behind is the
highest-value diagnosed work: three regressions that flipped in **both**
arms, so they are real, not noise. Each is a separate lever and wants its own measured arm.

- **`gpt4_59149c77` — extraction date drift.** The new prompt attached a *different date to
  the same event* (Jan 15 → Jan 14), turning a 7-day gap into 6. Start by diffing the
  `validStart` the two prompts assign to the same session; this may be a population, not one
  row.
- **`gpt4_7f6b06db` — distractor crowding.** Richer facts displace distinct events out of the
  top 15 ("two Yosemites, no Muir Woods"). **Not the token cap:** `evidence_rows` stayed
  pinned at 15 in every question of every run, median tokens 490 → 887 against a 2000 budget.
  It is rank displacement, so raising `DEFAULT_MAX_CONTEXT_TOKENS` would not touch it.
- **`gpt4_93159ced_abs` — abstention erosion.** More evidence, more willingness to answer
  something adjacent. Both directions of one dial, both replicated: false-refusal 6.3% → 1.1%
  (sonnet) / 8.4% → 3.2% (GLM) while hallucination went 20% → 40% in both (1 → 2 of 5).
  Answerable 77/95 → 84/95, unanswerable 5/5 → 4/5. Read the two together before touching the
  abstention directive — and re-read "Two prompt sentences that cost answers" first.

Also still open, from the same type: **`7161e7e2`** now HAS the full 7×4 shift table in its
evidence row and the answerer still refuses the positional lookup ("the sheet does not specify
Admon's exact Sunday shift"). That is a synthesis failure on correct evidence — the only one
of its kind in the set, and a cheap `diagnose-temporal.ts` dump will show you the exact row.
**All four Hindsight arms answer it correctly** ("On Sunday, the shift rotation for Admon was
the 8am-4pm (Day Shift)"), so the positional lookup is demonstrably answerable from these
sessions; the lever is the reflect prompt, not retrieval.

### 2. `multi-session` — the two arms disagree by 11 points

88.9% (sonnet) vs 77.8% (GLM) on the same 27 questions after the assistant-content change,
having been 74.1% vs 81.5% before it — i.e. the arms swapped which one is ahead. Two of the
27 are known-bad-gold. There is still no diagnosed lever here, and the arm disagreement means
**any multi-session number from a single arm is uninterpretable**. A second
system agrees: Hindsight swings 74.1% → 92.6% across engine models on these same 27 questions,
and its effort-and-model-matched arm ties dem-glm at **81.5% vs 81.5%** — i.e. there is no
architectural multi-session gap to chase, only variance. Run a `diagnose` pass over
the questions where the arms disagree (`36b9f61e` is the cleanest: WIN in sonnet, LOSS in GLM
on identical evidence) before theorising — that set isolates synthesis from retrieval for free.

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

## The extraction cache was re-keyed on 2026-09-17 — the next run is a COLD extract

Removing `confidence` changed the extraction prompt, so the fingerprint moved
`f4752a79 -> 06414f62` and **all 130,779 cached facts are unreachable**. The next bench run
cold-extracts all 19,195 sessions: **~$7 and ~5 hours** at `--extract-concurrency 10`.

Nothing is lost — the old entries are still in `extraction.json` under the old key, so
restoring the prompt line makes them reachable again. But **the n=500 = 87.4% baseline cannot
be reproduced without re-paying**, and any re-extracted number differs from it by extraction
noise regardless of this change. Pair the re-extract with the next change that needs one.

## Can dem replace Strata inside ax? Not as measured — and the blocker is consolidation

Asked and analysed 2026-09-17. **No, and the n=500 win does not argue for it**, because the two
are different layers and the benchmark never tested the part that matters.

**What Strata is.** 8,553 LOC in which retrieval is a slice. The rest is consolidation
(`cluster`, `dedup`, `promotion`, `rollup`, `recurrence`, decay), doc rendering, injection,
rules, tiers, a sensitive gate, bootstrap/reindex. It registers 9 hooks (3 agent tools,
`system-prompt:augment`, the rules hooks) and is consumed by `cli`, `channel-web` (the
`AgentMemory` UI + workspace routes), `chat-orchestrator`, `agent-runner-core`'s prompt engine,
and the aisdk runner's compaction. dem is `retain`/`recall`/`reflect` with no counterpart.

**Storage is the hard blocker.** Strata's memory lives in the agent WORKSPACE as markdown docs
via `workspace:*` hooks (storage-agnostic per invariant 1), with a pluggable index that already
has sqlite AND postgres backends behind a shared contract test
(`packages/memory-strata-index-contract`). dem is bound to a local `better-sqlite3` file —
nothing owns that file in the multi-tenant k8s deployment. dem's native vocabulary (bi-temporal
validity intervals, epistemic networks, RRF channels) is also exactly what invariant 1 forbids
in hook payloads.

**What "consolidation" IS** (`packages/memory-strata/src/consolidator.ts`), one ordered pass:
**decay -> cluster -> decide -> dedup -> write -> delete**.
1. inbox observations older than `DECAY_DAYS = 14` are dropped before anything else;
2. `clusterBySubject` groups them and elects a doc category by majority factType vote;
3. `decidePromotion` drops anything below `CONFIDENCE_THRESHOLD = 0.7`;
4. `isDupe` drops anything with Jaccard token overlap **>= 0.6** against facts already in the
   target doc;
5. append/merge into `docs/<category>/<slug>.md`, near-dup slugs folded by `findNearDupSlug`;
6. **the inbox file is DELETED** — invariant I12, `docs/` is the single source of truth.
Plus quarantine, `system/recent.md` + `map.md` regeneration, a rollup pass, and
`RECURRENCE_THRESHOLD = 2` for procedures to crystallize.

So consolidation is the **lossy compaction step**: a fact is recallable later only if it
survives. **dem has never faced it** — `retain()` writes every fact and nothing ever removes,
merges or decays it, so at query time every fact ever extracted is present. That is why 87.4%
is not evidence dem would win in production.

**How to test it, cheapest first:**
- **Level 0 (free, partly done):** apply each rule's predicate to dem's fact store and count
  what would be dropped. **Already measured: the confidence gate is a no-op** (only 0.2% of
  facts fall below 0.7 — this is also why `confidence` was deleted). **Still to measure: the
  Jaccard >= 0.6 dedup**, which is the one likely to bite, because the assistant-content fix
  deliberately produces long list-shaped objects under repeated subjects. A naive O(n^2) pass
  over 130k facts times out — bound the sample.
- **Level 1 (~1 day, ~$3):** add a post-`retain` consolidation regime to the bench (confidence
  gate, per-subject Jaccard dedup, decay vs the question date) and re-run n=500. **No new LLM
  calls** — all local. This yields the number that actually decides the question.
- **Level 2 (~1 week):** run dem behind Strata's real observer -> inbox -> consolidator as a
  `memory:index:*` backend and use Strata's own e2e bench. True answer; runs into the storage
  blocker above. Note the contract is DOCUMENT-shaped
  (`{docId, category, slug, summary, body, headers}` -> `{snippet, score}`), so dem would be
  reduced to another BM25+vector index and lose the bi-temporal intervals and epistemic
  networks that make it interesting.

**The metric at every level is fact-level SURVIVAL, not aggregate accuracy**: of the
gold-bearing facts, what fraction survive? That is the hard ceiling on post-consolidation
accuracy and it is measurable before any answering happens.

**Meanwhile, the one thing worth harvesting regardless:** Strata scores 59.3% on
temporal-reasoning where dem scores 90.2% on 133 questions. `packages/memory-strata/src/
inject.ts` has **no date handling at all** — no relative time, no "today is". Porting dem's
`When` column (date + weekday + elapsed time computed in TypeScript) and `asOf`-as-grounding
is a prompt change to Strata measured in days, not an architecture swap.

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
9. **MEASURED NOISE FLOOR AT n=100: +/-4-6pp on IDENTICAL code. Nothing smaller than ~4pp
   is detectable here, and a single run per arm cannot detect anything at all.**
   Eight runs, same code, same 100 questions, GLM answerer: 15-row config scored
   86.0/86.0/84.0/82.0 (mean 84.50, sd 1.91), budget-fill config 85.0/83.0/89.0/87.0
   (mean 86.00, sd 2.58). **21 of 100 questions flip at least once across the 8 runs.**
   Cherry-picking the best budget run against the worst 15-row run manufactures **+7.0pp**
   from two configs doing nothing different — larger than any real effect measured on this
   project except the assistant-content fix. With 4 repeats per arm the minimum detectable
   difference is ~3.9pp (t(6), SE 1.61); with one run per arm you cannot estimate variance,
   so no delta is interpretable. Per-TYPE rows sit on n=6-27 and are far worse.
   **Before believing any change: 4+ repeats per arm, or an effect big enough to not care.**
   (This measures answerer + judge variance only — one sample, one extraction cache — so it
   is a LOWER BOUND on the real error budget.) Repeats are cheap: GLM answering is ~$0.02
   per run and the grok judge ~$0.10, so 8 runs cost about $1 on warm caches.
10. **Run BOTH answer arms before believing any per-type delta.** The second arm costs
    ~15 min and cents on warm caches, and it is this bench's cheapest noise filter. On the
    assistant-content change, of 26 flips across the two arms only **7 wins and 4 losses
    replicated**, one question (`36b9f61e`) flipped in OPPOSITE directions, and a headline
    multi-session **+14.8** in one arm showed as **−3.7** in the other. A mechanism story is
    not corroboration — one is equally easy to write for either sign, after the fact. Use
    McNemar on discordant pairs; the runs are paired.
11. **Tests are HERMETIC** (hash embedder, lexical reranker, canned extractors, no
    network). Keep it that way — new retrieval features need deterministic tests.
12. **Memory discipline:** write `.claude/memory/` updates ONLY in this worktree and
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

## Assistant-content extraction — what the fix was (2026-09-16)

`/Users/vpulim/Downloads/assistant-fix.md` prescribed four fixes. **Three of the four were
aimed at causes this codebase did not have** — the second consecutive fix doc for which that
was true. Dumping the cached facts and then the evidence table (~10 minutes, free) showed:

- assistant facts were **already** being emitted with `subject: assistant` and
  `network: experience`, in all six failing sessions;
- retrieval **already** ranked the right session's facts **1–7** in five of six.

What was actually wrong was the detail inside them:
`assistant | generated_song | sad song with lyrics and note sequences` — for a question
asking what the chorus's chord progression was. The line that caused it was
**"Keep objects concise: a phrase, a value, or an outcome."** Do not reintroduce it.

The replacement ports the shape of Strata's proven 2026-08-02 observer contract
(`packages/memory-strata/src/observer.ts`, which moved the same type 25.9% → 83.3%): two
named kinds of fact (USER and ASSISTANT), keep the specifics rather than the topic, keep a
list/table/sequence whole and in order as ONE fact, copy verbatim strings exactly, at most 5
assistant facts each under 400 characters. Measured effect: object length p50 **56 → 189**
chars, max 444 → 564. Newlines in `object`: **0 in 46,654 facts**, before and after — the
markdown evidence table is not at risk from the longer payloads.

A second, independent bug was fixed alongside it: **`memoryStatement` spaced out underscores
in `object`**. `subject`/`predicate` are snake_case by contract, but `object` is free text, so
the stored handle `@jessica_poole_jewellery` reached the answerer as `@jessica poole
jewellery` and it reported a handle that does not exist. The judge named it outright: *"Agent
gives a different Instagram handle (no underscores)."* That one row is `b759caee`.

### What was deliberately NOT built, and why

- **`parseAssistantIntent` regex + query expansion** (doc Fix 2) — no failing question needed
  it; retrieval was already ranking the right session 1–7.
- **A +0.35 RRF boost for `network=experience` AND `subject='assistant'`** (doc Fix 3) —
  **would have made things worse.** `b759caee`'s gold is a WORLD fact
  (`jessica_poole | instagram_account | @jessica_poole_jewellery`); boosting `subject=assistant`
  demotes it beneath the vaguer `assistant | wrote_blog_post`.
- **An `actor: "user" | "assistant"` field on `ExtractedFactSchema`** (doc Fix 1) —
  `subject: "assistant"` already carries the speaker, and a parallel field is two sources of
  truth for one concept.
- **`formatCandidateForReranker`** (doc Fix 4) — `memoryStatement` already emits
  `assistant recommended: X`; the delta was the word "The", against a retrieval stage that was
  not the bottleneck.

### The two questions this did NOT fix

- **`5809eb10`** — gold ("construction began in 2014") sits in a **user-pasted document**, not
  an assistant turn. Outside this lever by construction. The "keep the specifics" rule is
  scoped to assistant facts, following Strata; widening it to long pasted user content is a
  plausible next arm, but it would fatten every fact and wants its own measurement.
- **`7161e7e2`** — the full 7×4 shift table IS in the evidence row now, and the answerer still
  says "the sheet does not specify Admon's exact Sunday shift". Extraction fixed, synthesis
  did not follow through: it will not map `Sunday: Admon, Magdy, Ehab, Sara` positionally onto
  the column header list. The only pure-synthesis failure in the set.

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
│   ├── harness.ts                corpus, stacks, append-only embed cache, stratifiedSample
│   ├── extraction.ts             GLM extractor + prompt/model-fingerprinted fact cache
│   ├── llm.ts                    OpenRouter client (effort "none" omits reasoning)
│   ├── run.ts                    scoring run
│   ├── diagnose-temporal.ts      dump the evidence table a question actually sees
│   └── compare-strata.ts         re-express results in Strata's metrics
├── tests/                        72 passing, hermetic
│   ├── assistant-content.test.ts verbatim objects + extraction-prompt contract
│   └── embed-cache.test.ts       append-only ndjson, legacy adoption, torn lines
├── scripts/verify-db.ts          vec0/FTS5 smoke
└── README.md
```

## Where the reasoning is written down

`/Users/vpulim/dev/ai/ax-next-dem/.claude/memory/decisions.md` — the 2026-09-16 entries
carry the full rationale, the rejected alternatives, and the measurements behind every
claim here. `patterns.md` has the two reusable lessons (dump the prompt before
theorising about retrieval; compute in code the arithmetic you'd otherwise ask a cheap
model to do).
