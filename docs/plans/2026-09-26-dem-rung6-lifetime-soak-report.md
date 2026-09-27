# Facts-memory lifetime soak (rung 6) — TASK-520

## Outcome

**Partial: measured to 50,000 rows, not to 500,000.** The run stopped itself at the disk
guard before the 130k checkpoint: the machine's data volume had about 1 GB free, and the
next step needed roughly 0.33 GB plus a 1 GiB reserve. Nothing was lost; everything up to
50k was captured, and the three stages that grow are linear across all four points, so the
larger sizes below are **extrapolations, labelled as such**. Re-measuring 130k–500k is a
follow-up that needs about 3 GB free disk and ~$0.5.

**Verdict against §8's stop condition** (*"recall latency growing with store size faster
than a lifetime tolerates"*):

- **Measured (10k–50k): no stop.** Recall p95 stayed at 643–695 ms, well under the
  planner's 1.6 s. The growing part is small at this size.
- **But recall latency does grow with store size, linearly, and the whole growth is
  local.** Local work (FTS5 + `vec0` + fusion, all on the host's event loop) grows
  **+252 ms p95 per 100k rows** (r² 0.998; +163 ms at p50). Sparse (FTS5) is two thirds
  of it (**+167 ms p95 / 100k**), dense (`vec0` brute force) the rest (**+72 ms / 100k**),
  fusion+hydrate +13 ms. The recency channel is flat. The two provider round trips do not
  grow (embed ~170–200 ms p50, rerank ~170–190 ms p50 at every size).
- **Extrapolated (not measured):** local p95 ≈ 650 ms at 250k and ≈ 1.28 s at 500k.
  Adding the ~515 ms of non-local p95 measured at 50k, recall p95 would cross **1.6 s at
  roughly 420k rows**. Whether that is inside "a lifetime" depends on how fast a person
  writes facts (below), so this is a **projected** failure, not a measured one.

Rank displacement is the sharper signal, and it **is** measured on real facts: with the
probe's own ~326 facts, the gold fact is in the top 15 for **100%** of probes; grown to
**32,501 real facts** it is **91.9%**, and top-1 falls from **97.0% to 65.7%**. Every
probe that left the top 15 also left the 40-row rerank pool, and 7 of 99 left the top 200
entirely.

Actual spend: **$0.4436 of the $10 cap**, all provider-reported (3,550 requests, zero
failed). Nobody was billed a "probably".

## What was measured, and on what

| Measurement | Rows | Real or synthetic |
|---|---|---|
| Latency by stage, store size | 10k, 25k, 32,501 | **Real** rung-4 facts (the first 10k/25k are a seeded subset) |
| Latency by stage, store size | 50k | 32,501 real + 17,499 **synthetic** |
| Rank displacement | own bank (~326) → 1k → 2k → 4k → 8k → 16k | **Real** (own bank + other banks' real facts) |
| Rank displacement | 32,501 | **Real** (every bank) |
| Rank displacement | 50k | Real + **synthetic filler** — the weaker estimate |
| Closure audit | all 15 closures in 32,501 rows | **Real** |

**Deviation from the card, on purpose.** The card asked for latency on synthetic rows at
10k and 25k; we used real facts there instead, and synthetic only beyond 32.5k. Latency is
content-blind for the dense channel and nearly so for FTS5, and real rows are the more
honest version of "~240-char statements" — but the actual reason is disk: one database
that holds real facts first and synthetic filler after serves latency *and* the >32k
displacement points, and a second database did not fit.

## Store size

| Checkpoint | Rows | Real | Synthetic | Active | Closed | DB bytes | Bytes/row |
|---|---:|---:|---:|---:|---:|---:|---:|
| 10k | 10,000 | 10,000 | 0 | 9,997 | 3 | 33.7 MB | 3,366 |
| 25k | 25,000 | 25,000 | 0 | 24,986 | 14 | 82.5 MB | 3,301 |
| all real | 32,501 | 32,501 | 0 | 32,486 | 15 | 106.9 MB | 3,288 |
| 50k | 50,000 | 32,501 | 17,499 | 49,985 | 15 | 158.5 MB | 3,171 |

About **3.2 KB per fact** on disk (the 384-float vector is 1.5 KB of it), so 500k facts is
about 1.6 GB per agent. The closure rate is **0.046%**: closing does essentially nothing to
slow growth, so under this design a store only gets bigger.

## Recall latency vs store size, by stage

100 pinned probes per checkpoint (3 warm-ups excluded), one recall each at the tool's
default `limit: 15`, sequential, through `memory:facts:recall` on the preset's own plugin
configuration. Embed and rerank are TASK-521-style handler spans; the four local stages are
the exported `recall.js` functions, timed one by one on a second connection with the query
vector the product just embedded. Milliseconds, nearest-rank p50 / p95.

| Rows | Recall | Embed | Rerank | Local (recall − providers) | Sparse | Dense | Fusion + hydrate | Recency |
|---:|---|---|---|---|---|---|---|---|
| 10,000 | 380 / 695 | 179 / 320 | 167 / 320 | 31 / 41 | 20 / 28 | 9 / 11 | 2.1 / 2.5 | 0.09 |
| 25,000 | 501 / 645 | 203 / 366 | 192 / 303 | 66 / 81 | 47 / 60 | 17 / 21 | 3.5 / 4.3 | 0.09 |
| 32,501 | 440 / 643 | 177 / 301 | 182 / 288 | 76 / 96 | 53 / 74 | 20 / 25 | 4.3 / 5.0 | 0.11 |
| 50,000 | 457 / 657 | 162 / 296 | 172 / 307 | 98 / 142 | 62 / 95 | 28 / 40 | 6.5 / 7.9 | 0.11 |

Least-squares slope over the four checkpoints:

| Stage | p50 ms per 100k rows | p95 ms per 100k rows | r² (p95) |
|---|---:|---:|---:|
| Local, total | +163 | **+252** | 0.998 |
| Sparse (FTS5 + join + `bm25` sort) | +104 | **+167** | 0.972 |
| Dense (`vec0`, k = 160, exact) | +47 | **+72** | 0.986 |
| Fusion + hydrate | +11 | +13 | 0.984 |
| Recency | +0.05 | — | — |
| Embed, rerank | no trend (r² 0.29 / 0.005) | | |

"Local" counts clean calls only. The one degraded call at 10k (below) lost the rerank
budget race, so its rerank span outlived the recall and `recall − providers` came out at
−1,605 ms; it is excluded (99 calls at 10k). The harness as committed now records no local
figure for such a call; the captured `results.json` predates that fix, and this table was
recomputed from it.

End-to-end recall shows no clean trend across 10k–50k (r² 0.25) because provider jitter
(~±150 ms) is still bigger than the local growth at this size. That is exactly why the
stages were timed separately.

**Two things these numbers do not show, and they matter for the follow-up.**

1. **The local stages are synchronous.** better-sqlite3 runs on the host's event loop, so
   ~100 ms of local work at 50k (and a projected ~1 s at 500k) is time during which the
   host serves nobody else. This run is one agent, one recall at a time; it does not
   measure the contention a busy host would feel.
2. **One degraded call:** at 10k, one rerank took 3.6 s and lost the product's 2 s budget
   (`degraded: ['ranking']`). It is included in the p95 above. The 1-minute load average
   was 45 at that checkpoint — sibling agents were building on the same machine — so treat
   the 10k provider numbers as the noisiest of the four.

### How big is a lifetime? (inferred, not measured)

Rung 4's banks hold ~326 facts from ~48 sessions, about **6.8 facts per session**. At 5
conversations a day that is ~12k facts a year, so the projected 420k crossover is ~34
years away. At 20 a day (a heavy, agent-driven user) it is ~50k a year and the crossover
is **~8 years** out. Both rates are guesses; the per-100k-row slopes above are the numbers
to redo this arithmetic with.

## Rank displacement

**Probe** = the question text of rung 4's 100 pinned LongMemEval-S questions (rung 4 kept
no model-issued recall queries, so the question is the only pinned probe text). **Gold** =
the probe's own-bank active facts whose `conversation_id` is one of the question's
`answer_session_ids` — the evidence sessions. 99 of 100 probes have gold; `eaca4986` has
none and is excluded. **Rank** = position of the best gold fact in `memory:facts:recall`
at `limit: 200` (the first 40 are reranked, the rest are fused order).

Below 32k, each probe gets its own store: its own bank, then other banks' real facts in a
per-probe seeded order. At 32,501 every probe sees the same store (all 100 banks).

| Store | Probes | Top-1 | Top-5 | Top-15 | Top-40 | Not in top 200 | Median rank |
|---|---:|---:|---:|---:|---:|---:|---:|
| own bank (mean 326 rows) | 99 | 97.0% | 100% | 100% | 100% | 0 | 1 |
| 1,000 | 99 | 94.9% | 98.0% | 100% | 100% | 0 | 1 |
| 2,000 | 99 | 88.9% | 98.0% | 100% | 100% | 0 | 1 |
| 4,000 | 99 | 84.8% | 97.0% | 99.0% | 99.0% | 0 | 1 |
| 8,000 | 99 | 78.8% | 92.9% | 93.9% | 93.9% | 0 | 1 |
| 16,000 | 99 | 70.7% | 89.9% | 92.9% | 92.9% | 2 | 1 |
| **32,501 (all real)** | 99 | **65.7%** | 87.9% | **91.9%** | 91.9% | 7 | 1 |
| 50,000 (+ synthetic) | 99 | 65.7% | 87.9% | 91.9% | 91.9% | 7 | 1 |

From own bank to 32,501: **34 probes moved down, none moved up, 8 fell out of the top
15** (and none came back in). By question type, the top-15 losses were temporal reasoning
27 → 24, multi-session 27 → 26, and **single-session preference 6 → 2**. Knowledge-update,
single-session-user and single-session-assistant held.

Top-15 and top-40 are identical at every size: **a gold fact that leaves the 40-row rerank
pool is gone** — the reranker never sees it, and the fused tail rarely brings it back.
That is the failure shape to design against, not "rank drifts a little".

**Synthetic filler barely displaces anything.** From 32,501 to 50,000 (17,499 synthetic
rows) exactly one probe moved down and none left the top 15. As the card predicted,
random-vector, bag-of-words filler is a far gentler distractor than real facts, so the 50k
row is a weak lower bound on displacement and says nothing about 500k real facts.

**Caveats on the real-fact numbers.** The distractors are 99 *other* people's histories,
all filed as `user`, so they are topically unlike one real person's later life — whether
that makes them harsher or gentler than a lifetime of one person's facts is unknown.
LongMemEval-S also shares filler sessions across questions: 205 of the 32,501 rows repeat
another row's statement word for word, and a copy from another bank outranking the
probe's own copy counts here as displacement. Finally, the dense channel's document
vectors carry the **TASK-590 defect** (stored facts embedded as queries), because we
re-embedded through the product path on purpose; dense ranking may improve once that
lands, so these displacement numbers are for the product as it is today.

## Closure audit

All 15 closures in the 32,501 real facts (there are only 15, so this is a census, not a
sample), every one within a single bank. All 15 are on the three single-valued slots:
`lives_in` 6, `works_at` 3, `role` 6. Mechanically every one is what the rules say: same
slot, newer closer, `valid_end` set to the closer's `valid_start`. Whether each *should*
have closed, in our reading:

| # | Slot | Closed → closer | Our read |
|---|---|---|---|
| 1 | lives_in | "Oakdale, California" → "Lives in the city, close to the park…" | **Lossy** — a vague value closed a specific one |
| 2 | lives_in | "Shimokitazawa, Tokyo" → "Downtown Manhattan, 10021" | Plausible move |
| 3 | works_at | "P.T. AECOM Indonesia…" → "a bank, … HR hub site" | Plausible |
| 4 | works_at | "Quinnox, AI engineer" → "XYZ Corporation" | **Wrong** — placeholder employer from filler text |
| 5 | lives_in | "Springfield" → `based_in` "Indonesia…" | Plausible (relation normalized onto the slot) |
| 6 | lives_in | "a small town" → "same area as maternal grandparents" | Refinement, harmless |
| 7 | lives_in | "same area as grandparents" → "New York City metro" | Plausible |
| 8 | role | "Freelance writer…" → "Freelance System Architect…" | **Questionable** — people hold several roles |
| 9 | role | "Freelance System Architect…" → "Freelance Senior System Engineer…" | **Questionable** — same day, likely concurrent |
| 10 | role | "Freelance Senior System Engineer…" → "CTO at XYZ Company…" | **Wrong** — placeholder employer |
| 11 | role | "paralegal…" → "Freelance writer…" | Plausible for the transcript |
| 12 | role | "Senior Marketing Manager at XYZ Inc." → "marketing specialist" | **Lossy** — less specific closed more specific |
| 13 | role | "Career coach and Instagram influencer" → "teacher…" | Plausible for the transcript |
| 14 | lives_in | "San Francisco Bay Area" → "Paris, 11th arrondissement" | Plausible move |
| 15 | works_at | "likes to work at cafes and parks around Tokyo" → "Manager of Yemek.com" | **Mis-slotted** — a work *place habit* filed as employer |

About half look right; the rest are placeholder text, single-valued `role` meeting people
with several jobs, or a vaguer statement closing a sharper one. LongMemEval haystacks mix
personas, so "right" is fuzzy here — but the closure rate is so low that closure is not
what decides growth either way. This is one reviewer's reading, not a labelled set.

## Method and provenance

- Run ID `6967cc7b-03d9-47db-bdb4-b84f97124255`, directory
  `~/.cache/ax-memory-bench/task520-6967cc7b-03d9-47db-bdb4-b84f97124255` (new; the frozen
  TASK-497 artifacts were not opened for writing and not resumed).
- Source revision `1270b72426c40c50583f147fb3f74154903c61a1` (clean tree, enforced by the
  harness); harness digest `df761613783e1b2c5b2abcbd7d55238569a2403d7aac79f76bda8a28d5408058`.
- Harness: `scripts/memory-lifetime-soak.mjs` + `scripts/memory-lifetime-soak-lib.mjs`,
  run with `pnpm exec tsx scripts/memory-lifetime-soak.mjs --env <.env.walk>`.
- Banks: `~/.cache/ax-memory-bench/task497-banks`, 100 banks / 300 files copied into the
  run directory and read from the copy; copy hash
  `ccf11c6ef63108debe799654cd1d3ca5fba301c67679167aaba7574f86744647`. 32,501 rows
  (32,296 distinct statements — the card's "32,296 unique facts" counts statements, not
  rows), mean 235 characters. The copy was deleted after reading to save disk.
- Probes: `scripts/memory-product-e2e-inputs.json` (corpus SHA-256
  `d6f21ea9…c3a442`, question-ID list SHA-256 `536d9b13…fbfd`).
- Synthetic rows: seed **520** (`mulberry32`); about/relation and length copied from a
  random real row, value drawn from the real facts' word-frequency distribution, a random
  384-d unit vector, `transaction_time` after every real fact (a lifetime grows forward),
  all active.
- Providers: `google/gemini-embedding-001:nitro` @ 384 and `voyageai/rerank-2.5:nitro`
  through OpenRouter, exactly as `presets/memory` wires them (TASK-523). Real facts were
  re-embedded by the product's own `memory:facts:reindex` under the store's model
  fingerprint, then copied into the per-probe stores.
- Machine: Apple M3 Max, 36 GB, Node 24.15.0, shared with other agents (load averages 4.6–45
  across checkpoints, recorded per checkpoint in `results.json`).
- Spend ledger: TASK-497's reserve-before-request `Ledger`, $10 cap, every request
  settled from OpenRouter's `usage.cost`. $0.44356005 total.

| Artifact | SHA-256 |
|---|---|
| `manifest.json` | `917287d63feb498b358980fd0d0e0d2432d73650612e0af3b43d4741a40f7884` |
| `results.json` | `e56f1efd8682b0f1047297afb4ddf158e5db31ab37eb4fc0f4baf9e5e4306a5c` |
| `costs.jsonl` | `dc704ba15c8394e5830d90f0d3f30cf10847ddd9574d7eaa744921e19cc6a217` |

The slope fits, the own-bank → 32k movement counts and the per-type counts were derived
from `results.json` after the run (least squares over the four checkpoints' p50/p95;
nearest-rank quantiles); the soak database itself was deleted afterwards to give the disk
back.

## Follow-ups

1. **Measure 130k / 250k / 500k.** Same command, ≥3 GB free on the data volume, ~$0.5,
   ~40 min. This turns the extrapolated crossover into a measurement.
2. **Recall latency grows ~250 ms p95 per 100k facts, all in synchronous local work
   (FTS5 ~2/3, `vec0` ~1/3).** Design the response against *that* measurement — including
   the event-loop stall — before a store reaches the projected ~420k crossover.
3. **Gold facts fall out of the 40-row rerank pool as the store grows** (top-15 100% →
   92%, top-1 97% → 66% from 326 to 32.5k real facts; preference questions worst). This is
   the displacement failure the forgetting/ranking design should target; re-measure after
   TASK-590 fixes document embeddings.
