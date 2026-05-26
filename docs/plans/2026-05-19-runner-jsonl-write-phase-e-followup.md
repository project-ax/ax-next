# Phase E follow-up — SDK transcript jsonl not bundled into workspace

**Date:** 2026-05-19
**Predecessor:** `2026-05-19-conversations-get-zero-turns-investigation.md`
**Status:** OPEN — gates `conversations:get` returning real turns on
dev cluster + history-load chip download path + parts of the Phase 3
manual smoke.

## Problem

The Anthropic SDK uses `$CLAUDE_CONFIG_DIR` (when set) as the root for
**both** skill-discovery AND native transcript writes:

  - `$CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md` — host-installed skills
  - `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl` — turn transcripts
  - `$CLAUDE_CONFIG_DIR/sessions/<n>.json` — session metadata

PR #95 (Phase 0 skill-install) set
`CLAUDE_CONFIG_DIR=/home/runner/.ax/session` so the SDK's `'user'`
setting source resolves to a host-owned root SEPARATE from the
workspace's `'project'` source (`/permanent/.claude/skills/`). That
goal is achieved — but as a side effect the SDK now writes its
transcript jsonl to `/home/runner/.ax/session/projects/…`, which is
**outside `/permanent`** (workspaceRoot) and therefore not picked up by
the runner's post-turn `git add -A + bundle`.

Result: `conversations:get` returns `{ turns: [] }` for every
conversation booted on a runner running the post-Phase-0 image — even
after a successful assistant reply that streamed correctly to the live
frame.

Direct evidence (dev cluster, kind-ax-next-dev, 2026-05-19):

  - Pre-Phase-0 (May 17-18) bundle commits contain
    `.claude/projects/-permanent/<sid>.jsonl` + `.claude/sessions/N.json`.
  - Post-Phase-0 (May 19) bundle commits contain `.cache/`, `.npm/`,
    `summary.md`, attachment uploads — but **never** `.claude/projects/`
    or `.claude/sessions/`.

## Options

### Option A — symlink `$CLAUDE_CONFIG_DIR/projects` into `/permanent`

Have the runner (or the init container) `mkdir -p /permanent/.claude/projects`
+ `ln -sfn /permanent/.claude/projects $CLAUDE_CONFIG_DIR/projects`. The
SDK keeps writing to `$CLAUDE_CONFIG_DIR/projects/…`, but the actual
bytes land inside `/permanent` and get bundled normally.

  - Pros: minimal change, no runner-code rewrite, preserves Phase 0's
    skills-vs-project split.
  - Cons: requires the symlink to exist before the SDK first opens the
    jsonl file. Init-container can do this — pod-spec already pre-creates
    `/home/runner/.ax/session/skills` for the same reason.
  - Open question: does the SDK follow symlinks for write? Likely yes
    (it's a normal `fs.createWriteStream`), but verify on a probe pod.
  - Same problem for `.claude/sessions/` if the host ever needs that data.
    Currently the host doesn't read sessions/, only projects/, so we can
    defer.

### Option B — explicit env override `CLAUDE_PROJECT_DIR` (if SDK supports it)

If the SDK lets us decouple skills-root from transcript-root via a
separate env (e.g. `CLAUDE_PROJECT_DIR`), set transcript root to
`/permanent/.claude` and leave `CLAUDE_CONFIG_DIR` pointing at
`/home/runner/.ax/session`. Investigation needed:
`@anthropic-ai/claude-agent-sdk` source for `process.env` references.

  - Pros: clean separation, no symlinks.
  - Cons: requires SDK to support it; if not, fall back to A.

### Option C — set `CLAUDE_CONFIG_DIR` to a subdir of `/permanent`

E.g. `CLAUDE_CONFIG_DIR=/permanent/.ax/session`. Skills-root and
transcript-root both land in `/permanent`, so both are bundled.

  - Pros: simplest one-line fix.
  - Cons: leaks host-owned skills surface into the workspace bundle (so
    the workspace ends up containing the chmod-restricted host skills
    dir). The whole reason Phase 0 put it under `/home/runner/.ax/` was
    to keep it OUT of the workspace. Probably regresses I-P0-1 / I-P0-3.
    Listed for completeness; do NOT pursue without re-reading PR #95
    rationale.

### Recommended order

1. Try **B** first (10 minutes of SDK source-reading).
2. If unsupported, ship **A** (symlink during init container).
3. **C** is the last resort and likely violates Phase 0 invariants.

## Scope

  - Whichever option lands, also extend `sandbox-subprocess` (same
    `CLAUDE_CONFIG_DIR=$HOME/.ax/session` pattern at
    `packages/sandbox-subprocess/src/open-session.ts:377`).
  - Add a runner-side test: after a successful turn, the bundle MUST
    contain a path matching `.claude/projects/**/*.jsonl`. This is the
    test that would have caught the regression — the existing Phase 3
    workspace-bundle-wire tests bundled an empty workspace, so they
    never exercised the SDK's own jsonl write.
  - Update PR-95-era comments in `main.ts:418-427` and
    `proxy-startup.ts:68-77` so a future reader understands the
    transcript-write trap, not just the skills-discovery split.

## Manual verification (after fix)

On `kind-ax-next-dev`:

1. Send a turn through the chat UI.
2. Wait ~3s for the post-turn bundle to land.
3. `kubectl -n ax-next exec ax-next-git-server-experimental-0 -- \
     git -C /var/lib/ax-next/repo/<wsId> ls-tree -r HEAD --name-only | grep '\.claude/projects'` →
   expect at least one `.claude/projects/-permanent/<sid>.jsonl`.
4. `curl localhost:8080/api/chat/conversations/<convId>` → expect
   `turns[]` populated.

## Not in scope

  - Migrating the existing 4 broken conversations' transcripts. They're
    permanently lost — the SDK wrote them to ephemeral pod storage that
    was reaped. Document and move on.
  - Phase E broader transcript-storage design. This is a targeted patch
    on the existing runner-owned-sessions design (per
    `project_runner_owned_sessions_design.md`), not a redesign.
