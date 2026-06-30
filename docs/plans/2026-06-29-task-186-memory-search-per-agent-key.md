# TASK-186 — Per-agent key the memory_search host index + memory_note/read_section tools

epic: skill-crystallization · parent: TASK-182 (PR #351)

## Problem

TASK-182 moved consolidated memory to the per-agent `/agent` git tier for the
observer, consolidator, bootstrap and `system-prompt:augment` (inject) paths. Three
host-side surfaces were left pooled across agents in tier deployments:

1. **`memory_search` host index** — the `memory:index:*` backends (sqlite + postgres)
   key rows ONLY by `docId` (`<category>/<slug>`); the `ctx` is ignored. Every agent's
   docs land in one shared FTS table → agent A's `memory_search` can return agent B's
   facts. This is true in BOTH the CLI preset (one shared sqlite db) and the k8s preset
   (one shared postgres table) — a multi-tenant isolation gap.
2. **`memory_note`** — writes the inbox observation to `ctx.workspace.rootPath` (the
   shared host CWD in a tier deployment), NOT the per-agent `/agent` tier.
3. **`memory_read_section`** — reads the doc from `ctx.workspace.rootPath`, same gap.

Additionally (surfaced by the patterns.md TASK-182 note): on the tier path the
consolidator OMITS bus/ctx, so `memory:doc:written` never fires → the index is never
populated in tier deployments. Keying an index that's never written would be
half-wired, so we also re-enable population on the tier path (reindexer reads the doc
from `/agent` via `workspace:read`).

## Approach

Three independent, testable changes. The index keying is UNCONDITIONAL (scope every
row by the calling agent — fixes CLI pooling too); the two tools + the reindexer route
through the `/agent` tier only when `agentTierAvailable(bus)` (CLI stays on its
per-localdir workspace root, unchanged).

### Task 1 — Per-agent key the index backends (sqlite + postgres + contract)

- Add a stable `agent_key` dimension to both backends, derived from `ctx`
  (`sha256(JSON.stringify([userId, agentId]))`, truncated — "workspaceIdFor or
  equivalent"). The backends already receive `_ctx`; compute the key there. A small
  local `agentScopeKey(ctx)` helper per backend (duplicated like `MAX_TOP_K`; Invariant
  2 forbids cross-plugin import).
- Schema: add `agent_key` column. sqlite FTS5 table gets `agent_key UNINDEXED`;
  postgres gets `agent_key TEXT NOT NULL` and the PRIMARY KEY becomes
  `(agent_key, doc_id)`.
- `upsert`: scope delete+insert / ON CONFLICT by `(agent_key, doc_id)`.
- `search`: add `WHERE agent_key = ?`.
- `delete`: scope by `(agent_key, doc_id)`.
- `clear`: scope by `agent_key` (clears only the caller's docs).
- The hook I/O contract (`UpsertInput`/`SearchInput`/`DeleteInput`) is UNCHANGED on the
  wire — `agent_key` is derived inside the backend from the ambient `ctx`, never a
  caller-supplied field. This keeps the surface storage-agnostic (no userId/agentId
  leaking into the neutral hook payload).
- Contract test: a new shared case in `runIndexContract` — upsert the same `docId` under
  ctx A and ctx B with different bodies; search under A returns only A's; search under B
  returns only B's; delete under A doesn't touch B; clear under A leaves B intact. This
  case FAILS on the pre-fix pooled behavior (Bug Fix Policy).

### Task 2 — `memory_note` routes through the `/agent` tier

- When `agentTierAvailable(bus)`: hydrate the agent's `/agent` memory into a scratch,
  write the inbox observation to the scratch (`writeInboxObservation`), flush back to
  `/agent`. Mirror the observer's hydrate→run→flush in plugin.ts.
- Else (CLI): unchanged — write to `ctx.workspace.rootPath`.
- The sensitive-gate runs BEFORE any tier I/O (no credential ever hydrated/flushed).

### Task 3 — `memory_read_section` reads from the `/agent` tier

- When `agentTierAvailable(bus)`: read `memory/docs/<category>/<slug>.md` from `/agent`
  via `workspace:read` (owner-routed by ctx), parse with the SAME doc parser, extract
  the section. Mirror `readTierSystemBody` in inject.ts.
- Else (CLI): unchanged — `readDoc({ workspaceRoot: ctx.workspace.rootPath, ... })`.
- The `parseDocId` traversal-guard runs FIRST, regardless of path.

### Task 4 — Re-enable index population on the tier path (companion, anti-half-wired)

- Make the reindexer tier-aware: on `agentTierAvailable(bus)`, read the doc from
  `/agent` via `workspace:read` (owner-routed by ctx) instead of `readDoc(ctx.workspace.rootPath)`.
- Pass bus+ctx to the consolidator on the tier path so `memory:doc:written` fires.
- Now the keyed index is actually populated per-agent in tier deployments.

## Boundary review

- **Hook surface change?** The `memory:index:*` hook I/O types are UNCHANGED (agent_key
  is derived inside the backend from ctx, not added to the payload). No new hook. The
  `workspace:read`/`workspace:list`/`workspace:apply` calls from the two tools + reindexer
  reuse the existing TASK-182 surface. No boundary-review needed for a new hook — there
  isn't one.
- **Field names that leak?** None. `agent_key` is a backend-private column; it never
  appears in a hook payload. `docId`/`category`/`slug`/`summary`/`score` stay neutral.
- **Alternate impl?** A backend keyed by a different scheme (e.g. a per-agent table or
  schema) would honor the same contract — the contract test is agnostic to HOW isolation
  is implemented, only that ctx A can't read ctx B.

## Security

This changes a multi-tenant isolation boundary → run `security-checklist` in Phase 3/5.
Verify: (a) search/upsert/delete/clear cannot read or mutate another agent's rows;
(b) the two tools' tier paths are owner-routed by ctx (the git tier confines to the
agent's repo); (c) the doc-id traversal guard + sensitive gate run before any I/O.

## Out of scope (follow-ups)

- Migrating existing pooled index rows: in the k8s preset the index is rebuilt from
  `/agent` content on the next consolidation, and the old pooled rows simply become
  unreachable (no agent_key match). A one-time `clear`+rebuild is unnecessary. Note in
  handoff if an operator wants the stale rows purged.
