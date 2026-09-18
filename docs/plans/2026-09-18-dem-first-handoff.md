# HANDOFF — DEM-first memory, rungs 0 and 1

**Written:** 2026-09-18, at the end of the session that produced PRs #578, #587, #588, #589.
**Read first:** `dem-memory/HANDOFF.md` (the bench's own handoff — install recipe, noise floors,
the asOf/temporalAnchor gotcha). This file is the layer above it: what the DEM-first ladder has
established, what is open, and what will bite you.

---

## 1. State of play

Four PRs, a **stack**, each based on the one above. Review and merge in order.

| PR | branch | base | what |
|---|---|---|---|
| [#578](https://github.com/project-ax/ax-next/pull/578) | `dem-rung0-measurements` | `main` | rung 0 — three measurements + one unplanned finding |
| [#587](https://github.com/project-ax/ax-next/pull/587) | `dem-slot-supersession` | #578 | §3.3–3.4 in `src`, behind a flag |
| [#588](https://github.com/project-ax/ax-next/pull/588) | `dem-deterministic-ids` | #587 | content-derived row ids, default flipped, with arms |
| [#589](https://github.com/project-ax/ax-next/pull/589) | `dem-rung1-rescoped` | #588 | rung 1, re-scoped |

All four are `MERGEABLE`. **#578 has 9/9 CI green. #587–#589 report NO CHECKS** — this repo's CI
only triggers on PRs based on `main`, so the stacked ones are unverified by CI until each is
rebased onto `main` as its predecessor merges. All of them pass the full local gate (below).

Worktree: `/Users/vpulim/dev/ai/ax-next/.claude/worktrees/dem-rungs`, branch
`dem-rung1-rescoped` (the stack tip), clean.

**Reports, all in `docs/plans/`:**
- `2026-09-18-dem-rung0-report.md` — rung 0, with two in-place corrections (see §4)
- `2026-09-18-dem-deterministic-ids-report.md` — the id arms
- `2026-09-18-dem-rung1-report.md` — rung 1, re-scoped
- `2026-09-18-dem-first-memory-design.md` — the spec all of this is testing

---

## 2. What was established

**Rung 0 gates.** `assistant | recommended` closes 0 rows under the slot design: **PASS**, and
stronger than asked — max rows closed by any one statement is **1**, against DEM's **622**.
Normalizer precision: **FAIL as specified**. The embedding nearest-neighbour scores **13.2%**
precision on a uniform random sample of what it maps and misplaces **6 of 32 canonical
spellings** (`first name` → `birthday` at 0.834). Structural, not tuning: eight descriptions
partition the relation space into eight attractor cells. Above threshold 0.88 it maps nothing.
**The exact-synonym table is 100% precise by construction** and maps 442 facts (0.34%).

**The graph channel does nothing.** Returns any candidate on 2/100 questions, contributes 0–1
unique rows to 1,500, coverage identical on/off across three runs and two rerankers. **Decision:
drop it.** *This has NOT been done yet* — see §3.

**Retrieval was not reproducible.** `randomUUID()` ids meeting `id.localeCompare` tie-breaks:
same question ingested twice gave a different top-15 on **12/12** questions, with different row
sets. Fixed; `content` is now the default; the probe reads **0/N**.

**Rung 1 passes.** Only **16 of 500** questions can change under the slot rule (the other 484 are
provably identical), so scoring those 16 gives the exact corpus delta: **+0.20pp**. The
deterministic-id change costs nothing detectable: **−0.30pp, p = 0.59**, against a 1.6pp floor.

---

## 3. Open work, highest value first

### 3.1 Merge the stack

Four PRs, in order. As each merges, rebase the next onto `main` so CI actually runs on it.
Nothing in the stack depends on anything outside it.

### 3.2 Drop the graph channel (decided at rung 0, not yet done)

Pure subtraction, no measurement needed beyond what #578 already contains.
`MemoryRepository.batches()` has exactly one caller (the rebuild in `createDemMemory`) and
`matchEntities` exactly one production caller (`recall.ts`), so `dem-memory/src/graph/`, the
`graph` parameter on `RecallEngine` and `RetainEngine`, the rebuild in `setBank`, and
`stats().graphNodes/graphEdges` all go with it. Re-run `bench/graph-ablation.ts` afterwards to
confirm coverage is unchanged.

### 3.3 The knowledge-update problem — needs a design decision, not code

`031748ae` went 4/4 → 2/4 because the slot rule closed
`user | works_as | Senior Software Engineer (new role)`, a gold row, on a knowledge-update
question. **The mapping `works_as → role` is correct.** The closure is still wrong, because
`validityClause` defaults to `valid_end = INFINITY` — a closed row leaves the candidate set
entirely — and a knowledge-update question asks about the *transition*, not the current value.

§4.2 of the design gives the agent no way to ask for history. Keeping `at` off the tool was
right (it is the footgun the DEM README warns about); **"show me superseded values too" is a
different and safer request** and nobody has designed it. One question in 500 here, but
knowledge-update is one of LongMemEval's six types and the one DEM already scores 87–88% on.

### 3.4 Rungs 2–6

Untouched. §8 of the design has them. Before decomposing them into board cards, note that
rung 0 and rung 1 both found the specified rung was the wrong experiment — expect the same.

---

## 4. Things this session got wrong. Do not re-derive them.

**The noise-floor claim failed its own test.** The rung-0 report originally said retrieval
nondeterminism was "a concrete, removable part" of the bench's 1.6pp floor. Measured: the
deterministic arm's spread is **0.91pp against the control's 0.50pp — wider, not tighter**. At
n=4 that is not evidence either way, but the prediction was directional and came out against.
Retracted in place in both the report and the probe header. **The floor is dominated by the
answerer and the judge**, exactly as the published figure always said. The determinism finding
stands on the probe, which is a property of the store, not a statistic about scores.

**§3.4's rule 2 is wrong as written** ("if an **active** row has `R'.when > S.when`"). It
produces overlapping intervals when three values arrive newest-first. Both implementations now
end every row **open at** the new statement's start. Found only by testing all six arrival
orders — no single-order test sees it.

**A.4's replay method overstates DEM's closure rate ~3.4× at conversation scope.** The replay
treats a bank as one flat stream; `retain()` runs the invalidation loop before inserting the
batch's own rows. Flat 245, `--batch batched` 71, real ingest 75. `flat` stays the default so
the script still reproduces A.4; quote `--batch batched` for anything about the product. **The
lifetime column is unaffected** and that is where rung 0's argument lives.

**Three measurement traps, all now guarded but worth knowing:**
1. Reporting one arm's closures implies it is the only agent. The baseline closes **more** (75
   vs 59), and on the biggest mover the slot arm closes nothing.
2. An **in-flight** run passes a "no errors" filter. `ids-det-4` read 89.5% at 19/500 and
   inflated a treatment mean by 0.7pp. **Gate on the denominator.**
3. A **resumed** run keeps its stale `error` rows and the summary line double-counts. **Read the
   last row per `question_id`.**

---

## 5. How to run anything here

Environment: `dem-memory/` is a standalone **npm** sub-project — use `npm`, not `pnpm`, inside
it. Install is `npm install --ignore-scripts` then `npm rebuild better-sqlite3 esbuild`.

**The bench caches are gitignored and live in the OTHER worktree:**
`/Users/vpulim/dev/ai/ax-next/.claude/worktrees/dem-memory/dem-memory/bench/cache/`
(`extraction.json` 65 MB, `embeddings.ndjson` 1.5 GB). This worktree reaches them through a
**symlink** at `dem-memory/bench/cache`. If you make a fresh worktree, recreate it:

```bash
ln -s /Users/vpulim/dev/ai/ax-next/.claude/worktrees/dem-memory/dem-memory/bench/cache \
      <your-worktree>/dem-memory/bench/cache
```

`dem-memory/.gitignore` says `bench/cache` without a trailing slash precisely so that symlink is
ignored; do not "fix" it back.

**Always pass `--fingerprint f4752a79`.** It pins the extraction generation behind the 87.4%
baseline, is read-only, and errors on a miss. Without it a run cold-extracts 19,195 sessions for
~$7 and ~5 hours.

**Credentials.** Vertex embeddings need only `GOOGLE_CLOUD_PROJECT=canopy-ai-498321` plus gcloud
ADC. Cohere and OpenRouter keys live in `/Users/vpulim/dev/ai/ax-next/.env.walk` — never copy it
into the repo or echo its values. A small wrapper script that `source`s it is the way; the ones
this session used were in the session scratchpad and are gone, so recreate as needed:

```bash
#!/bin/bash
set -euo pipefail
set -a; . /Users/vpulim/dev/ai/ax-next/.env.walk; set +a
export GOOGLE_CLOUD_PROJECT=canopy-ai-498321
export NODE_OPTIONS=--max-old-space-size=10240
cd /Users/vpulim/dev/ai/ax-next/.claude/worktrees/dem-rungs/dem-memory
exec npx tsx "$@"
```

**The offline analyses** (no LLM calls; `bench/README.md` lists them):

```bash
npx tsx bench/supersession-replay.ts   --fingerprint f4752a79 [--rule slot] [--order session] [--batch batched]
npx tsx bench/normalizer-eval.ts       --fingerprint f4752a79 [--threshold 0.78] [--write]
npx tsx bench/graph-ablation.ts --n 100 --fingerprint f4752a79 --stack vertex
npx tsx bench/reproducibility-probe.ts --n 12 --fingerprint f4752a79   # must read 0/N
npx tsx bench/closure-impact.ts --n 500 --fingerprint f4752a79 [--ids a,b,c]
```

**Use `--stack vertex` for anything that compares two evidence tables.** `rerank-v4.0-pro` is
not reproducible — three calls with byte-identical input gave a third differing by 4.26e-3, and
~22% of top-15 tables reorder between identical calls. `--stack production` is for scored runs.

**A scored run** is ~57 min at n=500 alone, ~5 s/question; three concurrent is fine on 36 GB.
`bench/run.ts --ids <list>` scores a named subset — its TOTAL is **not** a corpus accuracy and
the run says so.

**The gate before any PR** (from CLAUDE.md, and note the two opposite traps it documents):

```bash
cd dem-memory && npm run typecheck && npx vitest run     # 193 tests at the stack tip
cd .. && pnpm test:scripts && pnpm test:eslint-rules && npx eslint .
```

`dem-memory/**` is outside the pnpm workspace and eslint-ignored, so the repo-wide
`pnpm -r run test` is unaffected by anything in it.

---

## 6. Two environment facts

**Disk.** `/System/Volumes/Data` was at 874 GB of 926 GB with ~600 MiB free at one point this
session and killed a run with `ENOSPC` at 71%. It recovered to 38 GB free on its own. The bench
caches are only ~1.6 GB of that, so this is not the bench's doing — but check `df` before a long
run.

**Vertex embedding quota.** 12 concurrent workers over 5-instance calls is ~95 req/s and returns
429; the embedder's own retry gives up after 4 attempts so the job dies rather than slows. 5
workers is ~130–200 relations/s and runs clean.
