# JIT — Admit-to-Catalog Queue + Share-to-Catalog Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the self-healing catalog's **admit queue** (three new `@ax/skills` service hooks — `catalog:submit` / `catalog:list-requests` / `catalog:admit`) and the **cross-domain promotion** it drives: an admin admits a *share-to-catalog* submission of a user-scoped skill by promoting its **reviewed bundle bytes** into the global catalog and **retiring the author's editable working copy** (the §6D hard requirement), so the vetted bytes ship read-only org-wide and can no longer be forked. Cold-start *"a user needed X"* requests land in the same queue.

**Architecture:** `@ax/skills` already owns the global catalog (`skills_v1_skills`), the user-scoped skill namespace (`skills_v1_user_skills`), and — once TASK-40 lands — a shared **content-addressed bundle store** (`createBundleStore`). TASK-41 adds **one new table** (`skills_v1_catalog_requests`) and **one new store** (`catalog-requests-store.ts`), reusing that *same* shared bundle store. A **share** submission **snapshots** the source user-scoped skill at submit time — its `manifestYaml`/`bodyMd` verbatim plus a content-addressed tree SHA pointing at the extra-file bytes — so the bytes the admin reviews are *exactly* the bytes that later ship (no review-vs-ship drift, even if the author edits their live copy). `catalog:admit` re-validates the snapshot, `store.upsert`s it to the **global** scope (which re-derives the *same* tree SHA — "register the tree SHA in the catalog DB"), and `userStore.delete`s the author's user-scoped copy (working-copy retirement). All promotion stays **inside `@ax/skills`** using its own stores — no cross-plugin import, no new IPC action (capability minimized). The admin review UI and the user-facing *"submit to catalog"* trigger are **TASK-45** (this plan's half-wired window).

**Tech Stack:** TypeScript, pnpm workspace, kysely + Postgres (testcontainers in tests), zod (return-shape contracts), `crypto.randomUUID()` (request ids), vitest.

## Scope guardrails

- **Boundary review: REQUIRED** (three new service-hook signatures). The full note is in **"Boundary review for the three new hooks"** below and is reproduced in the PR description. Headline: every payload field is storage-agnostic — **no** `bundle_tree_sha` / git / sha / row vocabulary crosses a hook boundary (the snapshot's tree SHA stays an internal storage detail; bundles cross the boundary as the established `files: { path, contents }[]` contract). The design §11 note's `draftSkillMd` field is **stale** (predates bundles + content-addressing) and is refined below.
- **Security-checklist applies — the card flags it explicitly** ("admin review IS the supply-chain gate, bites hardest on the Registry tier"). It is a **pre-PR gate** (Task 7 Step 4) with a pre-stated threat model in **"Security threat model"** below. The three threats: **supply chain** (a possibly-Registry-tier, possibly-injection-authored bundle goes org-wide only after an admin reviews + admits; admit re-validates and ships exactly the reviewed snapshot); **prompt injection** (submit is an inert queue insert — no code runs, no egress widens, nothing materializes until an admin admits); **trust-domain integrity** (retiring the editable user copy closes the user-wins-precedence hole that would otherwise keep serving forkable bytes after admission).
- **Half-wired window: OPEN, closed by TASK-45.** All three hooks are registered + unit-tested + reachable from the canary e2e (Task 7), but their **production callers** land later: the admin **Catalog / Admit-queue UI** (drives `catalog:list-requests` + `catalog:admit`) and the user-facing **"submit to catalog"** trigger (drives the share `catalog:submit`) are **TASK-45**; the broker's **cold-start filing** (firing `catalog:submit` on a search miss, design §13) is a smaller **broker follow-up**. State this in the PR "Half-wired window OPEN" section. Window CLOSES in **TASK-45**. (This mirrors the Phase-1a / TASK-40 pattern: a hook may merge half-wired *as long as it is reachable from the canary acceptance test* and the closing task is named — invariant I3.)
- **Green bar per task** = the package-scoped triad `pnpm -F @ax/skills build && pnpm -F @ax/skills test && pnpm -F @ax/skills lint` (tsc + vitest + eslint, **not just vitest** — task.txt hard requirement #6). The **whole-monorepo** triad (`pnpm build && pnpm test && pnpm lint`) is the Task 7 pre-PR gate. **Bug-fix-test policy** (CLAUDE.md): any bug found mid-implementation gets a regression test before the fix is done.

## Dependency status & as-built re-verification (READ FIRST)

This card **Depends on TASK-33, TASK-39, TASK-40** (and transitively TASK-36). The board's "Depends on" gating means `yolo-ship` pulls TASK-41 **only once all three are Done**, so by execution time TASK-39 + TASK-40 are merged to `main`. **Verified at authoring time (2026-05-26):**

- **TASK-33 — MERGED** (`20bdc31b`, PR #182). The per-user attachment layer + orchestrator union are on `main`:
  - `skills:attach-for-user` / `skills:list-user-attachments` registered in `packages/skills/src/plugin.ts` (the `registers` array; handlers ~`plugin.ts:560-611`); `createUserAttachmentsStore` in `packages/skills/src/user-attachments-store.ts`.
  - The orchestrator unions `per-user > agent-global > default` and **drops a deleted-but-still-attached skill silently** (`packages/chat-orchestrator/src/orchestrator.ts`, the `skillById.get(...) === undefined → continue` guard). **This is load-bearing for retirement:** after admit deletes the user-scoped copy, the author's *attachment* (keyed by `skillId` only, no scope) transparently re-resolves to the now-global skill via `skills:resolve(ownerUserId)` user-wins merge — the author keeps the skill, now sourced from the vetted catalog. Re-confirm the union + silent-drop before Task 6/7.
- **TASK-36 — MERGED** (`73084ba6`, PR #188). `agent:apply-capability-grant` (registered by `@ax/chat-orchestrator`) resolves the skill's slots, calls `skills:attach-for-user`, binds `skill:<id>:<slot>` refs, and retires the warm session so the next turn re-spawns. **Not directly extended by TASK-41**, but it is why an admitted skill takes effect for the author with no extra code. (Line anchors shifted when TASK-36 merged — cite by **symbol**, re-verify before relying on any `orchestrator.ts:NNNN`.)
- **TASK-39 — NOT on `main` at authoring time** (In Progress; only the impl-plan doc is merged, `36f42742`). Taken from the committed plan `docs/plans/2026-05-26-jit-open-mode-agent-authored-skills-flow-c-impl.md`. **The single most important consequence for TASK-41:** TASK-39 installs an agent-authored skill by **`skills:upsert`-ing it to the USER skill store** (`scope: 'user'`, with `files[]`) **and retiring the `.ax/skills/<id>` *workspace* draft at install time** (its resolved fork #3). So by the time a user *shares* a skill, the **"draft to share" is a `skills_v1_user_skills` row** — the workspace draft is already gone. **This refines §6D** (see the resolved fork below). Re-confirm TASK-39's user-scope upsert + draft-retirement shape before Task 4/6.
- **TASK-40 — NOT on `main` at authoring time** (In Progress; only the impl-plan doc is merged, `fc61ddc1`). Taken from the committed plan `docs/plans/2026-05-26-jit-bundle-git-tree-backing-byte-store-swap-impl.md`. TASK-41 builds directly on it:
  - `createBundleStore(repoRoot)` → `BundleStore { writeTree(files: BundleFile[]): Promise<string | null>; readTree(treeSha: string): Promise<BundleFile[]> }`, **content-addressed** (identical bytes → identical SHA → free dedup), with extract-boundary mode/path re-validation. Exported from `packages/skills/src/bundle-store.ts`.
  - `skills_v1_skills` + `skills_v1_user_skills` each gain a nullable `bundle_tree_sha` column; `createSkillsStore(db, bundleStore?)` / `createUserSkillsStore(db, bundleStore?)` accept the **shared** store; `createSkillsPlugin(config: SkillsPluginConfig = {})` constructs **one** `bundleStore` in `init` and injects it into both stores.
  - **TASK-41 reuses that same `bundleStore`** for the requests store, and relies on content-addressing so the global `store.upsert` at admit re-derives the *exact same* tree SHA as the reviewed snapshot ("register the tree SHA" + "shipped == reviewed"). Re-confirm `createBundleStore`, the `bundle_tree_sha` column, the `init` wiring (the exact local variable name — the plan calls it `bundleStore`), and `store.upsert({ …, files })` before Task 2/4/6.

**Confirmed against `main` (do not trust file:line anchors — re-grep before editing):**

- [ ] **No `catalog:*` hooks exist yet.** `git grep "catalog:submit\|catalog:list-requests\|catalog:admit\|catalog-requests\|admit-to-catalog" packages/` returns only design/plan docs. `@ax/skills` registers exactly ten `skills:*` hooks today (`plugin.ts:151-162`). Confirm none of the three exist before adding them.
- [ ] **`@ax/skills` owns both stores + the migration.** `createSkillsStore` (global, `store.ts`), `createUserSkillsStore` (user, `user-store.ts`), `createUserAttachmentsStore` (`user-attachments-store.ts`), and `runSkillsMigration` (`migrations.ts`) are all in-plugin. Promotion + retirement therefore need **no cross-plugin call** — admit reads/writes `@ax/skills`'s own stores (one source of truth, I4). Confirm `store.upsert(...)` and `userStore.delete(ownerUserId, skillId)` are the as-built signatures (`plugin.ts:336-352` shows `userStore.upsert`; `plugin.ts:405-430` shows `skills:delete` scope=user calls `userStore.delete(ownerUserId, skillId)`).
- [ ] **`skills:delete` scope=user is purge-safe for retirement.** `plugin.ts:411-429` deletes the user row and **intentionally skips** both the credential purge and the agent-in-use guard (the `skill:<id>:<slot>` ref is global-namespaced; purging on a user delete would nuke the same-id global skill's creds). This is exactly what retirement wants: drop the editable user copy **without** purging the author's credential, which the promoted global skill (same slots) reuses. Confirm the skip is still in place.
- [ ] **`parseSkillManifest` + `validateBundleFiles` are the validity authorities** (`packages/skills/src/manifest.ts`, `packages/skills/src/bundle-files.ts`). `skills:upsert` runs both (`plugin.ts:279-324`). Admit re-runs both on the snapshot (defense-in-depth — the bytes go org-wide). Confirm `validateBundleFiles(files: BundleFile[]): void` throws on traversal / `.mcp.json` / `.claude/` / `.git/` / caps.
- [ ] **Return-shape contracts pattern.** Every `skills:*` hook registers with `{ returns: <Zod schema> }` and `return-schemas.test.ts` is the drift guard (`types.ts:191-324`). The three new hooks follow suit; the schemas are storage-agnostic by construction (Task 3).
- [ ] **Test harness.** Unit: `makeKysely()` + `runSkillsMigration` (in `migrations.test.ts:14`, `store.test.ts:31`). Plugin: `makeHarness({ services? })` builds `createDatabasePostgresPlugin` + `createSkillsPlugin()` over testcontainers Postgres, with `http:register-route` + `auth:require-user` stubs (`plugin.test.ts:58-76`). Canary: real `@ax/agents` + `@ax/skills` + `@ax/chat-orchestrator` with capture-fakes for `sandbox:open-session` / `proxy:open-session` (`e2e/skill-install.canary.test.ts:175-450`). **After TASK-40, `makeHarness` may thread a `bundleStore` repoRoot** — re-verify and mirror whatever TASK-40 left.

> **Implementation forks resolved (task.txt hard requirement #7):**
>
> 1. **What the "working copy" to retire actually is — RESOLVED: the user-scoped skill store entry, not a `.ax/skills` workspace draft.** §6D's diagram retires `.ax/skills/<id>` (the workspace, RW domain). But TASK-39 (resolved fork #3) **already retires that workspace draft at install time**, leaving the usable skill in `skills_v1_user_skills`. So at *share* time the only editable copy is the user-store row, and **retirement = `skills:delete` scope=user** for `(authorUserId, skillId)`. **Rationale:** §6D's two stated reasons still hold, just relocated — (a) the SDK *project*-vs-*user* dir collision is moot (TASK-39 removed the project copy), but (b) the **integrity** reason is sharper than ever: the user-store row is editable via settings, and the orchestrator's **user-wins precedence** would keep resolving the author's editable copy *instead of* the vetted global one — defeating admission and letting the agent fork vetted bytes. Deleting the user row makes the union resolve the global catalog skill. This is a **flagged stale-design assumption** (§6D language predates TASK-39's install-time draft retirement); the integrity invariant (design §10 "the writable copy is retired on admission") is honored at the post-TASK-39 location.
> 2. **Snapshot at submit vs. read-live at admit — RESOLVED: snapshot at submit.** `catalog:submit` (share) records the source skill's `manifestYaml`/`bodyMd` verbatim + a content-addressed tree SHA of its extra files into the request row. **Rationale:** the design's promotion guarantee is "the SHA guarantees the bytes that ship are exactly the bytes the admin reviewed — no review-vs-ship drift" (§6D, §9.2). Reading the live user skill at admit time would let the author edit between submit and admit, so the admin reviews stale bytes. Content-addressing makes the snapshot cheap and durable: the tree blobs survive even if the author later deletes/edits the skill (TASK-40: orphaned objects are content-addressed, not GC'd at catalog scale). Re-submitting while a request is pending **dedups** to the existing snapshot (§13 "files an admit-request (deduped)"); to get *new* bytes reviewed, the prior request is decided first, then re-submitted (the §6D "re-edit = new draft + re-submit" pattern).
> 3. **Whole-bundle single-SHA pinning (SKILL.md *inside* the registered tree) — RESOLVED: NOT in this task; deferred, consistent with TASK-40.** TASK-40 explicitly deferred "whole-bundle SHA pinning … a P5/P6 promotion-task refinement." The "shipped == reviewed" guarantee is **already met without it**: the request snapshot pins the extra files *cryptographically* (tree SHA, tamper-evident) and SKILL.md via **host-controlled verbatim DB columns** (`manifest_yaml`/`body_md` — not agent-writable, so a verbatim copy is as good as a hash for the threat model). Folding SKILL.md into the tree would change the storage model for no integrity gain here. Stated as a known residual.
> 4. **Promote via the `skills:upsert` hook vs. the in-plugin store — RESOLVED: the in-plugin global `store.upsert`, with explicit re-validation.** Admit reconstructs `{ manifestYaml, bodyMd, files }` from the snapshot, re-runs `parseSkillManifest` + `validateBundleFiles` (defense-in-depth), then calls the plugin's own `store.upsert(...)` (global). **Rationale:** stays inside `@ax/skills` (one source of truth, I4); avoids bus re-entrancy and the global-upsert credential-purge path (irrelevant to a fresh promotion); content-addressing means `store.upsert` re-derives the *same* `bundle_tree_sha` as the snapshot, so the catalog row literally registers the reviewed tree SHA.
> 5. **Cold-start vs. share in one hook — RESOLVED: one `catalog:submit` with a `kind` discriminant; `catalog:admit` promotion is share-only.** Both flavors *land in the queue* (card requirement), so `catalog:submit` accepts `kind: 'share' | 'cold-start'` and `catalog:list-requests` returns both. But a cold-start has **no bundle to promote** (it's a wishlist "please add a skill for X"), so `catalog:admit` with `decision: 'admit'` on a cold-start request throws `cold-start-not-promotable` — the admin authors a skill via the existing admin flow and then `reject`s/closes the request (or it's deduped away once a matching catalog skill exists). `decision: 'reject'` works for both kinds.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/skills/src/migrations.ts` | DDL + row types for skills tables | **add** `skills_v1_catalog_requests` table (+ partial-unique pending index) + `CatalogRequestRow` + `SkillsDatabase` entry |
| `packages/skills/src/catalog-requests-store.ts` | **new** — admit-queue persistence + bundle snapshot/reconstruct + dedup | **create** |
| `packages/skills/src/types.ts` | public hook payload types + return schemas | **add** `CatalogSubmit{Input,Output}`, `CatalogListRequests{Input,Output}`, `CatalogAdmit{Input,Output}`, `CatalogRequest`, and the three `*OutputSchema`s |
| `packages/skills/src/plugin.ts` | hook registration + wiring | **construct** the requests store from the shared `bundleStore`; **register** `catalog:submit` / `catalog:list-requests` / `catalog:admit`; **add** them to `registers` |
| `packages/skills/src/__tests__/migrations.test.ts` | migration tests | **extend** — requests table + pending-dedup index |
| `packages/skills/src/__tests__/catalog-requests-store.test.ts` | **new** — store unit tests | **create** |
| `packages/skills/src/__tests__/return-schemas.test.ts` | return-shape drift guard | **extend** — the three new schemas |
| `packages/skills/src/__tests__/plugin.test.ts` | hook unit tests | **extend** — submit/list/admit/reject + dedup + retirement |
| `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` | end-to-end canary | **extend** — share → admit → re-invoke materializes the promoted global skill for the author; user copy retired; no duplicate-id collision; catalog row registers the tree SHA |

---

## Shared rule: the catalog-request snapshot (referenced by Tasks 2, 4, 6)

A **share** request is an **immutable snapshot** of the source user-scoped skill, taken at submit time:

- `manifest_yaml` + `body_md` — copied **verbatim** from the source skill (the SKILL.md index).
- `bundle_tree_sha` — the content-addressed tree SHA of the source skill's **extra (non-SKILL.md) files**, obtained by `bundleStore.writeTree(files)` (`null` when the skill is single-file). Because the store is content-addressed, this equals the source skill's own `bundle_tree_sha` and stays valid even if the author later edits/deletes the skill.

Reconstruction (for `list-requests` review and for `admit` promotion) is `files = bundle_tree_sha === null ? [] : await bundleStore.readTree(bundle_tree_sha)`. **`bundle_tree_sha` is a storage detail — it NEVER appears in a hook payload.** Bundles cross hook boundaries only as `files: { path, contents }[]` (the established storage-agnostic contract). A **cold-start** request has `manifest_yaml = body_md = bundle_tree_sha = NULL` (`files: []`).

**Dedup:** at most one **pending** request per `skill_id`, enforced by a partial unique index `WHERE status = 'pending'` (belt) plus a SELECT-then-INSERT (suspenders, mirroring `user-attachments-store.ts`'s accepted-race pattern). A second submit for an already-pending `skill_id` returns the existing request with `created: false`.

---

### Task 1: Add the `skills_v1_catalog_requests` table

**Files:**
- Modify: `packages/skills/src/migrations.ts`
- Test: `packages/skills/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `migrations.test.ts` (mirrors the existing testcontainers + `makeKysely()` + `runSkillsMigration` pattern):

```typescript
it('creates skills_v1_catalog_requests; one pending request per skill_id', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);

  await db
    .insertInto('skills_v1_catalog_requests')
    .values({
      request_id: 'req-1',
      kind: 'share',
      skill_id: 'linear',
      requested_by_user_id: 'alice',
      source_owner_user_id: 'alice',
      status: 'pending',
      description: 'share my linear skill',
      manifest_yaml: 'name: linear\ndescription: d\nversion: 1\n',
      body_md: '# linear\n',
      bundle_tree_sha: null,
    })
    .execute();

  const row = await db
    .selectFrom('skills_v1_catalog_requests')
    .selectAll()
    .where('request_id', '=', 'req-1')
    .executeTakeFirstOrThrow();
  expect(row.status).toBe('pending');
  expect(row.decided_at).toBeNull();

  // A SECOND pending request for the same skill_id is rejected by the partial
  // unique index (one pending per skill_id — the dedup guarantee).
  await expect(
    db
      .insertInto('skills_v1_catalog_requests')
      .values({
        request_id: 'req-2',
        kind: 'share',
        skill_id: 'linear',
        requested_by_user_id: 'bob',
        source_owner_user_id: 'bob',
        status: 'pending',
        description: 'dup',
        manifest_yaml: null,
        body_md: null,
        bundle_tree_sha: null,
      })
      .execute(),
  ).rejects.toThrow();

  // But once req-1 is decided, a fresh pending request for the same id is allowed.
  await db
    .updateTable('skills_v1_catalog_requests')
    .set({ status: 'admitted', decided_at: new Date(), decided_by_user_id: 'admin' })
    .where('request_id', '=', 'req-1')
    .execute();
  await db
    .insertInto('skills_v1_catalog_requests')
    .values({
      request_id: 'req-3',
      kind: 'share',
      skill_id: 'linear',
      requested_by_user_id: 'bob',
      source_owner_user_id: 'bob',
      status: 'pending',
      description: 're-submit after decision',
      manifest_yaml: null,
      body_md: null,
      bundle_tree_sha: null,
    })
    .execute();
});
```

Also extend the `afterEach` teardown in this file to drop the new table (no FK; tidy order):

```typescript
await k.schema.dropTable('skills_v1_catalog_requests').ifExists().execute();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/migrations.test.ts`
Expected: FAIL — relation `skills_v1_catalog_requests` does not exist.

- [ ] **Step 3: Add the table + the partial-unique index + the row type**

In `packages/skills/src/migrations.ts`, inside `runSkillsMigration`, after the existing table/ALTER statements, add:

```typescript
  // skills_v1_catalog_requests — the admit-to-catalog queue (JIT §6D, §11.6).
  // BOTH cold-start "a user needed X" requests AND share-to-catalog
  // submissions land here. A share request is an IMMUTABLE SNAPSHOT of the
  // source user-scoped skill at submit time: manifest_yaml/body_md verbatim
  // (the SKILL.md index) + bundle_tree_sha (the content-addressed pointer to
  // the extra-file bytes, NULL for a single-file skill). Snapshotting at
  // submit guarantees the bytes the admin reviews are exactly the bytes
  // admit promotes (no review-vs-ship drift). Cold-start rows carry NULL for
  // all three snapshot columns. `source_owner_user_id` is the user whose
  // editable working copy admit retires (NULL for cold-start). `status`:
  // 'pending' | 'admitted' | 'rejected'.
  await sql`
    CREATE TABLE IF NOT EXISTS skills_v1_catalog_requests (
      request_id           TEXT PRIMARY KEY,
      kind                 TEXT NOT NULL,
      skill_id             TEXT NOT NULL,
      requested_by_user_id TEXT NOT NULL,
      source_owner_user_id TEXT NULL,
      status               TEXT NOT NULL DEFAULT 'pending',
      description          TEXT NOT NULL DEFAULT '',
      manifest_yaml        TEXT NULL,
      body_md              TEXT NULL,
      bundle_tree_sha      TEXT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at           TIMESTAMPTZ NULL,
      decided_by_user_id   TEXT NULL
    )
  `.execute(db);

  // Dedup: at most one PENDING request per skill_id (a decided request frees
  // the id for re-submission). Partial unique index — the DB enforces the
  // §13 "deduped" guarantee even under a SELECT-then-INSERT race.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS skills_v1_catalog_requests_one_pending
      ON skills_v1_catalog_requests (skill_id)
      WHERE status = 'pending'
  `.execute(db);
```

Add the row interface and extend `SkillsDatabase`:

```typescript
/**
 * Admit-queue request row. A share request snapshots the source user-scoped
 * skill (manifest_yaml/body_md verbatim + bundle_tree_sha pointer); a
 * cold-start request leaves the snapshot columns NULL. `bundle_tree_sha` is a
 * storage detail — never surfaced in a hook payload (bundles cross hook
 * boundaries as files[]).
 */
export interface CatalogRequestRow {
  request_id: string;
  kind: 'share' | 'cold-start';
  skill_id: string;
  requested_by_user_id: string;
  source_owner_user_id: string | null;
  status: 'pending' | 'admitted' | 'rejected';
  description: string;
  manifest_yaml: string | null;
  body_md: string | null;
  bundle_tree_sha: string | null;
  created_at: Date;
  updated_at: Date;
  decided_at: Date | null;
  decided_by_user_id: string | null;
}

export interface SkillsDatabase {
  skills_v1_skills: SkillsRow;
  skills_v1_user_skills: UserSkillsRow;
  skills_v1_user_attachments: UserAttachmentRow;
  skills_v1_skill_files: SkillFileRow;
  skills_v1_catalog_requests: CatalogRequestRow; // <-- add
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Green bar**

Run: `pnpm -F @ax/skills build && pnpm -F @ax/skills test && pnpm -F @ax/skills lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/migrations.ts packages/skills/src/__tests__/migrations.test.ts
git commit -m "feat(skills): add skills_v1_catalog_requests admit-queue table"
```

---

### Task 2: Create the catalog-requests store (snapshot + reconstruct + dedup)

**Files:**
- Create: `packages/skills/src/catalog-requests-store.ts`
- Test: `packages/skills/src/__tests__/catalog-requests-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/skills/src/__tests__/catalog-requests-store.test.ts`. Mirror `store.test.ts`'s `makeKysely()` + testcontainers setup (copy its `beforeAll`/`afterEach`/`makeKysely` boilerplate; add `skills_v1_catalog_requests` to the teardown). The store takes the **shared bundle store** (TASK-40's `createBundleStore`):

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundleStore } from '../bundle-store.js';
import { createCatalogRequestsStore } from '../catalog-requests-store.js';
// + the shared makeKysely()/runSkillsMigration boilerplate from store.test.ts

function freshBundleStore() {
  return createBundleStore(mkdtempSync(join(tmpdir(), 'ax-catreq-bundles-')));
}

it('submitShare snapshots the bundle; listPending/get reconstruct files', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  const store = createCatalogRequestsStore(db, freshBundleStore());

  const { request, created } = await store.submitShare({
    skillId: 'linear',
    requestedByUserId: 'alice',
    description: 'share linear',
    manifestYaml: 'name: linear\ndescription: d\nversion: 1\n',
    bodyMd: '# linear\n',
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
  });
  expect(created).toBe(true);
  expect(request.kind).toBe('share');
  expect(request.status).toBe('pending');
  expect(request.skillId).toBe('linear');
  expect(request.sourceOwnerUserId).toBe('alice');
  expect(request.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  expect(request.manifestYaml).toContain('name: linear');

  const pending = await store.listPending();
  expect(pending.map((r) => r.skillId)).toEqual(['linear']);
  expect(pending[0]?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);

  const got = await store.get(request.requestId);
  expect(got?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
});

it('a single-file share snapshots files: [] (bundle_tree_sha NULL)', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  const store = createCatalogRequestsStore(db, freshBundleStore());
  const { request } = await store.submitShare({
    skillId: 'gh', requestedByUserId: 'alice', description: 'd',
    manifestYaml: 'name: gh\ndescription: d\nversion: 1\n', bodyMd: '# gh\n', files: [],
  });
  expect(request.files).toEqual([]);
  const raw = await db.selectFrom('skills_v1_catalog_requests').select('bundle_tree_sha')
    .where('request_id', '=', request.requestId).executeTakeFirstOrThrow();
  expect(raw.bundle_tree_sha).toBeNull();
});

it('a second pending submit for the same skill_id dedups (created: false)', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  const store = createCatalogRequestsStore(db, freshBundleStore());
  const first = await store.submitColdStart({ skillId: 'jira', requestedByUserId: 'alice', description: 'need jira' });
  expect(first.created).toBe(true);
  const second = await store.submitColdStart({ skillId: 'jira', requestedByUserId: 'bob', description: 'me too' });
  expect(second.created).toBe(false);
  expect(second.request.requestId).toBe(first.request.requestId); // returns the existing one
  expect((await store.listPending()).length).toBe(1);
});

it('markDecided flips status and stamps the decider; frees the id for re-submit', async () => {
  const db = makeKysely();
  await runSkillsMigration(db);
  const store = createCatalogRequestsStore(db, freshBundleStore());
  const { request } = await store.submitColdStart({ skillId: 'jira', requestedByUserId: 'alice', description: 'need jira' });
  await store.markDecided(request.requestId, 'rejected', 'admin');
  expect((await store.get(request.requestId))?.status).toBe('rejected');
  expect((await store.listPending()).length).toBe(0);
  // id freed:
  const again = await store.submitColdStart({ skillId: 'jira', requestedByUserId: 'alice', description: 'still need jira' });
  expect(again.created).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/catalog-requests-store.test.ts`
Expected: FAIL — cannot find module `../catalog-requests-store.js`.

- [ ] **Step 3: Implement the store**

Create `packages/skills/src/catalog-requests-store.ts`:

```typescript
/**
 * @ax/skills admit-to-catalog queue store (JIT §6D, §11.6).
 *
 * Persists catalog requests and, for share submissions, an IMMUTABLE bundle
 * SNAPSHOT (manifest_yaml/body_md verbatim + a content-addressed tree SHA over
 * the extra files) so the bytes an admin reviews are exactly the bytes admit
 * promotes — no review-vs-ship drift (design §6D / §9.2). Reuses the SAME
 * shared content-addressed bundleStore the skill stores use (TASK-40), so a
 * snapshot dedups against the source skill's own tree and stays valid even if
 * the author later edits/deletes it.
 *
 * `bundle_tree_sha` is a STORAGE detail — it never leaves this file. Callers
 * see bundles as files[] only (storage-agnostic, invariant I1).
 */
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { SkillsDatabase, CatalogRequestRow } from './migrations.js';
import type { BundleFile } from './bundle-files.js';
import type { BundleStore } from './bundle-store.js';

export interface CatalogRequest {
  requestId: string;
  kind: 'share' | 'cold-start';
  skillId: string;
  requestedByUserId: string;
  /** The user whose editable working copy admit retires. null for cold-start. */
  sourceOwnerUserId: string | null;
  status: 'pending' | 'admitted' | 'rejected';
  description: string;
  createdAt: string; // ISO-8601
  /** Snapshot (share only; null for cold-start). */
  manifestYaml: string | null;
  bodyMd: string | null;
  /** Reconstructed extra files. [] for cold-start or single-file skills. */
  files: BundleFile[];
}

export interface SubmitShareInput {
  skillId: string;
  requestedByUserId: string;
  description: string;
  /** Snapshot bytes, resolved by the plugin from the source user-scoped skill. */
  manifestYaml: string;
  bodyMd: string;
  files: BundleFile[];
}
export interface SubmitColdStartInput {
  skillId: string;
  requestedByUserId: string;
  description: string;
}

export interface CatalogRequestsStore {
  submitShare(input: SubmitShareInput): Promise<{ request: CatalogRequest; created: boolean }>;
  submitColdStart(input: SubmitColdStartInput): Promise<{ request: CatalogRequest; created: boolean }>;
  listPending(): Promise<CatalogRequest[]>;
  get(requestId: string): Promise<CatalogRequest | null>;
  markDecided(
    requestId: string,
    status: 'admitted' | 'rejected',
    decidedByUserId: string,
  ): Promise<void>;
}

export function createCatalogRequestsStore(
  db: Kysely<SkillsDatabase>,
  bundleStore: BundleStore,
): CatalogRequestsStore {
  async function rowToRequest(row: CatalogRequestRow): Promise<CatalogRequest> {
    const files =
      row.bundle_tree_sha === null ? [] : await bundleStore.readTree(row.bundle_tree_sha);
    return {
      requestId: row.request_id,
      kind: row.kind,
      skillId: row.skill_id,
      requestedByUserId: row.requested_by_user_id,
      sourceOwnerUserId: row.source_owner_user_id,
      status: row.status,
      description: row.description,
      createdAt: row.created_at.toISOString(),
      manifestYaml: row.manifest_yaml,
      bodyMd: row.body_md,
      files,
    };
  }

  // Dedup: return the existing pending request for this skill_id if any
  // (SELECT-then-INSERT; the partial unique index is the backstop under races).
  async function existingPending(skillId: string): Promise<CatalogRequestRow | undefined> {
    return db
      .selectFrom('skills_v1_catalog_requests')
      .selectAll()
      .where('skill_id', '=', skillId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
  }

  async function insert(values: {
    kind: 'share' | 'cold-start';
    skillId: string;
    requestedByUserId: string;
    sourceOwnerUserId: string | null;
    description: string;
    manifestYaml: string | null;
    bodyMd: string | null;
    bundleTreeSha: string | null;
  }): Promise<CatalogRequest> {
    const now = new Date();
    const row: CatalogRequestRow = {
      request_id: randomUUID(),
      kind: values.kind,
      skill_id: values.skillId,
      requested_by_user_id: values.requestedByUserId,
      source_owner_user_id: values.sourceOwnerUserId,
      status: 'pending',
      description: values.description,
      manifest_yaml: values.manifestYaml,
      body_md: values.bodyMd,
      bundle_tree_sha: values.bundleTreeSha,
      created_at: now,
      updated_at: now,
      decided_at: null,
      decided_by_user_id: null,
    };
    await db.insertInto('skills_v1_catalog_requests').values(row).execute();
    return rowToRequest(row);
  }

  return {
    async submitShare(input) {
      const dup = await existingPending(input.skillId);
      if (dup !== undefined) return { request: await rowToRequest(dup), created: false };
      // Content-addressed snapshot of the extra files (null when single-file).
      const bundleTreeSha = await bundleStore.writeTree(input.files);
      const request = await insert({
        kind: 'share',
        skillId: input.skillId,
        requestedByUserId: input.requestedByUserId,
        sourceOwnerUserId: input.requestedByUserId, // a user shares their OWN skill
        description: input.description,
        manifestYaml: input.manifestYaml,
        bodyMd: input.bodyMd,
        bundleTreeSha,
      });
      return { request, created: true };
    },

    async submitColdStart(input) {
      const dup = await existingPending(input.skillId);
      if (dup !== undefined) return { request: await rowToRequest(dup), created: false };
      const request = await insert({
        kind: 'cold-start',
        skillId: input.skillId,
        requestedByUserId: input.requestedByUserId,
        sourceOwnerUserId: null,
        description: input.description,
        manifestYaml: null,
        bodyMd: null,
        bundleTreeSha: null,
      });
      return { request, created: true };
    },

    async listPending() {
      const rows = await db
        .selectFrom('skills_v1_catalog_requests')
        .selectAll()
        .where('status', '=', 'pending')
        .orderBy('created_at', 'asc')
        .orderBy('request_id', 'asc')
        .execute();
      const out: CatalogRequest[] = [];
      for (const r of rows) out.push(await rowToRequest(r));
      return out;
    },

    async get(requestId) {
      const row = await db
        .selectFrom('skills_v1_catalog_requests')
        .selectAll()
        .where('request_id', '=', requestId)
        .executeTakeFirst();
      return row === undefined ? null : rowToRequest(row);
    },

    async markDecided(requestId, status, decidedByUserId) {
      await db
        .updateTable('skills_v1_catalog_requests')
        .set({ status, decided_at: new Date(), decided_by_user_id: decidedByUserId, updated_at: new Date() })
        .where('request_id', '=', requestId)
        .execute();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/catalog-requests-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Green bar**

Run: `pnpm -F @ax/skills build && pnpm -F @ax/skills test && pnpm -F @ax/skills lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/catalog-requests-store.ts packages/skills/src/__tests__/catalog-requests-store.test.ts
git commit -m "feat(skills): admit-queue store with content-addressed bundle snapshot + dedup"
```

---

### Task 3: Add the hook payload types + return schemas

**Files:**
- Modify: `packages/skills/src/types.ts`
- Test: `packages/skills/src/__tests__/return-schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `return-schemas.test.ts` (the file asserts each hook's `*OutputSchema` parses a representative value + strips undeclared keys — mirror its existing cases):

```typescript
it('CatalogSubmitOutputSchema parses + strips', () => {
  const parsed = CatalogSubmitOutputSchema.parse({
    requestId: 'r1', created: true, status: 'pending', extra: 'drop me',
  });
  expect(parsed).toEqual({ requestId: 'r1', created: true, status: 'pending' });
});

it('CatalogListRequestsOutputSchema parses a request with files but NO tree sha', () => {
  const parsed = CatalogListRequestsOutputSchema.parse({
    requests: [{
      requestId: 'r1', kind: 'share', skillId: 'linear', requestedByUserId: 'alice',
      sourceOwnerUserId: 'alice', status: 'pending', description: 'd',
      createdAt: '2026-05-26T00:00:00.000Z',
      manifestYaml: 'name: linear\n', bodyMd: '# l\n',
      files: [{ path: 'scripts/a.py', contents: 'print(1)' }],
      bundle_tree_sha: 'LEAK', // must be stripped — storage detail
    }],
  });
  expect(parsed.requests[0]).not.toHaveProperty('bundle_tree_sha');
  expect(parsed.requests[0]?.files).toEqual([{ path: 'scripts/a.py', contents: 'print(1)' }]);
});

it('CatalogAdmitOutputSchema parses + strips', () => {
  const parsed = CatalogAdmitOutputSchema.parse({ skillId: 'linear', admitted: true, x: 1 });
  expect(parsed).toEqual({ skillId: 'linear', admitted: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/return-schemas.test.ts`
Expected: FAIL — the three schemas are not exported.

- [ ] **Step 3: Add the interfaces + schemas**

In `packages/skills/src/types.ts`, append (the `CatalogRequest` output type deliberately has **no** `bundleTreeSha` — bundles cross as `files[]`):

```typescript
// ---------------------------------------------------------------------------
// Admit-to-catalog queue (TASK-41, JIT §6D / §11.6). The self-healing
// catalog's admit queue: BOTH cold-start "a user needed X" requests and
// share-to-catalog submissions land here; an admin admits a share (promote +
// retire the author's working copy) or rejects. Storage-agnostic — a share's
// bundle crosses the boundary as files[] (NEVER a tree sha); the snapshot's
// content-addressed pointer is an internal storage detail. Alternate impl: a
// generic approval queue.
// ---------------------------------------------------------------------------
export type CatalogSubmitInput =
  | {
      kind: 'share';
      /** The catalog id to propose; must be the requester's own user-scoped skill. */
      skillId: string;
      /** The authenticated user sharing their own skill (host-supplied). */
      requestedByUserId: string;
      description?: string;
    }
  | {
      kind: 'cold-start';
      /** A proposed slug for the missing capability (dedup key). */
      skillId: string;
      requestedByUserId: string;
      /** What the user wanted — free text the admin triages. */
      description: string;
    };
export interface CatalogSubmitOutput {
  requestId: string;
  /** false when a pending request for this skillId already existed (deduped). */
  created: boolean;
  status: 'pending' | 'admitted' | 'rejected';
}

/** One admit-queue request as seen by the admin review surface. */
export interface CatalogRequest {
  requestId: string;
  kind: 'share' | 'cold-start';
  skillId: string;
  requestedByUserId: string;
  sourceOwnerUserId: string | null;
  status: 'pending' | 'admitted' | 'rejected';
  description: string;
  createdAt: string;
  /** Snapshot of the submitted bundle (share only; null for cold-start). */
  manifestYaml: string | null;
  bodyMd: string | null;
  /** Extra (non-SKILL.md) files of the snapshot. [] for cold-start/single-file. */
  files: BundleFile[];
}
export interface CatalogListRequestsInput {
  /** Defaults to 'pending'. */
  status?: 'pending' | 'admitted' | 'rejected' | 'all';
}
export interface CatalogListRequestsOutput {
  requests: CatalogRequest[];
}

export interface CatalogAdmitInput {
  requestId: string;
  decision: 'admit' | 'reject';
  /** The authenticated admin deciding (host-supplied). */
  decidedByUserId: string;
}
export interface CatalogAdmitOutput {
  /** The promoted catalog id (present on a successful admit). */
  skillId?: string;
  admitted: boolean;
}
```

Then add the return schemas near the other `*OutputSchema` exports (reuse the existing `BundleFileSchema`):

```typescript
export const CatalogSubmitOutputSchema = z.object({
  requestId: z.string(),
  created: z.boolean(),
  status: z.union([z.literal('pending'), z.literal('admitted'), z.literal('rejected')]),
}) as unknown as ZodType<CatalogSubmitOutput>;

const CatalogRequestSchema = z.object({
  requestId: z.string(),
  kind: z.union([z.literal('share'), z.literal('cold-start')]),
  skillId: z.string(),
  requestedByUserId: z.string(),
  sourceOwnerUserId: z.string().nullable(),
  status: z.union([z.literal('pending'), z.literal('admitted'), z.literal('rejected')]),
  description: z.string(),
  createdAt: z.string(),
  manifestYaml: z.string().nullable(),
  bodyMd: z.string().nullable(),
  files: z.array(BundleFileSchema),
});

export const CatalogListRequestsOutputSchema = z.object({
  requests: z.array(CatalogRequestSchema),
}) as unknown as ZodType<CatalogListRequestsOutput>;

export const CatalogAdmitOutputSchema = z.object({
  skillId: z.string().optional(),
  admitted: z.boolean(),
}) as unknown as ZodType<CatalogAdmitOutput>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/return-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Green bar**

Run: `pnpm -F @ax/skills build && pnpm -F @ax/skills test && pnpm -F @ax/skills lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/types.ts packages/skills/src/__tests__/return-schemas.test.ts
git commit -m "feat(skills): catalog admit-queue hook payload types + return schemas"
```

---

### Task 4: Register `catalog:submit` (share reads + snapshots the user skill; cold-start; dedup)

**Files:**
- Modify: `packages/skills/src/plugin.ts`
- Test: `packages/skills/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `plugin.test.ts` (the harness builds `createSkillsPlugin()` over testcontainers; alice first authors a user-scoped skill, then shares it):

```typescript
it('catalog:submit (share) snapshots the author\'s user-scoped skill', async () => {
  const h = await makeHarness();
  // Author a user-scoped multi-file skill (the post-TASK-39 "draft to share").
  await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
    manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY,
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    scope: 'user', ownerUserId: 'alice',
  });

  const out = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
    kind: 'share', skillId: 'github', requestedByUserId: 'alice', description: 'share my github skill',
  });
  expect(out.created).toBe(true);
  expect(out.status).toBe('pending');

  const list = await h.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>(
    'catalog:list-requests', h.ctx(), {},
  );
  const req = list.requests.find((r) => r.skillId === 'github')!;
  expect(req.kind).toBe('share');
  expect(req.sourceOwnerUserId).toBe('alice');
  expect(req.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  expect(req.manifestYaml).toContain('name: github');
});

it('catalog:submit (share) of a skill the user does not own throws skill-not-found', async () => {
  const h = await makeHarness();
  await expect(
    h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'share', skillId: 'nope', requestedByUserId: 'alice', description: 'd',
    }),
  ).rejects.toMatchObject({ code: 'skill-not-found' });
});

it('catalog:submit (cold-start) files a bundle-less request; second dedups', async () => {
  const h = await makeHarness();
  const first = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
    kind: 'cold-start', skillId: 'jira', requestedByUserId: 'alice', description: 'I need Jira',
  });
  expect(first.created).toBe(true);
  const second = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
    kind: 'cold-start', skillId: 'jira', requestedByUserId: 'bob', description: 'me too',
  });
  expect(second.created).toBe(false);
  expect(second.requestId).toBe(first.requestId);
});
```

(`'github'` is the id in `SAMPLE_MANIFEST`; import the catalog I/O types from `../types.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts`
Expected: FAIL — no service registered for `catalog:submit`.

- [ ] **Step 3: Wire the requests store + register `catalog:submit`**

In `packages/skills/src/plugin.ts`:

Add imports:

```typescript
import { createCatalogRequestsStore } from './catalog-requests-store.js';
import {
  CatalogSubmitOutputSchema,
  CatalogListRequestsOutputSchema,
  CatalogAdmitOutputSchema,
} from './types.js';
import type {
  CatalogSubmitInput, CatalogSubmitOutput,
  CatalogListRequestsInput, CatalogListRequestsOutput,
  CatalogAdmitInput, CatalogAdmitOutput,
} from './types.js';
```

Add the three hooks to the manifest `registers` array (after `'skills:search-catalog'`):

```typescript
        'catalog:submit',
        'catalog:list-requests',
        'catalog:admit',
```

In `init`, construct the requests store from the **same shared `bundleStore`** TASK-40 builds (re-verify the exact local name; TASK-40 Task 5 names it `bundleStore` and constructs `store`/`userStore` from it):

```typescript
      // Reuse the shared content-addressed bundle store (TASK-40) so a share
      // snapshot dedups against the source skill's own tree and admit re-derives
      // the SAME tree SHA when it registers the bundle in the global catalog.
      const catalogRequestsStore = createCatalogRequestsStore(db, bundleStore);
```

Register `catalog:submit` (after the `skills:search-catalog` registration):

```typescript
      // -----------------------------------------------------------------------
      // catalog:submit (TASK-41) — file an admit-to-catalog request. Two kinds:
      //   share      — the requester promotes their OWN user-scoped skill; we
      //                snapshot its bundle (manifest/body verbatim + extra files)
      //                so admit ships exactly the reviewed bytes (no drift).
      //   cold-start — a bundle-less "a user needed X" wishlist item.
      // requestedByUserId is host-supplied (the authenticated caller); a share
      // can only reference the requester's own skill (sourceOwner == requester).
      // Dedup: one pending request per skill_id (store + partial unique index).
      // -----------------------------------------------------------------------
      bus.registerService<CatalogSubmitInput, CatalogSubmitOutput>(
        'catalog:submit',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (input.kind === 'share') {
            const detail = await userStore.get(input.requestedByUserId, input.skillId);
            if (detail === null) {
              throw new PluginError({
                code: 'skill-not-found',
                plugin: PLUGIN_NAME,
                message: `user '${input.requestedByUserId}' has no skill '${input.skillId}' to share`,
              });
            }
            const { request, created } = await catalogRequestsStore.submitShare({
              skillId: input.skillId,
              requestedByUserId: input.requestedByUserId,
              description: input.description ?? detail.description,
              manifestYaml: detail.manifestYaml,
              bodyMd: detail.bodyMd,
              files: detail.files,
            });
            return { requestId: request.requestId, created, status: request.status };
          }
          // cold-start
          const { request, created } = await catalogRequestsStore.submitColdStart({
            skillId: input.skillId,
            requestedByUserId: input.requestedByUserId,
            description: input.description,
          });
          return { requestId: request.requestId, created, status: request.status };
        },
        { returns: CatalogSubmitOutputSchema },
      );
```

> **Note for Task 5/6:** `catalog:list-requests` (Step 1's test calls it) is registered in Task 5 — that test case will go red→green across Tasks 4–5. If you implement strictly task-by-task, split the `list-requests` assertion into Task 5's test; the submit-only assertions (`created`/`status`) pass at the end of Task 4.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts -t "catalog:submit"`
Expected: PASS for the submit/dedup/not-found cases (the list-requests assertion lands in Task 5).

- [ ] **Step 5: Green bar**

Run: `pnpm -F @ax/skills build && pnpm -F @ax/skills test && pnpm -F @ax/skills lint`
Expected: all green (Task 5's `catalog:list-requests` case, if already added, is the only expected red — keep its assertion in Task 5).

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/plugin.ts packages/skills/src/__tests__/plugin.test.ts
git commit -m "feat(skills): catalog:submit — snapshot share or file cold-start request"
```

---

### Task 5: Register `catalog:list-requests` (reconstruct files for review)

**Files:**
- Modify: `packages/skills/src/plugin.ts`
- Test: `packages/skills/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `plugin.test.ts`:

```typescript
it('catalog:list-requests returns pending requests with reconstructed files, no tree sha', async () => {
  const h = await makeHarness();
  await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
    manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY,
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    scope: 'user', ownerUserId: 'alice',
  });
  await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
    kind: 'share', skillId: 'github', requestedByUserId: 'alice', description: 'share',
  });
  await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
    kind: 'cold-start', skillId: 'jira', requestedByUserId: 'bob', description: 'need jira',
  });

  const { requests } = await h.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>(
    'catalog:list-requests', h.ctx(), {},
  );
  expect(requests.map((r) => r.skillId).sort()).toEqual(['github', 'jira']);
  const share = requests.find((r) => r.skillId === 'github')!;
  expect(share.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  expect(share).not.toHaveProperty('bundle_tree_sha'); // storage detail must not leak
  const cold = requests.find((r) => r.skillId === 'jira')!;
  expect(cold.kind).toBe('cold-start');
  expect(cold.files).toEqual([]);
  expect(cold.manifestYaml).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts -t "list-requests"`
Expected: FAIL — no service registered for `catalog:list-requests`.

- [ ] **Step 3: Register `catalog:list-requests`**

In `plugin.ts`, after `catalog:submit`:

```typescript
      // -----------------------------------------------------------------------
      // catalog:list-requests (TASK-41) — the admin review feed. Defaults to
      // pending. A share request reconstructs its snapshot files (storage-
      // agnostic files[] — the tree SHA stays internal). Read-only.
      // -----------------------------------------------------------------------
      bus.registerService<CatalogListRequestsInput, CatalogListRequestsOutput>(
        'catalog:list-requests',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const status = input.status ?? 'pending';
          if (status !== 'pending' && status !== 'all') {
            // Decided-status filters are a TASK-45 refinement; MVP serves
            // pending (the actionable queue) + all.
            const requests = (await catalogRequestsStore.listPending()).filter(
              (r) => r.status === status,
            );
            return { requests };
          }
          if (status === 'all') {
            // listPending is the only store reader today; 'all' is a TASK-45
            // refinement. Return pending for now (the actionable set).
            return { requests: await catalogRequestsStore.listPending() };
          }
          return { requests: await catalogRequestsStore.listPending() };
        },
        { returns: CatalogListRequestsOutputSchema },
      );
```

> **Implementation note:** the `status` filtering above is intentionally minimal — `listPending()` is the only store reader this task needs. If TASK-45 needs decided-request history, add a `listAll()`/`listByStatus()` to the store then (don't speculatively build it now — YAGNI). The `status` field exists on the input so the hook surface is stable for TASK-45.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts`
Expected: PASS (including Task 4's list assertion).

- [ ] **Step 5: Green bar**

Run: `pnpm -F @ax/skills build && pnpm -F @ax/skills test && pnpm -F @ax/skills lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/plugin.ts packages/skills/src/__tests__/plugin.test.ts
git commit -m "feat(skills): catalog:list-requests — admin review feed (files[], no tree sha)"
```

---

### Task 6: Register `catalog:admit` (promote to global + retire the working copy; reject)

**Files:**
- Modify: `packages/skills/src/plugin.ts`
- Test: `packages/skills/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `plugin.test.ts`:

```typescript
it('catalog:admit promotes the share to the global catalog and retires the user copy', async () => {
  const h = await makeHarness();
  await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
    manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY,
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    scope: 'user', ownerUserId: 'alice',
  });
  const sub = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
    kind: 'share', skillId: 'github', requestedByUserId: 'alice', description: 'share',
  });

  // The user-scoped copy exists; the global one does not — yet.
  const userBefore = await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), { skillId: 'github', scope: 'user', ownerUserId: 'alice' });
  expect(userBefore.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  await expect(
    h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), { skillId: 'github', scope: 'global' }),
  ).rejects.toMatchObject({ code: 'skill-not-found' });

  const admit = await h.bus.call<CatalogAdmitInput, CatalogAdmitOutput>('catalog:admit', h.ctx(), {
    requestId: sub.requestId, decision: 'admit', decidedByUserId: 'admin',
  });
  expect(admit).toEqual({ skillId: 'github', admitted: true });

  // Promoted into the GLOBAL catalog with the bundle intact (shipped == reviewed).
  const global = await h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), { skillId: 'github', scope: 'global' });
  expect(global.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  expect(global.manifestYaml).toContain('name: github');

  // The author's editable working copy is RETIRED.
  await expect(
    h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), { skillId: 'github', scope: 'user', ownerUserId: 'alice' }),
  ).rejects.toMatchObject({ code: 'skill-not-found' });

  // Request marked admitted; queue empty; the id is freed for a future cycle.
  const { requests } = await h.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>('catalog:list-requests', h.ctx(), {});
  expect(requests.length).toBe(0);
});

it('catalog:admit reject closes the request without promoting', async () => {
  const h = await makeHarness();
  const sub = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
    kind: 'cold-start', skillId: 'jira', requestedByUserId: 'alice', description: 'need jira',
  });
  const out = await h.bus.call<CatalogAdmitInput, CatalogAdmitOutput>('catalog:admit', h.ctx(), {
    requestId: sub.requestId, decision: 'reject', decidedByUserId: 'admin',
  });
  expect(out.admitted).toBe(false);
  await expect(
    h.bus.call<SkillsGetInput, SkillsGetOutput>('skills:get', h.ctx(), { skillId: 'jira', scope: 'global' }),
  ).rejects.toMatchObject({ code: 'skill-not-found' });
});

it('catalog:admit of a cold-start request is not promotable', async () => {
  const h = await makeHarness();
  const sub = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
    kind: 'cold-start', skillId: 'jira', requestedByUserId: 'alice', description: 'need jira',
  });
  await expect(
    h.bus.call<CatalogAdmitInput, CatalogAdmitOutput>('catalog:admit', h.ctx(), {
      requestId: sub.requestId, decision: 'admit', decidedByUserId: 'admin',
    }),
  ).rejects.toMatchObject({ code: 'cold-start-not-promotable' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts -t "catalog:admit"`
Expected: FAIL — no service registered for `catalog:admit`.

- [ ] **Step 3: Register `catalog:admit`**

In `plugin.ts`, after `catalog:list-requests`:

```typescript
      // -----------------------------------------------------------------------
      // catalog:admit (TASK-41) — the supply-chain gate (decision #3: catalog
      // admission IS the approval). On 'admit' of a SHARE request: re-validate
      // the snapshot (parseSkillManifest + validateBundleFiles — defense-in-
      // depth, the bytes go org-wide), store.upsert it to the GLOBAL catalog
      // (content-addressing re-derives the same tree SHA → "register the tree
      // SHA"), then RETIRE the author's editable working copy via the user
      // store (§6D — the integrity backbone: user-wins precedence must not keep
      // serving forkable bytes). On 'reject': close the request. Cold-start
      // requests are not promotable (no bundle) — the admin authors via the
      // existing admin flow and rejects/closes the wishlist item.
      // -----------------------------------------------------------------------
      bus.registerService<CatalogAdmitInput, CatalogAdmitOutput>(
        'catalog:admit',
        PLUGIN_NAME,
        async (_ctx, input) => {
          const request = await catalogRequestsStore.get(input.requestId);
          if (request === null) {
            throw new PluginError({
              code: 'request-not-found',
              plugin: PLUGIN_NAME,
              message: `catalog request '${input.requestId}' does not exist`,
            });
          }
          if (request.status !== 'pending') {
            throw new PluginError({
              code: 'request-already-decided',
              plugin: PLUGIN_NAME,
              message: `catalog request '${input.requestId}' is already ${request.status}`,
            });
          }

          if (input.decision === 'reject') {
            await catalogRequestsStore.markDecided(input.requestId, 'rejected', input.decidedByUserId);
            return { admitted: false };
          }

          // decision === 'admit'
          if (request.kind !== 'share' || request.manifestYaml === null || request.bodyMd === null) {
            throw new PluginError({
              code: 'cold-start-not-promotable',
              plugin: PLUGIN_NAME,
              message: `request '${input.requestId}' is a cold-start with no bundle to promote — author the skill, then reject`,
            });
          }

          // Defense-in-depth re-validation of the snapshot before it goes
          // org-wide (the snapshot was validated at submit; re-check here).
          const parsed = parseSkillManifest(request.manifestYaml);
          if (!parsed.ok) {
            throw new PluginError({ code: parsed.code, plugin: PLUGIN_NAME, message: parsed.message });
          }
          try {
            validateBundleFiles(request.files);
          } catch (err) {
            throw new PluginError({
              code: 'invalid-bundle-file',
              plugin: PLUGIN_NAME,
              message: err instanceof Error ? err.message : String(err),
            });
          }

          // Promote into the GLOBAL catalog (idempotent by id → natural dedup).
          // store.upsert (TASK-40) re-derives the same content-addressed
          // bundle_tree_sha as the reviewed snapshot.
          await store.upsert({
            id: parsed.value.id,
            description: parsed.value.description,
            manifestYaml: request.manifestYaml,
            bodyMd: request.bodyMd,
            version: parsed.value.version,
            defaultAttached: false,
            sourceUrl: parsed.value.sourceUrl ?? null,
            files: request.files,
          });

          // Retire the author's editable working copy (§6D hard requirement).
          // The author's per-(user,agent) attachment (keyed by skillId, no
          // scope) transparently re-resolves to the now-global skill, so they
          // keep the capability — now sourced from the vetted catalog.
          if (request.sourceOwnerUserId !== null) {
            await userStore.delete(request.sourceOwnerUserId, parsed.value.id);
          }

          await catalogRequestsStore.markDecided(input.requestId, 'admitted', input.decidedByUserId);
          return { skillId: parsed.value.id, admitted: true };
        },
        { returns: CatalogAdmitOutputSchema },
      );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts`
Expected: PASS (whole plugin suite green).

- [ ] **Step 5: Green bar**

Run: `pnpm -F @ax/skills build && pnpm -F @ax/skills test && pnpm -F @ax/skills lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/plugin.ts packages/skills/src/__tests__/plugin.test.ts
git commit -m "feat(skills): catalog:admit — promote share to global catalog + retire working copy"
```

---

### Task 7: End-to-end canary + full verification + security-checklist + PR

**Files:**
- Modify: `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`

- [ ] **Step 1: Extend the canary — share → admit → re-invoke materializes the promoted skill for the author**

Add a new `describe` block to the canary (mirror the TASK-33 per-user union block's real-plugin harness + `ctxFor` + capture-fakes). The case proves the full §6D loop end to end: an author's user-scoped skill is shared, admitted (promoted + working copy retired), and a *fresh* invoke materializes the **global** skill into the sandbox for the author — with no duplicate-id collision and the catalog row registering the bundle's tree SHA. The canary already drops `skills_v1_skills` / `skills_v1_user_skills` / `skills_v1_user_attachments` in teardown — add `skills_v1_catalog_requests`.

```typescript
describe('skill-install canary: share-to-catalog promotion (§6D, real plugins)', () => {
  it('admit promotes the author bundle to global, retires the user copy, and re-invoke materializes it', async () => {
    const busRef: { current: HookBus | null } = { current: null };
    const fakes = buildCaptureFakes(busRef);
    const h = await createTestHarness({
      services: fakes.services,
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createAgentsPlugin(),
        createSkillsPlugin(),
        createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', oneShot: true, chatTimeoutMs: 5_000 }),
      ],
    });
    harnesses.push(h);
    busRef.current = h.bus;

    // 1. Alice authors a user-scoped bundle skill and attaches it on her agent.
    await h.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', h.ctx(), {
      manifestYaml: GITHUB_MANIFEST, bodyMd: 'Body.',
      files: [{ path: 'scripts/run.py', contents: 'print("hi")' }],
      scope: 'user', ownerUserId: 'alice',
    });
    const agentId = await createPersonalAgent(h, 'alice');
    await attachSkill(h, agentId, 'alice', 'github', { GITHUB_TOKEN: 'cred-ref-alice-gh' });

    // 2. Share → admit.
    const sub = await h.bus.call<CatalogSubmitInput, CatalogSubmitOutput>('catalog:submit', h.ctx(), {
      kind: 'share', skillId: 'github', requestedByUserId: 'alice', description: 'share',
    });
    const admit = await h.bus.call<CatalogAdmitInput, CatalogAdmitOutput>('catalog:admit', h.ctx(), {
      requestId: sub.requestId, decision: 'admit', decidedByUserId: 'admin',
    });
    expect(admit).toEqual({ skillId: 'github', admitted: true });

    // 3. The user copy is gone; the global catalog row carries the bundle tree SHA.
    const userRows = await cleanup.query(
      "SELECT skill_id FROM skills_v1_user_skills WHERE owner_user_id = 'alice' AND skill_id = 'github'",
    );
    expect(userRows.rows.length).toBe(0);
    const globalRow = await cleanup.query(
      "SELECT bundle_tree_sha FROM skills_v1_skills WHERE skill_id = 'github'",
    );
    expect(globalRow.rows[0].bundle_tree_sha).toMatch(/^[0-9a-f]{40}$/);

    // 4. Fresh invoke: the author's attachment re-resolves to the GLOBAL skill,
    //    materialized read-only — incl. the author. No duplicate-id collision.
    const outcome = await h.bus.call<unknown, AgentOutcome>(
      'agent:invoke', ctxFor(agentId, 'alice', 'canary-admit-walk'),
      { message: { role: 'user', content: 'hi' } },
    );
    expect(outcome.kind).toBe('complete');
    const installed = fakes.sandboxOpenInputs.at(-1)!.installedSkills ?? [];
    const gh = installed.filter((s) => s.id === 'github');
    expect(gh.length).toBe(1); // exactly one — no project/user duplicate-id collision
    expect(gh[0]!.files.find((f) => f.path === 'SKILL.md')?.contents).toContain('name: github');
    expect(gh[0]!.files.find((f) => f.path === 'scripts/run.py')?.contents).toBe('print("hi")');
  }, 60_000);
});
```

(Import the catalog I/O types + `cleanup` — the canary's existing `pg` client used by other DB-assert cases. Re-verify `cleanup` is in scope for this block; if the file scopes it per-describe, add a client the same way the file already does.)

- [ ] **Step 2: Run the canary**

Run: `pnpm -F @ax/skills test -- src/__tests__/e2e/skill-install.canary.test.ts`
Expected: PASS — the share→admit→materialize case plus all pre-existing canary cases green.

- [ ] **Step 3: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. (`pnpm build` (tsc) catches undeclared workspace deps vitest tolerates; `pnpm lint` confirms `no-restricted-imports` sees **no** cross-plugin `@ax/*` import — admit/retire use only `@ax/skills`'s own stores. task.txt hard requirement #6: the green bar is the whole triad, not just vitest.)

- [ ] **Step 4: Run the security-checklist skill (REQUIRED — the card flags it)**

Invoke the `security-checklist` skill and answer all three threat models against this diff. Key items, pre-stated in "Security threat model" below:
- **Supply chain (the headline — admin review IS the gate):** confirm admit re-validates the snapshot (`parseSkillManifest` + `validateBundleFiles`) before it goes org-wide; confirm the snapshot pins the reviewed bytes (manifest/body verbatim + content-addressed tree SHA) so shipped == reviewed even if the author edits their live copy; confirm promotion targets the **global** (admin-managed RO) scope.
- **Prompt injection:** confirm `catalog:submit` is an inert queue insert — no code runs, no egress widens, nothing materializes until an admin admits; `list-requests` returns inert `files[]` for review.
- **Trust-domain integrity:** confirm `catalog:admit` retires the editable user copy (`userStore.delete`) so user-wins precedence stops serving forkable bytes post-admission; confirm post-admit materialization reuses the unchanged TASK-32 runner extract-boundary (path/veto/no-exec-bit) — no new materialization code.
Paste the structured note into the PR.

- [ ] **Step 5: Commit + open PR**

```bash
git add packages/skills/src/__tests__/e2e/skill-install.canary.test.ts
git commit -m "test(skills): canary covers share-to-catalog promotion + working-copy retirement"
```

PR description MUST include:
- **Boundary review** (the full note below): three new service hooks; payloads storage-agnostic (`files[]` not tree-sha); §11's `draftSkillMd` refined; no IPC actions (capability minimized).
- **Half-wired window: OPEN** — the three hooks are reachable from the canary but have no production UI/broker caller until **TASK-45** (admin Catalog/Admit-queue UI + user "submit to catalog" trigger) and a small broker follow-up (cold-start filing on a search miss). Window CLOSES in TASK-45.
- **Stale design assumption flagged + resolved** — §6D's `.ax/skills/<id>` working-copy retirement is post-TASK-39 a **user-store** retirement (`skills:delete` scope=user); the integrity invariant is honored at the relocated copy.
- The security-checklist note.

---

## Boundary review for the three new hooks (per CLAUDE.md)

Reproduced in the PR description. Refines design §11's pre-spec (whose `draftSkillMd` field is stale — bundles + content-addressing postdate it).

**`catalog:submit`** (registered by `@ax/skills`)
- **Alternate impl:** a generic approval/review queue plugin (the admit queue is one instance of "queue a thing for human approval"). Concrete second impl exists → the hook is warranted.
- **Payload fields:** `{ kind, skillId, requestedByUserId, description? }`. **No leak** — no bundle bytes inline, **no `bundle_tree_sha`**, no row/sha/git vocabulary. A share references its source by `(requestedByUserId, skillId)`; the bundle is snapshotted host-side into a storage detail. (Refines §11's `draftSkillMd`: submit carries no inline SKILL.md; bundles never inline in this payload.)
- **Subscriber risk:** none — service hook (one impl), not a subscriber surface.
- **IPC:** **none.** Not agent-reachable. Host-side callers only (the broker tool runs in-host; the user "submit" trigger is an authenticated HTTP route, TASK-45). Keeping it off the wire is the capability-minimized choice (I5) — the agent cannot self-file admit requests except via the host-mediated broker/route.

**`catalog:list-requests`** (registered by `@ax/skills`)
- **Alternate impl:** the same generic queue's "list pending" read.
- **Payload fields (output):** `requests: [{ requestId, kind, skillId, requestedByUserId, sourceOwnerUserId, status, description, createdAt, manifestYaml?, bodyMd?, files }]`. Bundles surface as `files: { path, contents }[]` (the established storage-agnostic contract) — **`bundle_tree_sha` is stripped** by the `returns` schema and asserted absent (Task 3/5 tests). `requestId` is an opaque uuid.
- **Subscriber risk:** none (read-only service hook).
- **IPC:** **none** — host-side admin route (TASK-45) calls it.

**`catalog:admit`** (registered by `@ax/skills`)
- **Alternate impl:** the generic queue's "decide" + a domain promotion step.
- **Payload fields:** `{ requestId, decision: 'admit'|'reject', decidedByUserId }` → `{ skillId?, admitted }`. No storage vocabulary.
- **Subscriber risk:** none (service hook).
- **IPC:** **none** — host-side admin route (TASK-45).

---

## Security threat model (pre-stated — the card flags security-checklist)

The admit queue **is** the catalog's supply-chain gate (design §6D/§9.2/§10). Walked here so Task 7 Step 4 confirms rather than discovers.

- **Supply chain (bites hardest on Registry tier).** A user/agent-authored bundle — possibly Registry-tier (a `scripts/*.py` that shells out to `npx`/`pip`), possibly authored under prompt injection — becomes org-wide **only after** an admin reads the bundle (the file/diff review UI is TASK-45) and admits. TASK-41's guarantees: (1) the share request **snapshots** the reviewed bytes at submit (manifest/body verbatim + content-addressed tree SHA), so an author editing their live copy *after* submit cannot change what ships — **shipped == reviewed**, no TOCTOU; (2) `catalog:admit` **re-validates** the snapshot (`parseSkillManifest` + `validateBundleFiles` — traversal / `.mcp.json` / `.claude/` / `.git/` / caps) before promotion, defense-in-depth even though submit validated; (3) promotion targets the **global** (admin-managed, read-only trust) scope. The code-review safety attaches precisely at admission (§9.2 open-mode caveat: an un-admitted authored bundle grants nothing beyond what the agent's own sandbox already allows).
- **Prompt injection.** `catalog:submit` and `catalog:list-requests` are **inert**: a submit is a queue insert (no code execution, no egress widening, no materialization); list returns `files[]` as text for an admin to read. Untrusted content (skill description, body, intent) is stored and displayed, never executed, until a human admits. The card-as-backstop (design §10) and admin review are the human-in-the-loop controls; nothing in TASK-41 lets injected content self-promote.
- **Sandbox escape / trust-domain integrity.** Post-admit the bundle materializes read-only into `.ax/session/skills/` via the **unchanged** TASK-32 runner extract boundary (path-safety + veto-list + no-exec-bit re-validated at materialization) — TASK-41 adds no materialization code. The **working-copy retirement** (`userStore.delete` on admit) is the integrity linchpin: without it, the orchestrator's user-wins precedence would keep resolving the author's *editable* user-store copy instead of the vetted global one, letting the agent fork vetted bytes and re-add egress/credentials the admin never approved (design §10 "no path lets the agent edit vetted bytes").
- **Capabilities minimized (I5).** The three hooks are **not** IPC actions — the agent cannot reach the admit queue directly; only host-side callers (the in-host broker tool for cold-start; authenticated HTTP routes for share/admit, TASK-45) drive them. Promotion uses only `@ax/skills`'s own stores (no cross-plugin import/call). Retirement deliberately does **not** purge the author's credential (the `skill:<id>:<slot>` ref is reused by the promoted global skill — the existing `skills:delete` scope=user purge-skip).

---

## Half-wired window

**OPEN** for this task. The three `catalog:*` hooks are fully registered, unit-tested, and **reachable from the canary acceptance test** (Task 7) — satisfying invariant I3's "reachable from the canary" bar — but their **production callers** land later:

- **`catalog:list-requests` + `catalog:admit`** → the admin **Catalog tab + Admit queue UI** (bundle file/diff review). **Closed by TASK-45.**
- **share `catalog:submit`** → the user-facing **"submit to catalog"** trigger in the "Connections" settings surface (design Part II P3/P6). **Closed by TASK-45.**
- **cold-start `catalog:submit`** → the broker firing it on a `search_catalog`/`request_capability` miss (design §13). A smaller **broker follow-up** (needs a free-text "request a capability" tool or a search-miss hook — the current broker only returns `{ status: 'not-found' }`). Tracked as a follow-up; not blocking.

No new infra is left dangling: the table, store, and hooks are exercised end to end by tests + canary; only the human-facing entry points are deferred, each named with its closing task.

---

## Self-Review

**Spec coverage** (against design §6D + §11.6 + decisions #3/#7, and the card):
- "Admit queue — `catalog:submit` / `catalog:list-requests` / `catalog:admit`" → Tasks 1 (table) + 2 (store) + 3 (types) + 4/5/6 (hooks). ✓
- "Cold-start requests AND share submissions land here" → `kind` discriminant; both flavors in submit + list (Tasks 4/5). ✓
- "Admit = promote: register the tree SHA in the catalog DB" → `store.upsert` (global) re-derives the content-addressed `bundle_tree_sha` from the reviewed snapshot; canary asserts the global row's sha (Tasks 6/7). ✓
- "Materialize read-only into `.ax/session/skills/` for everyone, incl. the author" → the author's attachment re-resolves to the promoted global skill; canary re-invoke asserts materialization (Task 7); reuses the unchanged TASK-32/33 materializer. ✓
- "Working-copy retirement is a HARD requirement (§6D)" → `userStore.delete` on admit (Task 6); canary asserts the user row is gone + exactly one materialized entry (no dup-id collision) (Task 7). Stale-§6D location (workspace → user store) flagged + resolved. ✓
- "Dedup on skill id" → partial unique index + store SELECT-then-INSERT; dedup tests (Tasks 1/2/4). ✓
- "Reject" → `catalog:admit` `decision: 'reject'` (Task 6). ✓
- "Security-checklist — admin review IS the supply-chain gate" → pre-PR gate (Task 7 Step 4) + pre-stated threat model. ✓
- "Decision #3 (admission IS the approval) / #7 (share feeds the catalog)" → admit is the gate; share submissions promote into the catalog. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. Two intentional "follow the file's pattern" notes (the catalog-requests-store test's `makeKysely`/teardown boilerplate; the canary's per-describe `cleanup` client) reference existing anchors rather than inventing harness signatures. No TBD/TODO.

**Type consistency:** the request shape is `CatalogRequest { requestId, kind, skillId, requestedByUserId, sourceOwnerUserId, status, description, createdAt, manifestYaml, bodyMd, files }` everywhere (store + types + schema), with `files: BundleFile[]` (reusing the existing `BundleFile`/`BundleFileSchema`) and **no** `bundleTreeSha` on any public shape. The store is `createCatalogRequestsStore(db, bundleStore)`; `submitShare`/`submitColdStart`/`listPending`/`get`/`markDecided` signatures match across Tasks 2/4/5/6. `CatalogSubmitInput` is a `kind`-discriminated union; `CatalogAdmitInput.decision` is `'admit'|'reject'`. The hooks are added to the manifest `registers` array (Task 4) and registered in Tasks 4/5/6 — registration matches declaration (boot validation).

**Dependency assumptions flagged (deps NOT on `main` at authoring time):**
- **TASK-40** (`createBundleStore`, `bundle_tree_sha`, shared `bundleStore` in `init`, `store.upsert({…, files})`, `createSkillsPlugin(config)`) — re-verify the exact `init` local-variable name (`bundleStore`) and the `store.upsert` signature before Tasks 2/4/6.
- **TASK-39** (the "draft to share" is a `skills_v1_user_skills` row; the `.ax/skills` workspace draft is retired at install) — re-verify the user-scope upsert + draft-retirement before Tasks 4/6.
If either dep's as-built shape differs from its committed plan, adjust the snapshot read (`userStore.get`) / promotion (`store.upsert`) / retirement (`userStore.delete`) call sites accordingly and note the drift in the PR (task.txt hard requirement #1).

**Known residual / deferred (stated, not gaps):**
- **Whole-bundle single-SHA pinning** (SKILL.md inside the registered tree) — deferred, consistent with TASK-40; the snapshot already guarantees shipped == reviewed (extra files cryptographically, SKILL.md via host-controlled verbatim columns).
- **Decided-request history** in `catalog:list-requests` (the `status` filter beyond `pending`) — minimal today (`listPending` only); TASK-45 adds a store reader if its UI needs it (YAGNI now).
- **Cold-start production caller** (broker firing on a search miss) — a broker follow-up; the hook is exercised by tests/canary here.
- **Credential lifecycle on retirement** — intentionally unchanged: `skills:delete` scope=user skips the purge (global-namespaced `skill:<id>:<slot>` ref reused by the promoted skill). Same residual the TASK-33 user-scope path noted.
