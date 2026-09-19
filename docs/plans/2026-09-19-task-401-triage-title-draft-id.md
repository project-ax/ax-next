# TASK-401 — `item-edit --title` needs the `DI_` draft-issue content id

## Problem (measured, not inferred)

`.claude/skills/auto-ship/references/github-project.md` §8.2 is the snippet auto-ship's
triage gate runs to stamp `[TASK-n]` onto an untagged card. It passes `$ITEM_ID` — the
`PVTI_` **project-item** node id bound in §3/§4 — to `gh project item-edit --title`.

`gh` routes `--title` / `--body` to the `updateProjectV2DraftIssue` mutation, which wants
the **draft-issue content** id. Probed 2026-09-18 on a throwaway card:

- `--id <PVTI_…> --title …` → refused: `ID must be the ID of the draft issue content
  which is prefixed with DI_`. Title unchanged.
- `--id <DI_…> --title …` → succeeded.

So triage fails on **any** untagged card. Latent only because none has arrived since the
doc was written.

Scope note: §4's `--field-id` writes are the *opposite* — those take `PVTI_`. The fix must
not touch them.

## Tasks

1. **Fix §8.2.** Resolve the `DI_` content id via GraphQL from `$ITEM_ID`, assert the
   `DI_` shape, and only then `item-edit --title`. Capture `gh`'s status directly (no
   pipe) so a refusal is loud. Add the measured note + the `PVTI_`-is-for-fields caveat.
2. **Executing guard** — `scripts/__tests__/autoship-triage-title-draft-id.test.js`.
   Extracts §8.2's fenced block and **runs** it under bash *and* zsh against `gh` stubs
   that reproduce the measured rule. Asserts on the **resulting title** (a stub-written
   state file), never on a piped exit code. The doc stays the single implementation.

Both load-bearing at MVP: (1) is the live procedure, (2) is what stops it regressing.
No hook surface, no plugin, no dependency — no boundary review, no security checklist.
