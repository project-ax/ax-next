# TASK-133 — Skill editor form-first (synced raw-markdown toggle)

Epic: settings-unified. Design card 10. Depends on TASK-126 (#282, merged — Skills app-store).
Design doc: `docs/plans/2026-06-01-settings-unified-skills-connectors-credentials-design.md` §"Skills tab" + open-question line 153.

## Problem

Today, "Create"/"Install"/"Edit" in the Skills app-store opens `SkillEditor.tsx`, whose
default surface is the **raw `SKILL.md` textarea** + a parsed-preview pane. The design
(decision 9 / card 10) wants this demoted to an opt-in escape hatch and replaced by a
**form** with typed fields, plus a synced "Advanced — edit raw `SKILL.md`" toggle.

The hard requirement (open-question line 153): the form ⇄ raw round-trip must **preserve
unknown frontmatter keys**, leaning on `@ax/skills-parser` as the single parse authority.
Currently `buildSkillManifestYaml` emits only `name/description/version/connectors`, so any
other frontmatter key is silently dropped on round-trip.

## Tasks (independent, testable)

### Task 1 — `@ax/skills-parser`: preserve unknown frontmatter keys (load-bearing)
- `ParsedManifest` gains `extra: Record<string, unknown>` — the frontmatter keys the parser
  does NOT model (everything except `name`/`description`/`version`/`sourceUrl`/`connectors`).
  Always present; `{}` when there are none. The forbidden capability keys are still
  hard-rejected before this point, so `extra` can never carry reach/secrets.
- `buildSkillManifestYaml` gains optional `extra?: Record<string, unknown>`, merged UNDER the
  known keys (spread `extra` first, then the typed fields → known fields always win; a crafted
  `extra.name` can't shadow the real name). Existing two callers (agents/admin-routes,
  skills/cap-migration) pass no `extra` → unchanged behaviour.
- Re-export `buildSkillManifestYaml` + `splitSkillMd` through the `@ax/skills/manifest` subpath
  (`packages/skills/src/manifest.ts`) so channel-web can use them via its single `@ax/skills` dep.
- Tests (TDD): round-trip with an unknown key (`parse → value.extra has it → build(extra) → parse
  again → still there`); `extra` defaults to `{}`; known keys win over `extra` on build; existing
  build.test.ts round-trips still pass.

### Task 2 — `SkillEditor.tsx`: form-first with synced raw toggle (load-bearing)
- Canonical component state: `{ name, description, connectors[], body, extra, files, defaultAttached }`
  + a `raw` boolean (Advanced toggle) + a `rawText` string used only while raw mode is open.
- **Form mode (default):**
  - Name (`Input`) → slug `id`. Description (`Input`/`Textarea`). Connectors multi-select
    (Popover + Command combobox; selected shown as removable `Badge` chips; suggestions from
    `listConnectors()`; free-entry of arbitrary connector-id slugs allowed). Instructions
    (`Textarea`, the body). Additional files (the existing path+contents bundle rows, kept).
    "Available to all my agents by default" `Checkbox`.
  - Live validation: assemble the manifest via `buildSkillManifestYaml({id:name,description,
    version,connectors},extra)`, `parseSkillManifest` it, surface any error; Save disabled until
    it parses and file paths are valid.
- **Advanced raw toggle:** a `Checkbox`/switch "Advanced — edit raw `SKILL.md`". When ON, show a
  `Textarea` seeded by serializing current form state (`--- + buildSkillManifestYaml(...) + --- +
  body`). When toggled back OFF, `splitSkillMd` + `parseSkillManifest` the rawText; on success
  repopulate name/description/connectors/extra/body and return to form; on parse failure stay in
  raw and show the error (can't return to a form from an unparseable manifest).
- **Save:** serialize the SKILL.md from whichever surface is active (form state, or rawText if raw
  is open and parses) and call `api.upsertSkill/updateSkill(skillMd,{defaultAttached,files})` —
  the existing wire contract is unchanged.
- Same prop contract (`skillId?`, `onSaved`, `onCancel`, `api?`) → SkillsAppStore / CatalogTab /
  UserSkillsPanelBody keep working unchanged (they mock SkillEditor in their own tests).
- Rewrite `SkillEditor.test.tsx` for the form surface + the toggle + a round-trip-with-unknown-key
  test through the real parser.

### Task 3 — gate + review + ship
- `pnpm build` + `pnpm test` (filtered: @ax/skills-parser, @ax/skills, @ax/channel-web, plus full
  for the FK/teardown check) + lint (scoped to changed files).
- `/code-review` (high) as the local review gate (no ax-code-reviewer subagent available here).
- PR with the Security review note (below) + boundary note (no hook-surface change).

## Security review (for PR body)
- Sandbox: N/A — client React component + pure parser change; no new FS path / network / spawn /
  env. Write path unchanged (`skills:upsert`/`update` still run validateBundleFiles ≤512 KiB +
  parseSkillManifest server-side). New `extra` round-trip can't carry caps/secrets (parser
  hard-rejects capabilities/allowedHosts/credentials/mcpServers/packages/inline-secret keys).
- Injection: Untrusted authored content (manifest fields, body, file contents/paths) renders only
  through React text nodes / controlled Input+Textarea (never dangerouslySetInnerHTML) and is
  serialized to YAML via js-yaml `dump` (structured, not string concat). Server re-parses +
  re-validates; client is not a trust boundary. `extra` merge gives known fields precedence so a
  crafted extra key can't forge name/description/connectors.
- Supply chain: N/A — no package.json changes; js-yaml already a dep of @ax/skills-parser.

## Boundary review
No new/changed service-hook signature. Reuses `skills:upsert`/`skills:update` via the existing
`/admin/skills*` + `/settings/skills*` routes. `@ax/skills-parser` is a pure library, not a
plugin; the `extra` field is additive. channel-web imports the parser via the `@ax/skills/manifest`
subpath (existing eslint-disable pattern). No payload field-name leakage.

## YAGNI pass
- Task 1 extra-key preservation: LOAD-BEARING (the acceptance test demands it).
- Task 2 form + toggle: LOAD-BEARING (the entire card).
- No speculative fields added (no "version" form input — version is server-managed; the form keeps
  it in `extra`/round-trips it but doesn't surface a control, matching today's editor).
