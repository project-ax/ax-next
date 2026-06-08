# TASK-165 — Skill drafting → /workspace/.skill-draft/ (durable) + hardening

**Date:** 2026-06-08
**Epic:** filestore-user-files (design `docs/plans/2026-06-07-filestore-user-files-design.md`, Phase 3)
**Branch:** `auto-ship/TASK-165-skill-drafts-durable`

## Problem

Skill-authoring scratch lives at `/ephemeral/skill-draft/<id>/` — an emptyDir that
evaporates when the pod dies, so a half-finished draft is lost across sessions. Move it
to the durable per-agent NFS mount at `/workspace/.skill-draft/<id>/` (`AX_USERFILES_ROOT`,
set by TASK-163) so drafts persist, with a graceful `?? ephemeralRoot` fallback when no
durable mount is wired. Because the staging dir is now on shared, durable NFS, three
security controls compensate for losing ephemerality / single-writer isolation / auto-GC.

## Binding facts (predecessors)

- `AX_USERFILES_ROOT` = in-sandbox mountPath `/workspace` (TASK-163, both providers);
  exposed as `env.userFilesRoot` (no default — absent ⇒ no durable mount).
- Resolver returns `[]` when `owner.agentId` is absent ⇒ `/workspace` may be ABSENT ⇒
  `?? ephemeralRoot` fallback is load-bearing, not cosmetic.
- cwd/HOME re-root is TASK-164 (sibling, NOT a dependency). Do NOT depend on cwd being
  `/workspace`; reference the draft root EXPLICITLY by absolute path.

## Approach

The draft prefix is no longer a constant. Compute it from the active root:
`draftRoot = userFilesRoot ?? ephemeralRoot`, prefix = `<draftRoot>/.skill-draft/`,
`relativeDir = .skill-draft/<id>`. (Uniform `.skill-draft` dotted subdir under whichever
root is live — design §7 specifies it for the durable case; the model is told the prefix
dynamically so the literal value is no longer user-memorized.) `checkDraftPath` is
parameterized by the active prefix; the executor computes the prefix from its root.

## Tasks

### T1 — `draft-paths.ts`: parameterize prefix on the active root (pure)
- Export `draftPrefix(root: string): string` → `${root}/.skill-draft/` and
  `checkDraftPath(absPath, root)` that validates against that prefix; `relativeDir`
  becomes `.skill-draft/<id>`. Keep the strict id grammar + all current rejections
  (empty, outside-prefix, bare-prefix, nested, traversal, bad-id).
- Update doc comment (durable vs ephemeral, dynamic prefix).
- Tests: parameterized prefix accepted for both `/workspace` and `/ephemeral` roots; all
  existing rejection cases still hold under each root.

### T2 — executor: root resolution, SKILL.md lstat, quota, cleanup-on-promote
- `CreateSkillProposeExecutorOptions` gains `userFilesRoot?`. Resolve
  `draftRoot = userFilesRoot ?? ephemeralRoot`; reject when BOTH absent (message updated:
  "no durable user-files or ephemeral tier"). Pass `draftRoot` to `checkDraftPath`; map
  `dirAbs = join(draftRoot, relativeDir)`.
- **HR2 — SKILL.md lstat:** before reading SKILL.md, `fs.lstat` it; if symlink, reject
  (mirror the extra-file walk's symlink rejection at :170). Test.
- **HR3 — quota:** the structural caps (MAX_FILES/MAX_TOTAL_BYTES) already bound a bundle
  during the extra-file walk; that is the per-draft size control. Keep + test it explicitly
  on durable-root drafts.
- **HR3 — cleanup-on-promote:** after a successful host verdict of `active`/`pending`
  (NOT `quarantined`, NOT on throw), `fs.rm(dirAbs, {recursive,force})`. A failed cleanup
  must NOT fail the propose (best-effort; the verdict already shipped). Test both that the
  dir is gone on active/pending and that it survives on quarantined.

### T3 — descriptor + system-prompt: dynamic prefix text
- `skillAuthoringNote(draftRoot)` interpolates `<draftRoot>/.skill-draft/<id>/`.
  `operationalNotes` / `buildSystemPrompt` thread the resolved draft root
  (`userFilesRoot ?? ephemeralRoot`) into it. When neither is set, keep a sensible default
  so the prose stays coherent even with no tier.
- Descriptor: the `description` + input-schema `path` description must not hard-code
  `/ephemeral`; phrase it as `.skill-draft/<id>` under your durable/scratch root. Keep all
  existing contract text (next-turn, connectors, no-caps-block). Update descriptor test.
- Update stale comments in `main.ts`, `plugin.ts`, `ipc-protocol/actions.ts`,
  `ipc-core/handlers/skill-propose.ts` to say `.skill-draft` / dynamic root.

### T4 — wire executor in main.ts
- Pass `userFilesRoot: env.userFilesRoot` into `createSkillProposeExecutor` (spread-when-
  present, like ephemeralRoot). Thread the resolved draft root into `buildSystemPrompt`'s
  skill-authoring note.

## HR1 — `/workspace` is NEVER an SDK setting/skill source (verify, no change)
`settingSources: ['user']` is unchanged; we add NO `.claude/skills` symlink into
`/workspace`. A draft under `/workspace/.skill-draft/` is inert until `skill.propose`
promotes it. Add a test asserting `settingSources` stays `['user']` and `/workspace` is
not added as a skill/setting source.

## Security-checklist
Untrusted skill content now stages on a durable, shared NFS mount. Run the
`security-checklist` skill; the three hard requirements ARE the controls. Note in PR.

## Out of scope / follow-ups
- TTL sweeper for abandoned drafts (design §7.3 — deferred).
- Per-agent *mount-level* quota enforcement (deploy concern; the executor's per-draft
  size guard via the existing structural caps is the runner-side control).
