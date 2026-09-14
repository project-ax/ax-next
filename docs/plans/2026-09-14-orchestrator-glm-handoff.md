# Orchestrator accuracy + GLM model policy — handoff

**For:** the session that picks up retrieval/memory measurement after
2026-09-14.
**Status:** four PRs merged, `main` @ `042210c1`. Nothing half-landed; no branch
left open.
**Artifacts:** `docs/plans/2026-09-11-orchestrator-accuracy-report.md` (isolated
bench, n=500) and `docs/plans/2026-09-14-memory-strata-e2e-report.md` (shipped
stack, n=100).
**Spend to produce them:** ~$86, of which ~$50 was waste — see
[What this cost](#what-this-cost).

---

## Where things stand

Four PRs, in dependency order:

| PR | what it settled |
|---|---|
| #526 | Orchestrator accuracy measured at n=500 — and the bench bug that had been invalidating it |
| #540 | GLM 5.3 Flash for all five service roles; minimal reasoning on orchestrator + memory |
| #541 | That configuration can no longer fail quietly |
| #542 | e2e concurrency (~7min → ~2.5min/question) + the first GLM e2e measurement |

### The two numbers, and why they differ by 40 points

| harness | accuracy | what it measures |
|---|---|---|
| isolated bench (`--config e-map-fts`, n=500) | 33.2% haiku / 36.0% GLM | one-shot answer from a fixed top-K of **truncated** bodies |
| **e2e (`--mode e2e`, n=100)** | **76.0%** | the **shipped** plugin: snippets + `matchedFacts` + `memory_read_section` drill-in |

They are not in conflict and neither is wrong. **The isolated bench's absolutes
are floors** — its answer stage is deliberately lightweight, and raising its
body cap alone was worth +24pp (36.7% → 60.7% on a paired stratified 150). Quote
the isolated numbers for *arm-vs-arm* retrieval comparisons and the e2e number
for anything resembling product quality.

### Model policy, as shipped

| role | model | reasoning |
|---|---|---|
| retrieval-planning | `z-ai/glm-5.3-flash:nitro` (bare) | minimal |
| memory-rollup | `z-ai/glm-5.3-flash:nitro` (bare) | minimal |
| memory-extraction | `openrouter/z-ai/glm-5.3-flash:nitro` (ref) | minimal |
| memory-densify | same ref | minimal |
| title-generation | same ref | model default |

Deliberately **not** moved, each for a reason rather than an oversight: the
agent's own chat turn (the `claude-sdk` runner throws on any provider but
anthropic, and `2026-09-11-model-roles-design.md` decided chat-turn is not a
role), `web-research` (Anthropic **server-side** tools — repointing deletes the
capability), `safety-scan`, and the bench's answer-under-test + judge (a
cross-family judge is what stops the judge grading its own family).

**Operational consequence:** an Anthropic-only host now refuses to boot, naming
`llm:call:openrouter`. Any environment still booting on `ANTHROPIC_API_KEY`
alone needs an OpenRouter key before it comes back up.

---

## Next steps, in the order I would do them

### 1. Re-measure A vs E under the raised body cap — stratified n=150, ~$24

Every n=500 figure in the accuracy report was taken at the old 2,000-char cap
and is a floor. The open question is not just "what are the real numbers" but
**whether the BM25-vs-orchestrator gap widens**: good retrieval should be worth
*more* once the answer stage can use it, so +12pp may understate the
architecture.

n=150 stratified is the right instrument now that `--sample` is representative —
and it is the payoff for that fix, since it costs ~$24 instead of ~$100 at
n=500. Measured cost breakdown, so nobody is surprised:

| arm | Sonnet answer | planner | total |
|---|---|---|---|
| A: BM25-only | $16.23 | — | **$16.44** |
| E + haiku | $4.43 | $0.36 | $5.00 |
| E + glm | $7.08 | $0.05 | $7.34 |

Note the shape: **the BM25 baseline is the expensive arm**, because it always
injects 10 full documents where a planner injects 2–3. The planner is 1.4% of
the bill, so "use the cheap model" is not where the money is.

### 2. Chase `temporal-reasoning` — 59.3% on 27 of 100 e2e questions

The weakest stratum by a wide margin and the largest tied for first. It is also
the one most likely to be a *product* gap rather than a harness artifact:
answering "what did I use before I switched" needs the memory to preserve
supersession, and the consolidator's dedup/promote path is where that would be
lost. Start by reading the 11 failures in the resume JSONL
(`~/.cache/ax-memory-bench/longmemeval-s-e2e/2026-09-14.jsonl`) — each row
carries `question`, `goldAnswer`, `agentAnswer` and `judgeReason`.

### 3. Re-run the map rewrite with the production planner

The map-rewrite cache both E arms consumed is **Grok-authored, from May**.
Holding it fixed is what made the model comparison clean, and it leaves "GLM
planner over a GLM-densified map" unmeasured. Map quality is the lever the whole
c137 design rests on, so this is not a footnote.

### 4. Make a partial run representative — `stratifiedSample` returns corpus order

A flaw in my own fix. The full sample is proportional, but questions come back
in corpus order, so an **interrupted** run has completed a biased prefix (the
easy `single-session-user` block first). Round-robin across strata would make
every prefix representative. It matters because every long run in this repo gets
interrupted — three did in one afternoon.

### 5. Smaller, cheap

- **`--sample` for the isolated bench does not stamp its selection into the
  non-e2e report the way e2e does.** Worth a look for parity.
- **The bench corpora use category `episodes`** (plural) where the runtime's
  `parseDocId` allow-list has `episode`. Harmless today — the bench resolves
  against its own `memoryTree` — but it is the same bench↔runtime drift class
  that cost a paid n=500 run.
- **No board cards exist for any of this.** `CLAUDE.md` says the GitHub "TO DO"
  board is the source of truth; this whole track ran off-board.

---

## Traps found the expensive way

Each of these produced a confident wrong answer before it was caught. They are
listed because the next session will hit the same class.

**1. The bench showed its planner a different map than production does.** The
runtime *stores* `system/map.md` as `## <category>/` + `- <slug>: …` but renders
the planner's prompt through `renderMapForOrchestrator` — flat and fully
qualified. The bench imitated the storage form, so a planner echoing back the
bare slug produced an op resolving to nothing, dropped in silence and covered by
the BM25 fallback. **haiku lost 80% of its plans to it** while picking the same
documents GLM picked. Fixed by *delegating* to the runtime renderer, with
`map-matches-runtime.test.ts` failing if anyone re-inlines a lookalike. The old
`map.test.ts` was *pinning* the broken format, which is why it survived.

**2. `--sample N` was a prefix of a type-ordered corpus.** `--sample 40` was 40
`single-session-user` questions; knowledge-update starts at position 434 and
appeared in nothing. Every small-n number this repo published was drawn that
way, including the n=100 rounds the May report calls "misleading" — they now
have a mechanism. `--first N` preserves the old behaviour for reproducing a
historical run.

**3. The answer stage was reading 14% of the document.** Median gold body 14,424
chars against a 2,000-char cap; on 17% of questions *every* matching answer token
sat past the cut. Worth **+24pp** (z=4.16) with false-refusal collapsing 51% →
19.6% — the agent was not failing to reason, it was saying "I don't know" about
evidence that had been cut off. `pnpm --filter @ax/memory-strata
bench:diag-truncation` measures it, no API calls.

**4. A `ps`/`pgrep` pattern that does not match is not evidence a process is
dead.** Hit twice in one session. `pgrep -f "tsx test/bench"` returns nothing
while the run is alive — the real cmdline is `node …/tsx/…/cli.mjs
test/bench/cli.ts`. The working pattern is **`pgrep -fl "bench/cli.ts"`**. First
occurrence ran every arm of an n=500 bench twice (~$25); second launched a
duplicate e2e run onto a live one. *Corroborate a negative process check against
the artifact the process touches* — output mtime, checkpoint row count.

**5. A max is not a tail.** I wrote "GLM's tail is 4133ms, that risk is real"
into the code and the chart, sourced from an existing comment's table rather than
from the 500-call run I had just produced, which measured p95 1603ms. 4133ms is
the worst call in a *good* window. Latency claims now cite p50 **and** p95 **and**
the sample size, and name the run. `bench:latency` costs ~$0.02 and has a no-flag
control arm — run it twice before writing a number down.

**6. macOS `Pages free` is not a health metric.** It sits near zero by design.
0.4GB "free" alongside 15GB reclaimable read as a crisis. Use free + inactive +
purgeable.

---

## What this cost

~$86 total, and it is worth knowing which parts were avoidable.

| | |
|---|---|
| the n=500 accuracy round (3 arms) | ~$25 |
| …**run twice**, from trap #4 | ~$25 wasted |
| …**discarded entirely** for trap #1 and re-run | ~$16 |
| truncation control/treatment (n=150 ×2) | ~$7 |
| latency probes ×2 | ~$0.04 |
| e2e GLM run (n=100) | $7.28 |
| …duplicate question from trap #4, second occurrence | $0.07 |

The two instrument failures (#4, #5) and the fidelity failure (#1) account for
essentially all of the waste. None of them announced themselves — each produced
a plausible number that was wrong, which is the argument for the guards that
landed alongside the fixes.

---

## Running things again

```bash
set -a && . ./.env.walk && set +a          # ANTHROPIC + OPENROUTER + ZEROENTROPY

# isolated bench, one arm, stratified
pnpm --filter @ax/memory-strata bench --corpus longmemeval-s --config e-map-fts \
  --orchestrator-model glm --sample 150 --out docs/plans/<name>.md

# the shipped stack, parallel
pnpm --filter @ax/memory-strata bench --mode e2e --orchestrator-model glm \
  --sample 100 --concurrency 4 --cap 60

# free diagnostics
pnpm --filter @ax/memory-strata bench:diag-truncation
pnpm --filter @ax/memory-strata bench:latency
```

e2e checkpoints after **every** question to
`~/.cache/ax-memory-bench/longmemeval-s-e2e/<date>.jsonl`; resume with
`--resume <date>` and completed questions are skipped, not re-paid. A kill costs
at most one question (~$0.07). Every report now stamps the planner, the sampling
method with its resulting type mix, the answer-stage body cap, and per-model
spend — a number whose measurement conditions are not written down eventually
gets compared against one measured differently, which is the thread running
through every trap above.
