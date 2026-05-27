# TASK-57 — store-level atomic partial-update for the default-attached toggle

## Problem

`setDefaultAttached` (PATCH `/admin/skills/:id`, `packages/skills/src/admin-routes.ts`)
flips a skill's org-default flag by reading the FULL detail (`skills:get`) and then
re-writing the entire manifest/body/defaultAttached (`skills:upsert`). A concurrent
SKILL.md edit that lands between the read and the write is silently clobbered — a
documented race (admin-routes.ts comment "KNOWN LIMITATION … same class as plugin.ts's
credential-purge race"). The bundle extra-files are already race-safe (the route omits
`files`), but manifest + body are not.

## Fix

Add a store-level **atomic** partial-update primitive that flips `default_attached`
in a single transaction without touching manifest/body/bundle, and route the PATCH
handler through it.

## Tasks (independent, testable)

### Task 1 — `store.setDefaultAttached` (the atomic primitive) + store test
- File: `packages/skills/src/store.ts`.
- Add `setDefaultAttached(skillId: string, defaultAttached: boolean): Promise<{ found: boolean; defaultAttached: boolean }>` to the `SkillsStore` interface and impl.
- Impl: `db.transaction().execute(async (tx) => { … })`:
  1. `SELECT manifest_yaml FROM skills_v1_skills WHERE skill_id = ? FOR UPDATE` (`.forUpdate()`); if `undefined` → return `{ found: false, defaultAttached }`.
  2. If `defaultAttached === true`: re-parse the locked row's `manifest_yaml` via the shared `parseCapabilities` (from `_row-mappers.js`) and if `capabilities.credentials.length > 0`, throw a plain `Error('default-attached-requires-no-credentials: …')` — the plugin layer re-wraps as a `PluginError` with that code (keep the route's 400 behavior). Use the same code string the plugin already uses.
  3. `UPDATE skills_v1_skills SET default_attached = ?, updated_at = NOW() WHERE skill_id = ?` — flag + timestamp ONLY. Never manifest/body/bundle.
  4. Return `{ found: true, defaultAttached }`.
- Mirror `packages/onboarding/src/store.ts` `resetToPending` for the transaction + `.forUpdate()` shape.
- Tests (in `packages/skills/src/__tests__/store.test.ts`, testcontainer already present):
  - flips false→true, reads back via `get`, leaves manifest/body untouched.
  - flips true→false.
  - `found:false` for an unknown id (no row created).
  - flipping to `true` on a credentialed manifest throws (the I-S2 guard) and does NOT mutate the row.
  - **race regression**: seed, then run `setDefaultAttached(id,true)` and verify a manifest/body present before the call is still present after (the value the OLD get+upsert path would clobber). The strongest assertion: the primitive only writes the flag — assert manifest_yaml/body_md/bundle_tree_sha are byte-identical before vs after.

### Task 2 — wire the PATCH route to the atomic primitive (no hook-surface change)
- File: `packages/skills/src/admin-routes.ts`.
- `AdminRouteDeps` gains optional `store?: SkillsStore` (import the type from `./store.js`).
- `setDefaultAttached` handler: when `deps.store` is present, call `deps.store.setDefaultAttached(id, flag)`:
  - `found:false` → 404 (`skill-not-found`-shaped error / matching the existing 404).
  - credential rejection → 400 with code `default-attached-requires-no-credentials` (re-wrap the thrown Error → PluginError so `writeServiceError` maps it to 400; verify the existing `writeServiceError` mapping covers that code, else map explicitly).
  - success → 200 `{ skillId, defaultAttached }`.
  - When `deps.store` is absent → keep the existing `skills:get` + `skills:upsert` fallback verbatim (compatibility for the bus-only handler construction the tests use).
- `registerAdminSkillsRoutes(bus, initCtx, store?)` forwards the store to `createAdminSkillsHandlers`.
- Update the route doc-comment: replace the "KNOWN LIMITATION … no flag-only setter … tracked as a follow-up" paragraph with the atomic-path description (the store now provides the flag-only setter).

### Task 3 — inject the store in production wiring
- File: `packages/skills/src/plugin.ts`.
- The `init()` already builds `const store = createSkillsStore(db, bundleStore)`. Pass it to `registerAdminSkillsRoutes(bus, initCtx, store)`.

### Task 4 — route-level tests for the atomic path
- File: `packages/skills/src/__tests__/admin-routes.test.ts`.
- Add a helper to build a real `store` from the harness db (`database:get-instance` over the bus → `createSkillsStore(db)`), pass `{ bus, store }` to `createAdminSkillsHandlers`.
- Tests:
  - PATCH via the store path flips the flag (200) and preserves bundle files (port the existing `'PATCH flips defaultAttached and preserves the bundle extra files'` to the store-backed handler).
  - PATCH via the store path on a credentialed skill → 400 `default-attached-requires-no-credentials`.
  - PATCH via the store path on an unknown id → 404.
  - **race regression**: seed a skill, then simulate a concurrent SKILL.md edit by writing a NEW body/manifest via `skills:upsert` AFTER capturing detail but the atomic PATCH must NOT clobber it — the cleanest deterministic assertion: call the store-backed PATCH, then a separate `skills:upsert` body edit, then PATCH again, and assert the body edit survived (no stale read). Simpler/deterministic: assert that the store-backed PATCH never reads-then-writes manifest/body — covered structurally by Task 1's byte-identity test; at the route level just assert the toggle works + bundle preserved.
  - Keep one test that exercises the bus-only fallback (`{ bus: h.bus }`, no store) so that branch stays live + tested.

## Invariants check
- I1 transport/storage-agnostic hooks: no hook payload changes; the store primitive is internal. ✓
- I2 no cross-plugin imports: all edits inside `@ax/skills`. ✓
- I3 no half-wired: the primitive is wired into the PATCH route in the same PR; both store-path and fallback are tested. ✓
- I4 one source of truth: credential constraint logic re-uses the same `parseCapabilities` + same error code the plugin already uses. ✓
- I5 capabilities minimized: no new fs/net/spawn; pure SQL UPDATE on an owned table. ✓
- No hook-surface change: no `registers[]`/`calls[]`/payload-schema edits → boundary review not required.

## Out of scope / follow-ups
- The `skills:upsert` global-path credential-purge `previous` read-outside-txn race (plugin.ts comment) is a SEPARATE documented race; not this card. Leave its comment as-is. (Return as a follow-up.)
- User-scope default toggle: no route exists; no primitive added (YAGNI).
