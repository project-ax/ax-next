# Answer-stage screen — is the rest inference budget, answer discipline, or memory?

**The question:** after TASK-365/368 partitioned the 24 scored failures of the
2026-09-14 n=100 run, how much of what is left is reachable from the **answer stage**
at all?

**Answer: answer discipline is real and cheap. Inference budget is not the lever. And
the extraction gap is not reachable from the answer stage at all.**

Two arms over the same 24 failures, one variable each, everything else — memory,
ingest, retrieval, planner, judge — identical to the scored run.

| | raw fixes | **variance-adjusted** | cost vs baseline |
|---|---|---|---|
| **A — thinking** (`adaptive` @ `effort: high`) | 5 | **1** | 1.12× |
| **B — scaffold** (recall discipline) | 11 | **6** | **1.06×** |

**Cost: $4.60 all-in** ($2.24 scaffold + $2.36 thinking), against a ~$4 estimate.

---

## Why "adjusted" is the only honest column

Five of the raw fixes are rows **TASK-365 already showed answer correctly on a plain
redraw with no code change at all** — `gpt4_fa19884d`, `gpt4_5dcc0aab`, `993da5e2`,
`gpt4_5438fa52`, `0e5e2d1a`. They appear in both arms' raw counts and are evidence for
neither.

Reporting 11 vs 5 would have been a ~2× overstatement of both arms. That netting-out is
the single most valuable thing TASK-365 bought, and it is the reason this screen was
gated on a variance measurement rather than run first.

---

## The cleanest result: the four rows with a real control

Only four of the 24 have a *measured* control — TASK-365 replayed them and they refused
**twice**, unaided. Everything that happens to these rows is attributable.

| row | control | scaffold | thinking |
|---|---|---|---|
| `352ab8bd` | stable (refused 2×) | refused | refused |
| `5809eb10` | stable (refused 2×) | refused | refused |
| `7024f17c` | stable, **bad gold** | refused | refused |
| `eaca4986` | stable, **bad gold** | wrong | refused |

**Neither arm moved either TASK-366 extraction row — 0 of 2.** These are the only rows
in the set with proven-stable baselines, and no amount of answer-stage discipline or
thinking touched them. The agent keeps reporting, accurately, that its memory holds the
review activity and not the paper's numbers.

**So the extraction gap is not an answer-stage problem.** TASK-366 hardens from "the
best-evidenced card" into the one confirmed memory defect that the answer stage
demonstrably cannot reach.

---

## Arm B — the rules that fired, and the one that did not

Six adjusted fixes, each traceable to a rule written for it **in advance** (the mapping
was published in `2026-09-15-c137-oracle-diff.md` before this run):

| row | rule | what changed |
|---|---|---|
| `91b15a6e` | respect the qualifier | baseline invented a "$200 minimum" for the vanity; arm used the user's own "at least $150" → **$5,150 exactly** |
| `d24813b1` | advice questions are memory questions | baseline opened with cookies; arm opened *"Lemon Poppyseed Cake — you made this for a colleague's going-away party and it was a big hit"* |
| `a2f3aa27` | newest value wins; approximate resolves to the value | baseline gave "1,250–1,300"; arm gave *"approximately **1,300** — up from 1,250 noted slightly earlier"* |
| `4b24c848` | caveat after the answer, never in place of it | *"The most recent record shows you owned **5 H&M tops**"* — leads with the value, hedge follows |
| `c9f37c46` | resolve dates before computing | the Feb→Apr "roughly 3 months" slip (gold: 2 months) |
| `gpt4_e061b84f` | an intention is not an occurrence | stopped substituting a *planned* volleyball game for the Midsummer 5K |

`gpt4_e061b84f` is the only row **both** arms fixed — the plans-as-events mechanism is
reachable either by instruction or by more inference budget.

**The rule that missed.** `6a1eabeb` is a clean failure of the arm's own
newest-value-wins rule: the corpus supersedes a 27:12 personal best with 25:50, and the
arm still returned **27:12**. Same rule, two hits (`a2f3aa27`, `4b24c848`) and one miss.
That miss is most likely retrieval never surfacing the later value — which makes it a
memory row wearing an answer-stage costume, and worth checking before anyone counts it
against the scaffold.

---

## Arm A — thinking bought almost nothing

One adjusted fix (`gpt4_e061b84f`), which the scaffold also got, at **higher** cost.

This matters because c137's published data made thinking look like the big lever: their
GPT-4o run (no thinking) scores 82.4% and their Gemini-Pro run (thinking on) 94.0%. But
that comparison moves **four** variables at once — model family, thinking, `max_tokens`
4,000 → 24,000, and the scaffold. It cannot isolate thinking, and their own README says
the scaffold was swapped because "4o followed the long scaffold poorly".

This arm can isolate it, and does: **on our stack, `adaptive` thinking at `effort: high`
is not where the remaining points are.** The honest reading of c137's spread is that it
is mostly *model*, not *thinking*.

Two operational notes for whoever scopes TASK-371 properly:

- Thinking raised tool calls (e.g. `0a995998` 2 → 4) and settled at 1.12× cost, not the
  1.5× the first rows suggested.
- Our answer stage had been running with **no `thinking` parameter at all**, which on
  Sonnet 4.6 means thinking is **off**. That was an omission, not a decision — there is
  no comment anywhere justifying it. It is now a flag.

---

## What this screen CANNOT tell you, and it is the important caveat

**Every one of the 24 rows was already a failure.** So there is no regression risk
inside the sample — and **no information at all about the 76 rows that were already
correct**.

That is not a hypothetical worry for arm B. Watching its answers:

- `88432d0a` — the arm argued with itself mid-answer (*"last Saturday = May 20… wait,
  actually…"*) and introduced an "apple pie in the cast iron skillet" that does not
  appear in the evidence sessions. Written working-out appears to invite invention while
  enumerating.
- `9a707b81` — went from a wrong **answer** to a **refusal**, growing the false-refusal
  bucket. That is the trade TASK-370 explicitly calls a failure rather than a tradeoff.
  Arm A regressed nothing.

**Six adjusted fixes out of 24 known failures is a screen result, not a product result.**
It earns a full n=100 confirmation; it does not justify shipping the scaffold.

---

## Every row

```
question           label    control               scaffold   thinking   
------------------------------------------------------------------------
0a995998           badgold  no control run        incorrect  incorrect  
88432d0a                    no control run        incorrect  incorrect  
7024f17c           badgold  stable (refused 2x)   abstained  abstained  
32260d93                    no control run        incorrect  incorrect  
d24813b1                    no control run        FIXED      incorrect  
91b15a6e                    no control run        FIXED      incorrect  
gpt4_7f6b06db               no control run        incorrect  incorrect  
9a707b81                    no control run        abstained  incorrect  
gpt4_4fc4f797               no control run        incorrect  incorrect  
gpt4_e061b84f               no control run        FIXED      FIXED      
6e984301                    no control run        incorrect  incorrect  
gpt4_fa19884d               UNSTABLE (flipped)    FIXED      FIXED      
gpt4_5dcc0aab               UNSTABLE (flipped)    FIXED      FIXED      
c9f37c46                    no control run        FIXED      incorrect  
993da5e2                    UNSTABLE (flipped)    FIXED      FIXED      
gpt4_5438fa52               UNSTABLE (flipped)    FIXED      incorrect  
gpt4_93159ced_abs  strict   no control run        incorrect  incorrect  
6a1eabeb                    no control run        incorrect  incorrect  
4b24c848           strict   no control run        FIXED      incorrect  
a2f3aa27           strict   no control run        FIXED      incorrect  
0e5e2d1a                    UNSTABLE (flipped)    FIXED      FIXED      
352ab8bd                    stable (refused 2x)   abstained  abstained  
5809eb10                    stable (refused 2x)   abstained  abstained  
eaca4986           badgold  stable (refused 2x)   incorrect  abstained  
```

## What changes on the board

| card | change |
|---|---|
| **TASK-366** | **Hardened.** Its two rows are the only proven-stable failures in the set, and **neither arm moved either one**. The extraction gap is confirmed unreachable from the answer stage. This is the memory defect. |
| **TASK-370** | **Screen passed; do not ship on it.** 6 adjusted fixes at 1.06× cost, each traceable to a named rule. Next step is an n=100 confirmation that measures the **76 currently-correct rows** and the `_abs` split, not another failure-set screen. |
| **TASK-371** | **Reduce scope.** Thinking at `effort: high` is not the lever on our stack. The live question is the one this arm did NOT test: the **answer model** (we are on previous-generation `claude-sonnet-4-6`; `claude-sonnet-5` is newer *and* cheaper at $2/$10 vs $3/$15). |
| **TASK-369** | Still unrun and still gates any small claim. 15 of the 19 attributable rows here have **no control draw**, so the adjusted numbers are an **upper bound** on both arms. |

## Reproducing

```bash
set -a && . ./.env.walk && set +a
IDS=0a995998,88432d0a,7024f17c,32260d93,d24813b1,91b15a6e,gpt4_7f6b06db,9a707b81,\
gpt4_4fc4f797,gpt4_e061b84f,6e984301,gpt4_fa19884d,gpt4_5dcc0aab,c9f37c46,993da5e2,\
gpt4_5438fa52,gpt4_93159ced_abs,6a1eabeb,4b24c848,a2f3aa27,0e5e2d1a,352ab8bd,5809eb10,eaca4986

# arm A — inference budget
pnpm --filter @ax/memory-strata bench --mode e2e --orchestrator-model glm \
  --ids "$IDS" --cap 3 --resume <fresh-id> --answer-effort high

# arm B — answer discipline
pnpm --filter @ax/memory-strata bench --mode e2e --orchestrator-model glm \
  --ids "$IDS" --cap 3 --resume <fresh-id> --answer-scaffold
```

The two arms can run concurrently — `runE2EQuestion` takes a fresh `mkdtemp` workspace
per question, so there is no collision. **But they share one output path:** `--out` is a
no-op in `--mode e2e`, so both write
`docs/plans/<date>-memory-strata-e2e-report.md` and the second finisher silently
overwrites the first. That happened on this run (the thinking arm's report survived; the
scaffold's was lost). The resume JSONLs are the authoritative artifact — the `.md` is
derivative. Copy it aside per arm, or accept losing one.

Scoring is free and re-runnable from the JSONLs:
`~/.cache/ax-memory-bench/longmemeval-s-e2e/{2026-09-14,repro-rate,arm-scaffold,arm-thinking-high}.jsonl`.

Sources: `docs/plans/2026-09-15-c137-oracle-diff.md` (which rule targets which row, published
before this run), `docs/plans/2026-09-15-task-365-repro-rate-report.md` (the control),
`docs/plans/2026-09-15-task-368-gold-quality-audit.md` (bad-gold and strict-scored labels).
