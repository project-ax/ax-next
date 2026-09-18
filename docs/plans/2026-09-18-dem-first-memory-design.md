# DEM-first agent memory — design

**Date:** 2026-09-18
**Status:** design, not scheduled. A thought experiment that produced a buildable spec.
**Question it answers:** if ax had never built Strata and only had DEM (`dem-memory/`), how would we solve agent memory, context optimization, and memory tiering — and what would it cost?
**Predecessors:** `docs/plans/memory-strata-design.md` (what this replaces in the experiment), `dem-memory/HANDOFF.md` (the measurements this rests on), `docs/plans/2026-09-17-counting-directives-report.md`, `docs/plans/2026-09-16-evidence-depth-and-source-anchors-report.md`.

## How to read this

Sections 1–8 are the design. Appendix A lists every number the design leans on and where it came from, including one measurement made while writing this doc. Appendix B is the boundary review CLAUDE.md requires for new hooks. Where a claim is unmeasured it says so; where a decision was a judgment call it names the alternative.

---

## 0. Framing and the four decisions

DEM scores **87.4%** on LongMemEval-S (n=500, replicated across two answerers) against Strata's **76.0%**, with the lead concentrated in two question types with confirmed mechanisms — temporal-reasoning (90.2 vs 59.3) and single-session-assistant (91.1 vs 63.6). Consolidation is not the blocker: 99.1% of gold-session facts survive Strata's drop rules, 0/500 questions starved. The blocker to "just replace Strata" is the interface — `memory:index:*` is document-shaped and has nowhere to put a validity interval — and DEM's binding to a local sqlite file.

So the design question was never "swap the engine." It was "what does agent memory look like when the unit is a ~20-token bi-temporal statement instead of a document?" Four decisions were made up front and everything else follows from them:

| Decision | Choice | Alternative not taken |
|---|---|---|
| Source of truth | **The fact store.** Markdown is an export that nothing reads back. | Markdown-as-truth (Strata's #1 principle) — reduces DEM to another BM25+vector index behind a doc-shaped contract. |
| How memory reaches the model | **Hybrid, staged.** Tool-first (`memory_recall` returns the evidence table) plus a small always-injected block. An automatic per-turn seam only if measurement says the agent doesn't search. | Automatic per-turn table (the exact shape that scored 87.4%, but needs a kernel seam ax lacks and injects noise into non-question turns). |
| Decomposition | **Thin waist.** Product plugin over a storage-agnostic engine contract with sqlite + postgres backends, mirroring `memory-strata` + `memory-strata-index-*`. | One fat plugin — no alternate impl, DEM vocabulary becomes the API. |
| Forgetting | **Nothing yet — measure first.** Instrument store size and rank displacement; build a forgetting mechanism when a failing question demands it. | Read-time only / aggressive supersession / periodic synthesis. All have good mechanism stories; this project has learned twice that those don't survive measurement. |

---

## 1. What Strata solves, and what happens to each job

Thirteen jobs, of which retrieval accuracy is one:

| Strata job | Under DEM-first |
|---|---|
| Observer (`chat:end` extraction) | **Kept**, retargeted to statements. Carries DEM's pinned extraction prompt (`f4752a79`), which already ports the 2026-08-02 assistant-content contract. See §3.0. |
| Inbox | **Gone.** It staged a lossy step that no longer exists. `record` is atomic across relational + FTS + vector. |
| Consolidator (decay → cluster → confidence gate → Jaccard dedup → merge → delete) | **Gone.** It bounded *document count*; there are no documents. Measured: 99.1% gold-fact survival, i.e. the drops bought ~nothing. |
| `docs/<category>/<slug>.md` as truth | **Demoted to export** (§5). |
| Hot / warm / cold tiers, Promoter, LRU, pinning | **Hot** = rules file + profile view + recent view + digest, ~300–500 tokens, all derived per chat. **Cold** = the store, reached by `memory_recall`. **No warm tier and no promoter**: the unit is small enough that nothing is pre-loaded, so the only boundary is "in the prompt" vs "in the store," decided per turn by retrieval. |
| Injection block (3,500 tokens, drop order) | ~300–500 tokens with a drop order (§4.1). |
| `map.md` (2,000 tokens, LLM-densified, sidecar cache) | **Replaced** by a cheap derived digest (§4.1). The riskiest substitution in this table; it has one number to earn (tool-call rate). |
| Retriever + orchestrator (planner LLM, p50 1.4–1.6 s, silent BM25 fallback past budget) | **Gone.** No model in the read path. |
| `memory_search` / `memory_read_section` | **One tool**, `memory_recall`. Drill-down doesn't exist as a concept — a statement *is* the full content. |
| `memory_note` | **Kept**; `provenance: agent`. |
| Human tier (`system/rules.md`) | **Kept verbatim, outside the store**, in a subtree the export cannot write to by construction (§5.2). |
| Rollup + recurrence (~1,400 LOC) | **Deferred.** Not built until a failing "how many X" question demands it. Note it would *not* fall out of §3.3 for free: only profile slots are normalized, and `recommended`/`attended`-style relations stay free text, so an aggregate would need its own normalization when the demand appears. |
| Sensitive gate + quarantine | **Kept**, applied at `record` to one row with one flag. |
| Index contract (sqlite + postgres) | **Kept**, re-pointed at `memory:facts:*`. |
| AgentMemory UI | **Kept**, as a client of the product hooks (§5.3). |
| Bootstrap / reindex | **Kept**; reindex = rebuild FTS + vectors from the relational table and drain `pending` fields. |

**Size, measured:** `packages/memory-strata/src` is 8,553 LOC non-test plus 2,590 across the two index backends; `dem-memory/src` is 2,126. The product layer here is not free, but the consolidator, rollup, map builder, promoter, orchestrator and doc-store all vanish, and those are the bulk of the 8,553.

**What this buys beyond the table:** invariant 4. Today `docs/` is simultaneously the truth, the index input and the UI surface, written by the consolidator, the map builder and the rollup GC. Here there is one writer to the store and one derived writer (the export) to the workspace.

---

## 2. Architecture

### 2.1 Packages

- **`@ax/memory`** — the product layer. Observer, speaker rewrite, normalizer, the injected block, the two tools, the export materializer, the human tier, the caller-facing hooks. Contains no DEM vocabulary.
- **`@ax/memory-facts-sqlite`**, **`@ax/memory-facts-postgres`** — the engine (DEM's store + four-channel recall + RRF + rerank) behind `memory:facts:*`.
- **`@ax/memory-facts-contract`** — the shared contract test both engines run.

### 2.2 Hook surface

Two layers. **The hook you call determines provenance** — there is no `provenance` field in any caller-facing payload.

**Product layer (`@ax/memory`) registers:**

| Hook | Payload → result | Provenance |
|---|---|---|
| `memory:recall` | `{query?, about?, at?, activeOnly?, limit}` → `{statements: [{id, about, relation, value, when, until?, kind?}], degraded: string[]}` | read |
| `memory:remember` | `{about, relation, value, when?}` → `{id}` | **human** — the only external write; called by the UI |
| `memory:forget` | `{ids}` → `{}` | human |
| `memory:rules:read` / `memory:rules:write` | unchanged from today | human |
| `system-prompt:augment` | the block (§4.1) | — |
| `tool:execute:memory_recall`, `tool:execute:memory_note` | §4.2, §4.3 | agent |

**Subscribes:** `chat:end` (observer). **Calls:** `memory:facts:*`, `workspace:*` (export + rules), `llm:call:*` (extraction only).

**Engine (`@ax/memory-facts-*`) registers:**

| Hook | Payload |
|---|---|
| `memory:facts:record` | `{batchKey, statements: [{about, relation, value, when, kind?, slot?, provenance, ownerUserId, conversationId?}]}` |
| `memory:facts:recall` | `{query?, about?, at?, activeOnly?, ownerUserId?, limit, poolSize}` → `{statements, degraded}` |
| `memory:facts:supersede` | `{ids}` |
| `memory:facts:clear` | `{}` |
| `memory:facts:reindex` | `{}` — rebuild derived indexes, drain `pending` |

The engine payload carries `provenance` and `ownerUserId` because they are stored columns; only `@ax/memory` calls it. Tenant (`agentId`) always comes from `ctx`, never from a payload.

### 2.3 What the read path never does

No generative call, anywhere. Four deterministic channels (sparse, dense, graph, temporal) → RRF → cross-encoder → top-N. The two external calls it *does* make (embedder, reranker) are the subject of §4.4.

One caveat on the graph channel: DEM's co-occurrence graph is keyed on `about`, which is the speaker on 90.0% of rows — so as built it is two giant nodes and noise. Its contribution to RRF has never been ablated. Rung 0 (§8) ablates it; the outcome is either drop the channel or re-key it on an entity list, and neither is decided here.

---

## 3. Write path

### 3.0 Observer — the component worth 57 points

`chat:end` → dialogue → one structured extraction call → statements. Measured: the extractor is worth ~57 points (gpt-4.1-nano 26.0% vs glm-5.3-flash 83–88% on identical questions and answerer); the answerer is worth ~nothing (McNemar p=1.000). **This design does not change the extraction prompt.** It carries the prompt behind fingerprint `f4752a79` verbatim, including the assistant-content contract that moved single-session-assistant 45.5 → 81.8 in both answer arms.

**The observer sees user and assistant turns only — never tool results, never attachment bodies.** Web pages, files and MCP output are the highest-volume injection channel into memory; the assistant's restatement of a tool result is one hop removed and in the model's voice. (Whether Strata's observer honours this today should be checked; if not, it's a pre-existing hole.)

Fire-and-forget, as today: `chat:end` must not block on a ~30 s call. Every failure is an event (§6.4).

### 3.1 Statement shape

```ts
{
  about: string;                            // canonical subject; speaker rewritten per §3.2
  relation: string;                         // FREE TEXT — what retrieval reads; never a key
  value: string;
  when: string;                             // ISO; DEM's validStart
  kind?: 'world' | 'experience' | 'opinion';// passthrough until ablated — it is in the prompt that scored 87.4%
  conversationId?: string;                  // provenance only; never a retrieval key
}
```

`predicate` splits into `relation` (free text) and `slot` (derived, §3.3) because it was doing two jobs — a label the reranker reads and a key supersession matches on — and free text is right for the first and fatal for the second (Appendix A.4).

### 3.2 Speaker rewrite and ownership

The extractor canonicalizes the speaker as `user`. With the store keyed by agent (§6.1) that collapses every person who talks to a team agent into one subject, and `lives_in` would be closed each time a different person says where they live. At `record`, the product layer rewrites `about: user` → `about: user:<userId>` from `ctx`, and stamps every statement with `ownerUserId` (the conversation's user). Same shape `@ax/decisions` uses for the same reason. Conversations with no live person — a routine run — carry the routine owner's id, per the existing rule that system paths materialize a real owner rather than a synthetic actor.

### 3.3 Normalizer — `slot`

**Purpose.** Give "active" a meaning. Without it the active set is unbounded and supersession fails in both directions (Appendix A.4).

- **The slot list** is one config constant in `@ax/memory`, eight entries, *all single-valued*: `name`, `pronouns`, `lives_in`, `works_at`, `role`, `timezone`, `language`, `birthday`. This list *is* the profile whitelist (§4.1) — same constant, one owner. Everything else has no slot and never closes anything.
- **Mapping is deterministic and post-extraction.** Embed the relation (snake_case split to words) with the write-path embedder, nearest-neighbour against slot descriptions, strict threshold, small exact-synonym table in front. No LLM; no extractor change, so `f4752a79` stays pinned and the effect is measurable in isolation. `slot` is stored but derived — an embedder change re-runs it via `reindex`.
- **The error is asymmetric.** A false positive (`visited` → `lives_in`) closes a true fact; a false negative is the measured baseline. The threshold's initial value is set at rung 0 from the precision sample (§8) and loosens only on `closed_by` evidence (§3.4).
- **Not built:** multi-valued slots, `replaces`, `retracts`, and DEM's `invalidatesPrevious`. knowledge-update scored 87.2% with supersession firing on 0.11% of rows — newest-wins at read time is already doing that job. `invalidatesPrevious` was 91.8% no-match anyway.

The vocabulary is deliberately generic. LongMemEval is a consumer chatting with an assistant and can't tell us what an ax agent's slots should be; anything domain-shaped (`prefers_backend`) waits for evidence.

### 3.4 Closure rules (engine, one transaction)

On record of statement **S** with a slot, within the tenant and `(about, slot)`:

1. Close every active **R** with `R.when ≤ S.when`: `R.until = S.when`, `R.closed_by = S.id`.
2. **Two-sided.** If an active **R′** has `R′.when > S.when`, close S at the earliest such `R′.when`. DEM's SQL is `valid_start <= ?` only — a backdated `lives_in` currently stays active beside the current one.
3. **Provenance immunity.** A row is closed only by a row of equal-or-higher provenance: `human > agent > extracted`. A person's correction survives the next chat mention.
4. Equal `when`: later `transaction_time` wins.

`memory:facts:supersede {ids}` is the explicit close (UI delete), `closed_by = null`. `until` and `closed_by` are columns, so every closure is auditable and reversible. No-slot rows never close anything.

### 3.5 Batch semantics

- **Idempotent.** `chat:end` can fire twice. `batchKey = conversationId + content hash` (the extraction cache's own key shape); a repeated batch is a no-op, not duplicate rows.
- **All-or-nothing per batch.**
- **Pending, not lost.** Embedder unavailable → rows stored with `embedding: pending`, `slot: pending`; `reindex` drains. Pending slot = under-closing, the safe direction.
- Extraction schema failure → one retry with the schema echoed (the bench already does this), then drop the batch with an event.

---

## 4. Read path

Strata puts ~3,500 tokens in every prompt plus a 2,000-token map, then a planner LLM per search. This puts **~300–500** in the prompt and spends nothing generative on the way to the model.

### 4.1 Always-injected block (`system-prompt:augment`, at chat start)

| Part | Source | Size | Dropped |
|---|---|---|---|
| **Rules** | the human-tier file, verbatim | as written | never |
| **Profile** | active rows, `about = user:<caller>`, `slot ≠ null`, rendered `- lives_in: Seattle (noted Mar 2024)` | ≤ ~10 rows | last |
| **Recent** | last 3 conversations by `transaction_time`, the 3 most recent statements of each, dated | ~150 tokens | second |
| **Digest** | distinct non-speaker `about` values ranked by count × recency, top ~20: *"I hold memory about: cedar_creek (4, Aug), …"* | ~150 tokens | first |

Three store queries, no embedding, no rerank, no model — milliseconds, which is why chat start is fine and no per-turn seam is needed for the block. Soft cap ~800 tokens.

Two rendering rules learned the hard way: the profile says **"(noted …)"**, never "since" — `when` equals the extraction date on 93% of rows, so it is when we *learned* it. And Recent is grouped by conversation because one `chat:end` emits ~12 statements; a flat last-N is the tail of one topic.

**The digest is weak for user-centric memory and this design says so.** It covers entities (the ~10% of subjects that aren't the speaker). It says nothing about the bulk — no-slot facts about the user: a fitness routine, a job search, the kids. There is no free derivation for those (top relations by count are `stated`, `listed`). The tool description, profile and recent carry that load, and the only number that matters is the **tool-call rate** on the product e2e bench (§8). If the agent doesn't search when it should, the upgrade is a post-hoc entity pass over `value` — a small call that reads extracted facts, not dialogue, so the extractor stays pinned. Not built until the rate says so.

The block is built at chat start and is stale for the rest of the conversation if memory changes mid-chat. Same property as today; `memory_recall` is the fresh path.

### 4.2 `memory_recall` — the per-turn path

Input: `{ query: string; limit?: number }`. Default 15 rows, max 40 (rerank pool scales with `limit`; budget-fill was measured null).

Not on the tool, on purpose:
- **`at` (time travel).** The exact footgun DEM's README warns about, handed to a model: an agent asked "what was I doing in March" will pass `at: March` and evict everything recorded later. `asOf` is automatic and the `When` column renders dates, so no measured question type needs it. Stays on `memory:recall` for the UI.
- **`about`.** "Everything about Cedar Creek" is `query: "Cedar Creek", limit: 40`; `about` values are extractor-canonical and a model guessing them misses.
- **Statement ids.** They pay tokens for a tool the agent doesn't have; correction of slot facts already works through `memory_note` under provenance ordering. Ids stay on the hook output for the UI.

Output is the evidence table **byte-identical to DEM's**: `Kind | When | Statement`, `When` as date + weekday + elapsed computed in TypeScript, oldest-first, `asOf` set to the wall clock by the product layer on every call. This table is the artifact behind temporal-reasoning 90.2 vs 59.3; nothing in the read path re-renders it. The result header carries today's date, the degraded state if any (§4.4), and the *measured* grounding line from DEM's reflect prompt — not a new one; see "two prompt sentences that cost answers" in `HANDOFF.md`. The abstention directive does not otherwise come along, and hallucination over a thin table is the failure to expect; §8 rung 4 is where that gets measured.

Per-turn cost to the model: ~500–900 tokens (measured median 490 → 887 at 15 rows), only on turns where the agent asks, plus the tool definition.

### 4.3 `memory_note`

`{ about, relation, value, when? }` → `record` with `provenance: agent`, through the speaker rewrite and normalizer like everything else. No dedup; the export groups duplicates for display.

### 4.4 Degraded mode is a signal, not a quieter answer

The read path has two external dependencies and DEM's fallbacks are silent — the fault the orchestrator was criticized for.

- Embedder unavailable → dense channel skipped, RRF over three; `degraded: ['semantic']`.
- Reranker unavailable → lexical fallback; `degraded: ['ranking']`.
- Store unavailable → **tool error**. An empty table is a valid answer; a failed store is not.
- Timeouts, provisional until measured: embed 1.5 s, rerank 2 s, whole call 4 s, then degrade with the flag set. Embed + rerank end-to-end latency has not been measured and replaces a planner at p50 1.4–1.6 s.

Degraded state renders in the tool result header and in telemetry. The engine contract asserts the flags; the product layer test asserts they render.

---

## 5. Export and UI

**Facts are truth; markdown is an export nothing reads back.**

### 5.1 Who the export is for

Not only people. `agent-tier-sync.ts` exists because the **reflection runner reads `/agent/memory/**` inside its sandbox** — skill crystallization no-ops without it. Two consumers: git history and portability for the person; a filesystem view for the runner.

### 5.2 The materializer

- **Trigger:** after each `record` batch and after any `supersede`, debounced per tier (the `/agent` tier is per-(caller, agent), §6.1); writes through `workspace:apply`, owner-routed by `ctx`. One-way: no hydrate, no read-back.
- **Layout.** The human tier and the export get **different subtrees**:

  ```
  permanent/memory/
    rules.md                  ← human tier; the export's delta builder is rooted at facts/ and cannot emit this path
    facts/
      profile.md              ← active slot rows about the viewer, "(noted …)"
      recent.md               ← last 3 conversations, grouped
      user/2026-09.md         ← monthly journal for speaker subjects, named by transaction_time (server clock)
      assistant/2026-09.md
      about/<slug>.md         ← one file per non-speaker subject; slug = [a-z0-9_-]{1,64}, hashed if the subject doesn't survive
  ```

  The delta builder's root is a type, not a runtime check. That replaces `stripHumanTierChanges`.
- **Format.** One line per statement: `- 2026-09-17 · lives_in · Seattle`. Closed rows stay, rendered `(until 2026-11-02)` — bi-temporal history is *visible* in the export, which markdown-as-truth never gave.
- **Idempotent.** Full regeneration, hash-diff against the previous export; unchanged files aren't rewritten.
- **Staleness:** the debounce window. The runner's file view can lag one turn.
- **Scope.** The `/agent` tier is per-(caller, agent), so the export writes the viewer's scope (§6.1). Under a future shared-visibility mode it fans out to each member's tier — N copies, consistent with the Files tab.

### 5.3 The UI

`channel-web`, shadcn primitives, **a client of `memory:recall` / `memory:remember` / `memory:forget`** — the same product hooks, never the engine hooks, never the export:

- **Profile** — slot rows, each editable. An edit is `memory:remember` (closes the prior under §3.4); a delete is `memory:forget`.
- **Rules** — the existing editor over `memory:rules:*`. Unchanged.
- **Search** — the same `When` table the agent sees, with per-row **Forget**.
- **History** toggle on any list — closed rows with `until` and what closed them.

What's lost against Strata's tab: editing prose documents. There are none. A person edits *facts* — a list with a delete button — which is arguably the clearer surface for a non-technical user; a `ux-design` pass owns the copy. Statements render as plain text, never as markdown (§6.3).

### 5.4 Not built

Import (markdown → store). "You can leave with your data" is the export; "you can arrive with it" is a separate feature with no demand yet — and the one thing the greenfield framing hides, because real adoption would need it (§8).

---

## 6. Tenancy, security, error handling

Walked with the `security-checklist` skill's three threat models.

### 6.1 Tenancy — keyed by agent, scoped by owner

Checked before deciding: the `/agent` tier is per-(caller, agent) (`agentWorkspaceCtx(agentId, userId)` takes the authenticated caller), so today a team agent has N separate memories and no shared memory at all — Strata's composite key is an accident of tier routing, not a policy. `@ax/decisions` solved the same problem the other way: one store per agent, every row carries `owner_user_id`, reads are scoped by it — *"`userId` is a SCOPE, not a hint."*

- **Tenant key = `agentId`**, from `ctx`, engine-side, on every hook.
- **Every row carries `ownerUserId`**; reads are scoped by it **by default**, which is behaviourally identical to today. Agent-wide visibility is a per-agent setting, off unless the agent's owner turns it on — and **not built** until a team agent asks for it. The keying is free; the mode is the only YAGNI part.
- Human corrections are scoped the same way: you correct rows you own; an agent's owner can correct any.
- Postgres: tenant + owner columns on every table; the dense channel is a **filtered** ANN — pgvector's HNSW under-returns on selective filters, so iterative index scan with exact-scan fallback when filtered hits < `limit`. Never post-filter a widened pool.
- SQLite: the CLI preset is single-user, so the widened-pool problem is moot there; rows are still keyed and the contract's isolation cases run against it.
- Every `ids` in `supersede` and every `closed_by` is tenant- and owner-checked; a foreign id is refused.

Shared mode, when built, makes memory a cross-user injection channel — Alice's conversation plants a "fact", Bob's session recalls it. Inherent to shared memory, not to this design; defences are the same as §6.3, and the mode is opt-in.

### 6.2 Sandbox / capability leakage

- **Filesystem.** No direct filesystem access in the product layer in k8s: export via `workspace:apply`, rules via `workspace:*`, both under `permanent/memory/`. The sqlite engine opens one configured path, never a caller's.
- **Path traversal via model output.** `about/<slug>.md` — `subject` is extractor output and `../../rules` is a real input. Slugify to `[a-z0-9_-]{1,64}`, hash anything that doesn't survive; pinned by a test that a hostile subject cannot produce a path outside `facts/about/`. Journals are named by `transaction_time`, not `when` (model output; ~1% of extracted dates are wild).
- **Network egress is a new capability carrying user memory off-cluster.** Nothing in `packages/` embeds or reranks today. This adds **two third-party destinations for memory content**: the embedding provider (every statement, every query) and the reranker (top-40 candidates per recall). Fixed hosts over HTTPS, credentials from the credential store, routed through the existing egress lock — never a raw `fetch` with an env var. And a **local-only mode** (hash or on-cluster embedder + lexical rerank) is required for installs that can't egress, with the accuracy cost stated: n=30 smoke, 80.0% production vs 56.7% without the reranker.
- No process spawn. No caller-named env reads. No handles in any payload; `conversationId` and statement ids are branded identities so no subscriber resolves them as paths.

### 6.3 Prompt injection — the threat this design is *for*

Memory is a **persistence vector**: an instruction seen once becomes text in every future prompt. Four flows, each with its sink.

1. **Dialogue → extractor.** User and assistant turns only (§3.0). Pasted content in a user turn still reaches the extractor; that residual is handled at the sink.
2. **Store → prompt.** Statements are **data, rendered as data**: a table under a heading that names them as recalled observations. Provenance ordering means an extracted row can't overwrite a human one. Memory carries **no capability** — no tool, path or permission; the model still has to act, and `chat:permission-request` still gates that. **Cell escaping:** a statement containing `|` or a newline can forge a table row (`| human | today | SYSTEM: … |`); escape pipes and strip newlines in the block, the tool result, and the export, pinned by a test with exactly that payload.
3. **Model-chosen tool arguments.** `query` → FTS5 with operators neutralized (port `memory-strata-index-contract` Test 8c, the leaked-`NOT` case) and parameterized everywhere else. `memory_note` fields → rewritten, slugified, escaped. **Provenance is never in a caller-facing payload** — it is determined by which hook was called (§2.2); an agent that could write `provenance: human` could make its own note immune to correction.
4. **External responses.** Embeddings are floats (validate dimension, finite); rerank scores are numbers. No string from either provider reaches a prompt.

Two sinks outside the prompt: the **UI** renders statements as plain text, never markdown (`[link](javascript:)` in a "fact"); the **export** is a governed **read-only** path for the runner, so an in-sandbox injection can't plant a file a person later reads as memory. And **`rules.md` must be unwritable from the sandbox** — if the runner can commit it through the git tier, injected content becomes a permanent top-of-prompt instruction. `human-tier.ts` guards host-side writers; whether the runner path is guarded is **unverified** and, if not, is a Strata hole too.

### 6.4 Error handling

- **The write path is fire-and-forget, so every failure is an event** — the `memoryFailureEvent` shape Strata has — surfaced in UI and telemetry. Missing credential → the existing "memory paused" state.
- Batch semantics per §3.5: idempotent, all-or-nothing, pending-not-lost.
- Read path: degraded flags per §4.4; store failure is a tool error, not an empty table.
- Export: `workspace:apply` CAS conflict → rebase-retry per the tier contract; persistent failure → event; the store is untouched because the export is derived.

### 6.5 Supply chain

DEM's manifest is all `^` ranges — pin exact. `sqlite-vec` is already a Strata dependency at `^0.1.6` (unpinned; pre-existing) and ships prebuilt binaries via optional platform deps — read its install path before pinning. `google-auth-library` is avoidable: the embedding endpoint takes a bearer token, so a scoped token from the credential store plus `fetch` drops the dependency and its transitive tree. `better-sqlite3` 13.0.3 and `pg` already exist. No `pgvector` npm package (raw SQL), no reranker SDK (`fetch`). Extraction rides `llm:call`.

### Security note (checklist contract)

- **Sandbox:** new egress to embedding + rerank providers carrying memory content — fixed hosts, credential-store keys, egress-lock routed, local-only mode required; export path slugified and subtree-rooted by type, journals named by server time; no spawn, no env, no handles.
- **Injection:** observer reads user/assistant turns only; statements rendered as data with pipe/newline escaping in all three sinks; provenance determined by hook, never payload; FTS operators neutralized; UI plain-text; export read-only in sandbox; `rules.md` sandbox-writability to be verified.
- **Supply chain:** pin exact; `sqlite-vec` install path audited (already present at `^`); drop `google-auth-library` for a credential-store token + `fetch`; no reranker SDK, no pgvector package.

---

## 7. Growth — measure first

Nothing deletes. Under this design "active" means something (§3.3–3.4) but the store grows without bound, and the one diagnosed retrieval failure in DEM — query-entity crowding — gets worse with size, not better. Rather than pick a forgetting mechanism from a mechanism story, instrument:

- store size per agent (rows, active rows, closed rows) over time;
- recall latency vs. store size;
- rank displacement: for a fixed probe set, does the gold row's rank drift as the bank grows;
- closure audit via `closed_by`: what the normalizer actually closed, sampled.

§8 rung 6 produces the first of these numbers. A forgetting policy is designed when one of them fails, against the failure.

---

## 8. Measurement ladder and rollout

Every rung has a gate and a price, and any rung can end it. Cheapest first, which is also the order in which the design's own claims get tested.

| Rung | What | Cost | Gate |
|---|---|---|---|
| **0 — Offline** | Commit the supersession replay (Appendix A.4) as `bench/supersession-replay.ts`. Normalizer over all 84,561 predicates → mapping rate, hand-checked precision sample, known-bad list. Graph-channel ablation (recall-only). | $0, ~1 day | `assistant \| recommended` closes 0; precision on the sample; ablation decides whether `entities` is ever worth building |
| **1 — Bench** | n=500, GLM answerer, **4 runs per arm**, normalizer on vs. off, facts pinned to `f4752a79` | ~$2 | No loss beyond the 1.6pp floor. This can only show normalization doesn't *hurt*; what it buys isn't on LongMemEval |
| **2 — Engines** | `memory:facts:*` on sqlite + postgres; contract: agent isolation, owner scoping, closure atomicity, two-sided close, provenance immunity, degraded flags, pending drain, foreign-id refusal | build | Contract green on both |
| **3 — Product layer** | Observer → rewrite → normalize → record; block; `memory_recall`; `memory_note`; export; UI; `memory:recall/remember/forget` | build | Unit + reachable from the canary acceptance test (invariant 3) |
| **4 — Product e2e, like-for-like** | Strata's own e2e bench with an *agent* holding `memory_recall`, n=100, two answer arms | ~$1 | **Accuracy ≥ 76.0% replicated across arms**; tool-call rate, tool calls/question, $/100q, recall p95 (< the planner's 1.6 s) all reported |
| **5 — Walk on kind** | Day-one empty state; profile after one chat; correction survives re-mention; Forget; History; export visible from the runner; `rules.md` unwritable from the sandbox | walk | Passes |
| **6 — Lifetime soak** | The full corpus as one bank (130k rows): §7's numbers | ~$0 | Produces the numbers the forgetting decision was deferred *for* |

**What stops it.** Rung 1 losing accuracy. Rung 4 below Strata, or a tool-call rate that says the agent doesn't search without a map — the digest upgrade is the next experiment, not a rewrite. Rung 6 showing recall latency growing with store size faster than a lifetime tolerates.

**If it were real, not pretend.** One memory plugin per preset — `memory-strata` *or* this, never both for an agent (invariant 4) — with `memory:rules:*` as the shared contract so the Rules UI works with either. Adoption needs the import §5.4 declined to build, because existing agents have docs. That is the honest price of the thought experiment.

---

## 9. Open questions

- **`kind` (DEM's epistemic networks).** In the prompt that scored 87.4%, with no measured consumer — the same shape `confidence` had before it was deleted as a constant. Ablate; keep as passthrough until then.
- **Graph channel contribution.** No ablation exists. Rung 0.
- **Observer vs. compaction.** What the observer sees when a long conversation was compacted before `chat:end`. Shared with Strata; not this design's to answer.
- **`rules.md` writability from the sandbox.** Unverified; rung 5.
- **Shared team memory.** Schema-ready, not built, no policy for what "shared" includes beyond "everything the agent holds."

---

## Appendix A — the measurements this design rests on

All from `dem-memory/HANDOFF.md` and the reports it cites unless noted. Quote the replicated row, not the headline; per-type rows at n=100 sit on n=6–27 and move ±4–6pp on identical code.

**A.1 Accuracy, n=500, full corpus, grok-4.3 judge.** DEM 87.4% (sonnet-4.6) / 87.4% (glm-5.3-flash), Strata 76.0%. Noise floor on identical code: TOTAL 1.6pp, multi-session 5.3pp, hallucination 13.4pp. Per type: temporal-reasoning 90.2 vs 59.3; single-session-assistant 91.1 vs 63.6; knowledge-update 87.2 vs 80.0; multi-session 80.5 vs 85.2 (Strata wins); single-session-user 95.7 vs 100.0.

**A.2 Consolidation survival.** 99.1% of gold-session facts survive Strata's drop predicates; 0/500 questions starved; Jaccard dedup takes 0.26% by volume, aimed at the two types DEM leads on.

**A.3 Negative results, both shipped opt-in and off.** Evidence depth (budget-fill vs fixed-15): no replicated gain, 1.9× tokens. Source excerpts: same. Counting directives: +0.6pp inside noise, false refusal doubled and replicated — reverted. Model choice: extractor worth ~57 points, answerer ~0.

**A.4 Supersession replay — measured 2026-09-18 while writing this document.** Over the 130,779 facts pinned to `f4752a79` in `bench/cache/extraction.json`, replaying DEM's invalidation rule (`UPDATE … WHERE subject = ? AND predicate = ? AND valid_end = ∞ AND valid_start <= ?`):

| | Per-conversation scope¹ | Lifetime bank (one user, all facts) |
|---|---|---|
| Facts flagged `invalidatesPrevious` | 1,242 (0.95%) | 1,242 |
| Flags with an exact `(subject, predicate)` prior | 102 | 372 |
| Flags that found nothing | 91.8% | 70% |
| Rows actually closed | 140 (0.11% of facts) | 5,587 (4.27%) |
| Rows closed per matched flag | — | p50 2, p90 23, max 622 |

¹ Approximated by grouping cache keys on session-id prefix, not the exact per-question haystack; the lifetime column is exact.

Predicate space: 84,561 distinct predicates, 86.8% singletons; top of the distribution `stated`, `listed`, `provided_solution`, `recommended`, `interested_in`. Subject is `user`/`assistant` on 90.0% of rows.

Under-closing examples (flag set, prior under a different name): `changed_water_change_routine` vs `current_routine`; `prefers_lunch_at` vs `prefers_control_ingredients`; `provided_schedule` vs `provided_setup_steps`. Over-closing examples (lifetime bank): `assistant | recommended` closed **68 rows** on one new recommendation; `user | interested_in` closed 40; `assistant | provided_solution` closed 46, 30, 23.

Conclusion: the 87.4% was measured with supersession effectively off; enabling it as coded in a lifetime bank is destructive; `predicate` cannot be both a free-text label and an exact-match key. Hence §3.3. The replay scripts were run from the scratchpad and should be committed at rung 0.

**A.5 Sizes.** `packages/memory-strata/src` 8,553 LOC non-test (+2,590 index backends); `dem-memory/src` 2,126.

**A.6 Cost, not like-for-like.** Strata's real pipeline $7.28/100q e2e; DEM's $0.012/100q is answer-side on warm caches, extraction excluded.

---

## Appendix B — boundary review (CLAUDE.md, required for new hooks)

**`memory:facts:record | recall | supersede | clear | reindex`** (engine contract)
- *Alternate impl:* Strata's document-shaped store behind `memory:index:*` — a real one that ran in production. A second alternate is the postgres engine itself, contract-tested against sqlite.
- *Leaking field names:* renamed before subscribers exist — `validStart` → `when`, `valid_end` → `until`, `invalidatesPrevious` → gone, `bankId` → `ctx.agentId`, `network` → `kind` (optional), `rerankPool` → `poolSize`. `RRF`, `vec0`, `FTS5`, `cosine` do not appear in any payload.
- *Subscriber risk:* none can key off a storage-specific field because none is exposed; `degraded` names capabilities (`semantic`, `ranking`), not vendors.
- *Wire surface:* schema lives in `@ax/memory-facts-contract`, not a central file.

**`memory:recall | remember | forget`** (product surface)
- *Alternate impl:* Strata's `memory_search` + `memory_note` + doc edit, re-expressed as these three; the shapes are engine-independent by construction.
- *Leaking field names:* none — `about`, `relation`, `value`, `when`, `until`, `ids`.
- *Subscriber risk:* provenance is implied by the hook, not carried; a caller cannot escalate by field.
- *Wire surface:* schema in `@ax/memory`.
