# TASK-164 — Plan 2: cwd=HOME=/workspace + re-root `.ax/**` & `.claude/**` → /agent

**Date:** 2026-06-08
**Epic:** filestore-user-files (`docs/plans/2026-06-07-filestore-user-files-design.md`, §8-9, Phase 2)
**Branch:** `auto-ship/TASK-164-plan2-cwd-home-reroot`

## Problem

Phase 1 (TASK-163) wired a durable per-agent NFS mount at `/workspace` and set
`AX_USERFILES_ROOT` in the runner env — but only ADDED it to `additionalDirectories` +
a system-prompt note. The agent's `cwd`/`HOME` still point at `/agent` (the governed,
git-backed emptyDir tier). So relative-path file work / builds / clones still default to
the ephemeral git tier, and `~/bin` is still git-bundled.

Plan 2 separates the **user's working frame** (cwd/HOME) from the **governed frame**
(`/agent`, validated + git-backed). The governance linchpin (§14) is that the agent's
own `.ax/**`+`.claude/**` self-edits MUST stay on the governed tier even though cwd moved
to ungoverned NFS — otherwise a `.ax/SOUL.md` write relative to cwd=/workspace would land
on ungoverned NFS, bypassing the validator and breaking git-backed memory.

## Approach (gated on `AX_USERFILES_ROOT` set)

When `env.userFilesRoot` is set, the runner computes `sdkHome = sdkCwd = userFilesRoot`
(=`/workspace`); when unset, both stay `env.workspaceRoot` (=`/agent`) — **today's
behavior, byte-identical**. The governed frame (`env.workspaceRoot`=/agent) is used for
everything else and never moves.

## Tasks (independent, test-first)

### Task 1 — Broaden the PreToolUse re-rooter to the full policy scope (the linchpin)
`packages/agent-claude-sdk-runner/src/pre-tool-use.ts` (+ deps).

- Add `@ax/core` to the runner's `package.json` deps + tsconfig refs. Import
  `POLICY_PREFIXES` (`['.ax/', '.claude/']`) and `POLICY_EXACT_PATHS`
  (`{CLAUDE.md, CLAUDE.local.md}`) — single source of truth shared with the validator.
- Generalize `rerootUploadsPath` → `rerootGovernedPath(value, workspaceRoot)`: matches a
  governed path appearing as a path segment (start-of-string or after `/`):
  - `.ax/<rest>` or `.claude/<rest>` → `<workspaceRoot>/.ax/<rest>` etc. (keep the prefix)
  - root-exact `CLAUDE.md` / `CLAUDE.local.md` as a final segment → `<workspaceRoot>/CLAUDE.md`
  - refuse any `..` segment (kept from uploads re-rooter).
  - idempotent on an already-`<workspaceRoot>`-rooted path (changed=false).
- `resolveAttachmentPaths` → `resolveGovernedPaths(input, workspaceRoot, { broaden })`:
  the `broaden` flag (true iff userFilesRoot set) toggles between full-policy match and
  the legacy uploads-only match. Only `PATH_INPUT_KEYS` (file_path/path/notebook_path)
  rewritten; free-text fields never touched.
- `createPreToolUseHook` gains a `broaden: boolean` option; passes it through.
- **Tests (the linchpin — exhaustive):** `.ax/x`, `.claude/x`, `CLAUDE.md`, `CLAUDE.local.md`
  re-root to `/agent`; bare / cwd-prefixed (`/workspace/.ax/x`) / home-prefixed forms all
  re-root; user paths (`/workspace/data/f.csv`, `src/index.ts`, `notes.md`) do NOT; `..`
  refused; idempotent on `/agent/.ax/x`; `foo.ax/x` (not a segment) untouched; free-text
  untouched; with `broaden:false` only `.ax/uploads/` re-roots (legacy regression).

### Task 2 — Reshape cwd/HOME/home-bin/additionalDirectories in `main.ts`
- Compute `const sdkHome = env.userFilesRoot ?? env.workspaceRoot;` once.
- `cwd: sdkHome` (was `env.workspaceRoot`).
- `HOME: sdkHome` (was `env.workspaceRoot`).
- `buildHomeBinEnv(sdkHome, …)` (was `env.workspaceRoot`) → `~/bin` follows HOME.
- `additionalDirectories`: when userFilesRoot set, ensure `/agent` (workspaceRoot) and
  `/ephemeral` are present (so the agent can still reach `.ax/uploads`, transcripts dir,
  scratch). Keep userFilesRoot out of the list when it IS the cwd (cwd is always granted).
  Dedup. When unset → today's list (ephemeral + userFiles if any).
- `createPreToolUseHook({ client, workspaceRoot: env.workspaceRoot, broaden: env.userFilesRoot !== undefined })`.
- Leave every other `env.workspaceRoot` use (git, transcript symlink, prompt-engine,
  uploads) untouched.
- Update the inline comments that assert HOME/cwd=workspaceRoot.

### Task 3 — Make the workspace system-prompt note cwd-aware
`packages/agent-claude-sdk-runner/src/system-prompt.ts` + `prompt-engine.ts`.

- `workspaceNote` (and `operationalNotes` / `buildSystemPrompt`) learn the effective cwd.
  When cwd != governed root: state the working dir (`<cwd>`) AND that shared files
  (`.ax/uploads/…`) live under the governed root `<workspaceRoot>` — resolve them there,
  never under `~`. When cwd == governed root: unchanged prose.
- Thread `sdkHome`/cwd from `main.ts` into `buildSystemPrompt`.
- Tests: note mentions both dirs when they differ; unchanged when equal.

### Task 4 — Regression tests: governed reads stay anchored to /agent
- Unit: `buildHomeBinEnv` from HOME=/workspace → `/workspace/bin` on PATH.
- Assert (via existing prompt-engine / transcript test seams) that `.ax` reads + transcript
  readdir-walk key off `workspaceRoot`, not cwd — i.e. unaffected by the cwd move.
  (Skill discovery is CLAUDE_CONFIG_DIR-based; documented, no code path moves.)

## Security checklist
Run `security-checklist` (sandbox boundary: the re-root is the control keeping agent
self-edits on the governed tier). Structured note in the PR.

## Out of scope / follow-ups
- Drafts → `/workspace/.skill-draft/` (Phase 3 / separate card).
- Per-agent quota / cleanup (design §7.3, Phase 3+).
