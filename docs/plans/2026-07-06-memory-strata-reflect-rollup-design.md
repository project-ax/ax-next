# memory-strata `reflect` — write-time rollup docs — design

**Date:** 2026-07-06
**Status:** draft — pending review (revised after adversarial review, 2026-07-06)
**Owner:** Strata retrieval
**Prior:** `2026-07-03-memory-strata-multi-session-enumeration-design.md` (read-time levers, shipped #379); `2026-07-05-memory-strata-enumeration-e2e-diagnosis.md` + its 2026-07-06 Update (cheap orchestrator experiment, shipped PR #380 — cap+marker+coaching lifted orchestrator multi-session 43.3%→60.0%). Deferred `reflect` spec: `memory-strata-design.md:1069-1200`, `:1301`.

## Motivation

The read-time levers took orchestrator multi-session from 43.3% to **60.0%** — ~2 questions shy of the ≥65% gate. The 2026-07-06 flip analysis split the 12 remaining multi-session misses into three buckets:

| bucket | example misses | reachable by a rollup? |
|---|---|---|
| **sum/aggregation over found instances** | luxury total ($2,500), driving hours, jogging 0.5h | yes — via the enumerated instance set (numeric pre-sum is a follow-up) |
| **off-by-one undercount** | clothing 2/3, model kits 4/5, food-delivery 2/3, weddings "at least 3" | **yes — the core target** |
| **retrieval miss / abstention** | properties viewed, bed-time-before-appointment | **no** — the instances never surface; out of scope |

Buckets 1–2 (~5–7 questions) share one shape: the instances **are in memory**, scattered across subjects/sessions, and the answer model still miscounts them at read time. That is the one-hop cross-document-aggregation failure c137 documents and the gap the unbuilt `reflect` op was designed for. The read-time levers made the model *look harder*; they cannot make read-time counting *reliable*. A rollup makes the count a **materialized fact the model reads instead of computes**.

Reflect is a **gap-closer** for the last ~5pt, scoped to the two reachable buckets — not "the earned next lever" (the experiment falsified read-time aggregation as the *whole* wall).

## Goal

At consolidation time, for each **recurring instance-class already present in memory** (≥K member docs), materialize a `docs/rollup/<class>.md` doc that states the **count** and lists **every member instance** (dated, linked to its source doc). The doc surfaces through the *existing* retrieval path (BM25 / orchestrator + `matchedFacts`), so on "how many X" the answer model reads a pre-computed answer instead of re-deriving it.

Success: orchestrator multi-session e2e ≥ 65% (from 60.0%) with no single-session or abstention regression, same n=100 harness; BM25 no worse. Measured against the enum+exp baselines (orch 78.0%/60.0%, BM25 76.0%/53.3%).

## Non-goals (and how this design answers the deferral objections)

The enumeration design deferred reflect for two reasons. This design is bounded specifically to defuse them:

- **"Unbounded ad-hoc taxonomy."** Rollups are **not** minted per hypothetical query class. The class detector (D2) only ever operates over the **existing enumerable docs**, and a class materializes only when it has **≥K real member docs** among them. This is true for both the deterministic and the LLM stage: the LLM is asked to *cluster the docs it is shown* into ≥K-member classes and its proposed membership is verified against real doc ids (hallucinated ids dropped; sub-K classes discarded) — it **cannot invent a class for a query that has no members on disk**. The taxonomy is therefore bounded by the data: at most `floor(docs/K)` classes, in practice a handful (you have a few things you did ≥3 times, not thousands). Ad-hoc one-offs never reach K, cost nothing, produce nothing, and keep falling back to the shipped read-time levers. **A rollup is a best-effort accelerator, never the sole path** — a missing or stale rollup must degrade to read-time enumeration, never produce a wrong answer (this is why GC index-deletion, D4, is load-bearing, not a nicety).
- **"Write-amplification."** The pass runs only on **dirty** passes (an enumerable-category doc was promoted/merged this pass). On a dirty pass it costs: the O(docs) `listDocs` scan that map-regen already pays **plus one more doc-read scan** for class detection, **plus one cheap LLM call** over doc *summaries* (not bodies) for the semantic-naming stage. Writes are **idempotent** — a rollup is rewritten only when its `(members, count, instance-line text)` hash changes (same skip pattern as `mergeConversationIntoDoc`). Cost is O(changed classes) in writes and one bounded LLM call per dirty pass — not per turn.

Still out of scope (unchanged): per-fact index rows; entity disambiguation; **any index/contract change** — `memory-strata-index-*` and the `memory:index:search`/`upsert`/`delete` hook *schemas* are untouched (rollups are ordinary docs; `category` is already a free string in both backends — verified in `memory-strata-index-sqlite/src/schema.ts` and the postgres backend); map **format** changes (a rollup gets one ordinary map line). Numeric pre-summation and an orchestrator-prompt preference hint are deferred (see Follow-ups).

## Design

### D1. A new `rollup` doc category (full change list)

`rollup` becomes a first-class `DocCategory`. Because a doc category is referenced by more than the two lists the first draft named, the **complete** change set inside `@ax/memory-strata` is:

- `paths.ts` — add `'rollup'` to `DocCategory`.
- `doc-store.ts` — add `'rollup'` to `CATEGORIES` (so `listDocs` enumerates `docs/rollup/`).
- **`doc-id.ts` — add `'rollup'` to the closed `VALID_CATEGORIES` allow-list.** This is load-bearing and was missing from the draft: `parseDocId` gates the orchestrator map menu (`orchestrator.ts:216`), the `<load>` guard (`orchestrator.ts:312`), `memory_read_section` (`tools/memory-read-section.ts`), **and `matchedFacts` enrichment** (`tools/memory-search.ts` calls `parseDocId(row.docId)`; a `null` return yields `matchedFacts: []`). Omit this and a retrieved rollup silently surfaces with no instance lines on the orchestrator path — the exact path being tuned 60→65%.
- `types.ts` — add `docs/rollup` to the `DocFileType`/`MemoryFileType` unions so `writeRollupDoc`'s typed frontmatter compiles.

All four edits are inside `@ax/memory-strata`; the index packages and the `memory:index:*` schemas are untouched, so index-neutrality holds. `factType: 'rollup'`, `origin: 'reflect'` in frontmatter mark rollups synthesized (mirrors the design-doc mental-model conventions: lower confidence ceiling, **no supersession** of source docs). Rollups are **excluded from `recent.md`** (filter `category !== 'rollup'` in `recent.ts`) — they are a search-time accelerator, not hot-tier content, and shouldn't crowd the always-injected Recent summary.

### D2. Two-stage class detection: deterministic pre-group → bounded LLM naming

A **class** is a set of ≥K member docs (K default **3**, configurable) within the **enumerable categories** (`episode`, `entity`, `general` — configurable; `preference`/`decision` are single-state, not enumerable). Detection runs in two stages so the cheap path handles the easy classes and the LLM only sees the residue:

**Stage A — deterministic pre-grouping (no LLM).** Group enumerable docs by a shared, rare **class-token** drawn from `{subject, summary, fact-line heads}` (length ≥3, non-stopword, naively singularized; token must appear in ≤ `SALIENCE_MAX_FRACTION` of the category's docs, default 0.4, to drop generics like `user`/`day`/`visited`). A group of ≥K distinct docs is a class. This cleanly catches classes whose members *lexically share the class word* — e.g. **model kits** (each kit doc contains `kit`), doctors.

**Stage B — bounded LLM naming over the residue.** The adversarial review established (against the 2026-07-03 autopsy) that the classes dominating the failure set are **semantically named** — **furniture** (couch/table/desk), **cuisines** (Italian/Thai/Mexican), **food-delivery** (DoorDash/Grubhub), **festivals buried as fact-lines in one shared `episode/user.md`** — whose members share *no* surface token. Deterministic grouping cannot name these. So a **single cheap LLM call per dirty pass** is given the *summaries* (≤50 tokens each) of the enumerable docs Stage A did **not** already claim, and asked:

> Cluster these memory documents into classes, where a class is a kind of thing the user did/owns repeatedly. Return only classes with **≥K members**, each member cited by its exact doc id. Do not invent doc ids or classes without ≥K members.

The response is **verified deterministically**: every cited doc id must exist in the input set (drop hallucinations), and any class below K after verification is discarded. This keeps the LLM strictly a *namer/clusterer of real docs* — the bound in Non-goals (≥K real members) is enforced in code, not trusted to the model. Model: the cheap extraction tier already in the stack (`claude-haiku-4-5`).

A doc may belong to multiple classes (a "beach wedding in Maui" → both `weddings` and `maui`); correct and cheap. Total rollups per pass is capped (default 50) with a `rollup_cap_exceeded` log if hit — **no silent truncation**.

*(Rationale for reversing the initial "no-LLM" fork: the real data shows doc-granular lexical grouping reaches only ~1–2 of the ~5–7 target questions. Stage B is what reaches the rest. It stays bounded because it clusters existing ≥K-member docs, not hypothetical queries.)*

### D3. Rollup materialization (doc-store) — indexed like any doc

For each qualifying class, build the rollup deterministically from its member docs:

```markdown
---
id: rollup/weddings
type: docs/rollup
factType: rollup
origin: reflect
confidence: 0.8
summary: "Weddings — 3 the user attended (rollup)"   # ← count rides here (see D5)
subject: weddings
rollup_count: 3
rollup_members: [episode/emily-and-sarah, episode/jen-and-tom, episode/rachel-and-mike]
rollup_generated: 2026-07-06T…
---
# Rollup: weddings

## Count
3 distinct weddings.

## Instances
- (2026-01-05) Emily and Sarah's wedding — [[episode/emily-and-sarah]]
- (2026-03-02) Jen and Tom's barn wedding — [[episode/jen-and-tom]]
- (2026-06-20) Rachel and Mike's beach wedding — [[episode/rachel-and-mike]]
```

Each instance line is the member doc's most representative dated fact line (first dated fact matching the class, else its summary), carrying the D1-era `(YYYY-MM-DD)` date and a `[[link]]`.

**Indexing is not automatic from a bare file write.** `writeNewDoc`/`appendFact` are the only sites that fire `memory:doc:written`, which `reindex.ts` turns into `memory:index:upsert` (the CLI/BM25 path's sole indexing trigger). Therefore `writeRollupDoc` **must fire `memory:doc:written` (kind `created`/`updated`) itself** — writing via bare `atomicWriteUtf8` alone would leave the rollup on disk and in the map but invisible to `memory_search`. (It re-uses `atomicWriteUtf8` for the file write, then fires the event, mirroring `writeNewDoc`.)

**MVP scope:** count + enumerated list. **Numeric pre-summation** (`## Total: $2,500`) is a deferred follow-up — deterministic money/duration parsing over free-text is its own fragile surface; the complete instance list already moves buckets 1–2.

### D4. Trigger, laziness, idempotence, and GC (consolidator)

A `runRollupPass` step near the end of `runConsolidation`, ordered **after** near-dup merge / write (so a class counts merged docs once) and **before** the final `regenerateMap` (so new/removed rollups get map lines in the same pass): decay → cluster → decide/dedup/write → **rollup pass** → map regen.

- **Dirty gate:** run only if the pass promoted/merged ≥1 fact into an **enumerable-category** doc. The current `promoted`/`dupesMerged` counters are category-agnostic, so add a per-category enumerable-write flag to the loop (small addition at `consolidator.ts:233/267`).
- **Recompute:** rebuild the class index (Stage A + B) from `listDocs`, compute qualifying classes + bodies.
- **Idempotent write:** write `docs/rollup/<class>.md` only if a stable hash of `(rollup_members, rollup_count, instance-line text)` differs from the on-disk rollup. The hash **includes the instance-line text**, so an edit to a member's representative fact (same members, same count) still rewrites. Fire `doc:written` on write.
- **GC — with index deletion (was missing; this is the blocking fix from review).** Any `docs/rollup/<slug>.md` whose class no longer qualifies (dropped below K after dedup/merge, or now generic) is deleted. **Doc deletion is the first deletion path in the system** — `reindex.ts` today only upserts. So GC must also remove the index row, or a stale rollup keeps answering `## Count: 3` after the file is gone (a wrong-answer-by-construction bug, and a direct violation of the Non-goals "never a wrong answer" promise). Wire it via a storage-agnostic **`memory:doc:deleted { docId }`** event (or extend the `doc:written` `kind` union with `'deleted'`) + a `reindex.ts` branch that calls the existing `memory:index:delete` hook. Index schema untouched — the `delete` hook already exists in both backends. GC unlinks **only** paths matching `docs/rollup/<slug>.md` with `slug ∈ SLUG_RE` (never a raw `readdir`+`unlink`).
- Instrument: `rollup_written` / `rollup_skipped_unchanged` / `rollup_gc_deleted` / `rollup_cap_exceeded`, each with class + member count.

### D5. Retrieval surfacing (how the count actually reaches the model)

Rollups are indexed like any doc (D3), so BM25/orchestrator retrieves `rollup/weddings` on "how many weddings." Two channels deliver the answer, and it matters which:

- **The count rides the frontmatter `summary`** ("Weddings — 3 the user attended"), which is a top-level `SearchResult.summary` field the model always sees. *Correction from the draft:* `matchedFacts` extracts only `- ` bullet lines (`matched-facts.ts`), so the `## Count` prose line is **not** surfaced that way — the summary is the reliable count channel.
- **The instance list rides `matchedFacts`** (the `## Instances` bullets), giving the model the complete, dated, de-duplicated set to verify the count and to *sum* over (bucket 1).

*Optional, deferred:* a one-line orchestrator-prompt hint to prefer `rollup/*` for counting queries (prompt-only, no contract change).

**Over-count / noise risk (needs a real gate, not just monitoring — review finding #5).** Two hazards: (a) the rollup + its source docs both surface, showing instances twice; (b) a weak salience band admits noise-token rollups that inject redundant lines. The diagnosis shows extra surfaced facts *cause* over-counting (babies 5→6, cuisines 4→5). Mitigations: the authoritative `summary` count anchors the answer; the shipped WS-A coaching says "count distinct instances"; `[[links]]` make overlap recognizable; and the LLM stage (D2-B) produces *named* classes (not raw token bands), which is a stronger relevance filter than Stage A alone. **Pre-registered rollback:** if the e2e over-count cases (babies/cuisines) regress vs the enum+exp baseline, gate Stage A behind a higher salience bar or ship LLM-named rollups only.

## Testing (TDD per layer)

1. **class-detect Stage A unit:** docs sharing a rare token ≥K → one class; below K → none; generic token over `SALIENCE_MAX_FRACTION` → excluded; singularization; multi-class membership; per-pass cap enforced + logged.
2. **class-detect Stage B unit:** stub LLM returns proposed classes → membership verified against real doc ids (hallucinated ids dropped; sub-K classes discarded); residue-only input (Stage-A-claimed docs excluded).
3. **rollup-doc unit:** qualifying class → correct frontmatter (`summary` carries count, `rollup_count`, `rollup_members`, `origin: reflect`) + `## Count`/`## Instances` body with dated `[[linked]]` lines; write fires `memory:doc:written`.
4. **idempotence unit:** unchanged `(members,count,instance-text)` → no write (`rollup_skipped_unchanged`); a member's edited representative fact → rewrite; added member → count+1 rewrite.
5. **GC + index-staleness regression (the blocking bug):** a class dropping below K → rollup file unlinked **and** `memory:index:delete` fired → a subsequent `memory_search` does **not** return the stale rollup. `rollup_gc_deleted` logged; map line gone.
6. **consolidator integration:** no-enumerable-write pass skips the rollup pass (per-category dirty gate); a promoting pass runs it; ordering is after near-dup merge, before map regen.
7. **surfacing:** direct/CLI path — rollup indexed and returned by `memory_search` with count in `summary` and instances in `matchedFacts`; **tier path** — `reindexTierDocs` includes rollups; **orchestrator** — `rollup/…` passes `parseDocId`, appears in the rendered map menu, and a `<load>` of it is not dropped.
8. **rollup enumeration canary (kit-level):** ingest 3 sessions each adding one wedding under a different subject → `docs/rollup/weddings.md` exists with count 3 + all three linked instances; `memory_search("how many weddings")` returns it.

## Boundary review

- **New event — `memory:doc:deleted { docId }`** (or a `'deleted'` arm on `doc:written`). Alternate impl: any doc store that deletes could fire it. Field names storage-agnostic (`docId` only; no path/sha/bucket). Subscriber: `reindex.ts` maps it to the existing `memory:index:delete` hook. Wire schema lives in the memory-strata plugin. This is the *only* new payload; the draft's "no new hooks" claim was wrong (GC needs it).
- **No `memory:index:*` schema change** — `category` is a free string in both backends; `delete`/`upsert` already exist.
- **Subscriber risk:** rollups are ordinary docs; existing retrieval consumers treat them as such.

## Security review

- **Untrusted content — LLM naming (D2-B):** the model reads only the agent's **own** stored doc summaries (already reachable via `memory_read_section`) and returns class labels + doc ids. Its output is **not trusted**: doc ids are verified to exist before any write, class slugs pass `slugify`, sub-K classes are dropped. No arbitrary path or content from the model reaches disk. No new external egress (same in-cluster extraction model already used).
- **Scope:** rollup writes/reads go through the agent-scoped doc store (traversal-guarded ids). GC unlinks only slug-guarded `docs/rollup/*.md`.
- **Disclosure:** rollups expose counts/lists of the agent's own memory it could already enumerate; no trust boundary crossed. Response volume rides the shipped `matchedFacts` caps.

## Validation

After all tasks land, re-run the e2e harness (both retrieval paths, fresh resume ids); compare against enum+exp baselines (orch 78.0%/60.0%, BM25 76.0%/53.3%). Gate: **multi-session ≥ 65%**, overall no worse than baseline −1pt, correct-refusal ≥ 83%. Diff the JSONL vs `orch-exp-lowcap.jsonl` for per-question flips on the bucket-1/2 misses (weddings, kits, clothing, food-delivery, luxury, furniture, cuisines). Watch the over-count cases (babies/cuisines) for the D5 rollback trigger. If sum-questions (bucket 1) stay red, that scopes the numeric-pre-sum follow-up.

## Follow-ups (out of scope)

- Numeric pre-summation in rollups (`## Total`) once count-rollups prove out.
- Line-granular detection (group fact-lines across docs) if class-in-one-doc cases (festivals) still miss after Stage B.
- Orchestrator-prompt hint to prefer `rollup/*` for counting queries.
- Entity disambiguation (the two-Emilys collision) — separate observer-side lever.
