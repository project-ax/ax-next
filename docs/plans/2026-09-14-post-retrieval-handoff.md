# Retrieval is done. The bottleneck moved. — handoff

**For:** the session that picks up memory accuracy after 2026-09-14.
**Status:** the orchestrator-accuracy handoff (`2026-09-14-orchestrator-glm-handoff.md`)
is fully executed — all five steps plus TASK-362. **One loose end: the work is on
an unpushed local branch.** See [Before anything else](#before-anything-else).
**Spend:** ~$61. Roughly $15 of it bought a negative result that should stop a
much larger investment; almost none of it was waste.

---

## Before anything else

Seven commits sit on **`orch-glm-followups`**, a local branch with **no
upstream**, in the worktree `.worktrees/orch-glm-followups`. Nothing is pushed
and no PR exists. 730 tests pass, typecheck is clean.

```
ccbe20f8  docs(bench): un-truncating the map bought nothing (TASK-362)
153deda9  fix(bench): the dead-map-line metric counted a clause as a whole line
8db7adf3  docs(bench): the GLM-authored map did not beat the Grok one (step 3)
8cc59d29  feat(bench): make the map summary cap measurable and settable (TASK-362)
90a64675  fix(bench): meter the map-rewrite path, which spent ~$7 and reported nothing
8a885b1d  docs(bench): re-measure A vs E under the raised body cap — the gap 2.2x'd
4f1b0317  fix(bench): make every prefix of a stratified run representative
```

Open the PR before starting anything new. If it is stale by the time you read
this, rebase rather than re-deriving — the reports in `docs/plans/` are the paid
artifacts and cannot be regenerated for free.

---

## The conclusion, so you do not re-litigate it

**Retrieval is solved well enough that it is no longer the bottleneck.** Do not
spend another dollar tuning it without a new reason.

| settled | number |
|---|---|
| orchestrator beats BM25-only | **+32.6pp** (30.7% → 63.3%), z=5.67, **and 44% cheaper** |
| answer-stage body cap at 20,000 | +24pp; the most valuable single change on the track |
| GLM 5.3 Flash as planner, minimal reasoning | tied with haiku on accuracy (z=0.93), better recall, 7.5× cheaper |
| recall@5 in every orchestrator arm | **88–93%** |

**And what is settled NOT to pursue — this is the expensive half of the lesson:**

Map fidelity is not the lever. Three maps, spanning **13.6% → 0.1% dead
(unselectable) lines** and **90% → 0% mid-word truncation**, and *no variant is
distinguishable from another* (Bonferroni α=0.0167 over three comparisons). Both
properties anyone would fix first were fixed and the number never moved up. The
c137 premise that "map quality is the lever the whole design rests on" is **not
supported** by any measurement this repo has taken.

The mechanism generalises, so carry it forward: **a map line is a routing label,
not evidence.** Once the planner selects a document, its full body is injected up
to 20,000 chars. Truncating the label barely hurts routing; truncating the *body*
starved the answer stage. That is why one cap was worth +24pp and the other worth
nothing — and it predicts which future caps will matter.

Two hypotheses are dead. Do not restart from either:

- **supersession loss in the consolidator's dedup/promote path** (the previous
  handoff's guess) — *zero* of the 11 temporal-reasoning failures involve it.
- **map densification / un-truncation / dead-line cleanup** — measured, no effect.

---

## Next steps, in the order I would do them

### 1. TASK-361 — where is the specific value lost? Free.

The best-motivated card on the board, and it costs nothing.

All **9 false refusals** in the n=100 e2e run share one shape: the agent
retrieves the right document and narrates that the specific value is not in it.

> "only capture the general topics we discussed" (gold: 38 subjects)
> "captures the melodies … but not the chord progressions"
> "mention you exploring **bluegrass music**" (gold: the band's name)

Mean `toolCalls` on false refusals is **2.9, the highest of any verdict**
(correct: 2.0). It searches harder and finds only the topic. This is not
retrieval — it is Observer extraction or consolidator densification preserving
the subject and dropping the number, the year, the proper noun.

**The task:** for those 9 question ids, dump the memory state the agent actually
had and check whether the gold value appears anywhere in `docs/` or only in the
raw session. That separates *extraction never captured it* from *consolidation
later dropped it* — different fixes, and the resume JSONL cannot tell them apart.
No API calls.

Hits `single-session-assistant` hardest (**36% false refusal, zero wrong
answers**) — the purest signal, because those questions ask only for a figure
from a past turn. Note it starts at corpus position 434, so **only `--types`
reaches it**; `--sample 100` contains none.

### 2. TASK-363 — anchor-event selection. Scope after 361.

7 of 27 temporal questions answered wrongly, the highest wrong-answer rate of any
type. Retrieval surfaces a plausible *neighbour* and nothing checks that the
chosen event is the one the question names: answered Sequoia where gold is Muir
Woods, Volleyball where gold is the 5K Run; and "Mar 17 → May 15 = 59 days" where
the arithmetic is right and the anchor is wrong. A retrieval/answer-stage
concern — do **not** fold it into 361's memory-fidelity fix.

### 3. TASK-364 — false premise gets repaired, not refused. Small.

One case, narrow, batch it. Abstention is otherwise healthy (4 correct refusals,
lowest mean toolCalls of any verdict).

### 4. Close TASK-362.

Answered (no). Move to Done when the PR merges. The card body carries the result.

---

## Traps found the expensive way

**1. `--rewrite-map` over a populated cache is a silent no-op.** The rewrite is
incremental by body hash, so it skips everything, prints `19195/19195` and
`Done. 19195 summaries in cache`, and exits 0 having made **zero API calls** —
output that was indistinguishable from the real 58-minute run. You can regenerate
a map, observe success, and measure the old one. **The cache must be moved aside
first.** `90a64675` added spend to the progress line, so `$0.00` is now the tell.

**2. A metric that greps for a phrase counts a clause as a whole line.** The
dead-map-line metric searched for "no personal details". A rewriter with room
writes informative lines that merely *end* with that clause — and the clause is
truncated away at 120 chars and survives at 400. So the metric reported the
cut-400 map **degrading** (3.8% → 6.4% dead) precisely because it had stopped
being mutilated. It counted 1,226 dead lines where 18 were dead, and it made
GLM's real advantage look 10× smaller (4× rather than 45×). Strip the clause,
then ask what is left (`isDeadLine`, pinned by a test).

**3. `gh project item-list` silently truncates at its limit.** A first query at
the default limit reported "0 items in To Do" for a board that had 12. Pass
`--limit 400` and check the count against the total. Companion to the previous
handoff's trap #4: *a negative result from a query is not evidence of absence
until you have checked the query could have seen a positive one.*

**4. `Pages free` is not the only macOS memory trap — so is the page size.**
Deriving "3.7 GB available" on a machine that had 14.8 GB, because the arithmetic
assumed 4 KB pages and Apple Silicon uses **16 KB**. Read the page size out of
`vm_stat`'s own header rather than assuming it.

**5. A proportional sample still yields a biased prefix.** `stratifiedSample`
allocated proportionally then sorted back into corpus order, so a run was
representative only once it *finished* — and e2e checkpoints per question and
gets interrupted routinely. Fixed in `4f1b0317`; the test that asserted the old
ordering was *pinning* the defect and is replaced, not deleted.

---

## State of the world

**Map caches** — `~/.cache/ax-memory-bench/longmemeval-s/`, three named variants,
with the published baseline active:

| file | map | dead | cut |
|---|---|---|---|
| `map-rewrites.json` **(active)** = `map-rewrites.grok-may.json` | Grok, May | 13.6% | 59.3% |
| `map-rewrites.glm120.json` | GLM @ cut 120 | 0.3% | 90.0% |
| `map-rewrites.glm400.json` | GLM @ cut 400 | 0.1% | 0.0% |

The Grok map is active deliberately: every published E number was measured
against it, and it is not beaten by either alternative. **Restore it if you swap
one in.**

**Reports** (`docs/plans/`, all on the branch):

- `2026-09-14-bodycap-remeasure-report.md` — A vs E, the +32.6pp result
- `2026-09-14-glm-map-rewrite-report.md` — step 3, a non-result
- `2026-09-14-task362-map-cap-report.md` — the map cap, a negative result
- `2026-09-14-temporal-reasoning-triage.md` — the 11 failures, free

**Which number to quote.** The isolated bench is for **arm-vs-arm comparison
only**; its absolutes are floors. **76.0% (e2e, n=100) is the product number.**
n=150 resolves about **±11pp** — adequate for A-vs-E, genuinely underpowered for
the map comparisons, which is why those are reported as non-results rather than
as an 8- or 11-point reversal.

---

## Running things again

```bash
set -a && . ./.env.walk && set +a          # ANTHROPIC + OPENROUTER + ZEROENTROPY

# free diagnostics — run these before paying for anything
pnpm --filter @ax/memory-strata bench:diag-truncation        # answer-stage bodies
pnpm --filter @ax/memory-strata bench:diag-map-truncation    # map lines
pnpm --filter @ax/memory-strata bench:diag-map-truncation --probe 60   # ~$0.07

# isolated bench, one arm, stratified. --out is REQUIRED for concurrent arms:
# the default path is date-stamped, so two arms overwrite each other.
pnpm --filter @ax/memory-strata bench --corpus longmemeval-s --config e-map-fts \
  --orchestrator-model glm --sample 150 --out docs/plans/<name>.md

# the shipped stack (the product number), parallel
pnpm --filter @ax/memory-strata bench --mode e2e --orchestrator-model glm \
  --sample 100 --concurrency 4 --cap 60

# regenerate the map — MOVE THE CACHE ASIDE FIRST or this does nothing
mv ~/.cache/ax-memory-bench/longmemeval-s/map-rewrites.json{,.keep}
AX_BENCH_MAP_SUMMARY_CHARS=400 pnpm --filter @ax/memory-strata bench \
  --corpus longmemeval-s --rewrite-map
```

**Cost shape, so nothing surprises you.** ~70% of spend is **Sonnet answering**,
~27% authoring maps, **~2% the judge**. Do not try to save money on the judge —
cross-family judging is what stops a model grading its own family. The expensive
arm is **BM25** ($14.27 vs E's $7.99), because it injects 10 documents where the
planner injects 2.95.

A run costs ~$8/arm at n=150 and checkpoints only in e2e mode; the isolated bench
has **no resume**, so an interrupted isolated run loses everything.

**Liveness.** `pgrep -fl "bench/cli.ts"` is the pattern that matches. Progress
prints only every 50 questions, so silence is normal — corroborate against CPU
time (≈100% means still indexing, well under means it is calling APIs) and the
log's mtime. `ps`-based negatives have twice caused duplicate paid runs here.

**Credits.** OpenRouter ran dry mid-run once. The key's own limit was fine; the
*account credit balance* was the binding constraint and the error says
`in_flight_budget_exhausted`. Check with:

```bash
curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  https://openrouter.ai/api/v1/credits
```

The map rewrite resumes cleanly from its cache — when it died at 7,450/19,195 the
restart re-paid nothing.
