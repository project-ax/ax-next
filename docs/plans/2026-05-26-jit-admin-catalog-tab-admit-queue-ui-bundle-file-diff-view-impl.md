# JIT Admin Catalog Tab + Admit Queue UI (Bundle File/Diff View) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a **channel-web UI** card — invoke the `shadcn` skill before touching any component (every CLI call needs `-c packages/channel-web`), and the `security-checklist` skill before opening the PR (see Scope guardrails).

**Goal:** Give admins the Part-II admin surface: reframe the existing admin **Skills** tab as **Catalog** (browse + version, tier badge, read-only §9.2 bundle file-view, inline org-default toggle), and add a new **Admit queue** inbox where cold-start + share-to-catalog requests are reviewed via a **bundle file/diff view** and admitted/rejected — because, post-bundles, "admit" means *reviewing code*, not a manifest (design §9.2 review burden, decision #16).

**Architecture:** Two layers. (1) **Server** (`@ax/skills`): the admit-queue hooks (`catalog:list-requests`/`catalog:admit`) already exist from TASK-41 — this card adds the thin admin **HTTP routes** that front them (mirroring the existing `/admin/skills*` pattern in `admin-routes.ts`), enriches the skill-list route with a derived `tier`, adds a bundle-preserving org-default toggle route, and fixes a latent file-drop bug in the edit route. No new hooks. (2) **Client** (`@ax/channel-web`): a renamed `CatalogTab`, a new `AdmitQueueTab` wired into `AdminShell`/`AdminSidebar`, a shared read-only `BundleFileView`, a `BundleReviewDialog` with a pure line-diff util, and typed wire clients. All untrusted bundle content renders as escaped text (no markdown→HTML), and the deciding-admin identity is host-supplied — never trusted from the client body.

**Tech Stack:** TypeScript, pnpm workspace, React 19 + Vite, shadcn/ui (radix base, installed: `alert badge button card checkbox command dialog dropdown-menu input label popover progress select separator sheet table textarea tooltip`), Tailwind v3 semantic tokens, vitest + @testing-library/react (client), testcontainers Postgres (server route tests).

---

## Scope guardrails

- **Boundary review — no hook-surface change.** This card adds/changes **only HTTP routes**, all of which call **existing** service hooks (`skills:list`, `skills:get`, `skills:upsert`, `catalog:list-requests`, `catalog:admit`). Per CLAUDE.md, boundary review is required for new/changed **hook** signatures — there are none here. The HTTP request-body schemas live in the `@ax/skills` route modules (`admin-routes.ts`, `catalog-routes.ts`), per the wire-surface convention — not a central file. §11 pre-specified the `catalog:*` hooks; they shipped in TASK-41 and are unchanged.
- **Invariant compliance.**
  - **I1 (storage-agnostic payloads):** the snapshot a share request carries crosses as `files: { path, contents }[]` — never a `treeSha`/`bucket`/`oid`. Confirmed against `CatalogRequest` in `packages/skills/src/types.ts` (the content-addressed pointer stays internal to the store).
  - **I2 (no cross-plugin imports):** `channel-web` uses **type-only** imports from `@ax/skills` (allowed — `allowTypeImports: true`). `tier` is computed **server-side** (the route imports `classifyTier` within `@ax/skills`); the client never imports `classifyTier`. The one pre-existing runtime cross-plugin import (`@ax/skills/manifest` in `SkillEditor.tsx`, already `eslint-disable`d) is untouched. The line-diff util is local to `channel-web`.
  - **I4 (one source of truth):** `tier` is derived from capabilities at the route via the canonical `classifyTier` — no new stored column, no client re-implementation. The default flag toggles the *same* `default_attached` record the SkillEditor writes (the mirror property, decision #16 / P6).
  - **I5 (capabilities minimized):** every new route is `requireAdmin`-gated server-side; the admit `decidedByUserId` is taken from the authenticated actor, never the request body.
- **Security-checklist applies (pre-PR gate).** The card body does not explicitly flag it, but this work (a) renders **untrusted** share-submitted bundle bytes (paths, `SKILL.md` body, extra-file contents) in a **privileged admin** surface, and (b) adds admin-gated routes whose deciding identity must not be client-spoofable. Both are direct `security-checklist` triggers (untrusted content + IPC/admin routes). Run the skill before the PR and paste the structured note. The pre-stated threat model is in the **final task**.
- **Half-wired window — OPEN, but upstream of this PR.** `catalog:submit` currently has **no production caller** (verified: only `@ax/skills/plugin.ts` registers it; nothing fires it). So the Admit queue's *feeders* — the broker's cold-start auto-file (§13) and the in-chat "share to catalog" action (§6D) — land in a **later TASK**; until then the queue is correctly **empty** in production. This is upstream of this card: **every component in THIS PR is reachable, tested, and calls live hooks** (the route tests + the component tests seed requests via `catalog:submit` directly / via mocked clients), so this PR introduces **no** half-wired code (invariant I3). State in the PR: "Half-wired window OPEN — the Admit queue's upstream `catalog:submit` feeders ship later; the queue UI here is fully wired to the live read/admit hooks."

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/skills/src/index.ts` | public package surface | **add** type exports: `SkillTier`, `BundleFile`, `CatalogRequest`, `Catalog*` I/O types |
| `packages/skills/src/_routes-shared.ts` | shared route plumbing (`@ax/skills`-private) | **add** `patchDefaultBodySchema`; **extend** `writeServiceError` with catalog error codes |
| `packages/skills/src/admin-routes.ts` | `/admin/skills*` CRUD | **enrich** list with derived `tier`; **add** `PATCH /admin/skills/:id` (bundle-preserving default toggle); **fix** PUT to preserve extra files |
| `packages/skills/src/catalog-routes.ts` | **new** — `/admin/catalog/*` admit-queue routes | **create** (`GET /admin/catalog/requests`, `POST /admin/catalog/requests/:id/decision`) |
| `packages/skills/src/plugin.ts` | plugin init / route registration | **wire** `registerCatalogRoutes` into the existing route-unregister try/catch |
| `packages/channel-web/src/lib/skills.ts` | `/admin/skills*` wire client | **add** `tier` to `listSkills`; **add** `getSkillOrNull`, `setSkillDefaultAttached` |
| `packages/channel-web/src/lib/catalog.ts` | **new** — `/admin/catalog/*` wire client | **create** (`listCatalogRequests`, `decideCatalogRequest`) |
| `packages/channel-web/src/lib/bundle-diff.ts` | **new** — pure diff/compare utils | **create** (`diffLines`, `compareBundles`, `reconstructSkillMd`) |
| `packages/channel-web/src/components/admin/BundleFileView.tsx` | **new** — read-only file list + content pane | **create** |
| `packages/channel-web/src/components/admin/BundleDiffView.tsx` | **new** — per-file status + line diff renderer | **create** |
| `packages/channel-web/src/components/admin/CatalogTab.tsx` | renamed from `SkillsTab.tsx` + tier/file-view/default-toggle | **rename + extend** |
| `packages/channel-web/src/components/admin/AdmitQueueTab.tsx` | **new** — pending-request inbox | **create** |
| `packages/channel-web/src/components/admin/BundleReviewDialog.tsx` | **new** — review one request (file/diff) + Admit/Reject | **create** |
| `packages/channel-web/src/components/admin/AdminSidebar.tsx` | admin nav | **change** `skills`→`catalog`, **add** `admit-queue` |
| `packages/channel-web/src/components/admin/AdminShell.tsx` | admin pane router | **change** tab meta + render switch |

**Tests** (one per source change): `packages/skills/src/__tests__/admin-routes.test.ts` (extend), `packages/skills/src/__tests__/catalog-routes.test.ts` (new), and under `packages/channel-web/src/`: `__tests__/catalog-client.test.ts` (new), `lib/__tests__/bundle-diff.test.ts` (new), `components/admin/__tests__/{BundleFileView,CatalogTab,AdmitQueueTab,BundleReviewDialog,AdminShell}.test.tsx`.

---

## Shared rule: rendering untrusted bundle content (referenced by Tasks 9, 12, 15)

A share submission's `path`s, reconstructed `SKILL.md`, and extra-file `contents` are **untrusted** (a user authored them). Everywhere they render:

- Render contents as **escaped text only** — inside `<pre>`/`<code>`/React text nodes. **Never** `dangerouslySetInnerHTML`; **never** route an untrusted `SKILL.md` body through a markdown→HTML renderer.
- File paths render as plain text (React escapes by default).
- Caps are already enforced at submit (≤16 extra files, ≤256 KiB/file — `validateBundleFiles`), so rendering is bounded; do not add a second cap, but do not silently truncate either (show the bytes faithfully so the human review is honest).

---

## Reconstructing `SKILL.md` (referenced by Tasks 8, 12, 15)

`SKILL.md` is stored split across `manifestYaml` + `bodyMd` (it is not in the `files[]` array). To show it as the bundle's root file, reconstruct it **exactly** as the orchestrator and `SkillEditor` already do:

```ts
'---\n' + manifestYaml + (manifestYaml.endsWith('\n') ? '' : '\n') + '---\n' + bodyMd
```

This is the canonical concat (verified against `SkillEditor.tsx:86-91` and the orchestrator's `SKILL.md` construction). Task 8 puts it in one tested helper (`reconstructSkillMd`) so both the Catalog file-view and the admit review use the same bytes.

---

### Task 1: Export catalog/tier/bundle types; `GET /admin/skills` returns a derived `tier`

**Files:**
- Modify: `packages/skills/src/index.ts`, `packages/skills/src/admin-routes.ts`
- Test: `packages/skills/src/__tests__/admin-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `admin-routes.test.ts` (it already boots the skills plugin against a Postgres testcontainer and stubs `auth:require-user` — reuse that harness; seed a skill via the `create` handler or a direct `skills:upsert` bus call, then drive `handlers.list`):

```typescript
it('list annotates each skill with a derived tier', async () => {
  const h = await bootSkillsHarness(); // existing per-file harness factory
  const handlers = createAdminSkillsHandlers({ bus: h.bus });
  stubAdmin(h); // existing helper: auth:require-user → { id:'admin', isAdmin:true }

  // A 'bounded' skill (declares an allowed host, no packages).
  await h.bus.call('skills:upsert', h.ctx, {
    manifestYaml: 'name: gh\ndescription: GitHub.\nversion: 1\ncapabilities:\n  allowedHosts:\n    - api.github.com\n',
    bodyMd: '# gh\n',
    scope: 'global',
  });

  const { res, statusOf, bodyOf } = mkRes();
  await handlers.list(mkReq({}), res);
  expect(statusOf()).toBe(200);
  const body = bodyOf() as { skills: Array<{ id: string; tier: string }> };
  expect(body.skills.find((s) => s.id === 'gh')?.tier).toBe('bounded');
});
```

(Use whatever the file already names its harness boot + admin-stub helpers; mirror the existing `create`/`get` tests in the same file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/admin-routes.test.ts`
Expected: FAIL — `tier` is `undefined` on the list rows.

- [ ] **Step 3: Export the types and enrich the list handler**

In `packages/skills/src/index.ts`, add to the type-export block:

```typescript
export type {
  SkillTier,
  BundleFile,
  CatalogRequest,
  CatalogSubmitInput,
  CatalogSubmitOutput,
  CatalogListRequestsInput,
  CatalogListRequestsOutput,
  CatalogAdmitInput,
  CatalogAdmitOutput,
  CatalogCandidate,
} from './types.js';
```

In `packages/skills/src/admin-routes.ts`, import the classifier (same package — no cross-plugin import) and map the list output:

```typescript
import { classifyTier } from './catalog-tier.js';
import type { SkillTier } from './catalog-tier.js';
```

Replace the body of the `list` handler's success path so each summary gains `tier`:

```typescript
const out = await deps.bus.call<{ scope: 'global' }, SkillsListOutput>(
  'skills:list',
  ctx,
  { scope: 'global' },
);
const skills = out.skills.map((s) => ({
  ...s,
  tier: classifyTier(s.capabilities) satisfies SkillTier,
}));
res.status(200).json({ skills });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/admin-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/index.ts packages/skills/src/admin-routes.ts packages/skills/src/__tests__/admin-routes.test.ts
git commit -m "feat(skills): export catalog types; admin list returns derived tier"
```

---

### Task 2: `PATCH /admin/skills/:id` — bundle-preserving org-default toggle

**Files:**
- Modify: `packages/skills/src/_routes-shared.ts`, `packages/skills/src/admin-routes.ts`
- Test: `packages/skills/src/__tests__/admin-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('PATCH flips defaultAttached and preserves the bundle extra files', async () => {
  const h = await bootSkillsHarness();
  const handlers = createAdminSkillsHandlers({ bus: h.bus });
  stubAdmin(h);

  // Seed a bundled skill (extra file) with defaultAttached false. Bundles
  // can't be created via the POST route (SKILL.md-only), so seed via the bus.
  await h.bus.call('skills:upsert', h.ctx, {
    manifestYaml: 'name: helper\ndescription: A helper.\nversion: 1\n',
    bodyMd: '# helper\n',
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    scope: 'global',
  });

  const { res, statusOf } = mkRes();
  await handlers.setDefaultAttached(
    mkReq({ params: { id: 'helper' }, body: { defaultAttached: true } }),
    res,
  );
  expect(statusOf()).toBe(200);

  const detail = await h.bus.call('skills:get', h.ctx, { skillId: 'helper', scope: 'global' });
  expect(detail.defaultAttached).toBe(true);
  expect(detail.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
});

it('PATCH on a credential-bearing skill is rejected 400 (cannot be default)', async () => {
  const h = await bootSkillsHarness();
  const handlers = createAdminSkillsHandlers({ bus: h.bus });
  stubAdmin(h);
  await h.bus.call('skills:upsert', h.ctx, {
    manifestYaml:
      'name: gh\ndescription: GitHub.\nversion: 1\ncapabilities:\n  credentials:\n    - slot: GITHUB_TOKEN\n      kind: api-key\n',
    bodyMd: '# gh\n',
    scope: 'global',
  });
  const { res, statusOf, bodyOf } = mkRes();
  await handlers.setDefaultAttached(
    mkReq({ params: { id: 'gh' }, body: { defaultAttached: true } }),
    res,
  );
  expect(statusOf()).toBe(400);
  expect((bodyOf() as { code?: string }).code).toBe('default-attached-requires-no-credentials');
});

it('PATCH on an unknown id is 404', async () => {
  const h = await bootSkillsHarness();
  const handlers = createAdminSkillsHandlers({ bus: h.bus });
  stubAdmin(h);
  const { res, statusOf } = mkRes();
  await handlers.setDefaultAttached(
    mkReq({ params: { id: 'nope' }, body: { defaultAttached: true } }),
    res,
  );
  expect(statusOf()).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/admin-routes.test.ts`
Expected: FAIL — `handlers.setDefaultAttached` does not exist.

- [ ] **Step 3: Add the body schema**

In `packages/skills/src/_routes-shared.ts`, after `upsertBodySchema`:

```typescript
export const patchDefaultBodySchema = z
  .object({ defaultAttached: z.boolean() })
  .strict();
```

- [ ] **Step 4: Add the handler + route**

In `packages/skills/src/admin-routes.ts`, import the new schema and the detail/upsert types (already imported: `SkillsGetOutput`, `SkillsUpsertInput`, `SkillsUpsertOutput`), and add to the returned handler object:

```typescript
/** PATCH /admin/skills/:id — partial update: flip defaultAttached only.
 * Re-upserts with the existing manifest/body/files so a bundle's extra
 * files are NEVER dropped by a default-flag toggle (the SKILL.md-only
 * round-trip would otherwise wipe them — see Task 3). */
async setDefaultAttached(req: RouteRequest, res: RouteResponse): Promise<void> {
  const actor = await requireAdmin(deps.bus, ctx, req, res);
  if (actor === null) return;
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: 'missing skill id' });
    return;
  }
  const parsedBody = parseRequestBody(req.body);
  if (!parsedBody.ok) {
    res.status(parsedBody.status).json({ error: parsedBody.message });
    return;
  }
  const zr = patchDefaultBodySchema.safeParse(parsedBody.value);
  if (!zr.success) {
    res.status(400).json({ error: 'invalid-payload' });
    return;
  }
  try {
    const detail = await deps.bus.call<{ skillId: string; scope: 'global' }, SkillsGetOutput>(
      'skills:get',
      ctx,
      { skillId: id, scope: 'global' },
    );
    await deps.bus.call<SkillsUpsertInput, SkillsUpsertOutput>('skills:upsert', ctx, {
      manifestYaml: detail.manifestYaml,
      bodyMd: detail.bodyMd,
      files: detail.files,
      defaultAttached: zr.data.defaultAttached,
      scope: 'global',
    });
    res.status(200).json({ skillId: id, defaultAttached: zr.data.defaultAttached });
  } catch (err) {
    if (writeServiceError(res, err)) return;
    throw err;
  }
},
```

Import `patchDefaultBodySchema` from `'./_routes-shared.js'` at the top, and register the route in `registerAdminSkillsRoutes`:

```typescript
{ method: 'PATCH', path: '/admin/skills/:id', handler: handlers.setDefaultAttached },
```

(Add `setDefaultAttached` to the handler return-type signature of `createAdminSkillsHandlers`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/admin-routes.test.ts`
Expected: PASS. (The 400 maps via `writeServiceError`'s existing `default-attached-requires-no-credentials` entry; the 404 via `skill-not-found`.)

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/_routes-shared.ts packages/skills/src/admin-routes.ts packages/skills/src/__tests__/admin-routes.test.ts
git commit -m "feat(skills): PATCH /admin/skills/:id bundle-preserving org-default toggle"
```

---

### Task 3: Fix PUT to preserve a bundle's extra files on a `SKILL.md`-only edit

**Files:**
- Modify: `packages/skills/src/admin-routes.ts`
- Test: `packages/skills/src/__tests__/admin-routes.test.ts`

> **Bug-fix-test policy.** Post-bundles (TASK-40), `skills:upsert` replaces the file set with `input.files ?? []`. The `PUT` route (and the `SkillEditor` that drives it) sends `SKILL.md` only — so editing a bundled skill silently **wipes every extra file**. The new Catalog file-view (Task 12) makes those files visible, so this latent data-loss is now user-facing. Fix it here with a regression test that would have caught it.

- [ ] **Step 1: Write the failing test**

```typescript
it('PUT preserves a bundle\'s extra files when only SKILL.md is edited', async () => {
  const h = await bootSkillsHarness();
  const handlers = createAdminSkillsHandlers({ bus: h.bus });
  stubAdmin(h);

  await h.bus.call('skills:upsert', h.ctx, {
    manifestYaml: 'name: helper\ndescription: A helper.\nversion: 1\n',
    bodyMd: '# helper\n',
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    scope: 'global',
  });

  const editedSkillMd =
    '---\nname: helper\ndescription: A helper (edited).\nversion: 2\n---\n# helper edited\n';
  const { res, statusOf } = mkRes();
  await handlers.update(mkReq({ params: { id: 'helper' }, body: { skillMd: editedSkillMd } }), res);
  expect(statusOf()).toBe(200);

  const detail = await h.bus.call('skills:get', h.ctx, { skillId: 'helper', scope: 'global' });
  expect(detail.description).toBe('A helper (edited).');
  expect(detail.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]); // NOT wiped
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/admin-routes.test.ts`
Expected: FAIL — `detail.files` is `[]` (the edit dropped the bundle).

- [ ] **Step 3: Preserve existing files in the update handler**

In `packages/skills/src/admin-routes.ts`, import `PluginError` and the `BundleFile` type:

```typescript
import { makeAgentContext, PluginError, type AgentContext, type HookBus } from '@ax/core';
import type { /* existing */ SkillsGetOutput, BundleFile } from './types.js';
```

In the `update` handler, after `splitSkillMd` succeeds and before the `skills:upsert` call, fetch the current bundle's extra files (tolerating a not-yet-existing skill — PUT may create):

```typescript
let existingFiles: BundleFile[] = [];
try {
  const existing = await deps.bus.call<{ skillId: string; scope: 'global' }, SkillsGetOutput>(
    'skills:get',
    ctx,
    { skillId: id, scope: 'global' },
  );
  existingFiles = existing.files;
} catch (err) {
  // PUT-as-create: no prior skill → nothing to preserve. Any other error
  // propagates to the catch below.
  if (!(err instanceof PluginError && err.code === 'skill-not-found')) throw err;
}
```

Then thread `files` into the existing upsert call:

```typescript
const out = await deps.bus.call<SkillsUpsertInput, SkillsUpsertOutput>(
  'skills:upsert',
  ctx,
  { ...split, files: existingFiles, defaultAttached: zodResult.data.defaultAttached ?? false },
);
```

(The `try { ... } catch (err) { if (writeServiceError(res, err)) ...` block around the upsert is unchanged. The pre-fetch's own catch only swallows `skill-not-found`; everything else rethrows into that block.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/admin-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/admin-routes.ts packages/skills/src/__tests__/admin-routes.test.ts
git commit -m "fix(skills): PUT /admin/skills/:id preserves bundle extra files on edit"
```

---

### Task 4: Extend `writeServiceError` with the catalog admit error codes

**Files:**
- Modify: `packages/skills/src/_routes-shared.ts`
- Test: `packages/skills/src/__tests__/admin-routes.test.ts` (the shared mapper is exercised here; the catalog routes in Task 5 rely on it)

- [ ] **Step 1: Write the failing test**

Add a focused unit test that drives `writeServiceError` directly (it is exported from `_routes-shared.ts` and re-exported from `admin-routes.ts`):

```typescript
import { writeServiceError } from '../_routes-shared.js';
import { PluginError } from '@ax/core';

it('maps catalog admit error codes to HTTP statuses', () => {
  const cases: Array<[string, number]> = [
    ['request-not-found', 404],
    ['request-already-decided', 409],
    ['cold-start-not-promotable', 400],
    ['invalid-bundle-file', 400],
  ];
  for (const [code, status] of cases) {
    const { res, statusOf } = mkRes();
    const handled = writeServiceError(res, new PluginError({ code, plugin: '@ax/skills', message: 'x' }));
    expect(handled).toBe(true);
    expect(statusOf()).toBe(status);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/admin-routes.test.ts`
Expected: FAIL — `writeServiceError` returns `false` for these codes (status stays 200).

- [ ] **Step 3: Extend the mapper**

In `packages/skills/src/_routes-shared.ts`, inside `writeServiceError`, after the existing `skill-in-use` block:

```typescript
if (err.code === 'request-not-found') {
  res.status(404).json({ error: err.message });
  return true;
}
if (err.code === 'request-already-decided') {
  res.status(409).json({ error: err.message, code: 'request-already-decided' });
  return true;
}
```

And add `'cold-start-not-promotable'` and `'invalid-bundle-file'` to the `badRequestCodes` set.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/admin-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/_routes-shared.ts packages/skills/src/__tests__/admin-routes.test.ts
git commit -m "feat(skills): map catalog admit error codes in writeServiceError"
```

---

### Task 5: Catalog admit-queue routes (`GET requests`, `POST decision`) + plugin wiring

**Files:**
- Create: `packages/skills/src/catalog-routes.ts`
- Modify: `packages/skills/src/plugin.ts`
- Test: `packages/skills/src/__tests__/catalog-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/skills/src/__tests__/catalog-routes.test.ts` (mirror `admin-routes.test.ts`'s boot + `mkReq`/`mkRes` + `auth:require-user` stub; copy those helpers or import them if the file already factors them out):

```typescript
it('GET /admin/catalog/requests returns pending requests (admin-gated)', async () => {
  const h = await bootSkillsHarness();
  const handlers = createCatalogHandlers({ bus: h.bus });
  stubAdmin(h);

  // Seed: a user authors a skill, then files a share request.
  await h.bus.call('skills:upsert', h.ctx, {
    manifestYaml: 'name: linear\ndescription: Linear.\nversion: 1\n',
    bodyMd: '# linear\n',
    scope: 'user',
    ownerUserId: 'u-author',
  });
  await h.bus.call('catalog:submit', h.ctx, {
    kind: 'share',
    skillId: 'linear',
    requestedByUserId: 'u-author',
  });

  const { res, statusOf, bodyOf } = mkRes();
  await handlers.listRequests(mkReq({}), res);
  expect(statusOf()).toBe(200);
  const body = bodyOf() as { requests: Array<{ skillId: string; kind: string }> };
  expect(body.requests.find((r) => r.skillId === 'linear')?.kind).toBe('share');
});

it('GET /admin/catalog/requests is 403 for a non-admin', async () => {
  const h = await bootSkillsHarness();
  const handlers = createCatalogHandlers({ bus: h.bus });
  stubUser(h, { id: 'u-author', isAdmin: false }); // existing non-admin stub helper
  const { res, statusOf } = mkRes();
  await handlers.listRequests(mkReq({}), res);
  expect(statusOf()).toBe(403);
});

it('POST decision admits a share and ignores any client-supplied decider', async () => {
  const h = await bootSkillsHarness();
  const handlers = createCatalogHandlers({ bus: h.bus });
  stubAdmin(h); // actor.id === 'admin'

  await h.bus.call('skills:upsert', h.ctx, {
    manifestYaml: 'name: linear\ndescription: Linear.\nversion: 1\n',
    bodyMd: '# linear\n',
    scope: 'user',
    ownerUserId: 'u-author',
  });
  const submitted = await h.bus.call('catalog:submit', h.ctx, {
    kind: 'share',
    skillId: 'linear',
    requestedByUserId: 'u-author',
  });

  const { res, statusOf, bodyOf } = mkRes();
  await handlers.decide(
    mkReq({
      params: { id: submitted.requestId },
      // attacker tries to spoof the decider — must be ignored.
      body: { decision: 'admit', decidedByUserId: 'u-evil' },
    }),
    res,
  );
  expect(statusOf()).toBe(200);
  expect((bodyOf() as { admitted: boolean }).admitted).toBe(true);

  // The skill is now in the GLOBAL catalog; the author's working copy retired.
  const global = await h.bus.call('skills:get', h.ctx, { skillId: 'linear', scope: 'global' });
  expect(global.id).toBe('linear');
});

it('POST decision rejects a request', async () => {
  const h = await bootSkillsHarness();
  const handlers = createCatalogHandlers({ bus: h.bus });
  stubAdmin(h);
  await h.bus.call('skills:upsert', h.ctx, {
    manifestYaml: 'name: linear\ndescription: Linear.\nversion: 1\n',
    bodyMd: '# linear\n',
    scope: 'user',
    ownerUserId: 'u-author',
  });
  const submitted = await h.bus.call('catalog:submit', h.ctx, {
    kind: 'share',
    skillId: 'linear',
    requestedByUserId: 'u-author',
  });
  const { res, statusOf, bodyOf } = mkRes();
  await handlers.decide(
    mkReq({ params: { id: submitted.requestId }, body: { decision: 'reject' } }),
    res,
  );
  expect(statusOf()).toBe(200);
  expect((bodyOf() as { admitted: boolean }).admitted).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/catalog-routes.test.ts`
Expected: FAIL — cannot find module `../catalog-routes.js`.

- [ ] **Step 3: Implement the routes**

Create `packages/skills/src/catalog-routes.ts`:

```typescript
import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type {
  CatalogListRequestsInput,
  CatalogListRequestsOutput,
  CatalogAdmitInput,
  CatalogAdmitOutput,
} from './types.js';
import {
  requireAdmin,
  parseRequestBody,
  writeServiceError,
  type RouteRequest,
  type RouteResponse,
} from './_routes-shared.js';

// ---------------------------------------------------------------------------
// /admin/catalog/* — admit-queue review routes (admin-only).
//
//   GET  /admin/catalog/requests                 → pending admit requests
//   POST /admin/catalog/requests/:id/decision    → admit | reject
//
// These FRONT the catalog:* service hooks (registered in plugin.ts, TASK-41).
// The deciding admin identity is the AUTHENTICATED actor — NEVER the request
// body (invariant I5; a client-supplied decidedByUserId is ignored).
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/skills';

const decisionBodySchema = z
  .object({ decision: z.enum(['admit', 'reject']) })
  .strict();

export interface CatalogRouteDeps {
  bus: HookBus;
}

export function createCatalogHandlers(deps: CatalogRouteDeps): {
  listRequests: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  decide: (req: RouteRequest, res: RouteResponse) => Promise<void>;
} {
  const ctx = makeAgentContext({
    sessionId: 'skills-admin',
    agentId: PLUGIN_NAME,
    userId: 'admin',
  });

  return {
    /** GET /admin/catalog/requests */
    async listRequests(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      try {
        const out = await deps.bus.call<CatalogListRequestsInput, CatalogListRequestsOutput>(
          'catalog:list-requests',
          ctx,
          { status: 'pending' },
        );
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },

    /** POST /admin/catalog/requests/:id/decision */
    async decide(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireAdmin(deps.bus, ctx, req, res);
      if (actor === null) return;
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'missing request id' });
        return;
      }
      const parsedBody = parseRequestBody(req.body);
      if (!parsedBody.ok) {
        res.status(parsedBody.status).json({ error: parsedBody.message });
        return;
      }
      const zr = decisionBodySchema.safeParse(parsedBody.value);
      if (!zr.success) {
        res.status(400).json({ error: 'invalid-payload' });
        return;
      }
      try {
        const out = await deps.bus.call<CatalogAdmitInput, CatalogAdmitOutput>(
          'catalog:admit',
          ctx,
          {
            requestId: id,
            decision: zr.data.decision,
            decidedByUserId: actor.id, // host-supplied; body is ignored
          },
        );
        res.status(200).json(out);
      } catch (err) {
        if (writeServiceError(res, err)) return;
        throw err;
      }
    },
  };
}

export async function registerCatalogRoutes(
  bus: HookBus,
  initCtx: AgentContext,
): Promise<Array<() => void>> {
  const handlers = createCatalogHandlers({ bus });
  const routes: Array<{
    method: 'GET' | 'POST';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'GET', path: '/admin/catalog/requests', handler: handlers.listRequests },
    {
      method: 'POST',
      path: '/admin/catalog/requests/:id/decision',
      handler: handlers.decide,
    },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>(
      'http:register-route',
      initCtx,
      route,
    );
    unregisters.push(result.unregister);
  }
  return unregisters;
}
```

- [ ] **Step 4: Wire registration into the plugin**

In `packages/skills/src/plugin.ts`, add the import near the existing route imports:

```typescript
import { registerCatalogRoutes } from './catalog-routes.js';
```

Inside the existing route-registration `try` block (where `registerAdminSkillsRoutes` and `registerSettingsSkillsRoutes` are pushed into `routeUnregisters`), add a third batch:

```typescript
const catalogUnregisters = await registerCatalogRoutes(bus, initCtx);
routeUnregisters.push(...catalogUnregisters);
```

(No manifest change: the routes use `http:register-route` + `auth:require-user`, both already in `calls`, and call the `catalog:*` hooks this same plugin registers.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/catalog-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/skills/src/catalog-routes.ts packages/skills/src/plugin.ts packages/skills/src/__tests__/catalog-routes.test.ts
git commit -m "feat(skills): admin admit-queue routes (list requests + decision)"
```

---

### Task 6: Client wire client — `tier` on `listSkills`, `getSkillOrNull`, `setSkillDefaultAttached`

**Files:**
- Modify: `packages/channel-web/src/lib/skills.ts`
- Modify (fixtures): `packages/channel-web/src/components/admin/__tests__/SkillsTab.test.tsx`, `packages/channel-web/src/components/admin/__tests__/SkillAttachmentsSection.test.tsx`
- Test: `packages/channel-web/src/__tests__/catalog-client.test.ts` (new)

> **Fork resolution — `tier` is optional on the client type.** The server always populates `tier`, but typing it as optional (`tier?: SkillTier`) keeps the change additive: existing `listSkills` mock fixtures and the `SkillAttachmentsSection` consumer compile unchanged, and each later UI task stays independently green. The badge renders only when present. Rationale: minimize cross-task breakage for subagent execution; the server contract is unchanged either way.

- [ ] **Step 1: Write the failing test**

Create `packages/channel-web/src/__tests__/catalog-client.test.ts` (mirror `credentials-client.test.ts`'s `vi.spyOn(globalThis, 'fetch')` + `jsonResponse` pattern):

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listSkills, getSkillOrNull, setSkillDefaultAttached } from '../lib/skills';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('skills wire client (catalog additions)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('listSkills surfaces the server-derived tier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ skills: [{ id: 'gh', tier: 'bounded', capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } }, defaultAttached: false, version: 1, scope: 'global', description: 'x', updatedAt: '2026-05-26T00:00:00.000Z' }] }),
    );
    const skills = await listSkills();
    expect(skills[0]?.tier).toBe('bounded');
  });

  it('getSkillOrNull returns null on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
    expect(await getSkillOrNull('nope')).toBeNull();
  });

  it('setSkillDefaultAttached PATCHes with the CSRF header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ skillId: 'gh', defaultAttached: true }));
    await setSkillDefaultAttached('gh', true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/skills/gh',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ 'x-requested-with': 'ax-admin' }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/catalog-client.test.ts`
Expected: FAIL — `getSkillOrNull` / `setSkillDefaultAttached` are not exported.

- [ ] **Step 3: Extend `lib/skills.ts`**

At the top, widen the type import and add the catalog summary type:

```typescript
import type { SkillDetail, SkillSummary, SkillTier } from '@ax/skills';

/** A catalog row as the admin Catalog tab sees it: a summary plus the
 * server-derived risk tier (the set the broker proposes from). `tier` is
 * computed server-side via classifyTier — never re-derived on the client. */
export type CatalogSkillSummary = SkillSummary & { tier?: SkillTier };
```

Change `listSkills` to return the enriched type:

```typescript
export async function listSkills(): Promise<CatalogSkillSummary[]> {
  const res = await fetch('/admin/skills', { credentials: 'include' });
  const body = (await handleResponse(res)) as { skills: CatalogSkillSummary[] };
  return body.skills;
}
```

Add the two new functions:

```typescript
/** Like getSkill, but returns null on 404 (used by the admit review's diff:
 * a share request for a brand-new id has no existing catalog version). */
export async function getSkillOrNull(skillId: string): Promise<SkillDetail | null> {
  const res = await fetch(`/admin/skills/${encodeURIComponent(skillId)}`, {
    credentials: 'include',
  });
  if (res.status === 404) return null;
  return (await handleResponse(res)) as SkillDetail;
}

/** Flip a catalog skill's org-default flag without re-sending SKILL.md.
 * Server re-upserts preserving the bundle (PATCH route, bundle-safe). */
export async function setSkillDefaultAttached(
  skillId: string,
  defaultAttached: boolean,
): Promise<void> {
  const res = await fetch(`/admin/skills/${encodeURIComponent(skillId)}`, {
    method: 'PATCH',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({ defaultAttached }),
  });
  await handleResponse(res);
}
```

- [ ] **Step 4: Keep existing fixtures compiling**

`CatalogSkillSummary` adds only an **optional** field, so the existing `SKILL_A`/`SKILL_B` fixtures in `SkillsTab.test.tsx` and any `listSkills` mock in `SkillAttachmentsSection.test.tsx` still satisfy the type with **no edit**. Confirm by running their suites (Step 5). If a fixture is typed as `CatalogSkillSummary[]` and a test asserts on `tier`, add `tier: 'bounded'` there — otherwise leave them.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/catalog-client.test.ts src/components/admin/__tests__/SkillsTab.test.tsx src/components/admin/__tests__/SkillAttachmentsSection.test.tsx`
Expected: PASS (all three).

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/lib/skills.ts packages/channel-web/src/__tests__/catalog-client.test.ts
git commit -m "feat(channel-web): skills client — tier, getSkillOrNull, setSkillDefaultAttached"
```

---

### Task 7: Catalog wire client (`lib/catalog.ts`)

**Files:**
- Create: `packages/channel-web/src/lib/catalog.ts`
- Test: `packages/channel-web/src/__tests__/catalog-client.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `catalog-client.test.ts`:

```typescript
import { listCatalogRequests, decideCatalogRequest } from '../lib/catalog';

describe('catalog wire client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('listCatalogRequests unwraps the requests envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ requests: [{ requestId: 'r1', kind: 'share', skillId: 'linear', requestedByUserId: 'u1', sourceOwnerUserId: 'u1', status: 'pending', description: 'd', createdAt: '2026-05-26T00:00:00.000Z', manifestYaml: 'name: linear\n', bodyMd: '# l\n', files: [] }] }),
    );
    const reqs = await listCatalogRequests();
    expect(reqs[0]?.requestId).toBe('r1');
  });

  it('decideCatalogRequest POSTs the decision with the CSRF header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ admitted: true, skillId: 'linear' }));
    const out = await decideCatalogRequest('r1', 'admit');
    expect(out.admitted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/catalog/requests/r1/decision',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-requested-with': 'ax-admin' }),
        body: JSON.stringify({ decision: 'admit' }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/catalog-client.test.ts`
Expected: FAIL — cannot find module `../lib/catalog`.

- [ ] **Step 3: Implement `lib/catalog.ts`**

```typescript
/**
 * Catalog admit-queue wire client — typed wrappers around `/admin/catalog/*`.
 * Same posture as lib/skills.ts (credentials: 'include' on every call;
 * x-requested-with: ax-admin on writes; admin-gated server-side).
 *
 * The deciding-admin identity is supplied by the SERVER from the auth session
 * — the client sends only the decision. Do NOT add a decidedByUserId field.
 */
import type { CatalogRequest, CatalogAdmitOutput } from '@ax/skills';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

async function handleResponse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(`catalog API ${res.status}: ${excerpt.slice(0, 200)}`);
  }
  return res.json();
}

export async function listCatalogRequests(): Promise<CatalogRequest[]> {
  const res = await fetch('/admin/catalog/requests', { credentials: 'include' });
  const body = (await handleResponse(res)) as { requests: CatalogRequest[] };
  return body.requests;
}

export async function decideCatalogRequest(
  requestId: string,
  decision: 'admit' | 'reject',
): Promise<CatalogAdmitOutput> {
  const res = await fetch(
    `/admin/catalog/requests/${encodeURIComponent(requestId)}/decision`,
    {
      method: 'POST',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({ decision }),
    },
  );
  return (await handleResponse(res)) as CatalogAdmitOutput;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/catalog-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/catalog.ts packages/channel-web/src/__tests__/catalog-client.test.ts
git commit -m "feat(channel-web): catalog admit-queue wire client"
```

---

### Task 8: Pure bundle utils — `reconstructSkillMd`, `diffLines`, `compareBundles`

**Files:**
- Create: `packages/channel-web/src/lib/bundle-diff.ts`
- Test: `packages/channel-web/src/lib/__tests__/bundle-diff.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { reconstructSkillMd, diffLines, compareBundles } from '../bundle-diff';

describe('reconstructSkillMd', () => {
  it('fences the manifest and appends the body', () => {
    expect(reconstructSkillMd('name: x\n', '# Body\n')).toBe('---\nname: x\n---\n# Body\n');
  });
  it('adds a missing trailing newline to the manifest', () => {
    expect(reconstructSkillMd('name: x', '# B')).toBe('---\nname: x\n---\n# B');
  });
});

describe('diffLines', () => {
  it('marks added, removed, and context lines', () => {
    const out = diffLines('a\nb\nc', 'a\nB\nc');
    expect(out).toEqual([
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'context', text: 'c' },
    ]);
  });
  it('handles empty before (all adds)', () => {
    expect(diffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });
});

describe('compareBundles', () => {
  it('classifies added / removed / modified / unchanged per path', () => {
    const before = { 'SKILL.md': '# v1', 'scripts/a.py': 'print(1)', 'gone.txt': 'x' };
    const after = { 'SKILL.md': '# v2', 'scripts/a.py': 'print(1)', 'new.txt': 'y' };
    const entries = compareBundles(before, after);
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.status]));
    expect(byPath).toEqual({
      'SKILL.md': 'modified',
      'gone.txt': 'removed',
      'new.txt': 'added',
      'scripts/a.py': 'unchanged',
    });
    // sorted by path
    expect(entries.map((e) => e.path)).toEqual(['SKILL.md', 'gone.txt', 'new.txt', 'scripts/a.py']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/lib/__tests__/bundle-diff.test.ts`
Expected: FAIL — cannot find module `../bundle-diff`.

- [ ] **Step 3: Implement the utils**

Create `packages/channel-web/src/lib/bundle-diff.ts` (LCS line diff; `!` non-null assertions because `noUncheckedIndexedAccess` is on and the indices are provably in-bounds):

```typescript
/** Reconstruct a skill's SKILL.md from its split storage (manifest + body).
 * Matches SkillEditor / orchestrator byte-for-byte. */
export function reconstructSkillMd(manifestYaml: string, bodyMd: string): string {
  return (
    '---\n' +
    manifestYaml +
    (manifestYaml.endsWith('\n') ? '' : '\n') +
    '---\n' +
    bodyMd
  );
}

export type DiffLineType = 'context' | 'add' | 'remove';
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** Line-level LCS diff. `before`/`after` are whole-file strings. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.split('\n');
  const b = after.length === 0 ? [] : after.split('\n');
  const m = a.length;
  const n = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'remove', text: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < m) {
    out.push({ type: 'remove', text: a[i]! });
    i++;
  }
  while (j < n) {
    out.push({ type: 'add', text: b[j]! });
    j++;
  }
  return out;
}

export type BundleFileStatus = 'added' | 'removed' | 'modified' | 'unchanged';
export interface BundleFileEntry {
  path: string;
  status: BundleFileStatus;
  before: string | null; // current catalog content, null if newly added
  after: string | null; // submitted content, null if removed
}

/** Compare two path→contents maps. Result is sorted by path. */
export function compareBundles(
  before: Record<string, string>,
  after: Record<string, string>,
): BundleFileEntry[] {
  const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  return paths.map((path) => {
    const b = Object.prototype.hasOwnProperty.call(before, path) ? before[path]! : null;
    const a = Object.prototype.hasOwnProperty.call(after, path) ? after[path]! : null;
    let status: BundleFileStatus;
    if (b === null) status = 'added';
    else if (a === null) status = 'removed';
    else status = a === b ? 'unchanged' : 'modified';
    return { path, status, before: b, after: a };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/lib/__tests__/bundle-diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/bundle-diff.ts packages/channel-web/src/lib/__tests__/bundle-diff.test.ts
git commit -m "feat(channel-web): pure bundle diff/compare utils"
```

---

### Task 9: `BundleFileView` — read-only file list + content pane

**Files:**
- Create: `packages/channel-web/src/components/admin/BundleFileView.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/BundleFileView.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BundleFileView } from '../BundleFileView';

const FILES = [
  { path: 'SKILL.md', contents: '# Root skill doc' },
  { path: 'scripts/run.py', contents: 'print("hello")' },
];

describe('BundleFileView', () => {
  it('lists every file and shows the first file by default', () => {
    render(<BundleFileView files={FILES} />);
    expect(screen.getByRole('button', { name: 'SKILL.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'scripts/run.py' })).toBeTruthy();
    expect(screen.getByText('# Root skill doc')).toBeTruthy();
  });

  it('switches the content pane when a file is selected', () => {
    render(<BundleFileView files={FILES} />);
    fireEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }));
    expect(screen.getByText('print("hello")')).toBeTruthy();
  });

  it('renders untrusted contents as text (no HTML injection)', () => {
    render(<BundleFileView files={[{ path: 'x.md', contents: '<img src=x onerror=alert(1)>' }]} />);
    // The literal string is shown; no <img> element is created.
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/BundleFileView.test.tsx`
Expected: FAIL — cannot find module `../BundleFileView`.

- [ ] **Step 3: Implement the component**

Create `packages/channel-web/src/components/admin/BundleFileView.tsx` (composes existing primitives; content in `<pre>` so React escapes it — see the Shared rule on untrusted content):

```tsx
import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface BundleFileViewProps {
  /** Files to browse, in display order. SKILL.md (reconstructed) first. */
  files: { path: string; contents: string }[];
}

export function BundleFileView({ files }: BundleFileViewProps) {
  const [selected, setSelected] = useState<string>(files[0]?.path ?? '');
  const current = files.find((f) => f.path === selected) ?? files[0];

  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground">No files.</p>;
  }

  return (
    <div className="grid grid-cols-[200px_1fr] gap-3">
      <ul className="flex flex-col gap-px list-none m-0 p-0 max-h-[400px] overflow-auto rounded-md border border-border">
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => setSelected(f.path)}
              className={cn(
                'w-full text-left px-2 py-1.5 text-xs font-mono truncate transition-colors',
                f.path === current?.path
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              {f.path}
            </button>
          </li>
        ))}
      </ul>
      <pre className="font-mono text-xs whitespace-pre-wrap break-words max-h-[400px] overflow-auto rounded-md border border-border bg-muted/30 p-3 m-0">
        {current?.contents}
      </pre>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/BundleFileView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/BundleFileView.tsx packages/channel-web/src/components/admin/__tests__/BundleFileView.test.tsx
git commit -m "feat(channel-web): read-only BundleFileView (escaped content)"
```

---

### Task 10: Rename `SkillsTab` → `CatalogTab`; rewire `AdminShell` / `AdminSidebar`

**Files:**
- Rename: `packages/channel-web/src/components/admin/SkillsTab.tsx` → `CatalogTab.tsx`
- Rename: `packages/channel-web/src/components/admin/__tests__/SkillsTab.test.tsx` → `CatalogTab.test.tsx`
- Modify: `packages/channel-web/src/components/admin/AdminSidebar.tsx`, `packages/channel-web/src/components/admin/AdminShell.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/AdminShell.test.tsx`

- [ ] **Step 1: Write the failing test**

In `AdminShell.test.tsx`, add a test asserting the reframed nav (it will fail because the nav still says "Skills" and has no "Admit queue"):

```typescript
it('shows the Catalog and Admit queue nav items', () => {
  renderShell();
  const nav = screen.getByRole('list');
  expect(within(nav).getByText('Catalog')).toBeTruthy();
  expect(within(nav).getByText('Admit queue')).toBeTruthy();
});

it('clicking Catalog makes it the active tab', () => {
  renderShell();
  fireEvent.click(screen.getByRole('button', { name: 'Catalog' }));
  const nav = screen.getByRole('list');
  expect(within(nav).getByRole('button', { name: 'Catalog' }).getAttribute('data-active')).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/AdminShell.test.tsx`
Expected: FAIL — no "Catalog" / "Admit queue" text in the nav.

- [ ] **Step 3: Rename the component (mechanical) + stub `AdmitQueueTab`**

Rename `SkillsTab.tsx` → `CatalogTab.tsx` and rename the exported function `SkillsTab` → `CatalogTab` (no behavior change in this task — tier/file-view/default-toggle land in Tasks 11–13). Rename `SkillsTab.test.tsx` → `CatalogTab.test.tsx`, update its import (`import { CatalogTab } from '../CatalogTab'`) and the rendered element; keep every existing assertion.

Create a minimal `AdmitQueueTab.tsx` placeholder so `AdminShell` compiles now (it gets its real body in Task 14):

```tsx
export function AdmitQueueTab() {
  return <p className="text-sm text-muted-foreground">Loading…</p>;
}
```

- [ ] **Step 4: Rewire `AdminSidebar.tsx`**

Replace the `'skills'` member of `AdminTabId` with `'catalog'` and add `'admit-queue'`:

```typescript
export type AdminTabId =
  | 'providers'
  | 'model-config'
  | 'auth-providers'
  | 'agents'
  | 'catalog'
  | 'admit-queue'
  | 'mcp-servers'
  | 'teams';
```

Import two more lucide icons and update the `NAV` array (drop the old `skills` row, add `catalog` + `admit-queue`):

```typescript
import { ChevronLeft, KeyRound, Cpu, User, Server, UsersRound, ShieldCheck, Library, Inbox } from 'lucide-react';
// ...
const NAV: Array<{ id: AdminTabId; label: string; icon: typeof KeyRound }> = [
  { id: 'providers', label: 'Providers', icon: KeyRound },
  { id: 'model-config', label: 'Model config', icon: Cpu },
  { id: 'auth-providers', label: 'Auth providers', icon: ShieldCheck },
  { id: 'agents', label: 'Agents', icon: User },
  { id: 'catalog', label: 'Catalog', icon: Library },
  { id: 'admit-queue', label: 'Admit queue', icon: Inbox },
  { id: 'mcp-servers', label: 'MCP servers', icon: Server },
  { id: 'teams', label: 'Teams', icon: UsersRound },
];
```

(`Wrench` is no longer used — remove it from the import.)

- [ ] **Step 5: Rewire `AdminShell.tsx`**

Swap the imports and the `TAB_META` + render switch:

```typescript
import { CatalogTab } from './CatalogTab';
import { AdmitQueueTab } from './AdmitQueueTab';
// ...
const TAB_META: Record<AdminTabId, TabMeta> = {
  providers: { eyebrow: 'Admin', title: 'Providers' },
  'model-config': { eyebrow: 'Admin', title: 'Model config' },
  'auth-providers': { eyebrow: 'Admin', title: 'Auth providers' },
  agents: { eyebrow: 'Admin', title: 'Agents' },
  catalog: { eyebrow: 'Admin', title: 'Catalog' },
  'admit-queue': { eyebrow: 'Admin', title: 'Admit queue' },
  'mcp-servers': { eyebrow: 'Admin', title: 'MCP servers' },
  teams: { eyebrow: 'Admin', title: 'Teams' },
};
// ...in the pane:
{activeTab === 'catalog' && <CatalogTab />}
{activeTab === 'admit-queue' && <AdmitQueueTab />}
```

(Remove the old `{activeTab === 'skills' && <SkillsTab />}` line and the `SkillsTab` import.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/AdminShell.test.tsx src/components/admin/__tests__/CatalogTab.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/channel-web/src/components/admin/CatalogTab.tsx packages/channel-web/src/components/admin/AdmitQueueTab.tsx packages/channel-web/src/components/admin/AdminSidebar.tsx packages/channel-web/src/components/admin/AdminShell.tsx packages/channel-web/src/components/admin/__tests__/CatalogTab.test.tsx packages/channel-web/src/components/admin/__tests__/AdminShell.test.tsx
git rm packages/channel-web/src/components/admin/SkillsTab.tsx packages/channel-web/src/components/admin/__tests__/SkillsTab.test.tsx
git commit -m "refactor(channel-web): reframe Skills tab as Catalog; add Admit queue nav"
```

---

### Task 11: `CatalogTab` — tier badge column

**Files:**
- Modify: `packages/channel-web/src/components/admin/CatalogTab.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/CatalogTab.test.tsx`

- [ ] **Step 1: Write the failing test**

Extend `CatalogTab.test.tsx`. The mock `listSkills` already returns `SKILL_A`; give it a `tier` and assert the badge renders:

```typescript
it('renders each skill\'s tier badge', async () => {
  mockListSkills.mockResolvedValue([{ ...SKILL_A, tier: 'bounded' }]);
  render(<CatalogTab />);
  expect(await screen.findByText('bounded')).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/CatalogTab.test.tsx`
Expected: FAIL — no "bounded" text (no tier column).

- [ ] **Step 3: Add the Tier column**

In `CatalogTab.tsx`, change the `listSkills` state type to `CatalogSkillSummary[]` (import the type: `import { listSkills, deleteSkill, checkSkillForUpdates, refreshSkillFromSource, type CheckUpdateResult, type CatalogSkillSummary } from '@/lib/skills';` and `const [skills, setSkills] = useState<CatalogSkillSummary[] | null>(null);`).

Add a `Tier` header after `Description`:

```tsx
<TableHead>Tier</TableHead>
```

And a cell in the row (after the description cell):

```tsx
<TableCell>
  {s.tier ? (
    <Badge variant="outline" className="text-[10px] capitalize">
      {s.tier}
    </Badge>
  ) : (
    <span className="text-xs text-muted-foreground">—</span>
  )}
</TableCell>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/CatalogTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/CatalogTab.tsx packages/channel-web/src/components/admin/__tests__/CatalogTab.test.tsx
git commit -m "feat(channel-web): Catalog tab shows each skill's tier"
```

---

### Task 12: `CatalogTab` — read-only bundle file-view ("View files")

**Files:**
- Modify: `packages/channel-web/src/components/admin/CatalogTab.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/CatalogTab.test.tsx`

- [ ] **Step 1: Write the failing test**

Extend the test. Mock `getSkill` to return a detail with an extra file, click "View files", assert the dialog shows `SKILL.md` and the extra file:

```typescript
import { getSkill } from '@/lib/skills';
// add getSkill to the vi.mock('@/lib/skills', ...) factory:
//   getSkill: vi.fn(),
const mockGetSkill = vi.mocked(getSkill);

it('opens a read-only bundle file-view for a skill', async () => {
  mockListSkills.mockResolvedValue([{ ...SKILL_A, tier: 'bounded' }]);
  mockGetSkill.mockResolvedValue({
    ...SKILL_A,
    manifestYaml: 'name: github-api\ndescription: x\nversion: 1\n',
    bodyMd: '# gh\n',
    files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
  });
  render(<CatalogTab />);
  fireEvent.click(await screen.findByRole('button', { name: /view files for github-api/i }));
  expect(await screen.findByRole('button', { name: 'SKILL.md' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'scripts/run.py' })).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/CatalogTab.test.tsx`
Expected: FAIL — no "View files" control.

- [ ] **Step 3: Add the file-view action + dialog**

In `CatalogTab.tsx`:

- Import the pieces:

```tsx
import { FileCode } from 'lucide-react';
import { getSkill } from '@/lib/skills';
import { BundleFileView } from './BundleFileView';
import { reconstructSkillMd } from '@/lib/bundle-diff';
```

- Add state:

```tsx
const [viewingFiles, setViewingFiles] = useState<{ id: string; files: { path: string; contents: string }[] } | null>(null);
```

- Add a handler that fetches the detail and assembles the file list (SKILL.md reconstructed first):

```tsx
async function handleViewFiles(skillId: string) {
  try {
    const detail = await getSkill(skillId);
    setViewingFiles({
      id: skillId,
      files: [
        { path: 'SKILL.md', contents: reconstructSkillMd(detail.manifestYaml, detail.bodyMd) },
        ...detail.files,
      ],
    });
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}
```

- Add a "View files" button to the row actions (before Edit), with an `aria-label`:

```tsx
<Button
  variant="ghost"
  size="sm"
  onClick={() => void handleViewFiles(s.id)}
  aria-label={`View files for ${s.id}`}
>
  <FileCode className="h-3.5 w-3.5" />
</Button>
```

- Add the dialog near the other dialogs:

```tsx
{viewingFiles !== null && (
  <Dialog open onOpenChange={(o) => { if (!o) setViewingFiles(null); }}>
    <DialogContent className="max-w-4xl">
      <DialogHeader>
        <DialogTitle>Bundle files: {viewingFiles.id}</DialogTitle>
      </DialogHeader>
      <BundleFileView files={viewingFiles.files} />
    </DialogContent>
  </Dialog>
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/CatalogTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/CatalogTab.tsx packages/channel-web/src/components/admin/__tests__/CatalogTab.test.tsx
git commit -m "feat(channel-web): Catalog tab read-only bundle file-view"
```

---

### Task 13: `CatalogTab` — inline org-default toggle

**Files:**
- Modify: `packages/channel-web/src/components/admin/CatalogTab.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/CatalogTab.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
import { setSkillDefaultAttached } from '@/lib/skills';
// add setSkillDefaultAttached: vi.fn() to the vi.mock factory
const mockSetDefault = vi.mocked(setSkillDefaultAttached);

it('marks a skill as an org default via the inline toggle', async () => {
  // SKILL_B has no credentials → eligible to be a default.
  mockListSkills.mockResolvedValue([{ ...SKILL_B, tier: 'inert', defaultAttached: false }]);
  mockSetDefault.mockResolvedValue(undefined);
  render(<CatalogTab />);
  const toggle = await screen.findByRole('checkbox', { name: /default for slack-notify/i });
  fireEvent.click(toggle);
  await waitFor(() => expect(mockSetDefault).toHaveBeenCalledWith('slack-notify', true));
});

it('disables the default toggle for a credential-bearing skill', async () => {
  // SKILL_A declares GITHUB_TOKEN → cannot be a default.
  mockListSkills.mockResolvedValue([{ ...SKILL_A, tier: 'bounded' }]);
  render(<CatalogTab />);
  const toggle = await screen.findByRole('checkbox', { name: /default for github-api/i });
  expect((toggle as HTMLButtonElement).getAttribute('data-disabled') !== null || (toggle as HTMLInputElement).disabled).toBeTruthy();
});
```

(The shadcn `Checkbox` is a radix button with `role="checkbox"`; when disabled it carries `data-disabled` / `aria-disabled`. Assert whichever your installed checkbox exposes — verify by reading `components/ui/checkbox.tsx`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/CatalogTab.test.tsx`
Expected: FAIL — no default toggle.

- [ ] **Step 3: Add the Default column toggle**

In `CatalogTab.tsx`:

- Import:

```tsx
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { setSkillDefaultAttached } from '@/lib/skills';
```

- Add a handler that flips the flag and refreshes (surfacing the server's `default-attached-requires-no-credentials` if it slips through):

```tsx
async function handleToggleDefault(skillId: string, next: boolean) {
  try {
    await setSkillDefaultAttached(skillId, next);
    await refresh();
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}
```

- Add a `Default` header (after `Tier`) and a cell. Disable the toggle when the skill declares credentials (mirrors the SkillEditor's `canBeDefault`), with a tooltip explaining why:

```tsx
<TableCell>
  {s.capabilities.credentials.length > 0 ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Checkbox
            checked={s.defaultAttached}
            disabled
            aria-label={`Default for ${s.id}`}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>Capability-bearing skills must be attached per agent.</TooltipContent>
    </Tooltip>
  ) : (
    <Checkbox
      checked={s.defaultAttached}
      onCheckedChange={(v) => void handleToggleDefault(s.id, v === true)}
      aria-label={`Default for ${s.id}`}
    />
  )}
</TableCell>
```

(Remove the now-redundant `default` Badge next to the id if you prefer a single source of truth in the UI; the toggle is the canonical control. Keeping the badge is fine too — the test keys off the checkbox.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/CatalogTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/CatalogTab.tsx packages/channel-web/src/components/admin/__tests__/CatalogTab.test.tsx
git commit -m "feat(channel-web): Catalog tab inline org-default toggle"
```

---

### Task 14: `AdmitQueueTab` — pending-request inbox

**Files:**
- Modify: `packages/channel-web/src/components/admin/AdmitQueueTab.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/AdmitQueueTab.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AdmitQueueTab } from '../AdmitQueueTab';
import type { CatalogRequest } from '@ax/skills';

vi.mock('@/lib/catalog', () => ({
  listCatalogRequests: vi.fn(),
  decideCatalogRequest: vi.fn(),
}));
import { listCatalogRequests } from '@/lib/catalog';
const mockList = vi.mocked(listCatalogRequests);

const SHARE_REQ: CatalogRequest = {
  requestId: 'r1', kind: 'share', skillId: 'linear', requestedByUserId: 'u-author',
  sourceOwnerUserId: 'u-author', status: 'pending', description: 'Linear issues.',
  createdAt: '2026-05-26T00:00:00.000Z',
  manifestYaml: 'name: linear\ndescription: Linear.\nversion: 1\n', bodyMd: '# linear\n', files: [],
};

describe('AdmitQueueTab', () => {
  beforeEach(() => vi.resetAllMocks());

  it('lists pending requests with their kind and skill id', async () => {
    mockList.mockResolvedValue([SHARE_REQ]);
    render(<AdmitQueueTab />);
    expect(await screen.findByText('linear')).toBeTruthy();
    expect(screen.getByText(/share/i)).toBeTruthy();
    expect(screen.getByText('Linear issues.')).toBeTruthy();
  });

  it('shows an empty state when there are no requests', async () => {
    mockList.mockResolvedValue([]);
    render(<AdmitQueueTab />);
    await waitFor(() => expect(screen.getByText(/no pending/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/AdmitQueueTab.test.tsx`
Expected: FAIL — the placeholder renders only "Loading…".

- [ ] **Step 3: Implement the inbox**

Replace the placeholder `AdmitQueueTab.tsx` (the `BundleReviewDialog` it opens lands in Task 15; here, wire a `Review` button that sets `reviewing` state — Task 15 fills the dialog):

```tsx
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { listCatalogRequests } from '@/lib/catalog';
import type { CatalogRequest } from '@ax/skills';

export function AdmitQueueTab() {
  const [requests, setRequests] = useState<CatalogRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      setRequests(await listCatalogRequests());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRequests([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admit queue</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {requests === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending requests. Cold-start and share-to-catalog submissions land here.
          </p>
        ) : (
          requests.map((r) => (
            <div
              key={r.requestId}
              className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
            >
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant={r.kind === 'share' ? 'secondary' : 'outline'} className="text-[10px]">
                    {r.kind}
                  </Badge>
                  <span className="font-mono text-xs">{r.skillId}</span>
                </div>
                <p className="text-sm">{r.description}</p>
                <p className="text-xs text-muted-foreground">
                  requested by {r.requestedByUserId} · {new Date(r.createdAt).toLocaleString()}
                </p>
              </div>
              <Button variant="outline" size="sm" aria-label={`Review ${r.skillId}`} disabled>
                Review
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
```

(The `Review` button is `disabled` for now; Task 15 wires it to open `BundleReviewDialog` and removes `disabled`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/AdmitQueueTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/admin/AdmitQueueTab.tsx packages/channel-web/src/components/admin/__tests__/AdmitQueueTab.test.tsx
git commit -m "feat(channel-web): Admit queue inbox lists pending requests"
```

---

### Task 15: `BundleReviewDialog` — file/diff review + Admit/Reject

**Files:**
- Create: `packages/channel-web/src/components/admin/BundleDiffView.tsx`
- Create: `packages/channel-web/src/components/admin/BundleReviewDialog.tsx`
- Modify: `packages/channel-web/src/components/admin/AdmitQueueTab.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/BundleReviewDialog.test.tsx`, `AdmitQueueTab.test.tsx`

- [ ] **Step 1: Write the failing test (diff view + dialog)**

Create `BundleReviewDialog.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BundleReviewDialog } from '../BundleReviewDialog';
import type { CatalogRequest } from '@ax/skills';

vi.mock('@/lib/catalog', () => ({ decideCatalogRequest: vi.fn() }));
vi.mock('@/lib/skills', () => ({ getSkillOrNull: vi.fn() }));
import { decideCatalogRequest } from '@/lib/catalog';
import { getSkillOrNull } from '@/lib/skills';
const mockDecide = vi.mocked(decideCatalogRequest);
const mockGetOrNull = vi.mocked(getSkillOrNull);

const SHARE_REQ: CatalogRequest = {
  requestId: 'r1', kind: 'share', skillId: 'linear', requestedByUserId: 'u1',
  sourceOwnerUserId: 'u1', status: 'pending', description: 'Linear.',
  createdAt: '2026-05-26T00:00:00.000Z',
  manifestYaml: 'name: linear\ndescription: Linear.\nversion: 1\n',
  bodyMd: '# linear v2\n', files: [{ path: 'scripts/q.py', contents: 'print(2)' }],
};

const COLD_REQ: CatalogRequest = {
  requestId: 'r2', kind: 'cold-start', skillId: 'jira', requestedByUserId: 'u2',
  sourceOwnerUserId: null, status: 'pending', description: 'I needed Jira.',
  createdAt: '2026-05-26T00:00:00.000Z', manifestYaml: null, bodyMd: null, files: [],
};

describe('BundleReviewDialog', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shows a new-skill share bundle (no existing catalog version)', async () => {
    mockGetOrNull.mockResolvedValue(null);
    render(<BundleReviewDialog request={SHARE_REQ} onClose={vi.fn()} onDecided={vi.fn()} />);
    expect(await screen.findByText('scripts/q.py')).toBeTruthy();
    // a brand-new file is marked "added"
    expect(screen.getAllByText(/added/i).length).toBeGreaterThan(0);
  });

  it('admits a share request', async () => {
    mockGetOrNull.mockResolvedValue(null);
    mockDecide.mockResolvedValue({ admitted: true, skillId: 'linear' });
    const onDecided = vi.fn();
    render(<BundleReviewDialog request={SHARE_REQ} onClose={vi.fn()} onDecided={onDecided} />);
    fireEvent.click(await screen.findByRole('button', { name: /^admit$/i }));
    await waitFor(() => expect(mockDecide).toHaveBeenCalledWith('r1', 'admit'));
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
  });

  it('disables Admit for a cold-start request (nothing to promote)', async () => {
    render(<BundleReviewDialog request={COLD_REQ} onClose={vi.fn()} onDecided={vi.fn()} />);
    const admit = await screen.findByRole('button', { name: /^admit$/i });
    expect((admit as HTMLButtonElement).disabled).toBe(true);
    // reject is available
    expect((screen.getByRole('button', { name: /^reject$/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/BundleReviewDialog.test.tsx`
Expected: FAIL — cannot find module `../BundleReviewDialog`.

- [ ] **Step 3: Implement `BundleDiffView`**

Create `packages/channel-web/src/components/admin/BundleDiffView.tsx` (renders per-file status + a line diff for modified files; colors use semantic tokens — `primary-soft`/`destructive-soft`):

```tsx
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { diffLines, type BundleFileEntry } from '@/lib/bundle-diff';

const STATUS_VARIANT: Record<BundleFileEntry['status'], 'secondary' | 'outline' | 'destructive'> = {
  added: 'secondary',
  modified: 'secondary',
  unchanged: 'outline',
  removed: 'destructive',
};

function FileBody({ entry }: { entry: BundleFileEntry }) {
  if (entry.status === 'unchanged') {
    return <p className="text-xs text-muted-foreground px-3 py-2">Unchanged.</p>;
  }
  // added → all-add diff; removed → all-remove diff; modified → real diff.
  const lines = diffLines(entry.before ?? '', entry.after ?? '');
  return (
    <pre className="font-mono text-xs leading-relaxed overflow-auto max-h-[320px] m-0 p-0">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            'px-3 whitespace-pre-wrap break-words',
            l.type === 'add' && 'bg-primary-soft text-primary',
            l.type === 'remove' && 'bg-destructive-soft text-destructive',
            l.type === 'context' && 'text-muted-foreground',
          )}
        >
          {l.type === 'add' ? '+ ' : l.type === 'remove' ? '- ' : '  '}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

export function BundleDiffView({ entries }: { entries: BundleFileEntry[] }) {
  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry) => (
        <div key={entry.path} className="rounded-md border border-border overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-muted/40 border-b border-border">
            <span className="font-mono text-xs truncate">{entry.path}</span>
            <Badge variant={STATUS_VARIANT[entry.status]} className="text-[10px] capitalize">
              {entry.status}
            </Badge>
          </div>
          <FileBody entry={entry} />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement `BundleReviewDialog`**

Create `packages/channel-web/src/components/admin/BundleReviewDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { getSkillOrNull } from '@/lib/skills';
import { decideCatalogRequest } from '@/lib/catalog';
import { compareBundles, reconstructSkillMd, type BundleFileEntry } from '@/lib/bundle-diff';
import { BundleDiffView } from './BundleDiffView';
import type { CatalogRequest } from '@ax/skills';

export interface BundleReviewDialogProps {
  request: CatalogRequest;
  onClose: () => void;
  onDecided: () => void;
}

/** Build a path→contents map from a request's snapshot (SKILL.md first). */
function submittedFiles(req: CatalogRequest): Record<string, string> {
  const map: Record<string, string> = {};
  if (req.manifestYaml !== null && req.bodyMd !== null) {
    map['SKILL.md'] = reconstructSkillMd(req.manifestYaml, req.bodyMd);
  }
  for (const f of req.files) map[f.path] = f.contents;
  return map;
}

export function BundleReviewDialog({ request, onClose, onDecided }: BundleReviewDialogProps) {
  const isShare = request.kind === 'share' && request.manifestYaml !== null;
  const [entries, setEntries] = useState<BundleFileEntry[] | null>(isShare ? null : []);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    if (!isShare) return;
    let cancelled = false;
    void (async () => {
      try {
        // Diff the submitted bundle against the current catalog version (if any).
        const current = await getSkillOrNull(request.skillId);
        if (cancelled) return;
        const before: Record<string, string> = {};
        if (current !== null) {
          before['SKILL.md'] = reconstructSkillMd(current.manifestYaml, current.bodyMd);
          for (const f of current.files) before[f.path] = f.contents;
        }
        setEntries(compareBundles(before, submittedFiles(request)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request, isShare]);

  async function decide(decision: 'admit' | 'reject') {
    setDeciding(true);
    setError(null);
    try {
      await decideCatalogRequest(request.requestId, decision);
      onDecided();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            Review {request.kind} request: {request.skillId}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{request.description}</p>

          {!isShare ? (
            <Alert>
              <AlertDescription>
                Cold-start request — there is no bundle to promote. Author the skill in the Catalog
                tab, then reject this request to clear it.
              </AlertDescription>
            </Alert>
          ) : entries === null ? (
            <p className="text-sm text-muted-foreground">Loading bundle…</p>
          ) : (
            <BundleDiffView entries={entries} />
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={deciding}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void decide('reject')} disabled={deciding}>
              Reject
            </Button>
            <Button onClick={() => void decide('admit')} disabled={deciding || !isShare}>
              Admit
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Wire the dialog into `AdmitQueueTab`**

In `AdmitQueueTab.tsx`: import `BundleReviewDialog`, add `const [reviewing, setReviewing] = useState<CatalogRequest | null>(null);`, change the `Review` button to `onClick={() => setReviewing(r)}` and drop its `disabled`, and render at the end of the card:

```tsx
{reviewing !== null && (
  <BundleReviewDialog
    request={reviewing}
    onClose={() => setReviewing(null)}
    onDecided={() => {
      setReviewing(null);
      void refresh();
    }}
  />
)}
```

Add a test to `AdmitQueueTab.test.tsx` that clicking `Review` opens the dialog:

```typescript
it('opens the review dialog for a request', async () => {
  mockList.mockResolvedValue([SHARE_REQ]);
  // getSkillOrNull is called by the dialog; mock @/lib/skills in this file too.
  render(<AdmitQueueTab />);
  fireEvent.click(await screen.findByRole('button', { name: /review linear/i }));
  expect(await screen.findByText(/review share request: linear/i)).toBeTruthy();
});
```

(Add `vi.mock('@/lib/skills', () => ({ getSkillOrNull: vi.fn().mockResolvedValue(null) }))` and `vi.mock('@/lib/catalog', ...)` with both functions to this test file.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm -F @ax/channel-web test -- src/components/admin/__tests__/BundleReviewDialog.test.tsx src/components/admin/__tests__/AdmitQueueTab.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/channel-web/src/components/admin/BundleDiffView.tsx packages/channel-web/src/components/admin/BundleReviewDialog.tsx packages/channel-web/src/components/admin/AdmitQueueTab.tsx packages/channel-web/src/components/admin/__tests__/BundleReviewDialog.test.tsx packages/channel-web/src/components/admin/__tests__/AdmitQueueTab.test.tsx
git commit -m "feat(channel-web): Admit queue bundle file/diff review + Admit/Reject"
```

---

### Task 16: Full verification + security-checklist gate + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. `pnpm build` (tsc) is the gate that catches the new `@ax/skills` type exports and the `channel-web` type-only imports across the package boundary; vitest alone would miss an undeclared export. Lint confirms no new runtime cross-plugin import slipped in (only `import type` from `@ax/skills`).

- [ ] **Step 2: Run the `security-checklist` skill**

Invoke `security-checklist` and answer all three threat models. Pre-stated model (confirm or refine):

- **Prompt-injection / untrusted-content (the primary threat here).** A share-to-catalog submission's `path`s, reconstructed `SKILL.md` body, and extra-file `contents` are attacker-influenceable and render in a **privileged admin** surface (Catalog file-view + Admit review). Mitigation: every render path is escaped text in `<pre>`/text nodes — no `dangerouslySetInnerHTML`, no untrusted-markdown→HTML (BundleFileView Task 9, BundleDiffView Task 15). The `BundleFileView` test asserts an `<img onerror>` payload renders as literal text and creates no element. Confirm there is no remaining HTML-rendering path for request/skill content.
- **Privilege / sandbox-escape-adjacent (authorization).** All new routes are `requireAdmin`-gated server-side (UI hiding is convenience only). The admit `decidedByUserId` is taken from the authenticated actor, **never** the request body — the `catalog-routes.test.ts` "ignores any client-supplied decider" case is the regression guard. Admitting promotes attacker-submitted bytes org-wide, but that is the human code-review gate doing its job (decision #16); the review UI presents the bytes faithfully and bounded (caps enforced at submit).
- **Supply chain.** No new dependencies — the diff util is hand-written; `classifyTier` is reused in-package; all UI composes already-installed shadcn primitives. Confirm `git diff` shows no `package.json` dependency additions.

Paste the structured note into the PR.

- [ ] **Step 3: Manual acceptance note (k8s, deferred)**

The end-to-end browser walk (admin opens Catalog → views a bundle's files; a seeded share request appears in Admit queue → review diff → Admit → skill appears in the global catalog) runs via `k8s-acceptance-loop` and is gated on a real `catalog:submit` feeder existing (the half-wired upstream). Note in the PR that the automated coverage here is the route tests + component tests; the live browser walk lands with the submit-feeder TASK. Do **not** block this PR on it.

- [ ] **Step 4: Open the PR**

PR description must include:
- **Boundary review:** no hook-surface change — new `/admin/skills` (tier, PATCH) and `/admin/catalog/*` routes call existing hooks; request-body schemas live in the `@ax/skills` route modules. Invariants I1/I2/I4/I5 addressed (see Scope guardrails).
- **Half-wired window OPEN:** the Admit queue's upstream `catalog:submit` feeders (broker cold-start auto-file; in-chat share action) ship in a later TASK; the queue UI here is fully wired to the live read/admit hooks and is correctly empty until then. No half-wired code in this PR.
- **Bug fix:** PUT `/admin/skills/:id` no longer drops a bundle's extra files on a SKILL.md-only edit (Task 3, with regression test).
- The `security-checklist` structured note (Step 2).

---

## Self-Review

**Spec coverage** (against the card: P5, P7.4, decision #16, §9.2):

- "Reframe Skills tab as **Catalog**" → Task 10 (rename + nav rewire). ✓
- "browse + **version** skills" → existing list + version column preserved through the rename (Task 10); `SkillEditor` create/update unchanged. ✓
- "read-only **bundle file-view** (§9.2 tree)" → Task 9 (`BundleFileView`) + Task 12 (Catalog "View files"). ✓
- "**admit-from-source**" → existing "New skill" (create from SKILL.md) + per-skill refresh-from-source, preserved through the rename. ✓
- "mark **org defaults**" → Task 13 (inline toggle, bundle-preserving via Task 2's PATCH; disabled + explained for credential-bearing skills). ✓
- "show each skill's **tier**" → Task 1 (server derives) + Task 11 (badge). ✓
- "**Admit queue** (Needs-Input shape): cold-start + share submissions" → Task 5 (routes) + Task 14 (inbox). ✓
- "reviewed via a **bundle file/diff view** (admit = code review)" → Task 8 (diff util) + Task 15 (`BundleDiffView` + `BundleReviewDialog`, diff vs current catalog version; cold-start = no bundle, Admit disabled). ✓
- "Admit (promote + retire working copy) / Reject; dedup on id" → handled by the existing `catalog:admit` hook (TASK-41); the UI calls it (Task 15). ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. The Task 10/14 placeholders (`AdmitQueueTab` stub, disabled Review button) are explicitly temporary scaffolding that later tasks replace within this same plan — not unfinished work shipped to `main`. ✓

**Type consistency:** the catalog summary is `CatalogSkillSummary = SkillSummary & { tier?: SkillTier }` (client) backed by the server route mapping `classifyTier`. `CatalogRequest`/`CatalogAdmitOutput` are imported as types from `@ax/skills` (index export added in Task 1). The file map is `Record<string, string>` (path→contents) in `compareBundles`/`BundleReviewDialog`; `BundleFileEntry` is the shared diff shape between `compareBundles`, `BundleDiffView`, and the dialog. `reconstructSkillMd` is the single SKILL.md reconstruction used by Catalog file-view and the admit diff. The admit route's `decidedByUserId` is always `actor.id`.

**Known residuals (acceptable):**
- `catalog:list-requests` serves only the **pending** set today (the plugin notes decided-status filtering as a "TASK-45 refinement"). The Admit queue is the *actionable inbox* (pending) — decided-request history is out of scope here (YAGNI); the hook's `status` input already exists so adding history later needs no contract change.
- The `SkillEditor` still cannot **add/edit** a bundle's extra files (it edits SKILL.md text only). Task 3 ensures edits **preserve** existing files; an editor that authors multi-file bundles is a separate, later concern and is not required by this card (bundled skills arrive via share-to-catalog admit, not the editor).
