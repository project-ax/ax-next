# TASK-899: the `/files` reader walks every component — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (yolo-ship Phase 3) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Dispatch each task at the model + effort its `[tier: …]` tag maps to.

**Goal:** Close the intermediate-directory race in the host's `/files` reader. `readConfinedUserFiles` becomes a thin adapter over the per-component no-follow walk from `e011da3`, so both providers' host-mounted `sandbox:read-user-files` reads go through it.

**Architecture:** `@ax/user-files-read` gets `walk-read.ts` back as an internal module. The walk opens the trusted root, then opens each path component relative to the descriptor it already holds, through `/proc/<pid>/fd/<n>/<name>`, with `O_NOFOLLOW`. `readConfinedUserFiles` keeps its signature and output shape and delegates to the walk. The realpath-then-open reader (`confineByRealpath`, `listDir`, `readFilePrefix`) is deleted, not kept as a fallback. Neither provider changes logic, because both already call `readConfinedUserFiles`. The k8s pod-per-call reader keeps its shell `realpath` check and is documented as out of scope.

**Tech stack:** TypeScript, Node ≥ 24 (`fs.promises`, numeric open flags including `O_PATH`), vitest 5, pnpm 10.33.2.

**Spec:** the card `[TASK-899]`. Decisions are in `.claude/memory/decisions/2026-10-21-TASK-899.md`, which you must read first: it says why each choice below was made. The walk's origin is `git show e011da3:packages/user-files-read/src/walk-read.ts` plus `src/__tests__/walk-read.test.ts` at the same commit. Its review history is `docs/plans/2026-10-17-w3b-project-files-impl.md` and W3 design §18. The NFS evidence is `git show e011da3:deploy/kind/w3b-nfs-race-2026-10-17.json`: on real NFS the walk leaked 0 times in 40,000 reads, and a plain read leaked 1,121 times in 20,000.

## Global Constraints

- **No hook-surface change.** The `sandbox:read-user-files` types in `packages/sandbox-mount-protocol/src/mount-spec.ts` stay byte-identical. Boundary review isn't needed because this changes internal implementation only. Say so in the PR.
- **No new dependencies.** No `package.json` or lockfile change.
- **Read limits unchanged.** `DEFAULT_CONFINED_READ_LIMITS` is 1 MiB `maxFileBytes` and 5000 `maxDirEntries`. Existing tests pin both against the reader pod's `READ_MAX_FILE_BYTES` and `READ_MAX_DIR_ENTRIES`.
- **Walk constants verbatim from `e011da3`:** `MAX_WALK_PARTS = 32`, `MAX_WALK_LIMIT_BYTES = 16 * 1024 * 1024`, `MAX_WALK_ENTRIES = 10_000`, `MAX_WALK_SKIPPED = 1_000`, and the `O_PATH` fallback `0o10000000`.
- **Answer shapes:**
  - A path-dependent miss is exactly `{ kind: 'absent' }`, with no `reason` and no other key.
  - A storage failure throws `UserFilesReadError` (the walk's `WalkReadError` is a subclass).
  - A malformed relPath (absolute, or containing `..`) throws with today's messages, which match `/relative/` and `/\.\./`.
- **Linux only, and loud elsewhere.** Off Linux the reader throws `UserFilesReadError` with `code: 'unsupported-platform'`. It never quietly falls back to a check-then-open read.
  - Guard every test that reads real files through the walk with `const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');` plus `describe.skipIf(!ON_LINUX)` or `it.skipIf(!ON_LINUX)`.
  - On this Mac those tests SKIP, and **a skip is not a pass.** Prove them in Linux (next section) and in CI.
- **Running one test file:** use `pnpm --filter @ax/<pkg> test <file>`, never `test -- <file>`. The `--` form runs the whole package (TASK-904). Check the file count in vitest's summary line.
- **Mutation:** you are the worktree owner. Commit first, then follow the `ax-mutation-restore` precondition and restore blocks in `.claude/skills/yolo-ship/SKILL.md`. Restore with `git checkout HEAD -- <path>`, and assert `git status --short` is empty between mutants.
- **Memory shards:** don't backtick a repo path that isn't tracked yet. The `memory-cited-paths-exist` guard in `pnpm test:scripts` fails on it. Until `walk-read.ts` and `errors.ts` are committed, write them without their directory.
- **Voice:** comments operators read (`values.yaml`, `SECURITY.md`) follow CLAUDE.md's voice. Be plain and direct about the risk, and don't joke about it.

## Running the walk's tests in Linux from this Mac

The walk needs Linux `/proc`, and this worktree is on macOS. Put this script in your scratchpad (**not** the repo) and run it from the worktree root.

```bash
cat > "$SCRATCH/linux-test.sh" <<'EOF'
#!/usr/bin/env bash
# linux-test.sh <src> <pkg> [<pkg>...]   <src> = a worktree dir, or git:<ref>
# Copies the source (no node_modules/dist/.git) into a throwaway node:24 Linux
# container, runs as uid 1000 (prod's host uid; non-root so DAC tests mean
# something), installs + builds the named packages and their deps, then runs
# each named package's tests. Nothing is written back to <src>.
set -euo pipefail
SRC=$1; shift
pkgs=("$@")
inst=(); for p in "${pkgs[@]}"; do inst+=(--filter "$p..."); done
tst=();  for p in "${pkgs[@]}"; do tst+=(--filter "$p"); done
docker volume create ax-linux-pnpm-store >/dev/null
docker run --rm -v ax-linux-pnpm-store:/s node:24-bookworm chown 1000:1000 /s
if [[ $SRC == git:* ]]; then
  stream() { git archive --format=tar "${SRC#git:}"; }
else
  stream() { COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -C "$SRC" --exclude=node_modules --exclude=dist --exclude=.git --exclude='*.tsbuildinfo' -cf - .; }
fi
stream | docker run --rm -i --user 1000:1000 -e HOME=/home/node -e CI=true \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -v ax-linux-pnpm-store:/s node:24-bookworm \
  bash -euo pipefail -c '
    mkdir -p /home/node/w && cd /home/node/w && tar -xf -
    P="corepack pnpm"
    $P config set store-dir /s >/dev/null
    $P install --frozen-lockfile '"${inst[*]}"' >/tmp/i.log 2>&1 || { tail -60 /tmp/i.log; exit 1; }
    $P '"${inst[*]}"' build >/tmp/b.log 2>&1 || { tail -80 /tmp/b.log; exit 1; }
    echo "uid=$(id -u) kernel=$(uname -r) node=$(node -v)"
    $P '"${tst[*]}"' --no-bail run test
  '
EOF
chmod +x "$SCRATCH/linux-test.sh"

"$SCRATCH/linux-test.sh" "$PWD" @ax/user-files-read
"$SCRATCH/linux-test.sh" "$PWD" @ax/user-files-read @ax/sandbox-subprocess @ax/sandbox-k8s
```

**The planner checked this recipe on 2026-10-21** on this Mac: OrbStack, linux/arm64, kernel 7.2.9, node 24.22.0, running as uid 1000.
- `git:e011da3`: `@ax/user-files-read` passed 176 tests with 2 skipped, including the walk's race test (6.5 s) and its search-only test.
- HEAD: `@ax/user-files-read` passed 40, `@ax/sandbox-subprocess` 111 and `@ax/sandbox-k8s` 429, with no failures.

Notes on using it:
- It tars the worktree's *current* files, uncommitted mutants included, so it is also your mutation runner.
- `COPYFILE_DISABLE` and `--no-mac-metadata` are load-bearing. Without them macOS adds `._*` AppleDouble files, and vitest fails to parse them.
- It starts no Testcontainers, so CLAUDE.md's `DOCKER_HOST` rule doesn't apply to it.
- It can't run the preset canaries, because they need Postgres. CI is their Linux run.
- If Docker is unavailable, stop and say so. Mutation testing the Linux-only guards needs it, and CI alone is too slow for that.

## Review Focus

These failure modes are the likeliest to bite a real person, and no CI test fully covers them. Where a test can pin one, the owning task adds it.

1. **A swap on production NFS.** Production is Filestore NFSv3 on the inline `nfs:` volume, with default lookupcache. The CI race test runs on a local filesystem. The walk's syscalls are the ones W3b proved on real NFS and ran in production, so this is a post-deploy smoke check (open an agent's Files tab), not a task.
2. **Directly addressed in-root symlinks now 404.** A symlink inside the agent's own files used to be served when asked for by path; listings already hid them. Tasks 2 and 3 pin this with tests.
3. **Errors past the first component now throw, and `ESTALE` gets one retry first.** `EACCES` or `EIO` at an intermediate component used to answer 404 and now throws, which the route turns into a 5xx.
   - `ESTALE`, NFS's stale handle, gets one retry from the walk itself. The retry is a whole new walk that opens the root and every folder on the way `O_RDONLY`, so NFS revalidates them. A folder the agent replaced is then served, and a deleted one is a 404. `ESTALE` that survives the retry is a 5xx, never a 404, because that means an export that went stale, or a folder the agent is rewriting faster than a read finishes.
   - One cost: after an `ESTALE`, a search-only (0311) folder on the path is a 5xx (`EACCES`), because `O_RDONLY` needs read permission. The next read serves it.
   - Tests pin `EACCES` and every `ESTALE` outcome, with the error shape Node really produces (`code: 'Unknown system error -116'`, `errno: -116`). A real NFSv3 harness measured each case; the table is in the decisions shard.
   - Post-deploy check: open `out/<file>` in the Files tab. Have the agent run `rm -rf out && mkdir out` and rewrite the file. Within about 30 seconds, reload that file's view *without opening `out`*. It should show the new content. Before the fix, it errored for 30 to 60 seconds. The order matters: browsing `out` first refreshes the cache by itself and hides the bug.
4. **A path deeper than 32 components** answers 404 instead of being read. Task 2 pins this.
5. **A directory with 1,000 or more symlinks or special files ahead of its regular entries.** The walk stops listing, and the hook's dir answer has no field to say the list was cut short. This is accepted and documented in the adapter comment and the decisions shard. It isn't testable deterministically, because readdir order depends on the filesystem.
6. **A file name that isn't valid UTF-8 is left out of a listing.** Node decodes the name with U+FFFD in place of the bad bytes, the walk's lstat of the re-encoded name finds nothing, and the entry is skipped. Asked for by its mangled name, it's a 404. The old reader listed it under the mangled name and also answered 404 when it was opened, so it was never readable here; now it isn't shown either. A Linux test pins it, and the adapter comment documents it as a known gap.

## Files

| File | Change | Task |
|---|---|---|
| `packages/user-files-read/src/errors.ts` | create: `UserFilesReadError`, moved | 1 |
| `packages/user-files-read/src/walk-read.ts` | create: re-landed walk | 1 |
| `packages/user-files-read/src/__tests__/walk-read.test.ts` | create: re-landed tests | 1 |
| `packages/user-files-read/src/confined-read.ts` | re-export (1); adapter, delete realpath reader, header (2) | 1, 2 |
| `packages/user-files-read/src/__tests__/confined-read.test.ts` | port, plus race test | 2 |
| `packages/user-files-read/vitest.config.ts` | comment only | 2 |
| `eslint.config.mjs` (lines 67–78) | comment only | 2 |
| `docs/plans/2026-10-20-agent-tasks-design.md` (lines 773–774) | doc line | 2 |
| `packages/sandbox-k8s/src/__tests__/user-files-ops.test.ts` | guards plus 2 tests | 3 |
| `packages/sandbox-subprocess/src/__tests__/user-files-host-ops.test.ts` | guards plus 1 test | 3 |
| `packages/sandbox-subprocess/src/__tests__/userfiles-canary.acceptance.test.ts` | 1 guard | 3 |
| `packages/sandbox-k8s/src/user-files-ops.ts` | comments only: 693–702 (3); 490–516 and 660–679 (5) | 3, 5 |
| `packages/sandbox-k8s/src/config.ts` (lines 152–158) | comment only | 3 |
| `packages/sandbox-subprocess/src/user-files-host-ops.ts` (lines 35–46, 121–127) | comment only | 3 |
| `packages/channel-web/src/server/routes-workspace.ts` (lines 6848–6851) | comment only | 3 |
| `presets/memory/src/__tests__/canary.test.ts` | 4 guards | 4 |
| `presets/k8s/src/__tests__/acceptance.test.ts` | 1 guard | 4 |
| `packages/sandbox-k8s/SECURITY.md` | filesystem reach (lines 59–61); known limit | 5 |
| `deploy/charts/ax-next/values.yaml` (lines 344–351) | comment only | 5 |
| `deploy/charts/ax-next/templates/host/deployment.yaml` (lines 355–359) | comment only | 5 |

Order: 1 → 2 → 3 → 4 → 5. Tasks 3 and 5 both edit comments in `user-files-ops.ts`, in separate hunks, so run them in sequence.

---

### Task 1: Re-land the walk `[tier: sensitive]`

**security-checklist:** yes. This is a sandbox boundary that takes untrusted paths. It feeds the PR's security note.

**Files:**
- Create: `packages/user-files-read/src/errors.ts`. Move `UserFilesReadError` from `confined-read.ts` verbatim, class and doc comment.
- Modify: `packages/user-files-read/src/confined-read.ts`. Delete the class and add `export { UserFilesReadError } from './errors.js';`. The public API is unchanged. Nothing else in this task.
- Create: `packages/user-files-read/src/walk-read.ts`, from `git show e011da3:packages/user-files-read/src/walk-read.ts` with the deviations below.
- Create: `packages/user-files-read/src/__tests__/walk-read.test.ts`, from e011da3's copy, adapted as listed below.
- `src/index.ts` is unchanged. The walk stays internal, and only the adapter uses it.

**Interfaces (Produces, consumed by Task 2):**
```ts
export const MAX_WALK_PARTS: number;        // 32
export const MAX_WALK_LIMIT_BYTES: number;  // 16 MiB
export const MAX_WALK_ENTRIES: number;      // 10_000
export const MAX_WALK_SKIPPED: number;      // 1_000
export class WalkPathError extends Error { readonly code: 'invalid-path' }
export class WalkReadError extends UserFilesReadError { readonly depth: number } // -1 = the root
export type WalkAbsentReason = 'missing' | 'link-or-not-dir' | 'not-file-or-dir';
export type WalkReadOutput =
  | { kind: 'file'; contents: Uint8Array; truncated: boolean }
  | { kind: 'dir'; entries: UserFileDirEntry[]; truncated: boolean }
  | { kind: 'absent'; reason: WalkAbsentReason };
export interface WalkReadLimits { limitBytes: number; maxEntries: number }
export function splitRelPath(relPath: string): string[];
export function readConfinedByWalk(root: string, parts: string[], opts: WalkReadLimits): Promise<WalkReadOutput>;
```

**Deviations from `e011da3`.** Everything else is verbatim: flags, `O_PATH`, caps, `absentReason`, `fail()`, `fdPath`, the platform check, streamed `listDir` with its skip cap, and the `readPrefix` loop. The reviewer will run `git diff e011da3 HEAD -- packages/user-files-read/src/walk-read.ts` and expect only these:
1. `import { UserFilesReadError } from './errors.js'`, not `'./confined-read.js'`. Task 2 makes `confined-read.ts` import the walk, so importing back would be a cycle. `class WalkReadError extends UserFilesReadError` would then evaluate before its base class exists, which is a TDZ `ReferenceError` at load.
2. Reframe the header for the `/files` reader. Drop the shared-folder framing. Instead of "for shared folders (one agent's writes, read by the host on behalf of every project member) it is the whole threat", write that it's the whole threat for an agent's writes read by the host for the person browsing them, off an export that holds every tenant's files.
3. Replace the `.shared` 0711 rationale for `O_PATH` intermediates with the generic one. Passing through a directory should need search permission only, the reach a path lookup always needed, so a directory the agent made search-only (0311) still reads through. `O_RDONLY` would need read permission.
4. Delete the sentence "Callers map e.g. EACCES at `.shared` to `unavailable`".
5. Delete "(a 10 MiB download plus slack)" from the `MAX_WALK_LIMIT_BYTES` doc.
6. No `size` and no `updatedAt`. Delete `WalkDirEntry`, so entries are `UserFileDirEntry` (`{ name, kind }`). The file answer has no `size`. Keep `stat.size` as `readPrefix`'s allocation hint.

- [ ] **Step 1: Move the error class.** Create `errors.ts` and add the re-export. Run `pnpm --filter @ax/user-files-read test`. Expected: 40 passed. This is a pure move.
- [ ] **Step 2: Write `walk-read.test.ts`** with the cases below. Run `pnpm --filter @ax/user-files-read test src/__tests__/walk-read.test.ts`. Expected: FAIL, because `../walk-read.js` doesn't exist yet.

  **Cross-platform (no disk):**
  - `splitRelPath`: `''` gives `[]`, and `'docs/note.md'` gives `['docs','note.md']`.
  - `splitRelPath` throws `WalkPathError` with `code: 'invalid-path'` for each of `..`, `a/../b`, `/abs`, `/`, `a//b`, `a/./b`, `.`, `a/` and `a\0b`.
  - `splitRelPath` accepts 32 segments and refuses 33.
  - `readConfinedByWalk` refuses part lists `['..']`, `['']`, `['.']`, `['a/b']` and `['a\0']`, and 33 parts, with `WalkPathError`.
  - It throws `RangeError` for limits `{limitBytes:-1}`, `1.5`, `MAX_WALK_LIMIT_BYTES + 1`, `{maxEntries:0}` and `MAX_WALK_ENTRIES + 1`.
  - **NEW: "off Linux it refuses with unsupported-platform instead of answering."**
    - Save `Object.getOwnPropertyDescriptor(process, 'platform')`, then `Object.defineProperty(process, 'platform', { ...d, value: 'darwin' })`.
    - Assert `await expect(readConfinedByWalk(tmp, ['x'], LIMITS)).rejects.toMatchObject({ name: 'WalkReadError', code: 'unsupported-platform', depth: -1 })`.
    - Restore the descriptor in `finally`. The planner verified that `process.platform` is configurable on node 24.

  **Linux (`describe.skipIf(!ON_LINUX)`).** The fixture is `root = <realpath tmp>/agent-a` holding `hello.txt` (`'be kind'`, 7 bytes) and `docs/note.md` (`'all good'`), plus `outside = <tmp>/outside` holding `secret.txt` and `b/file.txt`, both `SECRET`. Use no `.shared` or `sf_` paths.
  - **Basic reads:**
    - Reading a file gives `{kind:'file', truncated:false}` with text `'be kind'`. A nested file reads too.
    - Listing `[]`-relative `docs` (root `<root>/docs`) gives `[{name:'note.md',kind:'file'}]`.
    - Listing the agent root gives entries that `toEqual`, sorted, `[{name:'docs',kind:'dir'},{name:'hello.txt',kind:'file'}]`, with `truncated: false` and no other keys.
    - A missing leaf, and a missing intermediate, give `{kind:'absent', reason:'missing'}`.
    - A file used as a directory gives `reason: 'link-or-not-dir'`.
  - **Limits:**
    - A file of exactly `limitBytes` is whole.
    - A file of `limitBytes + 1` is cut to `limitBytes` with `truncated: true`.
    - A listing capped at `maxEntries` sets `truncated`. An exact fit doesn't.
  - **SECURITY, symlinks:**
    - A leaf linking to `outside/secret.txt` gives `reason: 'link-or-not-dir'`, and `JSON.stringify(r)` doesn't contain SECRET.
    - A relative in-root leaf (`alias.md -> hello.txt`) is absent.
    - An intermediate linking out (`a -> outside`, reading `a/b/file.txt`) is absent, with no SECRET.
    - **NEW:** an in-root intermediate (`alias -> docs`, reading `['alias','note.md']`) gives `reason: 'link-or-not-dir'`.
    - A symlinked dir as the leaf is absent.
    - A symlink as the first component (`<root>/evil -> outside`) is absent for both `['evil']` and `['evil','secret.txt']`.
    - A listing omits a leaf link, a dir link and a dangling link.
  - **SECURITY, special files:**
    - A FIFO leaf doesn't block and gives `reason: 'not-file-or-dir'`.
    - A FIFO as an intermediate is absent.
    - A FIFO is omitted from a listing.
    - `readConfinedByWalk('/dev', ['null'], …)` gives `reason: 'not-file-or-dir'`.
  - **Search-only directory** (`it.skipIf(IS_ROOT)`):
    - With `chmod(docs, 0o311)`, `['docs','note.md']` reads `'all good'`.
    - `['docs']` rejects `{ code: 'EACCES' }`.
    - `afterEach` restores 0o755.
  - **Resource caps:**
    - `MAX_WALK_SKIPPED + 50` symlinks give `{kind:'dir', entries:[], truncated:true}`.
    - A few skipped entries don't truncate.
    - A small file under the `MAX_WALK_LIMIT_BYTES` limit is whole.
    - A 3 MiB file under a 2 MiB limit gives a 2 MiB prefix with `truncated: true`.
  - e011da3's race test **moves to Task 2**, pointed at `readConfinedUserFiles`. Don't keep a second copy here.
- [ ] **Step 3: Create `walk-read.ts`** (the deviations above).
- [ ] **Step 4: Run on macOS.** Run `pnpm --filter @ax/user-files-read test`. Expected: the cross-platform cases pass, and the on-disk describes are reported **skipped**.
- [ ] **Step 5: Run in Linux.** Run `"$SCRATCH/linux-test.sh" "$PWD" @ax/user-files-read`. Expected: every `walk-read.test.ts` case passes and **none** is skipped (uid 1000 isn't root).
- [ ] **Step 6: Typecheck.** Run `pnpm --filter @ax/user-files-read build`. Expected: exit 0.
- [ ] **Step 7: Commit.**
  ```bash
  git add packages/user-files-read/src/errors.ts packages/user-files-read/src/walk-read.ts \
    packages/user-files-read/src/__tests__/walk-read.test.ts packages/user-files-read/src/confined-read.ts
  git commit -m "feat(user-files-read): re-land the per-component no-follow walk (TASK-899)"
  ```
- [ ] **Step 8: Mutants.** Run one at a time, restore between each, and assert `git status --short` is empty. Use the Linux runner unless noted. Each mutant must turn the named tests red.
  - **M1.1** Drop `constants.O_NOFOLLOW` from the intermediate flags. Red: symlinked intermediate, in-root intermediate, first-component link.
  - **M1.2** Drop `constants.O_NOFOLLOW` from the leaf flags. Red: leaf to outside, relative in-root leaf, symlinked dir as leaf.
  - **M1.3** In `listDir`, change `fs.lstat(` to `fs.stat(`. Red: "listing omits …".
  - **M1.4** Make the skip-cap condition never true. Red: "stops a listing after MAX_WALK_SKIPPED …".
  - **M1.5** Change the intermediate `O_PATH` to `constants.O_RDONLY`. Red: the search-only test.
  - **M1.6** Delete the `process.platform !== 'linux'` block. Red **on macOS**, with `pnpm --filter @ax/user-files-read test src/__tests__/walk-read.test.ts`: the unsupported-platform test.
  - **M1.7** Drop `constants.O_NONBLOCK` from the leaf. Expected: the FIFO-leaf test fails on its 30 s timeout. Run it under `timeout 600 "$SCRATCH/linux-test.sh" …` so a stuck open can't hang the session.

---

### Task 2: `readConfinedUserFiles` becomes the walk `[tier: sensitive]`

**security-checklist:** yes. It feeds the PR's security note.

**Files:**
- Modify: `packages/user-files-read/src/confined-read.ts`. Add the adapter, rewrite the header, and delete `confineByRealpath`, `listDir`, `readFilePrefix`, `errnoOf` and the now-unused `fs`/`fsConstants` imports. Keep `VANISHED_ERRNOS` (ENOENT, ENOTDIR, ELOOP), `ConfinedReadLimits`, `DEFAULT_CONFINED_READ_LIMITS` and `safeJoinUnderRoot`, whose doc no longer says "step 1 of the walk in this file's header" in the old sense.
- Modify: `packages/user-files-read/src/__tests__/confined-read.test.ts`.
- Modify: `packages/user-files-read/vitest.config.ts`. Comment only. Both test files now leave the process: `mkfifo`, and the race test's node swapper.
- Modify: `eslint.config.mjs` lines 67–78. Comment only. Change "the ONE realpath-confined reader" to "the ONE confined reader (a per-component, no-follow walk)". The rest stands.
- Modify: `docs/plans/2026-10-20-agent-tasks-design.md` lines 773–774. The new line reads: "**Left in git history until something needs them:** the NFS `lookupcache=positive` static PV (#999). `walk-read.ts` came back in TASK-899 as the `/files` reader."

**Interfaces:**
- Consumes: Task 1's walk API.
- Produces: the unchanged signature `readConfinedUserFiles(root: string, relPath: string | undefined, limits: ConfinedReadLimits = DEFAULT_CONFINED_READ_LIMITS): Promise<ReadUserFilesOutput>`. It returns only `file`, `dir` or `absent`.

**The adapter, in this order. The order is the contract:**
1. `safeJoinUnderRoot(root, relPath)`. The lexical refusals throw exactly as today. Discard the return value.
2. `rel = relPath === undefined || relPath === '' || relPath === '.' ? '' : relPath`. The k8s provider sends `'.'` for the root.
3. If `rel !== '' && rel.split('/').length > MAX_WALK_PARTS`, return `{ kind: 'absent' }`. This is lexical, so it is the same answer whatever is on disk and no oracle. The old reader also answered absent for an over-long path.
4. `parts = splitRelPath(rel)`. A `WalkPathError` propagates, because malformed input is our bug.
5. Call `readConfinedByWalk(root, parts, { limitBytes: limits.maxFileBytes, maxEntries: limits.maxDirEntries })`.
   - Catch a `WalkReadError` whose `code` is in `VANISHED_ERRNOS` and return `{ kind: 'absent' }`. This covers a root the agent never created, at depth -1, and a path deleted mid-read.
   - Rethrow everything else, including `unsupported-platform` and `ESTALE` on the root.
6. Map to the hook shape: `{ kind: 'absent' }`, `{ kind: 'dir', entries }` or `{ kind: 'file', contents, truncated }`. Drop the walk's `reason` and its dir `truncated`.

**Header claims to make, in the file's existing voice:**
- **What it is.** One confined reader for an agent's durable subtree, shared by both realizations. The identity and ACL paragraphs stay.
- **Threat model.** The agent writes the tree and can plant a symlink at any depth, or swap one in at any moment, including between two of our steps.
- **Defense 1, lexical.** Absolute paths and `..` throw.
- **Defense 2, the walk (`walk-read.ts`).** No path is ever resolved and then reopened, so there is no check-then-use window. A symlink at any level, at the instant of lookup, fails the open, whether it points outside the subtree or inside it.
- **Defense 3, never served or named.** Symlinks, FIFOs, sockets and devices are never served and never named in a listing.
- **Absent vs broken (TASK-403).** A miss is `{ kind: 'absent' }` with nothing else, because a link and a missing file must look the same. A vanished path is absent. Every other errno throws. Each errno the walk sees is about a directory already proven to be inside this subtree, so telling them apart is no oracle.
- **What it replaced (TASK-899).** It replaced `realpath` plus a final `O_NOFOLLOW`. An agent swapping an intermediate directory for a link between the check and the open could read another tenant's file. W3's review reproduced this. On real NFS a plain read leaked 1,121 times in 20,000, and the walk 0 times in 40,000.
- **Linux only.** Elsewhere it throws `unsupported-platform` rather than fall back.
- **Known gap.** A listing that hits `MAX_WALK_SKIPPED` stops early, and the hook's dir answer can't say so.

- [ ] **Step 1: Port `confined-read.test.ts`.** Expected red: on Linux, the new tests and the moved injection points; on macOS, the cross-platform new tests.
  - **Delete:** the `confineByRealpath` describe, and the `confineByRealpath(neverWritten…)` line.
  - **Cross-platform (no disk):**
    - Keep `safeJoinUnderRoot`.
    - Keep the `..` test (`rejects.toThrow(/\.\./)`) and the absolute-path test (`/relative/`).
    - Keep the 1 MiB default-cap constant test.
    - **NEW:** "a path deeper than MAX_WALK_PARTS is absent, not an error". `readConfinedUserFiles(root, Array.from({ length: MAX_WALK_PARTS + 1 }, () => 'd').join('/'))` `toEqual({ kind: 'absent' })`.
    - **NEW:** "off Linux the reader refuses instead of answering". Stub the platform as in Task 1. The call rejects `toBeInstanceOf(UserFilesReadError)` and `toMatchObject({ code: 'unsupported-platform' })`.
  - **Linux (`describe.skipIf(!ON_LINUX)`):**
    - Every other existing `readConfinedUserFiles` test, unchanged. Each one already holds under the walk.
    - **NEW:** "'.' and '' both read the root". Both give a dir containing `hello.txt` and `docs`.
    - **NEW:** "SECURITY: an in-root symlink is not followed either". With `alias.md -> hello.txt` and `alias -> docs`, the paths `alias.md`, `alias/note.md` and `alias` each `toEqual({ kind: 'absent' })`. This is the deterministic proof that the reader is the walk: a realpath reader serves all three.
    - **NEW:** "answers carry only the hook's fields". `Object.keys(file).sort()` equals `['contents','kind','truncated']`, and dir keys equal `['entries','kind']`.
    - **NEW:** "SECURITY: an intermediate directory the host may not search is a broken read, not an absence" (`it.skipIf(IS_ROOT)`). With `chmod(docs, 0o000)`, `readConfinedUserFiles(root, 'docs/note.md')` rejects `UserFilesReadError` with `{ code: 'EACCES' }`. Restore 0o755 in `finally`.
    - **NEW race test:** "SECURITY: a directory swapped for a symlink mid-read never yields the secret". Use e011da3's swapper process and assertions verbatim. Read `readConfinedUserFiles(root, 'a/b/file.txt')`, where `a` swaps between `a.real` (holding `b/file.txt`, `'inside'`) and `a.link -> outside` (holding `b/file.txt`, SECRET). Assert at least 5,000 reads inside a 15 s deadline, `inside > 0`, `absent > 0` and `other === 0`, and that no body contains SECRET. Test timeout 30_000. Kill the swapper in `finally`.
  - **Errno block (Linux).** Move the injection points to what the walk calls. It does `import { promises as fs } from 'node:fs'`, so spy on that object.
    - A listing error of EIO or EACCES: `vi.spyOn(fs, 'opendir').mockRejectedValue(errno(…))` rejects `UserFilesReadError` with that code.
    - An `opendir` ENOENT gives `{ kind: 'absent' }`.
    - An unreachable root: wrap `fs.open` so it rejects `errno('ESTALE')` when `String(p) === root` and calls through to the original otherwise. Capture the original before spying. The call rejects `UserFilesReadError` with `{ code: 'ESTALE' }`.
    - A root never created gives absent (real filesystem).
    - Leaf failures: wrap `fs.open` to call through, and for the path ending `/hello.txt` spy on the returned handle's `read` or `stat`, or reject `ELOOP`.
      - A file read EIO throws with code EIO.
      - A partial read then EIO throws. `read` is called twice, and the leaf handle's `close` is called once.
      - A leaf `stat` EIO throws, and ENOENT gives absent.
      - An injected leaf `ELOOP` gives absent.
    - A real symlink to a sibling subtree is a plain absence.
- [ ] **Step 2: Write the adapter, delete the realpath reader, and rewrite the header.**
- [ ] **Step 3: Run on macOS.** Run `pnpm --filter @ax/user-files-read test`. Expected: the cross-platform tests pass and the Linux describes are skipped.
- [ ] **Step 4: Run in Linux.** Run `"$SCRATCH/linux-test.sh" "$PWD" @ax/user-files-read`. Expected: all pass, none skipped, and the race test passes (about 6–8 s).
- [ ] **Step 5: Typecheck and lint.** Run `pnpm --filter @ax/user-files-read build && pnpm exec eslint packages/user-files-read eslint.config.mjs`. Expected: exit 0.
- [ ] **Step 6: Commit** the five files: `git commit -m "fix(user-files-read): the /files reader walks every component instead of realpath-then-open (TASK-899)"`.
- [ ] **Step 7: Mutants.** Use the Linux runner unless noted.
  - **M2.1** Rethrow every `WalkReadError` (drop the VANISHED catch). Red: both never-created-root tests, and `opendir` ENOENT.
  - **M2.2** Map every `WalkReadError` to absent. Red: root ESTALE, listing EIO and EACCES, and the EACCES intermediate.
  - **M2.3** Drop `'.'` from step 2. Red: "'.' and '' both read the root".
  - **M2.4** Return the walk's answer unmapped. Red: "answers carry only the hook's fields", and every `toEqual({ kind: 'absent' })`.
  - **M2.5** Delete step 3. Red on macOS **and** Linux: the deeper-than-MAX test, because `WalkPathError` is thrown instead.
  - **M2.6** This proves the race test has teeth. Replace steps 4–6 with a naive `fs.readFile(path.join(root, rel))`, catching to absent. Red: the race test sees SECRET, along with the in-root-symlink and intermediate-symlink tests. A race test that passes this mutant proves nothing.

---

### Task 3: Both providers answer through the walk `[tier: integration]`

**security-checklist:** covered by the PR note from Tasks 1–2. This task changes no logic, only tests and comments.

**Files:** `packages/sandbox-k8s/src/__tests__/user-files-ops.test.ts`, `packages/sandbox-subprocess/src/__tests__/user-files-host-ops.test.ts`, `packages/sandbox-subprocess/src/__tests__/userfiles-canary.acceptance.test.ts`, plus the comment hunks in the Files table.

**Interfaces:** consumes Task 2's `readConfinedUserFiles`. The providers' `readUserFiles` signatures don't change.

- [ ] **Step 1: Guard the walk-dependent tests** with `it.skipIf(!ON_LINUX)`, defining `ON_LINUX` once per file as in the Global Constraints.
  - **k8s, host-mounted describe:**
    - Guard "lists the agent subtree WITHOUT creating a pod", "reads a nested file, exact bytes, no pod", "returns absent for a missing path" and "SECURITY: never opens a writable handle".
    - Split "CROSS-TENANT" in two. The `../` PluginError half stays cross-platform, because the provider's `safeRelPath` refuses it before the library. The intermediate-symlink half goes under the guard.
    - Leave "returns UNAVAILABLE …" and "falls back to the one-shot pod …" unguarded.
  - **subprocess `user-files-host-ops.test.ts`:**
    - Guard "lists the mount root directory", "reads a file under the mount", "returns absent for a missing path", the three SECURITY symlink tests and "never opens a writable handle".
    - Leave UNAVAILABLE, `..` and absolute unguarded.
  - **subprocess canary:** guard "the host reads an agent file back via sandbox:read-user-files (read-only)".
- [ ] **Step 2: Add the new provider tests (Linux):**
  - k8s: "an in-root symlink is absent: the host-mounted read is the per-component walk". Seed `agent-abc`, add `alias.md -> hello.txt` and `alias -> docs`. Reading `alias.md` and `alias/note.md` gives `{ kind: 'absent' }`, and `api.creates` has length 0.
  - k8s: "an agent that has never written anything reads as absent, not an error". Don't seed. The call `toEqual({ kind: 'absent' })` with no pod. This is production's most common case.
  - subprocess: "an in-root symlink is absent", with the same two links as the k8s test.
- [ ] **Step 3: Fix the comments.**
  - **`user-files-ops.ts` 693–702:** the reader opens every component of `rel` relative to the directory it already holds and refuses symlinks, which stops a planted or mid-read-swapped link reaching a sibling's subtree. Remove "realpath-confines".
  - **`config.ts` 152–158:** "the realpath confinement" becomes "the per-component no-follow walk".
  - **`user-files-host-ops.ts` 35–46 and 121–127:** describe lexical rejection, then a per-component `O_NOFOLLOW` walk that refuses a symlink at any depth, planted or swapped mid-read. Symlink children are dropped and caps apply. Off Linux the read throws `unsupported-platform` instead of falling back. No shipped entry point pairs this provider with the Files routes, and its real-file tests run on Linux (CI).
  - **`routes-workspace.ts` 6848–6851:** "realpath-confines every component under it" becomes "walks every component under it without following a symlink, so an agent-planted link — even one swapped in mid-read — cannot walk out of its own subtree".
- [ ] **Step 4: Run on macOS.** Run `pnpm --filter @ax/sandbox-k8s --filter @ax/sandbox-subprocess --no-bail run test`. Expected: green, with the guarded tests skipped.
- [ ] **Step 5: Run in Linux.** Run `"$SCRATCH/linux-test.sh" "$PWD" @ax/user-files-read @ax/sandbox-subprocess @ax/sandbox-k8s`. Expected: all three green, the new tests run, and nothing walk-related is skipped.
- [ ] **Step 6: Typecheck and lint.** Run `pnpm --filter @ax/sandbox-k8s --filter @ax/sandbox-subprocess --filter @ax/channel-web build` and lint the touched files. Then commit.
- [ ] **Step 7: Mutant re-runs.** Run both with all three packages on the Linux runner. These show the provider tests are wired to the walk.
  - **M1.1:** both providers' new in-root tests go red, along with the existing intermediate-symlink tests.
  - **M2.1:** k8s "never written anything" and the subprocess canary's "no-such-agent → absent" go red.

---

### Task 4: Keep the preset canaries honest off Linux `[tier: mechanical]`

**Files:** `presets/memory/src/__tests__/canary.test.ts` and `presets/k8s/src/__tests__/acceptance.test.ts`. Each defines `ON_LINUX` once, with one comment line: the `/files` reader is the Linux-only walk, and CI runs these on ubuntu.

- [ ] **Step 1: Guard exactly these tests** with `it.skipIf(!ON_LINUX)`. Each one's answer comes from the reader, so off Linux it would 500.
  - **memory canary:**
    - "the durable tier: folder, file and download answer, not index.html"
    - "double-encoded traversal is decoded once, so it is a literal filename that does not exist" (its 404 is the reader's)
    - "an agent-planted symlink into a neighbours subtree does not read through"
    - "a third user sees Alice as absent too, and Bob still reads his own files"
  - **memory canary, leave unguarded.** These are answered before the reader: 401, unknown `/api`, encoded `../` (400), neighbour by id (400), collapsed `../`, root download (400) and cross-tenant (ACL 404).
  - **k8s acceptance:** guard "F4 canary: the durable user-files tier is browsable over GET /api/workspace/agents/:id/user-files", keeping its `{ timeout: 180_000 }`.
- [ ] **Step 2: Verify.** Run `pnpm --filter @ax/preset-memory --filter @ax/preset-k8s build`. If `DOCKER_HOST` is configured, run both suites on macOS. Expected: the guarded tests skip and the rest pass. Otherwise say so. CI is the Linux run, and Phase 4 checks that CI executed them.
- [ ] **Step 3: Commit.**

---

### Task 5: The pod-per-call reader, documented out of scope `[tier: mechanical]`

**security-checklist:** covered by the PR note. This task is documentation only.

**Files:** `packages/sandbox-k8s/src/user-files-ops.ts` (lines 490–516 and 660–679), `packages/sandbox-k8s/SECURITY.md`, `deploy/charts/ax-next/values.yaml` (lines 344–351) and `deploy/charts/ax-next/templates/host/deployment.yaml` (lines 355–359).

**Claims to make:**
- **The gap.** The pod script confines with `realpath` and then reads or lists `$target` by name. That is the check-then-read shape TASK-899 removed from the host-mounted reader. The pod mounts the whole export, so an agent that swaps a directory on the path for a link between the two steps could in principle have the pod read through it.
- **Why it is out of scope:**
  - The walk is an in-process Node mechanism over `/proc/<pid>/fd`, and this pod runs a POSIX shell script in the runner image.
  - Production sets `sandbox.filestore.hostReadPath`, so this path runs only where the export isn't mounted into the host.
  - W3b's race harness had to put the swapper and reader on one mount, because across two NFS clients the reader kept seeing its own cached lookups. That lowers the odds here. It isn't a guarantee, and nobody has measured it for this pod.
- **Mitigation.** Set `hostReadPath`.

- [ ] **Step 1: `user-files-ops.ts`.**
  - Add a "KNOWN GAP (TASK-899)" paragraph to the pod host-read block (490–516), with the claims above.
  - In `readUserFiles`' doc (660–679), say the SET branch is the walk and the UNSET branch has the documented gap.
- [ ] **Step 2: `SECURITY.md`.**
  - Rewrite "Filesystem reach (host plugin side)" (lines 59–61). It is false today, because its grep finds `storage-client.ts`'s `readFileSync`.
    - With `userFilesHostReadRoot` set, the host reads the user-files export read-only through `@ax/user-files-read`'s walk.
    - With the shared pool, `storage-client.ts` reads the storage-helper mTLS files from the mounted secret.
    - Nothing writes.
  - Add a "Known limits" bullet with the gap, why it is out of scope, the mitigation, and the follow-up card id.
- [ ] **Step 3: Chart comments.**
  - In `values.yaml`, "realpath confinement in the reader" becomes "a reader that walks each path component without following symlinks". Then add, plainly: leaving `hostReadPath` empty isn't the cautious choice it looks like, because the pod-per-call reader checks a path and then reads it, and an agent that swaps a folder for a link at the right moment could in principle win that race. The host-mounted reader doesn't have that gap.
  - In `deployment.yaml`, "realpath confinement in @ax/user-files-read" becomes "the per-component no-follow walk in @ax/user-files-read".
  - These are comments only. The chart render tests don't snapshot them.
- [ ] **Step 4: File the follow-up card.** Standalone: create the Backlog card yourself. Orchestrated: put it in the handoff.
  - Title: `[TASK-n] /files reader pod: close the check-then-read gap, or retire the pod path`. Depends on: `none`.
  - Body: the gap, plus two options. (a) Open-then-verify in the script: `cd -P` per directory and check `pwd -P`, then open the file on fd 3 and confine `readlink /proc/self/fd/3` before reading from fd 3, proven on real NFS like W3b. (b) Retire the pod realization and have the durable Files tab answer `unavailable` without `hostReadPath`.
  - Put the card id into the `SECURITY.md` bullet.
- [ ] **Step 5: Commit.**

---

## Phase 4 notes (for the builder, not a task)

- **macOS gate:** `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. Walk-dependent tests show as skipped there, and that is expected.
- **Linux gate:** `"$SCRATCH/linux-test.sh" "$PWD" @ax/user-files-read @ax/sandbox-subprocess @ax/sandbox-k8s`. Expect 0 failures, and **0 skipped** in `walk-read.test.ts` and `confined-read.test.ts`.
- **CI:**
  - In "Test (affected packages + dependents)", confirm `@ax/user-files-read` ran the race test.
  - Confirm `@ax/preset-memory` and `@ax/preset-k8s` executed the Task 4 tests rather than skipping them.
  - Compare the run's head SHA to the PR head.
- **PR body:**
  - **Security review** block:
    - **Sandbox:** reach narrows. Every component is opened relative to a held descriptor with `O_NOFOLLOW` (`O_PATH` for pass-through directories, or `O_RDONLY` on the one retry after `ESTALE` so NFS revalidates them; `O_NONBLOCK` on the leaf), so no symlink is followed at any depth or moment, on either walk. Caps are unchanged. It's Linux-only and loud elsewhere. The pod path is a documented gap with its follow-up card.
    - **Injection:** the route-validated `relPath` is lexically checked, split and walked. It never reaches a shell, prompt or SQL. File names and bytes are returned as data.
    - **Supply chain:** N/A — no `package.json` or lockfile change.
  - **Boundary review:** not needed. This changes internal implementation only, with no hook-signature change.
  - **Behavior changes:** Review Focus items 2–6.
  - **Out of scope:** the pod path, with its follow-up card.
- **Decisions shard:** add a row for any deviation from this plan to `.claude/memory/decisions/2026-10-21-TASK-899.md`, and commit it with the work.
