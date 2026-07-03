# memory-strata multi-session enumeration — design

**Date:** 2026-07-03
**Status:** draft — pending review (assumed-scope decisions flagged inline with ⚑)
**Owner:** Strata retrieval
**Prior:** `2026-07-01-memory-search-snippet-design.md` (snippet lever, shipped PR #375, validated +35pt)

## Motivation

Post-snippet, multi-session questions are the dominant e2e failure: **46.7%** accuracy
(orchestrator) / **50.0%** (BM25) vs **84.3%** single-session (n=100 runs, 2026-07-02).
All 16 multi-session misses in the orchestrator run are **enumeration/aggregation**
questions ("how many X…") — the agent finds 1–3 of the gold 3–5 instances and
undercounts, or refuses.

A 5-question ingest autopsy (real pipeline, kept workspaces) isolated the fault.
**Capture is fine; aggregation is missing:**

| signal | result |
|---|---|
| gold instances present in docs after ingest | ~all (5/5 kits, 3/3 citrus, 4/4 festivals, 3/3 doctors, ≥2/3 weddings) |
| instances in ONE doc | no — scattered across 3–5 docs (each kit has its own doc) |
| map line reveals the instances | no — ~120-char per-doc theme line ("Jen recently married…" ✓ but Rachel & Mike's wedding invisible inside `decision/user`'s wedding-*planning* summary) |
| instances findable inside a doc | buried — all 4 festivals sit in a flat 76-line `episode/user.md` interleaved with fish-tank and car-insurance facts, undated |
| duplicates inflating counts | yes — B-29 kit spawned 4 near-dup docs; "how many projects" answered "at least 9" vs gold 2 |

Four mechanisms, two directions:

- **Under-count:** (1) cross-doc scatter with nothing that enumerates a class;
  (2) map lines summarize themes, not instances; (3) in-doc burial — flat undated
  fact lists, one 48-token snippet per hit.
- **Over-count:** (4) near-dup doc creation (`b-29-bomber-model` vs
  `b-29-bomber-model-kit`) and entity collisions (two different Emilys share
  `entity/emily.md`).

This is exactly the one-hop failure mode c137 documents ("cross-document
aggregation queries") and the gap the unbuilt `reflect` op was designed for
(`memory-strata-design.md:1071-1200`, `:1301`).

## Goal

Counting/aggregation questions over facts scattered across docs and sessions get
the full instance set in front of the answer model: `memory_search` surfaces
**every matching fact line** (not one snippet), facts carry **dates**, retrieval is
**coached to enumerate**, and the consolidator stops **minting near-duplicate docs**.

Success: multi-session e2e accuracy ≥ 65% (from 46.7%) with no single-session or
abstention regression, measured by the same n=100 harness.

## Non-goals

- **`reflect` / write-time rollup docs** — the failing classes are ad-hoc
  ("citrus fruits in cocktails"); precomputed rollups chase an unbounded taxonomy
  and add write-amplification. Re-evaluate only if read-time enumeration measures
  short. (Keeps the existing design-doc `reflect` spec deferred.)
- **Per-fact index rows** (index schema change in both backends) — escalation
  path if host-side line extraction shows stemming-recall gaps, not the first move.
- **Entity disambiguation** (the two-Emilys collision) — needs observer-side
  subject qualification; separate lever.
- **Map format changes** — the map stays one line per doc; enumeration flows
  through search results, not the map.

## Design

### D1. Per-fact date tags (promotion writes them, dates stop being dropped)

Inbox observations already carry `event_time`/`recorded_at`; promotion drops them.
`appendFactToBody`/`buildBody` (doc-store) now write each fact as:

```
- (2026-02-15) User visited The Art Cube gallery opening night.
```

The date is `event_time ?? recorded_at`, date-only ISO (`YYYY-MM-DD`), prefixed in
parens. Facts with no timestamp render without the parens (back-compat: existing
undated lines stay valid; no migration — docs densify as they're appended to).
This makes "this year" / "in February" / "past two weeks" enumerations decidable
by the answer model, which currently sees undated bullets.

⚑ assumed: prefix-parens format (vs suffix or frontmatter table). Cheap to change
before implementation.

### D2. `matchedFacts` on memory_search results (host-side, no contract change)

After retrieval returns doc hits (BM25 or orchestrator), the memory-strata plugin
— which owns the doc files — reads each hit's body and extracts **all fact lines
matching the query** (tokenized any-term match, case-insensitive, naive prefix
stemming: query token `wedding` matches `weddings`; `graduate` matches
`graduated`). Each `memory_search` result row gains:

```ts
matchedFacts: string[]   // every matching '- …' line from the doc body, in doc order
```

- Cap: 20 lines per doc, 60 per response (soft; log when clipped).
- Applies to orchestrator `<load>` rows too — the load's doc body is matched
  against the turn's query, so `<load>` rows stop carrying only an empty snippet
  (closes the PR #375 Backlog-card tension without waiting for map densification).
- `snippet` stays as-is (contract untouched, both backends unaffected — this
  layer is above `memory:index:search`).
- The tool description gains: for counting/enumeration questions, read
  `matchedFacts` across ALL hits and run additional searches with instance-term
  probes before answering.

Why host-side and not in the index: no schema/contract change across two
backends, identical behavior for both, works for `<load>` rows (which never touch
the index), and the class-semantics gap ("citrus" ≠ "lime") is unfixable at any
term-match layer — it's addressed by D3's probing instead.

### D3. Enumeration coaching (orchestrator + answer loop)

- **Orchestrator prompt**: for counting/aggregation queries, emit MULTIPLE ops —
  several `<fts>` probes (class term + plausible instance terms) plus `<load>` of
  candidate docs. The op array already supports this; it's never coached. Add a
  defensive cap of 8 ops per reply (drop extras, log) — today the parser
  whitelists op *types* but doesn't bound the count.
- **Answer loop (bench)**: `maxToolTurns` 4 → 6. Production chat has no such cap;
  bench-only constant.
- `followupNeeded` stays parsed-but-unconsumed (multi-hop remains deferred;
  multiple ops in ONE round cover the enumeration case).

### D4. Near-dup doc guard at promotion (over-count direction)

Before `writeNewDoc` creates a new doc, compare the new cluster's slug against
existing doc slugs in the same category: if one is a token-subset/superset within
an edit budget (e.g., `b-29-bomber-model` ⊂ `b-29-bomber-model-kit`), `appendFact`
to the existing doc instead of minting a new one. Deterministic token-set rule, no
LLM. Instrumented: log `near_dup_slug_merged` with both slugs.

⚑ assumed: token-subset heuristic (conservative; only merges same-category,
subset-relation slugs). Full cross-doc semantic dedup stays out (YAGNI until
measured).

### D5. Bench temporal fidelity (haystack_dates)

The e2e driver passes each haystack session's `haystack_dates[i]` as the
observer's `now`. The plugin currently hardcodes `now: new Date()` at its three
`runObserver` call sites, so this needs a small config seam
(`nowFn?: () => Date`, defaulting to `Date.now`-based; production unchanged —
the bench simply stops lying about when sessions happened). Also pass
`question_date` into the answer prompt as "today's date". Without this, D1's
dates are wall-clock ingest time and every time-scoped bench question stays
undecidable no matter how good enumeration gets.

## Testing (TDD per layer)

1. **doc-store unit**: promoted fact renders `- (YYYY-MM-DD) …` from
   `event_time`; missing timestamp renders bare; appended facts on an existing
   undated doc don't disturb old lines.
2. **matchedFacts unit**: doc with N matching + M non-matching lines → exactly
   the N matching lines, prefix-stemmed matches included, caps enforced.
3. **memory_search executor**: stub index returns doc hit → result rows carry
   `matchedFacts` from the doc body; orchestrator `<load>` path carries them too.
4. **near-dup guard unit**: subset-slug cluster appends instead of minting;
   non-subset slugs still create docs; log line asserted.
5. **e2e driver**: observer receives session-fiction `now`; answer prompt
   carries `question_date`.
6. **Enumeration canary (kit-level)**: ingest 3 sessions each adding one
   instance of a class across different subjects → `memory_search("<class>")`
   surfaces all 3 instances in `matchedFacts` across hits.

## Boundary review (hook-payload change)

- **Alternate impl:** `matchedFacts` is computed by the memory-strata plugin from
  its own doc store, regardless of which index backend produced the hit — both
  backends, and the no-index `<load>` path, produce it identically.
- **Field-name leak:** `matchedFacts` is storage-agnostic; no FTS/tsquery vocab.
- **Subscriber risk:** additive field on `tool:execute:memory_search` output;
  existing consumers ignore it.
- **Wire surface:** schema lives in the memory-strata plugin (same place the
  snippet field landed in PR #375).

## Security review

- **Untrusted content:** fact lines are the agent's own stored memory, already
  reachable via `memory_read_section`; matching is string comparison in-process —
  no query text reaches a SQL/FTS engine on this path. No new injection surface.
- **Scope:** doc reads go through the same agent-scoped doc store as
  `memory_read_section` (traversal-guarded doc ids).
- **Disclosure:** more of the agent's own memory per search response (capped);
  no trust boundary crossed.

## Validation

Re-run the e2e harness (both retrieval paths) with fresh resume ids after all
tasks land; compare against the 2026-07-02 post-snippet baselines
(orch 73.0% overall / 46.7% multi-session; BM25 70.0% / 50.0%). Gate: multi-session
≥ 65%, overall no worse than baseline −1pt, correct-refusal ≥ 83%.

## Follow-ups (out of scope)

- `reflect` rollups if enumeration measures short on salient recurring classes.
- Per-fact index rows if line-match stemming shows recall gaps.
- Entity disambiguation (observer-side subject qualification).
- Multi-hop orchestrator (`followupNeeded` consumption).
