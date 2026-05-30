# TASK-70 — Delete the half-wired LFS layer; gate the per-turn commit on a non-empty /permanent diff

Epic: out-of-git (Phase 5). Design: `docs/plans/2026-05-30-out-of-git-design.md` Part E + Phase 5.

## Problem

The git-LFS layer is fully built + routed but no client ever uses it (no `.gitattributes`,
no `git lfs track`, the default isomorphic-git backend ignores LFS filters). It is dead weight
+ a CLAUDE.md "no half-wired plugins" (I3) violation. With transcripts (TASK-67), blobs/attachments
(TASK-68), and skills (TASK-69) all off git, the per-turn commit/bundle now fires only on rare
identity/Pattern-A agent-state diffs — a pure chat turn should produce an EMPTY /permanent diff and
be skipped.

## Validated findings (traced 2026-05-30, post-TASK-67/68/69)

1. **LFS server is dead.** `workspace-git-server/src/server/lfs.ts` (sha256 store), its 4 routes in
   `listener.ts` (`lfs-batch`/`lfs-verify`/`lfs-storage-upload`/`lfs-storage-download` + route
   regexes + content-type/JSON-body gates + `lfsBaseUrl`), and per-workspace `.lfs/objects/`
   provisioning in `repos.ts` (create + delete) — no live caller. `lfs.ts`'s store was already
   promoted to `@ax/blob-store-fs` in TASK-65. DELETE all of it.

2. **Runner `git lfs install --local`** (`git-workspace.ts:158`) installs filters that never fire +
   makes ~25 runner tests RED in any sandbox without git-lfs. DELETE it + its test.

3. **`container/agent/Dockerfile`** apt-installs `git-lfs=3.3.0-1+deb12u1` + carries a doc comment
   block about it. REMOVE the pin + comment (capability reduction: drops git-lfs from the sandbox).

4. **Per-turn commit gating is ALREADY essentially correct.** `commitTurnAndBundle` does `git add -A`
   → `git diff --cached --quiet` (commit only when staged-diff non-empty) → gate the *bundle* on
   `git rev-list --count baseline..main` (return null when empty → commit-notify SKIPPED). The jsonl
   is gitignored (TASK-67), so a pure chat turn stages nothing → null → skipped. Phase-5 work here is
   to (a) add an explicit short-circuit + regression test proving an empty /permanent diff produces
   NO commit and is skipped, and (b) retire the stale "Phase 5 / TASK-70" comments.

5. **Genuinely-dead workarounds to remove (card scope):**
   - `readTranscriptFromWorkspace` + the now-unused `parseJsonlToTurns` import in
     `conversations/src/plugin.ts` — the legacy transcript-via-git read, only ever reached for
     pre-TASK-66 conversations with zero event-log rows. ax-next has NO production data
     (memory/context.md), so this fallback is dead. The `conversations:get` event-log + transcript-row
     path (TASK-66/67) is the live read. KEEP the `workspace:list`/`read`/`apply` *calls* + types —
     `conversations:drop-turn` still declares them (see finding 7).
   - `scaffoldSdkProjectsSymlink` (`git-workspace.ts`) + its main.ts call site — existed solely to
     make `git add -A` capture the SDK jsonl into git. The jsonl is gitignored + resume rebuilds from
     rows (TASK-67), so its purpose is moot. The HOME-redirect fallback the call-site comment names
     still lands the SDK jsonl inside `<workspaceRoot>/.claude/projects` for the runner's own
     delta-ship/resume readers (which readdir-walk, not git), so removing the symlink does not break
     transcript shipping.

6. **NOT removing the resync (card premise invalid — documented deviation).**
   The card lists "the commit-notify parent-mismatch resync (`commit-notify-resync.ts`,
   `resyncBaselineAndReplay`)" under "now-dead workarounds the data move obsoletes." That premise is
   FALSE: `resyncBaselineAndReplay` is a GENERAL concurrent-writer recovery (replays `oldBaseline..main`
   onto `newBaseline`) that still protects the SURVIVING identity/Pattern-A git commit path; and
   `commit-notify-resync.ts` also exports `flushWorkspaceToHost` (BUG-W2 mid-turn host-tool workspace
   visibility, called from main.ts:446), which is transcript-independent and LIVE. The host
   `workspace.commit-notify` handler still returns `actualParent` on parent-mismatch (the resync
   trigger). Deleting this would BREAK live infra — contradicting the card's own "gate (don't break)"
   directive + the TASK-67 CORRECTION ("commitTurnAndBundle SURVIVES... the bundle path is NOT dead").
   DECISION: do NOT remove it; document loudly; return as a follow-up + learning.

7. **Out of scope: `conversations:drop-turn`.** Post-TASK-67 it reads `.claude/projects/**/<sid>.jsonl`
   via `workspace:list` (git tree) — which is now gitignored → returns empty → drop-turn no-ops. This is
   a pre-existing TASK-67 consequence (the routines silence-token feature is now non-functional), NOT
   introduced by this PR, and NOT in this card's named scope. Leave the code intact (don't break its
   declarations); flag as a follow-up.

8. **Deterministic-OID coupling is NOT LFS-related and is NOT removed.** `BASELINE_ENV` /
   `HOST_GIT_DETERMINISTIC_ENV` / the server client produce reproducible OIDs for the empty-baseline
   seed + the bundle round-trip — the SURVIVING identity/Pattern-A git path. The design's "shrinks to
   whatever still rides git" is a conceptual reduction (it now matters only for rare agent-state, not
   every chat turn); the code stays because that path stays. Document.

9. **TASK-73 preemptive timeout:** bump `workspace-git-server/vitest.config.ts` `testTimeout` to 30s
   (still on the 5s default; real-git bundle work; same flake class).

## Tasks

1. **Delete the LFS server.** Remove `workspace-git-server/src/server/lfs.ts` + `__tests__/lfs.test.ts`.
   In `listener.ts`: remove the `./lfs.js` import, the 4 `lfs-*` `RouteMatch` kinds + their regexes
   (`LFS_BATCH_RE`/`LFS_STORAGE_RE`/`LFS_VERIFY_RE`/`LFS_LOOSE_RE`) + match branches, the `lfs-batch`/
   `lfs-verify` content-type branch + the LFS entries in `invalid-repo-id`'s union, the PUT method-gate
   comment, the `routeUsesJsonBody` LFS note, the 4 dispatch cases, and `lfsBaseUrl`. PUT method support:
   PUT was ONLY for `lfs-storage-upload` — drop PUT from the method gate (`matchRoute` will 503/400 it).
   In `repos.ts`: remove the `.lfs/objects/` provisioning (create) + the `.lfs` removal (delete).
   Verify `listener.test.ts`/`repos.test.ts`/`argv-injection.test.ts`/`matchRoute` tests for LFS asserts
   and prune them.

2. **Remove runner `git lfs install --local`** (`git-workspace.ts`) + its test in `git-workspace.test.ts`
   ("runs `git lfs install --local`..."). Update the surrounding comment.

3. **Remove `git-lfs` from `container/agent/Dockerfile`** (apt pin + the doc comment block).

4. **Explicit commit gate + regression test.** In `commitTurnAndBundle`, keep the existing
   `baseline..main` range gate (the authoritative ship signal) and make the empty-diff skip explicit;
   add a `git-workspace.test.ts` case: a turn that stages NOTHING in /permanent → `commitTurnAndBundle`
   returns null (no commit created), proving commit-notify is skipped. Retire the stale "Phase 5/TASK-70"
   comments in main.ts + git-workspace.ts (the thinning is now done).

5. **Remove dead workarounds.** Delete `readTranscriptFromWorkspace` + the `parseJsonlToTurns` import in
   `conversations/src/plugin.ts`; the `conversations:get` legacy fallback now returns `{ turns: [],
   displayEvents: [] }` when there are no event rows (no production data → no pre-TASK-66 chats).
   Delete `scaffoldSdkProjectsSymlink` + its main.ts call site; update the call-site comment to note the
   HOME-redirect lands the jsonl in the workspace for the readdir-walking delta-ship/resume readers.

6. **Bump `workspace-git-server` testTimeout to 30s** (TASK-73 flake class).

7. **security-checklist** — this removes a storage/network boundary (LFS server endpoints) + a sandbox
   binary (git-lfs). Capability reduction; produce the PR security note.

## YAGNI pass
All tasks load-bearing. No new abstractions. (Considered: re-pointing drop-turn to transcript rows —
out of scope, deferred as a follow-up. Considered: removing the deterministic-OID coupling — would break
Pattern A, not done.)
