# TASK-59 — SkillEditor multi-file bundle authoring

## Problem

`@ax/channel-web`'s `SkillEditor` (admin + user-scoped via injected `SkillEditorApi`)
can only author/edit the SKILL.md text of a skill. A bundle's extra files
(`SkillDetail.files: BundleFile[]`) cannot be created/edited in the UI.

The server-side `skills:upsert` hook **already** accepts and validates an optional
`files: BundleFile[]` (omit = leave the current bundle unchanged; present even if `[]`
= replace; `validateBundleFiles` is the host-side gate, re-validated at the wire
schema and both runner extract boundaries — defense-in-depth, invariant I2). The gap
is purely the HTTP path + UI:

1. `upsertBodySchema` (`.strict()`) only accepts `skillMd` + `defaultAttached`, so a
   `files` key in the body is rejected before it reaches the hook.
2. The POST/PUT admin + settings route handlers don't forward `files`.
3. The two wire clients (`lib/skills.ts`, `lib/user-skills.ts`) + the `SkillEditorApi`
   contract don't carry `files`.
4. `SkillEditor.tsx` has no UI to view/add/edit/remove bundle files.

This is **additive** and touches **no hook surface** (the `skills:upsert` input already
has `files?`). No boundary review needed; no sandbox/IPC/plugin-load change. The one
untrusted-content consideration: file contents are user-typed bytes rendered into a
`<Textarea>` (text node) — never `dangerouslySetInnerHTML` (the TASK-45 rule).

## Design decisions (logged in decisions.md)

- **Omit-vs-send preserved.** The wire-client `files` param is optional. When
  `undefined`, the body omits `files` (server preserves — unchanged behavior for the
  PATCH/refresh paths and any SKILL.md-only caller). When an array (even `[]`), it's
  sent and the server replaces the bundle. `upsertBodySchema` gains
  `files: z.array(...).optional()`.
- **Editor owns the full set.** `SkillEditor` loads `detail.files` into component
  state on edit (and `[]` on create). On save it **always sends the current `files`
  array** (the WYSIWYG model) — so an unrelated SKILL.md edit round-trips the loaded
  files rather than wiping them, and the displayed set IS the authoritative saved set.
  This is safe: the editor is showing exactly what it will save (no stale background
  read; the user sees and controls the set).
- **Validation = server is source of truth.** `validateBundleFiles` stays the canonical
  rule-set (host gate + wire + runner). `upsertBodySchema` adds only a lightweight
  shape/bound guard (array of `{path:string, contents:string}`, capped count/length) so
  a malformed body 400s early; the editor surfaces inline client-side hints (empty
  path, duplicate path) for UX but does not duplicate the full rule-set.

## Tasks (independent, testable)

### Task 1 — server: `upsertBodySchema` accepts optional `files`; routes forward it
- `_routes-shared.ts`: add `files` to `upsertBodySchema` —
  `z.array(z.object({ path: z.string().min(1).max(256), contents: z.string() })).max(16).optional()`.
  (Bounds mirror `validateBundleFiles` caps so a grossly-malformed body 400s at the
  schema; the canonical path/byte/veto rules stay in `validateBundleFiles`.)
- `admin-routes.ts` create + update handlers: forward `...(zodResult.data.files !== undefined ? { files: zodResult.data.files } : {})` into the `skills:upsert` call. Keep the omit-when-absent semantics.
- `settings-routes.ts` create + update handlers: same forward (scope stays user-forced).
- Tests: `admin-routes.test.ts` / `settings-routes.test.ts` — a PUT/POST with `files`
  forwards them to the hook; a PUT/POST without `files` omits the key (preserve); an
  invalid `files` shape 400s; an `invalid-bundle-file` from the hook surfaces as 400.

### Task 2 — wire clients: `upsertSkill`/`updateSkill` (+ user twins) send `files`
- `lib/skills.ts`: add `files?: BundleFile[]` to the `opts` of `upsertSkill` +
  `updateSkill`; include `files` in the JSON body only when defined.
- `lib/user-skills.ts`: same for `createUserSkill` + `updateUserSkill`.
- Tests: extend the existing wire-client tests (or add) asserting the body carries
  `files` when passed and omits it when not.

### Task 3 — `SkillEditorApi` contract + UI in `SkillEditor.tsx`
- Extend `SkillEditorApi.upsertSkill`/`updateSkill` opts with `files?: BundleFile[]`.
- Editor state: `files: BundleFile[]`. Load from `detail.files` on edit, `[]` on create.
- "Bundle files" section (below the SKILL.md grid, above the default-attached row):
  - Header: a `Label` + "Add file" `Button` (mirrors McpServerForm's add-row pattern).
  - Per file: a path `Input` (mono) + remove ghost `Button` (`Trash2`), and a contents
    `Textarea` (mono). Compose installed shadcn primitives + semantic tokens only.
  - Empty state: muted helper text.
  - Inline client hints (non-blocking save unless empty/dup path): show a small
    destructive note for an empty path or a duplicate path; disable Save when any path
    is empty or duplicated (server still re-validates).
- `handleSave` passes `{ defaultAttached, files }` to the api (always sends the array).
- Tests: extend `SkillEditor.test.tsx` — loads existing files into the editor; add a
  file + save forwards `files`; remove a file; SKILL.md-only edit still round-trips the
  loaded files; empty/duplicate path disables Save.

### Task 4 — whole-branch verification + memory
- `pnpm -F @ax/skills build && pnpm -F @ax/channel-web build`, the two package test
  suites, root `pnpm build`, lint.
- Update `.claude/memory/decisions.md` with the decisions above.

## YAGNI pass
- No drag-reorder, no file-tree view, no per-file rename-with-history. A flat
  add/edit/remove list is the MVP the card asks for. (Cut.)
- No diff view in the editor — that's the admit/review surface (BundleDiffView,
  TASK-45), not the authoring surface. (Cut.)
