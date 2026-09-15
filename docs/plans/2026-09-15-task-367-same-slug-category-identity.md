# TASK-367 — One concept, two docs: same slug under different categories

**Card:** `[TASK-367]` · **Deps:** none · **Source:** `docs/plans/2026-09-15-task-361-detail-loss-report.md` §2

## The design question, settled

The card asks the real question first: **are categories meant to partition concepts, or
describe them?** The code already answers it, in three independent places.

1. **`cluster.ts`'s own header** (`src/cluster.ts:13-20`) says a `ClusterCategory` is
   *"what kind of fact dominated the inbox observations"*, kept as a separate type from
   `DocCategory` (*"where to put the promoted file on disk"*). That is a description of
   a batch, not a partition of concept-space.
2. **`pickCategory` is a per-pass plurality vote** (`src/cluster.ts:115-128`) over the
   `factType` of whatever observations happened to arrive in that flush, with ties broken
   by Map insertion order. A concept's identity cannot depend on which facts arrived on
   Tuesday.
3. **The vote was already flipping, and was already patched once.** On 2026-07-29 `answer`
   observations were removed from the election precisely because *"enough assistant facts
   on a subject can outvote a genuine majority … splitting the same subject across BOTH
   `docs/entity/<slug>.md` and `docs/general/<slug>.md`"* (`cluster.ts:96-109`). That fix
   removed **one** cause of a flip. Every other cause — a session that happens to be
   preference-heavy, an episode-heavy week, a 2-2 tie decided by file read order — is
   still live.

Meanwhile the slug is already treated as the concept's identity *within* a pass:
`clusterBySubject` buckets by `slugify(subject)` explicitly so that *"the Consolidator
never writes two `docs/preference/react.md` files from two differently-cased
observations about the same subject"* (`cluster.ts:1-11`). And at the rollup layer, a
cross-category slug collision already **unions** its members rather than treating the
slugs as unrelated (`src/rollup.ts:194-224`, pinned by `rollup.test.ts:140`).

> **Decision: the slug is the concept's identity. The category is a descriptive
> attribute of the doc.** The consolidator's intra-pass design already agrees; only the
> cross-pass doc lookup disagrees, and that is the defect.

### Why not the other two options the card names

- **Keep both, cross-link them.** This documents the invariant-4 violation instead of
  removing it — there are still two sources of truth for one concept. It also does not
  work on the hot path: the planner picks a handful of docs off `system/map.md` in one
  round, so a "see also" pointer inside a doc body is read *after* selection and would
  need a second load to act on.
- **Make the category part of identity.** This is exactly what the code does today
  (`readDoc` is keyed `(category, slug)`), and it is what produces the bug. It is only
  defensible if the category is stable and meaningful; measured, it is a plurality vote
  over a batch, tie-broken by insertion order.

## The defect, precisely

`consolidator.ts:198-202` resolves the target doc by `(cluster.category, cluster.slug)`.
The only slug-based lookup in the pipeline — the near-dup guard at `:177-191` — reads
**one directory**, the cluster's own category (`listCategorySlugs`, `:529-537`), and
`findNearDupSlug`'s own header says "same-category callers only". So a cluster that votes
`entity` this pass **cannot see** `docs/general/<slug>.md` and mints a sibling.

Measured in the TASK-361 report: **11 same-slug pairs across 1,033 docs** (~1%), including
`user` under four categories in one tree. Rarity does not help when the split lands on the
subject being asked about — on `993da5e2` the agent quoted `general/living-room-decor` and
concluded it had "no information about an area rug"; the rug was in `entity/living-room-decor`.

## The fix

One resolution step in the consolidator, mirroring the near-dup redirect that already sits
two lines above it. Before the near-dup scan: if the exact slug has no doc in the elected
category but **does** have one under another subject category, adopt that category.

```ts
let slugsInCategory = await listCategorySlugs(root, cluster.category);
if (!slugsInCategory.includes(originalSlug)) {
  const adopted = await findSlugInOtherCategories(root, originalSlug, cluster.category);
  if (adopted !== null) {
    cluster.category = adopted;                                  // ← the fix
    slugsInCategory = await listCategorySlugs(root, adopted);
  }
}
const nearDup = slugsInCategory.includes(originalSlug) ? null : findNearDupSlug(...);
```

This composes with everything downstream for free, because `readDoc`, `writeNewDoc`,
`appendFact`, the `docId` in the `memory:doc:written` event, and the
`ENUMERABLE_CATEGORIES` rollup trigger all read `cluster.category`. After adoption
`slugsInCategory.includes(originalSlug)` is true, so `nearDup` is null by the **existing**
TASK-202 rule — an exact match beats a fuzzy one, now across categories as well as within.

**Properties worth stating:**

- **First-writer-wins on the category.** The existing doc keeps its category; the cluster
  moves to it. Nothing is renamed, moved, or deleted — there is no doc-move path in this
  package today (a move would need `memory:doc:deleted` + `memory:doc:written` or the
  index keeps a stale row, `reindex.ts:88-107`), and adding one is not needed to fix this.
- **`rollup` is excluded from the scan.** `docs/rollup/<class>.md` docs are *synthesized*
  from other docs, GC'd by a frontmatter hash, and unlink-guarded (`rollup.ts:378-395`).
  A subject slug that collides with a rollup class slug must not append subject facts into
  a synthesized doc.
- **No new twins can form after this.** Pass 1 writes `entity/x`; pass 2 votes `general`,
  finds `entity/x`, and appends there. Twins only exist in trees built before the fix.

### What this deliberately does not do (YAGNI pass)

| Considered | Verdict |
|---|---|
| Heal pre-existing twins (merge + delete the loser) | **Cut.** Needs a doc-move path, `memory:doc:deleted` fan-out, and index reconciliation. The measured pairs live in bench dump trees that are rebuilt from scratch each ingest, and there is no production memory data. Follow-up card. |
| Make `pickCategory`'s tie-break deterministic | **Cut.** With adoption in place a flipped vote no longer creates a twin — it only decides the category of a brand-new doc. Cosmetic once the real defect is closed. |
| Add a `categoryAdoptions` counter to `ConsolidationResult` | **Cut.** The sibling near-dup redirect logs and does not count; mirror it. Keeps the result shape stable. |

## Tasks

### Task 1 — Collapse the duplicated category lists (prep, enables Task 2)

`DocCategory` is currently enumerated in five hand-maintained copies, and
`.claude/memory/decisions.md` (2026-07-07) records that adding a category needs four
coordinated edits and that missing one is a silent no-op. Task 2 needs an ordered list of
*subject* categories; adding a sixth copy is the wrong move.

- Export from `paths.ts`: `DOC_CATEGORIES` (ordered, `as const satisfies readonly DocCategory[]`)
  and `SUBJECT_DOC_CATEGORIES` (= `DOC_CATEGORIES` minus `rollup`).
- Point `doc-store.ts`'s private `CATEGORIES` at `DOC_CATEGORIES` — net **fewer** copies.
- Test: exhaustiveness — every `DocCategory` union member appears in `DOC_CATEGORIES`
  (compile-time via `satisfies` + a runtime assertion), and `SUBJECT_DOC_CATEGORIES`
  excludes exactly `rollup`.

**Load-bearing?** Yes — without it Task 2 hard-codes a sixth list that drifts.

### Task 2 — Cross-category slug adoption in the consolidator

- Private `findSlugInOtherCategories(workspaceRoot, slug, electedCategory)` beside
  `listCategorySlugs` in `consolidator.ts`, scanning `SUBJECT_DOC_CATEGORIES` minus the
  elected one, in canonical order, returning the first hit or `null`. Deterministic on a
  legacy multi-hit tree by construction (fixed order).
- Wire it in at `consolidator.ts:177-191` per the snippet above.
- Log `memory_strata_doc_category_adopted { slug, electedCategory, adoptedCategory }`,
  gated on a real write/merge this pass exactly as the near-dup line is (`:355-360`) — a
  cluster whose observations all quarantine must not emit a phantom line.

### Task 3 — Regression tests (Bug Fix Policy — these go in before the fix is done)

In `src/__tests__/consolidator.test.ts`, following the near-dup guard tests at `:654/:736/:797`:

1. **The card's scenario.** Seed `docs/entity/<slug>.md`; run a consolidation whose cluster
   votes `general`. Assert **exactly one** doc with that slug exists tree-wide, it is the
   `entity` one, and it holds **both** facts. *Against unfixed code this produces two docs
   and fails.*
2. **Both halves retrievable from one doc** — the `living-room-decor` shape: the rug fact
   and the furniture fact come back from a single doc body.
3. **`rollup` is not adoptable.** A `docs/rollup/<slug>.md` with a colliding slug must be
   ignored: the cluster writes its own subject doc and the rollup file is untouched.
4. **Legacy multi-hit is deterministic.** Two pre-existing twins → adoption picks the same
   category on repeated runs, and no third doc is minted.
5. **Exact cross-category beats same-category near-dup.** Seed `general/b-29-bomber-model`
   plus `entity/b-29-bomber-model-kit`; an `entity`-voting cluster for `b-29-bomber-model`
   adopts the exact `general` doc rather than folding into the `-kit` near-dup.

### Task 4 — Correct the prose this fix makes stale

Contract rule 5. All three are load-bearing prose a future session would re-derive from:

- `cluster.ts:96-113` (`pickCategory`) presents the `answer`-vote exclusion as the defense
  against the twin split and states *"`findNearDupSlug` only dedups within one category so
  it goes blind across the twins"*. After this change the consolidator resolves across
  categories; the comment must say the vote exclusion reduces *churn* and point at the
  adoption step as the actual guarantee.
- `listCategorySlugs`'s header (`consolidator.ts:525-528`) is captioned "(D4 near-dup
  guard)" and gains a second caller.
- **`.claude/memory/context.md`, the 2026-06-29 memory-strata entry**, lists
  *"`system/map.md`, the retrieval orchestrator"* under **"NOT in runtime (design-only or
  bench-only)"**. Verified false this session: `consolidator.ts:403` regenerates the map on
  every pass, `inject.ts:135` splices `## Memory Map` into every system prompt, and both
  `packages/cli/src/main.ts:403` and `presets/k8s/src/index.ts:1382` construct the plugin
  with a live `orchestrator: { hook: 'llm:call:openrouter', model }`. This line is what made
  the map/selection half of this defect look unreachable; it ships corrected with the fix.

## A supporting detail worth recording

`capMapBody` (`inject.ts:167-181`) tail-drops lines from the **injected** map once it
exceeds ~2k tokens, and the map is sorted by category then slug — so a twin in a
late-sorting category can be cut from the prompt while its sibling survives. Collapsing
twins therefore also reduces map pressure. (The orchestrator itself reads the *uncapped*
body via `readInjectedMapBody`, so this affects the hot-tier inject, not the planner.)

## Boundary review

**Not required** — no hook signature changes, no new hook, no IPC action, no payload field.
The change is internal to `@ax/memory-strata`'s consolidation path. `manifest.calls` is
unchanged; `ConsolidationResult` keeps its shape. `memory:doc:written` fires with the
adopted `docId`, which is an ordinary existing docId, not a new field or vocabulary.

**Security-checklist:** not triggered — no sandbox boundary, IPC, plugin loading, new
dependency, or new handling of untrusted content. The one adjacent concern is path
traversal, and it is unchanged: the scan reuses `categoryDir()` over a closed category set
and an already-`slugify`'d slug, and reads only `*.md` names via the existing
`listCategorySlugs`.

## Verification

- `pnpm --filter @ax/memory-strata test` (baseline before this branch: 74 files, 754 passed, 1 skipped).
- `pnpm build` (tsc, whole repo) + `pnpm lint`.
- Repo gate: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.

## Follow-ups to file

1. **Heal pre-existing same-slug twins** (needs a doc-move path + index reconciliation).
2. **Re-measure the pair count** after an e2e ingest run — the TASK-361 report's 11-pairs
   figure is the pre-fix baseline; the post-fix expectation is 0. **Costs ~$0.36, not $0:**
   the card inherited "free, no API calls" from the report, but that was only true while the
   `/tmp/t361` dumps existed, and they are gone from this machine. Re-measuring needs one
   paid re-dump (`bench:diag-detail-loss --out-dir <dir>`, extraction-only at ~$0.04/question
   over the default 9 ids); every re-score after that is free via `--from-dump`.
   `diag-detail-loss.ts:27-28` already corrects its own handoff the same way.
