# TASK-369 — how many of the 15 `incorrect` rows actually reproduce

**Status: the paid replay is IN FLIGHT and has produced 0 of 15 verdicts.**
This file is committed now so the free, already-finished half of the work is not
lost. **It contains no reproduction count, because none has been measured.** Do
not read a number out of it.

Everything below is labelled **MEASURED** (executed and observed) or
**INFERRED** (reasoned from reading code). They are not merged.

---

## What is not yet known

The deliverable — *how many of the 15 reproduce* — is **unmeasured**. The replay
ingests ~704 haystack sessions before it can score anything, and with four
questions in flight no row is appended until its own ingest, answer and judge
complete. At the point this file was written the run was 144/704 sessions in,
0/15 rows scored.

**The run is checkpointed.** `--resume task369-incorrect-repro` appends one JSONL
row per scored question to
`~/.cache/ax-memory-bench/longmemeval-s-e2e/task369-incorrect-repro.jsonl`.
Re-issuing the exact command below pays only for the questions that are still
missing, so a successor does not repeat the ~$1.24.

```bash
set -a && . ./.env.walk && set +a
pnpm --filter @ax/memory-strata bench --mode e2e --orchestrator-model glm \
  --ids 0a995998,88432d0a,32260d93,d24813b1,91b15a6e,gpt4_7f6b06db,9a707b81,gpt4_4fc4f797,gpt4_e061b84f,6e984301,c9f37c46,gpt4_93159ced_abs,6a1eabeb,4b24c848,a2f3aa27 \
  --concurrency 4 --cap 3 --resume task369-incorrect-repro
```

---

## MEASURED (free, deterministic, re-runnable without spend)

### 1. The card's premise holds: the 15 are 15, and they are the right 15

The card asserts the ids it lists are the `incorrect` rows of the 2026-09-14
n=100 run. Checked rather than assumed:

| | |
|---|---|
| lines in `2026-09-14.jsonl` | **101** |
| unique `questionId` | **100** (`c14c00dd` is written twice) |
| verdicts (deduped) | correct 72 · abstained-correctly 4 · **incorrect 15** · abstained-incorrectly 9 |
| accuracy (72+4)/100 | **76.0%** — matches the published product number |
| card's ids | 15 listed, 15 unique |
| card ids △ incorrect rows | **empty in both directions** |

All 15 also resolve in the corpus, and all 15 ingested their **full** haystack on
2026-09-14 (`sessionsIngested == len(haystack_session_ids)`, 15/15), so the
baseline labels were not set on a truncated ingest. Total haystack across the 15
is **704 sessions**, mean 46.9.

The duplicate `c14c00dd` row is worth knowing about — it is the reason the file
has 101 lines for a 100-question run — but it is not one of the 15 and it does
not move 76.0%.

### 2. TASK-368's headline does not reconcile with TASK-368's own table

The card says to group results by TASK-368's reading of each row, so that
grouping was recomputed from the report rather than quoted. Parsing its **"Every
row, with its reading"** table (24 rows, 24 unique ids) gives:

| | per-row table | report headline |
|---|---|---|
| bad gold | 3 | 3 |
| strict (gold present, scored wrong) | **3** | **4** |
| real | **18** | **17** |

The headline over-counts `strict` by one. The extra row is `eaca4986`: the
report's strict-evidence table lists **five** rows under a header that says
"The 4", and **two** of those five (`eaca4986`, `7024f17c`) are explicitly
already counted among the 3 bad-gold rows. Its parenthetical excuses only one of
the two ("the last row is from TASK-365's replay"), so 5 − 2 = **3** strict-only
rows, which is exactly what the per-row table independently says.

Consequences for the figures that were derived from the wrong input:

| TASK-368 stated | corrected |
|---|---|
| 76.0% product number | unchanged — **76.0%** |
| 79.0% excluding 3 known-bad-gold rows | unchanged — **79.0%** |
| 83.0% if the strict rows also went our way | **82.0%** |
| "~17 points of the 24 are ours to win" | **~18 of 24** |

Nothing here changes the shipped number or the 3-id bad-gold annotation list.
It moves one row from "winnable-but-scored-wrong" to "real", which makes the
addressable bucket slightly *larger*, not smaller.

Recompute it in a few seconds, no API keys:

```bash
python3 - <<'PY'
import re
from collections import Counter
txt = open('docs/plans/2026-09-15-task-368-gold-quality-audit.md').read()
sec = txt.split('## Every row, with its reading')[1]
rows = [l for l in sec.splitlines() if l.startswith('| `')]
c = Counter()
for l in rows:
    cells = [x.strip() for x in l.strip('|').split('|')]
    c[re.sub(r'\*|\s*\(weak\)', '', cells[3]).strip()] += 1
print(len(rows), 'rows ->', dict(c))
PY
```

### 3. How the 15 group under the corrected reading

1 bad gold (`0a995998`) · 3 strict (`4b24c848`, `a2f3aa27`,
`gpt4_93159ced_abs`) · 11 real. 1 + 3 + 11 = 15. The other 2 bad-gold and 0
strict rows sit in the 9-refusal bucket TASK-365 already replayed.

### 4. TASK-365's published rate verifies against its own JSONL

Re-derived from `repro-rate.jsonl` rather than trusted: 9 rows, **3/9 refused
again**, 6/9 did not, 5 of the 6 outright `correct`, spend $0.798. All as
published.

One framing detail that matters for comparing the two cards: TASK-365's headline
metric is **"refused again" (3/9)**. Its **"failed again" rate is 4/9**, because
`7024f17c` stopped refusing and failed on a hedge instead. The 15 rows here were
all scored `incorrect`, so the analogous headline for this card is *failed
again*, and it should be compared against 4/9, not 3/9.

### 5. The 2026-09-14 baseline ran `--concurrency 4`

From that report's own `Command` line:
`… --sample 100 --orchestrator-model glm --concurrency 4`. This replay matches
it. TASK-365 replayed its 9 at the harness default of 1 against the same
concurrency-4 baseline and does not note the difference.

An earlier launch of this replay (22:02Z) used the default 1 on the assumption
that matching TASK-365 was the comparable choice; that is backwards, since the
comparison this card makes is replay-against-baseline. It was aborted at **0
scored rows** and relaunched at 22:07Z. ~$0.03 of extraction on the aborted
launch is discarded and will not appear in the reported spend.

---

## INFERRED (from reading code — not executed)

**`--out` is a silent no-op in `--mode e2e`.** `cli.ts` declares `out`
(`:211`), copies it into the parsed args (`:239`), and the `mode === 'e2e'`
branch (`:254`) never passes it to `runE2EMode`. `runE2EMode` writes
unconditionally to `docs/plans/<date>-memory-strata-e2e-report.md`
(`e2e-cli.ts:406-413`); only the bench A–E path reads `args.out` (`cli.ts:591`).
**No test covers this** — `grep -l runE2EMode test/bench/__tests__/` returns one
file and it does not exercise the report path. TASK-365 reported the same
behaviour; this is a code read confirming it, not a second observation of it.

**A `pgrep` miss is not evidence a run is dead — and here the probe was the
thing that was wrong.** `pgrep -f 'tsx test/bench/cli.ts'` can never match,
because the real command line is
`…/node_modules/tsx/dist/cli.mjs test/bench/cli.ts …`. It produced a false
"process gone" while the run was healthy. Corroborated against log mtime,
observer-run count and `ps` before touching anything, per the card. Use
`pgrep -f 'test/bench/cli.ts'`.

---

## Method, so the eventual number is reproducible

- **What "reproduces" means:** the replay verdict is `incorrect` or
  `abstained-incorrectly`. All 15 were `incorrect` at baseline, so a row coming
  back `abstained-incorrectly` still counts as reproducing, but is broken out —
  a wrong answer becoming a refusal is a different product behaviour.
- **What "wrong the same way" means:** reproduces AND the failure turns on the
  same wrong value or substituted event. The per-row criteria were written down
  **before the first row was scored** and are preserved verbatim below, so the
  call is a prediction checked against the replay, not a story fitted to it.
- **n = 1 per question.** A row that answers correctly once is not proven
  stable; it is proven *not reproducible from one observation*. Same caveat
  TASK-365 carried.

### Pre-registered "wrong the same way" criteria

| id | 2026-09-14 wrong anchor | "same wrong anchor" iff the replay… |
|---|---|---|
| `0a995998` | answered **2** store items, excluding the sister's sweater | answers 2 again / misses the 3rd item |
| `88432d0a` | counted **5** bakes, including the May-28 chicken wings | counts a planned bake again |
| `32260d93` | led with stand-up, then also offered true-crime + history | recommends beyond stand-up again |
| `d24813b1` | ignored the lemon poppyseed anchor | again misses lemon poppyseed |
| `91b15a6e` | **$5,200** — vanity minimum taken as $200, not the user's $150 | uses a vanity minimum other than $150 |
| `gpt4_7f6b06db` | included **Sequoia**, dropped **Muir Woods** | same substitution |
| `9a707b81` | had Mar 20 and Apr 10 and declined to subtract | declines to subtract again |
| `gpt4_4fc4f797` | used the **May 15 planned** track day → 59 days | anchors on May 15 again |
| `gpt4_e061b84f` | substituted a **volleyball game** for the Midsummer 5K | same substitution |
| `6e984301` | "6 weeks as of Feb 11" → **~9 weeks** | reaches ~9 weeks / the same 6-week premise |
| `c9f37c46` | Feb → Apr called **3 months** | says 3 months again |
| `gpt4_93159ced_abs` | caught the false premise, then kept answering | keeps answering after the refusal |
| `6a1eabeb` | returned the stale **27:12** over the later 25:50 | returns 27:12 again |
| `4b24c848` | named 5, lost on the **"at least 5"** hedge | hedges on 5 again |
| `a2f3aa27` | gave the range **"1,250–1,300"** + a staleness caveat | gives a range / staleness caveat again |

### Config

| | |
|---|---|
| planner | `z-ai/glm-5.3-flash:nitro` (config E), `reasoning: minimal` |
| answer stage | `claude-sonnet-4-6`, no scaffold, no thinking arm |
| Observer / consolidator | `z-ai/glm-5.3-flash:nitro` |
| judge | `x-ai/grok-4.3` |
| concurrency | 4 — matching the baseline, not the harness default |
| cap | $3, against a $1.24 estimate (the 15 rows' own 2026-09-14 spend) |

### Free comparison once the rows exist

```bash
python3 - <<'PY'
import json, os
C = os.path.expanduser('~/.cache/ax-memory-bench/longmemeval-s-e2e')
orig = {}
for l in open(f'{C}/2026-09-14.jsonl'):
    r = json.loads(l); orig[r['questionId']] = r
rep = [json.loads(l) for l in open(f'{C}/task369-incorrect-repro.jsonl')]
FAIL = {'incorrect', 'abstained-incorrectly'}
for r in rep:
    print("%-22s %-12s -> %s" % (r['questionId'], orig[r['questionId']]['verdict'], r['verdict']))
print("failed again: %d/%d" % (sum(1 for r in rep if r['verdict'] in FAIL), len(rep)))
PY
```

Source: `docs/plans/2026-09-15-task-365-repro-rate-report.md`
Companion: `docs/plans/2026-09-15-task-368-gold-quality-audit.md`
