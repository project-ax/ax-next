# Assistant-content extraction — design

**Date:** 2026-07-29
**Package:** `@ax/memory-strata`
**Brief:** `docs/plans/2026-07-10-assistant-content-extraction-brief.md`
**Measurement this answers to:** `docs/plans/2026-07-08-memory-strata-postrollup-e2e-analysis.md` (FINAL n=500 section)

## Problem

`single-session-assistant` scores **25.9% (14/54)** while every other LongMemEval-S
type sits at 68–84%. **35 of its 40 failures are abstentions** — 49% of all false
refusals in the n=500 run. The signature is uniform: memory holds the **topic** but
not the **content**.

> "I can see we **did discuss** a children's book about dinosaurs, but I don't have that detail."
> "My memory **confirms we discussed** CITGO's three refineries (Lake Charles, Lemont, Corpus Christi) — but…"

Root cause is prompt-level, not input. `formatTranscript` (`src/observer.ts`) already
feeds assistant turns to the extraction LLM. But `EXTRACTION_PROMPT_SYSTEM` is wholly
user-centric ("durable facts … likely to still matter to **this user**") and the
factType taxonomy (`entity | preference | decision | episode | general`) has no slot
for assistant-provided content. So the model reads the assistant's answer and dutifully
writes *"User is writing a children's book about dinosaurs,"* discarding *"the
Plesiosaur had a blue scaly body."*

**Prize:** 25.9% → 70% (parity with every other type) = +24 questions = **+4.9pp
overall** (66.2% → 71.1%).

### What the gold answers actually demand

Read from `bm25-full-fixed.jsonl`, not inferred. The answers require fine detail and
**list ordinals**, which constrains the design:

| Question | Gold |
|---|---|
| "what color was the scaly body of the Plesiosaur" | The Plesiosaur had a blue scaly body. |
| "what was the **7th job** in the list you provided?" | Transcriptionist. |
| "what were **the other four options**?" | 'sexual fixations', 'problematic sexual behaviors', 'sexual impulsivity', 'compulsive sexuality' |
| "how many subjects were in the study" | 38 subjects |
| "processes used at the Lake Charles Refinery" | Atmospheric distillation, FCC, alkylation, hydrotreating |

Two consequences carried into the design: enumerated lists must retain **order and
count** (an ordinal question is unanswerable from a shuffled set of atomic facts), and
the unit of capture is a **specific checkable value**, not a topic label.

## Position: product need, not benchmark-gaming

Stated explicitly because the brief asks for it. This lever is worth building without
the benchmark. "What was that restaurant you recommended?" is among the most common
real recall asks in an assistant product, and today the product answers it with a
confident *"we discussed that, but I don't have the detail"* — the worst available
answer, because it proves the memory system saw the conversation and threw the payload
away.

The design follows the product case rather than the judge: attribution is mandatory,
speculation is excluded, lists are stored whole, and volume is hard-capped. None of
those four rules are things a benchmark would ask for.

## Scope

**In:** Observer extraction prompt + taxonomy, the truncation safety net that change
makes necessary, and a targeted bench measurement path.

**Out (deliberate):** retrieval changes, `memory_search` descriptor wording, a separate
`docs/answer/` category, a second extraction pass, embeddings. Each is either
unnecessary given the subject convention below, or a reserve lever (see
"Iteration levers held in reserve").

---

## Component 1 — targeted measurement path (`test/bench/`)

Ships **first and alone**, no production code. Without it, every iteration costs $143
and most of a day.

**The measurement trap it defeats:** the corpus is ordered in type blocks (user 70 →
multi 133 → preference 30 → temporal 132 → knowledge-update 69 → **assistant 54**). The
first `single-session-assistant` question is at position 434, so `--sample 100` and even
`--sample 400` contain **zero** of them.

**New opt-in flags** on `bench --mode e2e`: `--types <csv>`, `--ids <csv>`.

**Order of operations — filter, then slice:**

```
load all 500  →  filter by types/ids (when given)  →  slice to limit
```

Filtering *after* the slice would return zero assistant questions, which is the exact
trap being defeated. With no flags the pipeline is `slice(0, limit)` — byte-identical
to today's behavior.

**Shape:** a pure function in a new `test/bench/e2e-select.ts`:

```ts
selectSamples({ samples, types?, ids?, limit }): LongMemEvalSample[]
```

`e2e-cli.ts` calls it in place of its current inline `.slice(0, opts.sample)`;
`cli.ts` parses the two flags into `CliArgs` and threads them through `RunE2EOptions`.
The rendered report's `command` string echoes the flags so a filtered report can never
be mistaken for a full run.

**Tests** (`test/bench/__tests__/e2e-select.test.ts`), all pure, no network:

1. No flags → identical to `slice(0, limit)` (the back-compat guard).
2. `types: ['single-session-assistant']` → all 54, none of another type.
3. Filter applied before limit — filtering to a type whose block starts past `limit`
   still returns rows (the trap, asserted directly).
4. `ids` selects exactly the named questions, in corpus order.
5. Unknown type / unknown id → empty result, no throw.

## Component 2 — the extraction change (`src/observer.ts`)

`EXTRACTION_PROMPT_SYSTEM` gains an assistant-content section. Four rules, each
traceable to an observed failure:

1. **Capture** substantive content *the assistant provided* that the user may later ask
   to recall: recommendations, named entities/places/titles, specific values and
   numbers, and enumerated lists.
2. **Attribute** from the assistant's side. Every such fact begins `The assistant …`
   (recommended / listed / stated / explained), never blended with a user assertion.
   This is the guard against the misattribution family (the doctors / Alex-ribs
   failures) — storing "Ruby, Python, or PHP" without recording *who* said it invites
   answering "you told me X" when the user said X.
3. **Lists stay whole.** An enumerated list is **one** fact preserving order and count:
   `The assistant listed 10 work-from-home jobs for seniors: 1. …, 7. Transcriptionist, …`.
   Not one fact per item. This is what makes "the 7th job" answerable, and it caps
   volume at the same time. Lists longer than 10 items store the first 10 plus the
   total count.
4. **Durability bar.** Skip hedges and speculation ("might", "possibly", "I'm not
   sure"), generic advice, pleasantries, and anything the assistant merely restated
   from the user. At most ~5 assistant facts per session, each under ~400 characters.

Rule 4's speculation clause implements the brief's guardrail directly: the assistant
hedges, guesses, and is sometimes wrong, and memory must not launder that into a
durable "fact."

**Subject convention is unchanged** — this is the load-bearing retrieval decision. An
assistant fact takes the same topic subject as the user-side fact ("plesiosaur",
"amsterdam-hostel", "citgo"), so `clusterBySubject` puts both in the **same doc**, and
BM25 matches it on the topic terms the question already contains. No retrieval change,
no new index dimension, no descriptor change is required for the content to be
findable.

## Component 3 — taxonomy plumbing (3 edits)

A new `factType` with **no new doc category** — the cheapest shape that still leaves the
change measurable and auditable.

| File | Edit |
|---|---|
| `src/types.ts` | add `'answer'` to the `Observation.factType` union; note it on the frontmatter `factType` doc comment |
| `src/observer.ts` | add `'answer'` to the `parseObservations` allowlist |
| `src/cluster.ts` | map `'answer' → ClusterCategory 'general'` **explicitly** in `normalizeCategory` |

The `cluster.ts` map is explicit rather than relying on the existing unknown-value
fallback (which would also produce `general`) so the routing is legible at the call
site and a future taxonomy edit can't silently reroute it. `cluster.ts`'s own header
already anticipates this case: *"a future split (e.g. a new inbox factType that maps to
an existing doc category)"*.

**Not changed, verified by test:** `recent.md` filters Open Threads on `episode` /
`decision`, so `answer` cannot pollute the always-injected hot tier.

**Why not a `docs/answer/` category:** it costs 4 edits (`paths.ts`, `doc-store.ts`,
`doc-id.ts` `VALID_CATEGORIES`, `types.ts`) plus `recent.md` and
`ENUMERABLE_CATEGORIES` decisions — and, worse, it would **split a subject's facts
across two docs**, breaking the co-location that makes Component 2's subject convention
work.

## Component 4 — truncation safety net (`src/observer.ts`)

**A risk this change creates, not one it inherits.** `MAX_EXTRACTION_TOKENS` is 1024,
shared by every fact in a session. If output hits the cap the JSON array is cut
mid-object, `parseObservations` returns `null`, and the run records `parse-error` —
**every fact from that session is lost, user facts included.** Assistant content is
substantially more verbose (a 10-item list in a single fact), so this change pushes
sessions toward that cliff. Left unhandled it is a silent regression channel for the
five question types this lever isn't even targeting.

Two mitigations:

1. **`MAX_EXTRACTION_TOKENS` 1024 → 2048.** Cost is only actually-emitted output tokens
   (Haiku, $5/M out) — bounded by a few dollars across an n=500 run.
2. **Salvage parse.** When both the strict parse and the existing bracket-hunt fail,
   scan for complete top-level `{…}` objects and return those; return `null` only when
   zero survive. Converts a total-session loss into a partial one.

```
today:  [{"fact":"…"},{"fact":"…"},{"fact":"The assistant listed 10 jobs: 1. Vir
                                                          ^ cut at max_tokens
        → null → parse-error → ALL facts for the session lost

after:  → [obs1, obs2]  (complete objects kept, partial dropped)
```

**No silent truncation:** the `written` result variant carries an optional
`salvagedFromTruncation?: true`, and `src/plugin.ts` logs it on the existing Observer
result branch (a 4th file edit, beyond Component 3's three) — so if this fires in
production we find out from a log line instead of from a score drop.

This is a strictly-better failure mode for the existing pipeline independent of
assistant content, which is why it lands in the same PR rather than waiting.

## Component 5 — security (invariant 5)

Assistant output is model output, i.e. **untrusted content**. Storing more of it into
`docs/` means more untrusted text re-injected into a system prompt each turn — exactly
the exfiltration channel the two gates exist to close.

**Both gates already cover the new path, because both are factType-agnostic:**

- **Write-time (I7)** — `runObserver` calls `filterSensitive(obs.fact)` per candidate
  before any inbox write, with no reference to `factType`. An `answer` observation is
  gated identically to a `preference` one.
- **Promote-time (I11)** — `decidePromotion` runs confidence-then-`filterSensitive`
  over `summary + body`, again factType-agnostic.

Neither gate needs a code change. Both get an explicit test (below) so a future
refactor can't quietly route assistant content around them.

**The honest new risk:** near-verbatim list capture widens the window for injected text
(e.g. instructions the assistant echoed from a tool result) to be stored intact and
re-injected later. The mitigation is Component 2's attribution rule — facts are stored
as third-person *descriptions* of what was said (`The assistant listed …`) rather than
as standalone imperative text — plus the existing framing of the injected block as
data. This is a reduction, not an elimination; it is called out here so review sees it.

The `security-checklist` skill runs during implementation and produces the structured PR
security note (sandbox escape N/A, prompt injection = the above, supply chain = no new
dependencies).

## Testing

**TDD, with an explicit split** — a stubbed LLM can prove the plumbing but **cannot**
prove Haiku complies with the new prompt. Both halves are required.

**Unit (stubbed, no network, CI-safe):**

1. `observer` — a stubbed extraction returning `factType: 'answer'` survives parse and
   is written to the inbox with `factType: answer` in frontmatter. *Fails today*: the
   allowlist coerces it to `general`.
2. `observer` — salvage parse: a truncated array yields its complete objects. *Fails
   today*: returns `null`.
3. `observer` — the system prompt carries the assistant-content contract (weak but
   honest guard against a future edit silently reverting the lever).
4. `cluster` — an `answer` observation routes to `ClusterCategory 'general'`.
5. `consolidator` — an `answer` observation promotes into `docs/general/<subject>.md`
   alongside a user fact on the same subject (proves co-location, the retrieval
   assumption).
6. `recent` — an `answer` observation does not appear in Open Threads.
7. **Security** — an assistant-authored fact carrying a credential is rejected at
   write time (I7) and, injected directly into the inbox, is quarantined at
   promote time (I11).

**Behavioral (live, cheap):** `test/bench/repro-extract.ts`, in the style of the
existing `repro-*` diagnostics — run the real Haiku extraction over 3 known-failing
transcripts (Plesiosaur `89527b6b`, the WFH job list `1903aded`, CITGO `6ae235be`) and
print the extracted facts. A few cents. **This is the real red/green for this change**,
and it runs *before* the $15 targeted run — the brief's "prefer a repro over
speculation" rule applied to the extraction step.

## Validation plan

Baseline needs **no paid run**: `bm25-full-fixed.jsonl` already holds all 54 assistant
rows from the same fixed harness (14/54 = 25.9%), plus per-type and correct-refusal
numbers for the regression check.

| Step | Command | Cost | Gate |
|---|---|---|---|
| 0 | `repro-extract.ts` on 3 transcripts | ~$0.05 | facts contain the specific detail |
| 1 | `--mode e2e --types single-session-assistant --full` | ~$15, ~40min | **≥35/54 (≈65%)** vs 14/54 |
| 2 | `--mode e2e --full` (n=500), gated on step 1 | ~$143, ~6h | per-type no-regress; correct-refusal ≥83% |

Step 2 runs **only** if step 1 clears its bar. A miss iterates on the prompt at
$15/attempt rather than burning $143 on a lever that hasn't landed.

**Run mechanics** (every paid run — from the brief, non-negotiable):

```bash
git checkout fix/bench-final-session-inbox-stranding   # has the stranding fix
pnpm --filter @ax/memory-strata build                  # bench imports via dist/; stale dist = silent wrong result
set -a; source .env.walk; set +a
unset XAI_API_KEY                                      # BM25 path (the default/winning path)
pnpm --filter @ax/memory-strata bench --mode e2e … --cap 200 --resume <unique-label>
```

The date-stamped report clobbers same-day; the resume JSONL is the source of truth and
gets copied aside.

**Guardrails measured in step 2, per the brief:**

- **correct-refusal ≥83%** (currently 88.0%, 22/25). More stored content = more chances
  to answer an unanswerable question.
- **No per-type regression.** More docs/facts can dilute BM25 for user / multi-session /
  temporal. The n=500 table is the before-picture; comparison is per-type, not just
  overall.
- Type scores de-noise upward as samples fill — at n≈50+, ±1 question ≈ 2pt. No type
  verdict before its sample fills.

## Iteration levers held in reserve

Not built now (YAGNI); each is small and pre-identified so a miss has a next move:

- **`memory_search` descriptor wording** — if the targeted run shows the content *is*
  stored but the agent still abstains, hint that assistant-said content exists.
- **Stricter promotion threshold for `answer`** — one line in `promotion.ts` if the
  full run shows bloat.
- **Exclude `answer` docs from rollups** — `general` is in `ENUMERABLE_CATEGORIES`, so
  answer facts can join rollup classes. Accepted for now, watched in step 2.

## Delivery order

1. **PR-A** — bench `--types`/`--ids` filter + `selectSamples` + unit tests. No
   production code.
2. `repro-extract.ts` spot check (~$0.05).
3. **PR-B** — prompt + `answer` factType + cluster map + token cap + salvage + all unit
   tests + security note.
4. Step 1 targeted run → gate.
5. Step 2 full run → per-type + correct-refusal regression check.
6. Update `.claude/memory/` and append results to
   `docs/plans/2026-07-08-memory-strata-postrollup-e2e-analysis.md` — including a
   negative result if the lever misses.

## Boundary review

Not required: no hook signature changes, no new hooks, no IPC surface. Every edit is
internal to `@ax/memory-strata` (`observer.ts`, `types.ts`, `cluster.ts`) or to its
`test/bench/` harness. `Observation.factType` is a package-internal type, not a hook
payload field. Per CLAUDE.md, patches that only change a plugin's internal
implementation don't need boundary review.
