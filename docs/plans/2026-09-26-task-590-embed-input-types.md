# TASK-590 — memory embeds stored facts as documents, recall as queries

Card: walk TASK-589 measured, on kind against live OpenRouter
(`google/gemini-embedding-001:nitro` @ 384), that OpenRouter passes
`input_type` through to Gemini's task type: a bogus value gets Google's 400 on
`task_type`, `search_document` yields a different vector (cosine 0.94 against
the query vector), and omitting the field equals `search_query` (cosine 1.0).
TASK-523 (#752) deliberately sent no task type (unverified at the time), so
every stored fact has been embedded as a QUERY.

## What the code already does (read, not assumed)

- `@ax/memory-facts-sqlite` already asks for the right task: `'document'` on
  record and on the backfill, `'query'` on recall (`producers.ts` `embedTexts`).
  The hook payload `EmbedInput.task` already carries it.
- The loss is entirely in `@ax/embeddings`' OpenRouter driver
  (`remote.ts` `openrouterEmbed`), which drops `task` and posts
  `{model, input, dimensions, encoding_format}` for both.
- `embeddings:embed` has exactly one consumer (the fact store), so the
  document vectors to repair live in one table: `memory_facts_v1_vec`.

## Decisions

1. **Wire mapping in the driver.** `task: 'document'` → `input_type:
   'search_document'`; `task: 'query'` → `input_type: 'search_query'`. Sent
   explicitly for both (query is the measured default, but relying on an
   omitted field's default is how this bug happened). No hook-surface change:
   `task` is already on `EmbedInput`; `input_type` is driver-internal wire
   vocabulary and never crosses the bus.
2. **Re-embed existing vectors: fingerprint generation bump, which then FEEDS
   #752's vector-less path.** The brief framed these as alternatives; they are
   not. The post-record backfill re-embeds only rows with NO vector
   (`NOT EXISTS (… vec0 …)`), so on its own it would never touch the
   query-embedded vectors already stored — they have vectors. Something has to
   invalidate them, and the store's fingerprint is the one mechanism that owns
   "which recipe made the vectors in `vec0`". So the store's fingerprint becomes
   `<model>#<generation>` with a store-owned generation constant; every
   pre-TASK-590 store holds the bare model id, mismatches once, wipes `vec0` in
   one transaction, and the #752 post-record backfill re-embeds each agent's
   facts — now as documents — on its next successful record.
   - Cost, stated: the same transient TASK-523 accepted for a model change — an
     agent's recall reports `degraded: ['semantic']` until its next successful
     record, and a backlog past 200 rows drains over later records.
   - Rejected: keep old vectors and re-embed in place (needs a per-row "recipe"
     marker in or beside `vec0` — schema for a one-time migration); mixing
     query- and document-embedded fact vectors would also leave the dense
     channel comparing two recipes, which is what the fingerprint exists to
     prevent.
3. **No benchmark re-run** (TASK-523 ruling, restated on the card).

## Tasks

1. `@ax/embeddings`: map `task` → `input_type` in `openrouterEmbed`; replace the
   "no input_type" key-set pin with a pin of BOTH call shapes; rewrite the stale
   comment in `remote.ts`; README/SECURITY lines if any mention it.
2. `@ax/memory-facts-sqlite`: fingerprint generation suffix; tests that a
   pre-TASK-590 fingerprint (bare model id) with vectors is wiped and re-embedded
   through the post-record backfill with `task: 'document'`, and that recall
   embeds with `task: 'query'`.
3. Memory shard reversing TASK-523's "no task type on the wire" row; a pointer
   in the TASK-523 plan doc's decision 3.

YAGNI: all three load-bearing (1 is the fix, 2 is the acceptance's re-embed,
3 is contract rule 5 — the TASK-523 row is now false).

Security: no new egress, no new credential, no untrusted-input change — one
constant string field added to an existing outbound body.
