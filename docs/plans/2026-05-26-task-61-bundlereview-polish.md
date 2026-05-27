# TASK-61 — BundleReviewDialog polish: expected-404 + aria-describedby

UI polish on TASK-45's Admit-queue surface, surfaced by the TASK-50 walk. Two
minor defects in `BundleReviewDialog`:

1. **Expected 404 logs a console error.** When an admin reviews a *share* request
   whose `skillId` is **net-new** (no current catalog version), the diff probe
   `getSkillOrNull(skillId)` fires `GET /admin/skills/<id>`. The server correctly
   returns 404 (skill-not-found). The dialog handles it (`null` → render
   all-added), but the **browser auto-logs** the failed request as a red console
   error. The 404 is fully expected here, so it's noise.

2. **Missing `aria-describedby`.** `<DialogContent>` has no description association,
   so Radix logs a dev a11y warning (`Missing Description or aria-describedby for
   {DialogContent}`).

## Why the 404 fix is server-side

The browser logs **every** 4xx/5xx network response to the console regardless of
how `fetch` handles the resolved `Response`. JS cannot intercept or silence a 404
that has already happened. The only way to remove the console error is to **not
provoke an expected 404**. The diff only needs "is there a current catalog
version?" — so we turn that probe into a clean `200`:

- Add an **opt-in** `?missingOk=1` query param to `GET /admin/skills/:id`. With it
  set, a missing skill returns `200 { skill: null }` instead of `404`. Without it,
  behavior is unchanged (genuine `404`), so the strict `getSkill()` caller and
  REST semantics are untouched.
- `getSkillOrNull()` requests `?missingOk=1` and reads `body.skill` (which is the
  `SkillDetail` or `null`).

This is an internal route-behavior addition in the **same plugin** (`@ax/skills`).
No hook-surface change (`skills:get` is unchanged); no boundary review needed.

## Tasks (independent, testable)

### Task 1 — Server: `?missingOk=1` on `GET /admin/skills/:id`
**Files:** `packages/skills/src/admin-routes.ts`, `packages/skills/src/__tests__/admin-routes.test.ts`
- In the `get` handler: if `req.query.missingok === '1'` (http-server lowercases
  query keys), catch a `skill-not-found` `PluginError` and respond
  `200 { skill: null }`; otherwise the existing `writeServiceError` path
  (genuine 404) stands. On a found skill with the param, respond
  `200 { skill: detail }` (wrapped) so the shape is unambiguous.
- TDD: test that `GET ...?missingOk=1` on a missing id → `200 { skill: null }`;
  and that `?missingOk=1` on an existing id → `200 { skill: <detail> }`; and the
  existing "missing id → 404" test (no param) still passes. Extend `mkReq` to
  accept an optional `query`.

### Task 2 — Client: `getSkillOrNull` uses `?missingOk=1`
**Files:** `packages/channel-web/src/lib/skills.ts`, `packages/channel-web/src/lib/__tests__/skills.test.ts` (or new)
- `getSkillOrNull` requests `/admin/skills/<id>?missingOk=1`, expects `200`, and
  returns `body.skill` (`SkillDetail | null`). No 404 path needed anymore.
- TDD: mock `fetch` → `200 { skill: null }` returns `null`; `200 { skill: detail }`
  returns the detail; a real error status (500) still throws.

### Task 3 — Client: `DialogDescription` for aria-describedby
**Files:** `packages/channel-web/src/components/admin/BundleReviewDialog.tsx`,
`packages/channel-web/src/components/admin/__tests__/BundleReviewDialog.test.tsx`
- Import `DialogDescription` from `@/components/ui/dialog`; render
  `request.description` inside it within `<DialogHeader>` (replacing the bare
  `<p className="text-sm text-muted-foreground">`). Radix auto-wires
  `aria-describedby` on the content from the description's generated id.
- TDD: assert the dialog (`role="dialog"`) has a non-empty `aria-describedby`
  attribute pointing at an element containing the description text.

## Out of scope / follow-ups
- The `getSkillOrNull` 404 path elsewhere: only `BundleReviewDialog` uses it
  (verified single caller), so no other call site changes.
- No new dependency, no sandbox/IPC/plugin-loading surface → no security-checklist.

## Verification gate
- `pnpm build` (tsc project refs — the real cross-package type gate)
- `pnpm -F @ax/skills test` (Docker available this run → Postgres testcontainer ok)
- `pnpm -F @ax/channel-web test`
- `pnpm lint`
