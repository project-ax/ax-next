# A vs E under the raised body cap — the gap more than doubled

**Answers:** step 1 of `2026-09-14-orchestrator-glm-handoff.md`.
**Instrument:** isolated bench, `--sample 150` stratified, answer-stage body cap
**20,000** chars/doc (was 2,000 for every number in the accuracy report).
**Raw reports:** `2026-09-14-bodycap-remeasure-a-bm25.md`,
`2026-09-14-bodycap-remeasure-e-map-fts-glm.md`.
**Spend:** $22.26 ($14.27 arm A + $7.99 arm E), against the handoff's ~$24 estimate.
**Map held fixed:** the May/Grok-authored `map-rewrites.json`, the same cache every
published E number was measured against. Backed up before step 3 touched it.

---

## The result

Both arms ran the **identical 150 questions** (`multi-session=40
temporal-reasoning=40 knowledge-update=23 single-session-user=21
single-session-assistant=17 single-session-preference=9`), so this comparison is
paired and internal to one cap.

| | A: BM25-only | E: orchestrator + BM25 fallback (GLM) | Δ |
|---|---|---|---|
| **accuracy** | 30.7% | **63.3%** | **+32.6pp** (z=5.67) |
| recall@5 | 35.3% | **92.7%** | +57.4pp (z=10.34) |
| false refusal (on answerable) | 72/143 = 50.3% | 30/143 = 21.0% | −29.4pp (z=5.18) |
| correct refusal | 5/7 (71.4%) | 6/7 (85.7%) | +1 |
| hallucinated on unanswerable | 2 | 1 | −1 |
| **run cost** | **$14.27** | **$7.99** | **−44%** |
| cost per correct answer | $0.310 | **$0.084** | **−73%** |
| p50 / p95 retrieval ms | 190 / 560 | 2,525 / 15,229 | slower, as expected |

**The orchestrator arm is both substantially more accurate and materially
cheaper.** That is not a tradeoff being balanced; it is the same direction on
both axes. The mechanism is in the token counts: A fed Sonnet 4.50M input tokens
to answer 150 questions, E fed it 2.43M — because A always injects 10 documents
and E's planner injects a mean of **2.95**. The planner itself cost **$0.049,
0.6% of the run**.

## The handoff's open question, answered

> The open question is not just "what are the real numbers" but **whether the
> BM25-vs-orchestrator gap widens**: good retrieval should be worth *more* once
> the answer stage can use it, so +12pp may understate the architecture.

It widens, and by more than the handoff guessed:

| | A | E (GLM) | gap |
|---|---|---|---|
| old cap, 2,000 chars (n=500) | 21.2% | 36.0% | +14.8pp |
| **new cap, 20,000 chars (n=150)** | **30.7%** | **63.3%** | **+32.6pp** |

**The gap went from +14.8pp to +32.6pp — it 2.2×'d.** The raised cap is worth
roughly **+9.5pp to BM25 and +27.3pp to the orchestrator**, and the asymmetry has
a clear mechanism: a bigger body cap can only help on questions where the gold
document was actually retrieved. A's recall@5 is 35.3%, so on nearly two thirds
of questions there is no gold evidence in the context to un-truncate. E's recall
is 92.7%, so almost every question benefits.

This is the argument for the architecture that the +12pp number was understating.
It also means **every arm-vs-arm retrieval comparison in
`2026-09-11-orchestrator-accuracy-report.md` understates the spread**, not just
the absolute levels the report already flags as floors.

## What this does NOT say

- **The cross-cap deltas mix two changes.** The old numbers are n=500 over the
  full corpus; these are n=150 stratified. The A-vs-E comparison *within* this
  run is paired and clean; the 21.2%→30.7% and 36.0%→63.3% movements also carry
  sampling variation. Treat the +32.6pp gap as the measured number and the
  per-arm lifts as directional.
- **There is direct evidence of that noise in the table.** A's recall@5 reads
  35.3% here against 41.8% at n=500 — and recall@5 cannot be affected by an
  *answer-stage* cap, so the entire 6.5pp move is sample difference (~1.6 SE at
  n=150). That is the honest scale of cross-run noise here.
- **63.3% is still not the product number.** This is the isolated bench: one shot
  over a fixed top-K, no `matchedFacts`, no `memory_read_section` drill-in. The
  e2e harness measured **76.0%** on the shipped stack. The isolated absolutes
  remain floors; what changed is that they are much less misleading floors.
- **Nothing here tests the GLM-authored map.** Both arms read the May/Grok map,
  deliberately, so the only variable was the cap. Step 3 measures the map.

## Note on the reports themselves

Both raw reports are titled **"Strata vector-vs-no-vector spike report"** and end
with a **"Binding decision"** section adjudicating configs B and C against a
Level-3 threshold — neither of which this run measured. The header is inherited
from the template and is now actively misleading on a doc whose whole job is to
record measurement conditions. Worth a cleanup pass; not fixed here because it
would have meant editing the generator mid-run.
