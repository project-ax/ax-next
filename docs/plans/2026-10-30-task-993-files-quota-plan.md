# TASK-993 — Meter `/files` toward the storage quota; over quota blocks uploads, not chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count every agent's `/files` toward its owner's storage limit (measured after each turn and on the periodic sweep), stop turning a full person's chat away, keep refusing their uploads and published files, raise the default limit to 10 GiB, and tell people the true remedy: ask the agent to clean up, or ask an admin.

**Architecture:** A new host-internal service hook, `sandbox:user-files-usage { agentId } → { bytes }`, is registered by both sandbox providers next to `sandbox:read-user-files`. Both realize it with one new bounded, no-follow walk in `@ax/user-files-read`. `@ax/disk-quota` calls the hook (as an `optionalCall`) on each assistant `chat:turn-end` and on its 6-hourly sweep. It records an `agent-files:<agentId>` ledger row (new kind `agent-files`) charged to the agent's owner, folds that row into the existing "Agent files" total, and drops it on `agents:deleted`. The `chat:start` veto goes away; the `blob:pre-put` gate stays.

**Tech Stack:** TypeScript + vitest; Postgres via testcontainers (`@ax/disk-quota`, `presets/k8s` canary); Node `fs` over `/proc/self/fd` (Linux only); Helm values comments; Markdown docs.

**Spec:** `docs/plans/2026-10-29-agent-files-simplification-design.md` §12 (disk quota), §16 slice 3, §3 anti-goals. Card body: TASK-993. Decisions: `.claude/memory/decisions/2026-10-30-TASK-993.md` (read it: every "why" below is there).

## Brainstorm, self-answered (the questions a human would have been asked)

1. **Where does host-read of `/files` live today?** `sandbox-k8s/src/user-files-ops.ts` `readUserFiles` (host-mounted read under `config.userFilesHostReadRoot`, else a one-shot pod) and `sandbox-subprocess/src/user-files-host-ops.ts` `readUserFiles` (the resolved `localDir` `hostPath`). Both resolve the agent's mount through `sandbox:resolve-mounts` and read through `@ax/user-files-read`. The meter goes beside them.
2. **Which providers load where?** `presets/k8s` loads only `@ax/sandbox-k8s` ("No subprocess fallback", `index.ts:922`), and is the only composition that loads `@ax/disk-quota`. The CLI loads `@ax/sandbox-subprocess` and no disk-quota. Test compositions swap k8s for subprocess plus `@ax/workspace-localdir`. Only one provider is ever loaded (both register `sandbox:open-session`, and bootstrap refuses a duplicate), so registering one more hook in both adds no new collision.
3. **How does the host read an agent's `/files` in production?** Prod and kind set `sandbox.filestore.hostReadPath: /user-files` (TASK-899, TASK-992), so the export is mounted read-only into the host pod and `<hostReadRoot>/<agentId>` is a local path. Without it, the k8s provider has only the pod-per-call path, which is far too expensive for a meter. There the hook throws `user-files-usage-unavailable`.
4. **Can the existing git meter's walker (`workspace-git-core/src/disk-usage.ts`) be reused?** No. It `lstat`s by path, then `readdir`s by path. An agent that swaps a folder for a symlink between those two calls makes it walk another tenant's subtree, or `/` on the host: the W3b window. The new walk opens every directory relative to a held descriptor with `O_NOFOLLOW`.
5. **What does disk-quota meter today?** One row per `(owner_id, source)` in `disk_quota_v1_usage`, `kind IN ('workspace','blob')` (a CHECK constraint). `workspace:<agentId>` rows are re-measured on `workspace:applied` and on the sweep (`agents:list-personal-owners`, personal agents only); `blob:<sha>` rows are written on `blob:stored`. Gates: `blob:pre-put` and `workspace:pre-apply` fail closed; `chat:start` (`admitTurn`) fails open. Limits come from `settings:disk-quota` (`limitMb` 1024, `warnPercent` 80, `graceMs` 24 h), with bounds checked server-side (`LIMIT_BOUNDS`) and mirrored client-side (`STORAGE_LIMIT_BOUNDS`).
6. **What is the turn-end hook?** `chat:turn-end`, fired by `@ax/ipc-core` on the runner's `event.turn-end`. Its ctx carries the session's `agentId`/`userId`. The runner sends it twice per turn, `role: 'tool'` first, then `role: 'assistant'` (always), so measuring on the assistant one is once per turn.
7. **`agents:deleted`?** Exists: `{ agentId, ownerId, ownerType: 'user' | 'team' }`. `@ax/agents` fires it after the row is gone, with a 150 s per-subscriber bound. The sandbox providers already subscribe it to `rm -rf` the agent's `/files`.
8. **Is chat blocked anywhere else when full?** Only through the `chat:start` veto, which channel-web shows as `chat:start:storage-full` (`turn-error-labels.ts`). The Storage tab's `FULL_BODY` says "new messages are held". Both change here; the label stays for replayed history.
9. **Are alerts managed in the repo?** No (`deploy/` has no monitoring or alert-policy material), so the Filestore alert is documented in `deploy/GKE.md`.
10. **New row kind or reuse `workspace`?** New kind `agent-files`. Design §10's reset deletes `kind='workspace'` rows, and TASK-995 removes the git tier.

## Premises corrected (report these in the PR)

- **`channel-web/src/lib/storage-full-copy.ts` is dead.** Since TASK-989 its two constants (`STORAGE_FULL_RULES`, `STORAGE_FULL_IDENTITY`) have no caller; only tests and a re-export reach them. The live person-facing copy is `lib/storage-copy.ts`, plus `@ax/disk-quota`'s `blobFullMessage`, which the upload path shows verbatim. This plan deletes the dead file and rewrites the live copy (Task 7).
- **"A missing/unreadable home reports an error rather than 0"** is kept for a missing *mount* (`home-unavailable`), a missing *export*, and an unreadable root. A per-agent folder that does not exist yet (the agent never had a session) reads 0, which is what `@ax/user-files-read` already says about it. See the decisions shard.
- **"Registered by the providers that own host-read":** true, but k8s can measure only through the host mount (`hostReadPath`). Production composes only the k8s provider with disk-quota; the subprocess realization is exercised end to end by the disk-quota canary.
- **"Drop all of that agent's rows":** `agents:deleted` drops the `agent-files` row. The git `workspace:<id>` row keeps TASK-719's `workspace:deleted` release until TASK-995, which the card itself says owns git-tier quota code.

## Global Constraints

- **Do NOT touch the git tier or its quota code (TASK-995):** `workspace:*` hooks, `workspace-git*` packages, the `workspace:deleted` subscriber, `workspace:pre-apply`/`workspace:applied` metering, `workspace:usage`, `measureDirBytes`, `workspaceFullMessage`, and the TASK-720 save-refused plumbing (`SAVE_REFUSED_COPY` text, runner `saveRefused`, ipc-core). One exception: `save-refused-copy.ts:17-18` is a comment that points at a file this card deletes.
- **No delete action anywhere** (Files tab, routes, hooks): a host write path into an agent-writable tree is a §3 anti-goal.
- **Hook contract, exactly:** name `sandbox:user-files-usage`; input `{ agentId: string }`; output `{ bytes: number }` (allocated bytes). Not an IPC action.
- **Ledger:** kind `agent-files`, source `agent-files:<agentId>`, CHECK constraint name `disk_quota_v1_usage_kind_check`.
- **Limits:** default `limitMb: 10240`; bounds unchanged (`64..10_485_760` MB, server and client).
- **No new dependencies.** `@ax/disk-quota` does not import `@ax/sandbox-mount-protocol`; it reads the hook's answer as `unknown`.
- **Linux-only tests** (anything that walks a real directory) use `const ON_LINUX = process.platform === 'linux' && existsSync('/proc/self/fd');` with `describe.skipIf(!ON_LINUX)` / `it.skipIf(!ON_LINUX)`, as `walk-read.test.ts` does. Permission tests also skip as root (`IS_ROOT = process.getuid?.() === 0`).
- **Copy:** CLAUDE.md "Voice & Tone"; invoke the `ux-design` skill once for all four sentences in Task 7. Person-facing sentences carry no digits, no jargon, and no "delete"/"remove".
- **Cluster safety:** no kubectl, helm or gcloud against any cluster. Docs only describe gcloud commands.
- **Public repo:** no RFC1918 address, project ID or prod domain in docs. Use `<PROJECT_ID>` / `<CHANNEL_ID>` placeholders.
- **Gate (whole branch, before the PR):**
  - `pnpm build`
  - `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`
  - `pnpm lint`
  - Docker-backed suites (`@ax/disk-quota`, `presets/k8s` canaries) need `DOCKER_HOST` (local: `unix:///Users/vpulim/.orbstack/run/docker.sock`).
  - Per package: `pnpm --filter <pkg> test` (filter BEFORE the script name).

## Review Focus

1. **An agent tree that points out of itself:** a symlink to a sibling agent's folder or to `/`, or a folder swapped for a symlink mid-walk. Nothing outside the agent's root is counted or even listed. Tests in Task 1 (symlink file, symlinked dir, swap between `lstat` and `open`, `/proc/self/fd` + `O_NOFOLLOW` on every child open) and Task 2 (sibling agent never counted).
2. **An agent deleted while it is being measured, or a warm runner's late turn end after the delete.** No `agent-files` row comes back. Tests in Task 5 (held measurement, then a late turn end and a sweep after the release) and Task 6 (canary).
3. **A huge or hostile tree:** a million files, 10k-deep nesting, FIFOs, folders with no read permission, non-UTF-8 names. The walk never blocks, never leaks descriptors, stays bounded, returns a lower bound flagged partial, and the host runs at most two walks at once. Tests in Task 1 (caps, FIFO, unreadable folder, non-UTF-8 name, descriptor count) and Task 5 (concurrency limit).
4. **A k8s deployment without `hostReadPath`, a missing export, or an unreadable root:** an error, never 0, and no pod per turn. Tests in Task 1 (missing parent, unreadable root) and Task 2 (`user-files-usage-unavailable`, no `createNamespacedPod`).
5. **A team agent's turn end, or an agent whose owner cannot be resolved:** charged to `team:<id>`, never to the member who chatted; unresolvable means charged to nobody, so there are no duplicate rows. Tests in Task 5.

## Boundary review — `sandbox:user-files-usage` (copy into the PR)

- **Alternate impl:** a storage backend that reports per-directory usage itself (a quota-capable NFS server, or an object store summing an agent prefix for a bucket-backed `/files`). Today: the k8s host-mount walk and the subprocess local-dir walk.
- **Payload field names that might leak:** none (`agentId`, `bytes`). No server, export, subPath, path or pod name crosses the hook.
- **Subscriber risk:** none. It is a service hook with one caller (`@ax/disk-quota`), which reads only `bytes` and validates it as a finite non-negative number.
- **Wire surface:** not an IPC action. Host-internal; types in `@ax/sandbox-mount-protocol` beside `sandbox:read-user-files`.

## Security notes (feed the PR's `security-checklist` walk)

- New capability: the host process reads directory *metadata* (names, `lstat`) of an agent-writable tree through the existing read-only mount. It opens nothing but directories, never opens a writable handle, never follows a symlink, and spawns no process.
- Untrusted input: the tree's shape and names (agent-written). Bounded by entries, depth and time, plus two walks at once host-wide. Names are only ever path components handed to the kernel; never logged, never returned.
- Output reaches people only as a byte total, on the owner's own Storage tab and the admin view.
- Known residual: an agent that removes read/search permission from its own folders hides them from the meter. The reading is flagged partial and logged; the Filestore capacity alert is the backstop.
- `chat:turn-end`'s payload is runner-reported. The meter reads only `role` (already zod-validated by ipc-core) to skip the tool turn-end; `agentId`/`userId` come from the host-stamped ctx.

---

### Task 1: The confined usage walk in `@ax/user-files-read` [tier: sensitive] [security-checklist]

**Files:**
- Create: `packages/user-files-read/src/measure.ts`
- Modify: `packages/user-files-read/src/walk-read.ts`: export `errnoOf` (`:180`) and `fdPath` (`:208`); move the platform guard at `:231-236` into an exported `assertWalkPlatform(): void` (same error, same code) that `readConfinedByWalk` calls. No behaviour change.
- Modify: `packages/user-files-read/src/index.ts`: add `export * from './measure.js';`
- Test: `packages/user-files-read/src/__tests__/measure.test.ts`

**Interfaces:**
- Produces (exported from `@ax/user-files-read`):
  ```ts
  export interface UsageWalkLimits { maxEntries: number; maxDepth: number; maxMs: number }
  export const DEFAULT_USAGE_WALK_LIMITS: Readonly<UsageWalkLimits>; // { maxEntries: 1_000_000, maxDepth: 64, maxMs: 120_000 }
  export interface UsageReading { bytes: number; entries: number; complete: boolean }
  export function measureConfinedUserFiles(
    root: string,
    limits?: UsageWalkLimits,
    clock?: () => number, // ms; default Date.now
  ): Promise<UsageReading>;
  ```

**Rules the implementation must follow (the algorithm; these are what the tests pin):**
- Import `promises as fs` from `node:fs`, as `walk-read.ts` does, so the tests' `vi.spyOn(fs.promises, 'open')` sees every open.
- Validate limits first: each a safe integer, `maxEntries >= 1`, `maxDepth >= 0`, `maxMs >= 1`; otherwise `RangeError`. Then `assertWalkPlatform()`.
- **Root** (trusted configuration; may itself be a symlink, as in `readConfinedByWalk`): `fs.promises.open(root, O_RDONLY | O_DIRECTORY)`.
  - ENOENT: `stat(path.dirname(root))`. If that is a directory, return `{ bytes: 0, entries: 0, complete: true }`. Otherwise throw `UserFilesReadError` with the parent's errno code (`'ENOENT'` when it is missing).
  - Any other error opening, `fstat`ing or listing the root throws `UserFilesReadError` with the errno code (use `errnoOf`).
  - Count the root's own allocated bytes.
- **Allocated bytes of a stat:** `Number.isFinite(st.blocks) ? st.blocks * 512 : st.size`.
- **Iterative depth-first walk.** Each stack frame holds the directory's `FileHandle` (its fd names `/proc/self/fd/<fd>`) and a `Dir` from `fs.promises.opendir(fdPath(fd), { encoding: 'buffer', bufferSize: 64 })`; the root frame has depth 0. For each entry:
  - Skip names `.` and `..` (Buffer compare).
  - Every 256 entries, stop if `clock() - start > maxMs`. If `entries` would exceed `maxEntries`, stop. Either way, `complete = false`.
  - `entries++`. The child path is `Buffer.concat([Buffer.from(fdPath(fd) + '/'), name])`; `lstat` it.
    - ENOENT: skip, entry vanished; `complete` unchanged.
    - Any other errno: skip, `complete = false`.
  - Add the entry's allocated bytes, whatever its type.
  - If it is a directory:
    - When `depth + 1 > maxDepth`, set `complete = false` and do not descend.
    - Else open the same Buffer path with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`. ENOENT, ELOOP or ENOTDIR (swapped or vanished) means skip, `complete` unchanged. Any other errno means skip, `complete = false`.
    - Then `opendir` it as above (an error closes the handle and sets `complete = false`) and push the frame.
  - Never open anything that is not a directory.
- Below the root, a `dir.read()` error closes and pops that frame and sets `complete = false`. On the root frame it throws.
- `finally`: close every open `Dir` and `FileHandle`, swallowing close errors.
- File header comment: the threat model (agent-written tree, sibling tenants on the same export, swaps at any moment), why `measureDirBytes` is not reused (W3b), the bounds and why each exists, what "partial" means, and the known residual (permission-hidden folders).

- [ ] **Step 1: Write the failing tests** in `measure.test.ts`. Copy the `ON_LINUX` / `IS_ROOT` / platform-override helpers from `walk-read.test.ts`. The oracle for every byte expectation is `allocated(lstatSync(p))` summed over the root and every entry the walk should count, computed in the test.
  - Runs everywhere:
    - `'off Linux it throws unsupported-platform before touching the disk'`: `rejects.toMatchObject({ code: 'unsupported-platform' })` with `process.platform` forced to `'darwin'`.
    - `'rejects limits out of range with a RangeError'`: `maxEntries: 0`, `maxDepth: -1`, `maxMs: NaN`.
  - `describe.skipIf(!ON_LINUX)`:
    - `'sums allocated bytes of every file and folder, the root included'`: `a.bin` (10_000 B), `sub/b.bin` (5_000 B), `sub/deeper/c.bin` (1 B). Expect `{ bytes: oracle, entries: 5, complete: true }`.
    - `'an empty home is its own folder, complete'`.
    - `'a home folder that does not exist yet is 0 when the export exists'`: `{ bytes: 0, entries: 0, complete: true }`.
    - `'a missing export is an error, not 0'`: root under a missing parent rejects `UserFilesReadError` with `code: 'ENOENT'`.
    - `it.skipIf(IS_ROOT)('an unreadable home is an error, not 0')`: `chmod 000` the root; rejects with `code: 'EACCES'`; restore in `finally`.
    - `'SECURITY: a symlink to a big file outside the root counts as the link only'`: `outside/secret.bin` (4 MiB) and `root/link -> ../outside/secret.bin`; `bytes === oracle(root, link)`.
    - `'SECURITY: a symlinked folder is never descended'`: `root/escape -> outside/` holding 4 MiB; `bytes === oracle(root, escape)`.
    - `'SECURITY: a folder swapped for a symlink between its lstat and its open is not followed'`: `vi.spyOn(fs.promises, 'open')`. On the first call whose path (a Buffer: compare its string form) ends in `/victim`, first `rmSync(root/victim, { recursive: true })` and `symlinkSync(outsideDir, root/victim)`, then delegate. Expect the outside bytes not counted and `complete: true`.
    - `'SECURITY: every folder below the root is opened through the held parent descriptor with O_NOFOLLOW'`: spy `fs.promises.open`. Every call after the first has a path whose string form matches `/^\/proc\/self\/fd\/\d+\//`, and `flags & constants.O_NOFOLLOW` and `flags & constants.O_DIRECTORY` are both non-zero.
    - `'a FIFO is counted by lstat and never opened'`: `execFileSync('mkfifo', [root + '/pipe'])`; resolves `complete: true` (the test's own timeout is the "no hang" proof).
    - `'a file name that is not valid UTF-8 is still counted'`: `writeFileSync(Buffer.concat([Buffer.from(root + '/'), Buffer.from([0x66, 0xff, 0x6f])]), Buffer.alloc(3000))`; `bytes === oracle` including it.
    - `it.skipIf(IS_ROOT)('a folder it may not read is skipped and the reading is partial')`: `locked/` (mode 000) holding a file; `complete: false`; bytes include `locked` itself but not its child.
    - `'stops at maxEntries and says the reading is partial'`: 5 files, `maxEntries: 3`, so `entries: 3, complete: false`.
    - `'does not descend past maxDepth, and says so'`: `d1/d2/d3/deep.bin`, `maxDepth: 2`, so `complete: false` and `deep.bin` is not counted.
    - `'stops when maxMs runs out, and says so'`: a clock that advances 1_000 per call, `maxMs: 1`, at least 300 files; `complete: false`.
    - `'closes every descriptor it opened'`: `readdirSync('/proc/self/fd').length` is the same before and after a full walk of a 3-deep tree and after a capped walk.

- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @ax/user-files-read test`. Expected: FAIL, `measureConfinedUserFiles` is not exported (on macOS the Linux block is skipped).

- [ ] **Step 3: Implement** `measure.ts` and the `walk-read.ts` exports per the rules above.

- [ ] **Step 4: Run the package tests.** `pnpm --filter @ax/user-files-read test`. Expected: PASS, with `walk-read.test.ts` and `confined-read.test.ts` unchanged and green. Then `pnpm --filter @ax/user-files-read build`.

- [ ] **Step 5: Commit** `feat(user-files-read): confined, bounded usage walk for an agent's /files (TASK-993)`.

---

### Task 2: The hook contract and both providers register `sandbox:user-files-usage` [tier: sensitive] [security-checklist]

**Files:**
- Modify: `packages/sandbox-mount-protocol/src/mount-spec.ts`: append a `sandbox:user-files-usage` section after `ReadUserFilesHandler` (`:304`). Its comment says host-internal and not an IPC action, allocated bytes, never follows a symlink, a bounded reading may be a lower bound, and the error cases below.
- Test: `packages/sandbox-mount-protocol/src/__tests__/mount-spec.test.ts`: add a `describe('sandbox:user-files-usage signature (TASK-993)')` in the style of the read-user-files one (input `{ agentId }`, output `{ bytes }`, handler assignable to `ServiceHandler`).
- Modify: `packages/sandbox-k8s/src/user-files-ops.ts`: add `measureUserFiles`. Import `measureConfinedUserFiles` on the SAME import line as `readConfinedUserFiles`; `SECURITY.md`'s grep check counts lines. Extend the file header's list to three host-side ops.
- Modify: `packages/sandbox-k8s/src/plugin.ts:71-78`: add to `registers`, update the comment, and register beside `sandbox:read-user-files` (`:200-205`) with `{ timeoutMs: 180_000 }`.
- Modify: `packages/sandbox-k8s/src/config.ts:140-162`: the `userFilesHostReadRoot` doc adds that `sandbox:user-files-usage` measures through it and throws `user-files-usage-unavailable` when it is unset.
- Modify: `packages/sandbox-k8s/SECURITY.md:64`: the "user-files export, read-only" bullet adds that, for the storage limit, the host also walks an agent's folder for sizes (directories opened through the held descriptor, nothing else opened). Keep the `:67` grep claim true: still four lines.
- Modify: `packages/sandbox-subprocess/src/user-files-host-ops.ts`: add `measureUserFiles` and extend the header.
- Modify: `packages/sandbox-subprocess/src/plugin.ts:44-48,95-102`: add to `registers`, update the comment, register with `{ timeoutMs: 180_000 }`.
- Modify: `deploy/charts/ax-next/values.yaml:353-386` (the `hostReadPath` comment, comment only): add one short paragraph saying this mount is also what lets the storage limit count each agent's files; with it empty, agents' files are not measured (uploads and published files still are).
- Tests: `packages/sandbox-k8s/src/__tests__/user-files-ops.test.ts`, `packages/sandbox-k8s/src/__tests__/plugin.test.ts`, `packages/sandbox-subprocess/src/__tests__/user-files-host-ops.test.ts`

**Interfaces:**
- Consumes: `measureConfinedUserFiles`, `UsageReading` (Task 1).
- Produces:
  ```ts
  // @ax/sandbox-mount-protocol
  export interface UserFilesUsageInput { agentId: string }
  export interface UserFilesUsageOutput { bytes: number }
  export type UserFilesUsageHandler = ServiceHandler<UserFilesUsageInput, UserFilesUsageOutput>;
  // @ax/sandbox-k8s user-files-ops.ts
  export function measureUserFiles(ctx: AgentContext, bus: HookBus, config: ResolvedSandboxK8sConfig,
    log: Logger, input: UserFilesUsageInput): Promise<UserFilesUsageOutput>;
  // @ax/sandbox-subprocess user-files-host-ops.ts
  export function measureUserFiles(ctx: AgentContext, bus: HookBus, pluginName: string,
    log: Logger, input: UserFilesUsageInput): Promise<UserFilesUsageOutput>;
  ```
- Behaviour, both providers, in this order:
  1. `input?.agentId` must be a non-empty string; otherwise `PluginError` code `invalid-input`.
  2. Resolve with the existing helper (`resolveNfsUserFilesMount` / `resolveUserFilesHostPath`) using `ownerFromAgentId(input.agentId, ctx.userId)` and `readOnly: true`. `undefined` means `PluginError` code `home-unavailable` ("this agent has no durable /files home configured, so its files can't be measured"). An unrealizable kind still throws `unrealizable-mount-kind`.
  3. k8s only: `assertSafeSubPath(mount.subPath)`. If `config.userFilesHostReadRoot === ''`, throw `PluginError` code `user-files-usage-unavailable` ("measuring agent files needs the read-only host mount: set sandbox.filestore.hostReadPath") and create no pod. Root = `path.join(config.userFilesHostReadRoot, mount.subPath)`. Subprocess: root = `hostPath`.
  4. `const r = await measureConfinedUserFiles(root)`. When `!r.complete`, `log.warn('user_files_usage_partial', { agentId, entries: r.entries })`. Return `{ bytes: r.bytes }`. Walk errors propagate unchanged (the bus wraps them as `PluginError`).

- [ ] **Step 1: Write the failing tests.**
  - k8s (`user-files-ops.test.ts`): reuse `busWithNfs` and the host-mounted `hostReadConfig()`/`seed()` helpers. Stub resolvers use a server like `files.example.invalid` (TASK-992 pattern).
    - `'measureUserFiles: no resolver means home-unavailable, and no pod'`.
    - `'a resolver with no user-files mount means home-unavailable'`.
    - `'without a host read root it throws user-files-usage-unavailable and creates no pod'`: `api.createNamespacedPod` not called.
    - `'an unsafe subPath is refused before any read'`: `code: 'unsafe-subpath'`.
    - `'a localDir mount is unrealizable here'`.
    - `'a missing or empty agentId is invalid-input'`.
    - `it.skipIf(!ON_LINUX)('measures <hostReadRoot>/<subPath>: bytes equal the lstat oracle, no pod')`.
    - `it.skipIf(!ON_LINUX)('CROSS-TENANT: a sibling agent's folder, even behind a symlink in this one, is never counted')`.
    - `it.skipIf(!ON_LINUX || IS_ROOT)('a partial reading still answers bytes and logs user_files_usage_partial')`: a mode-000 subfolder; capture the logger.
  - k8s `plugin.test.ts`: `'registers sandbox:user-files-usage'` (`hasService` true, and the manifest `registers` contains it).
  - subprocess (`user-files-host-ops.test.ts`):
    - `'no resolver means home-unavailable'`
    - `'an nfs mount is unrealizable here'`
    - `'invalid-input'`
    - `it.skipIf(!ON_LINUX)('measures the resolved hostPath')` (oracle)
    - `it.skipIf(!ON_LINUX)('a folder that does not exist yet is 0')`
  - mount-protocol signature test.

- [ ] **Step 2: Run them to see them fail.**
  - `pnpm --filter @ax/sandbox-k8s test`
  - `pnpm --filter @ax/sandbox-subprocess test`
  - `pnpm --filter @ax/sandbox-mount-protocol test`
  - Expected: FAIL (no `measureUserFiles`, no types).

- [ ] **Step 3: Implement** the types, both `measureUserFiles`, both registrations, and the doc and comment edits listed under Files.

- [ ] **Step 4: Run the same three filters.** Expected: PASS. Then `pnpm build`, so `@ax/disk-quota` and `presets/k8s` see the new exports.

- [ ] **Step 5: Commit** `feat(sandbox): sandbox:user-files-usage in both providers (TASK-993)`.

---

### Task 3: Ledger kind `agent-files` [tier: sensitive]

**Files:**
- Modify: `packages/disk-quota/src/migrations.ts`
  - `UsageKind` (`:40`) gains `'agent-files'`.
  - The inline CHECK in `CREATE TABLE` (`:66`) lists all three kinds, so a fresh database is born wide.
  - After the `CREATE TABLE`, add the widening `DO $$` block copied from `packages/conversations/src/migrations.ts:241-266`: `pg_advisory_xact_lock(hashtext('disk_quota_v1_usage_kind_check'))`; skip when `pg_get_constraintdef` already contains `agent-files`; otherwise ONE `ALTER TABLE ... DROP CONSTRAINT IF EXISTS disk_quota_v1_usage_kind_check, ADD CONSTRAINT disk_quota_v1_usage_kind_check CHECK (kind IN ('workspace','blob','agent-files'))`.
  - Header (`:8-21`): three things now remove a row; add `agent-files:<agentId>` to the table description.
- Modify: `packages/disk-quota/src/store.ts`
  - `OwnerUsage.workspaceBytes` doc (`:10-11`): "the owner's agents: their `/files` (kind `agent-files`) and, until TASK-995, their git workspaces".
  - Add `agentFilesSource` and `deleteAgentFilesUsage`, the latter with plain equality on `source` AND `kind = 'agent-files'`, mirroring `deleteWorkspaceUsage` `:114-125`.
  - `usageFor` (`:127-137`) and `topOwners` (`:139-160`) use `SUM(bytes) FILTER (WHERE kind IN ('workspace','agent-files')) AS workspace_bytes`.
- Test: `packages/disk-quota/src/__tests__/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type UsageKind = 'workspace' | 'blob' | 'agent-files';
  export function agentFilesSource(agentId: string): string; // `agent-files:${agentId}`
  // DiskQuotaStore
  deleteAgentFilesUsage(agentId: string): Promise<number>; // rows removed, every owner; idempotent
  ```
- Wire and UI unchanged: `workspaceBytes` (shown as "Agent files") now includes agent-files rows.

- [ ] **Step 1: Write the failing tests** in `store.test.ts`:
  - Extend `'the database itself refuses an unknown kind or negative bytes'`: `'agent-files'` is accepted, `'bogus'` is still refused.
  - `'a table created before agent files is widened in place, once'`: drop the constraint and re-add it narrow (`CHECK (kind IN ('workspace','blob'))`), run `runDiskQuotaMigration(db)` twice. Then an `agent-files` upsert succeeds; exactly one row in `pg_constraint` for `conname = 'disk_quota_v1_usage_kind_check'`; its definition contains `agent-files`.
  - `'usageFor counts agent files under workspaceBytes, never fileBytes'`.
  - `'topOwners orders by a total that includes agent files'`.
  - `'deleteAgentFilesUsage drops that agent's row for every owner, and nothing else'`: the agent's `workspace:` row, a blob row and a neighbour agent's `agent-files:` row survive. A second call returns 0. An id containing `%`/`_` matches no other agent.
  - `'deleteWorkspaceUsage never touches an agent-files row'`.

- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @ax/disk-quota exec vitest run src/__tests__/store.test.ts` (Docker). Expected: FAIL (CHECK refuses `agent-files`; no `deleteAgentFilesUsage`).

- [ ] **Step 3: Implement** the migration and store changes.

- [ ] **Step 4: Run** `pnpm --filter @ax/disk-quota test`. Expected: PASS (the whole package; nothing else reads `kind`).

- [ ] **Step 5: Commit** `feat(disk-quota): agent-files ledger kind (TASK-993)`.

---

### Task 4: Stop vetoing `chat:start`; raise the default to 10 GiB [tier: integration]

**Files:**
- Modify: `packages/disk-quota/src/plugin.ts`
  - Remove `'chat:start'` from `SUBSCRIBED` (`:25-32`) and its subscriber (`:253-264`).
  - Rewrite the header's "TURNS AWAY" bullet (`:47-53`): it never turns a turn away (TASK-993), so a full person can ask their agent to tidy up, while uploads and published files stay refused.
- Modify: `packages/disk-quota/src/service.ts`
  - Delete `admitTurn` (`:266-289`) and its interface member (`:88-89`).
  - Rewrite the `AdmitDecision` and `STORAGE_FULL_REASON` docs (`:47-63`): the code is now only the write refusal's `code`.
  - Drop `admitTurn` from the header list.
- Modify: `packages/disk-quota/src/config.ts:31-35`: `limitMb: 10240`, with a one-line comment saying agent files (clones, dependencies, work product) count toward it now, and pointing at the decisions shard.
- Tests:
  - `packages/disk-quota/src/__tests__/service.test.ts`: delete the `'the turn gate (chat:start)'` describe (`:523-588`) and the two `admitTurn` lines at `:908,911`, keeping that test's write-gate assertions.
  - `packages/disk-quota/src/__tests__/plugin.test.ts`: manifest pin `:91-102` without `chat:start`. Replace the `'the chat:start front door…'` describe (`:307-331`) with the test below; keep the `chatStart` helper (`:190`), since the new test uses it.
  - The default is asserted at `config.test.ts:72`, `routes.test.ts:102-103` (`limitBytes`/`warnBytes` of the default), `routes.test.ts:214` and `routes.test.ts:294`; all move to `10240` (`10240 * MB`). Tests that pass an explicit `limitMb` are unaffected.
- Modify: `presets/k8s/src/__tests__/preset.test.ts`: the `subscribes` pin `:994-1001` without `'chat:start'`, and delete the `chat:start`/`agent:invoke` assertion `:1034-1038`.
- Modify: `presets/k8s/src/__tests__/disk-quota-acceptance.test.ts:914-970`: rewrite scenario (5). Also fix the `seedFull` doc at `:446` ("writes and turns are both refused") to say only writes are refused.

**Interfaces:**
- Produces: `DiskQuotaService` without `admitTurn`; `DEFAULT_LIMITS.limitMb === 10240`. Task 5 edits the same `SUBSCRIBED` list next.

- [ ] **Step 1: Write the failing tests.**
  - `plugin.test.ts` `'a FULL owner still starts a turn: chat:start is never vetoed (TASK-993), and their uploads are refused'`: `setLimitMb(b, 64)` and 64 MB of `blob:stored`. `b.harness.bus.fire('chat:start', alice, { message: { role: 'user', content: 'hi' } })` resolves `{ rejected: false }`. `blobPrePut(b, alice, 1)` is rejected with `code: 'storage-full'`.
  - `config.test.ts`: `DEFAULT_LIMITS` toEqual `{ limitMb: 10240, warnPercent: 80, graceMs: 86_400_000 }`, and `LIMIT_BOUNDS.limitMb.min <= 10240 <= LIMIT_BOUNDS.limitMb.max`.
  - Canary (5) renamed `'(5) a full owner can still start a turn; only their writes are refused'`: `seedFull(USER_A)`; `start(USER_A, 'dq-agt-turn-a')` resolves `{ rejected: false }`; a `blobPut(USER_A, randomBytes(4096))` refusal has `code: 'rejected'`; `seedFull('team:tm2')` and a team-agent start is also `{ rejected: false }`.

- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @ax/disk-quota test`. Expected: FAIL (the veto rejects; the default is 1024).

- [ ] **Step 3: Implement** the removals, the default and the comment rewrites, and update the pins listed under Files.

- [ ] **Step 4: Run** `pnpm --filter @ax/disk-quota test` and `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/preset.test.ts src/__tests__/disk-quota-acceptance.test.ts` (Docker). Expected: PASS.

- [ ] **Step 5: Commit** `feat(disk-quota): over quota no longer blocks chat; default limit 10 GiB (TASK-993)`.

---

### Task 5: Meter agent files at turn end and on the sweep; drop the row on `agents:deleted` [tier: sensitive]

**Files:**
- Modify: `packages/disk-quota/src/shared.ts`: add `createLimiter`.
- Modify: `packages/disk-quota/src/service.ts`: everything under "Behaviour" below, plus the header's list.
- Modify: `packages/disk-quota/src/plugin.ts`
  - `SUBSCRIBED` = `['workspace:pre-apply', 'workspace:applied', 'blob:pre-put', 'blob:stored', 'workspace:deleted', 'chat:turn-end', 'agents:deleted']`.
  - Two subscribers.
  - Append to `optionalCalls`: `{ hook: 'sandbox:user-files-usage', degradation: "Files in each agent's home folder are not measured, so they don't count toward their owner's storage limit; uploads, published files and git workspaces still do." }`.
  - Generalize `agentIdField` to read `{ agentId?: unknown }` from any payload.
  - Header METERS/RELEASES bullets.
- Tests: `packages/disk-quota/src/__tests__/service.test.ts`, `packages/disk-quota/src/__tests__/plugin.test.ts` (manifest pin `:91-120` gains the two hooks and the optional call).
- Modify: `presets/k8s/src/__tests__/preset.test.ts:994-1001`: the `subscribes` pin.

**Interfaces:**
- Consumes: `agentFilesSource`, `deleteAgentFilesUsage`, kind `'agent-files'` (Task 3); hook `sandbox:user-files-usage` `{ agentId } → { bytes }` (Task 2), read as `unknown`.
- Produces:
  ```ts
  // shared.ts
  export function createLimiter(max: number): { run<T>(fn: () => Promise<T>): Promise<T> };
  // service.ts
  export const AGENT_FILES_USAGE_HOOK = 'sandbox:user-files-usage';
  export const FILES_MEASURE_CONCURRENCY = 2;
  // DiskQuotaService gains:
  scheduleAgentFilesMeasure(ctx: AgentContext): void;        // chat:turn-end; fire-and-track; never throws
  releaseAgentFiles(agentId: unknown): Promise<void>;        // agents:deleted; never throws
  // ReconcileResult.measured / .failed now count workspace AND agent-files measurements
  // (doc-comment both). reconcile() order: workspaces, agent files, blob pass.
  ```

**Behaviour (decided; the tests pin each):**
1. **Owner:** split the `agents:resolve` half of `ownerOf` (`:192-217`) into `resolveAgentOwner(ctx): Promise<string | undefined>` (cached; `team:<id>` for team agents; `undefined` when unresolvable). `ownerOf` = `resolveAgentOwner(ctx) ?? acting user`; the gates are unchanged. Agent files use `resolveAgentOwner` ONLY: no acting-user fallback.
2. **Turn end:** the plugin's `chat:turn-end` subscriber returns at once. It skips when `payload.role === 'tool'` (read structurally) and otherwise calls `svc.scheduleAgentFilesMeasure(ctx)`, which runs `measureAgentFiles(ctx)` under `track()`.
3. **Coalescing, per agent:** a `measuringFiles: Map<agentId, { again: boolean; ctx: AgentContext; owner?: string; done: Promise<boolean> }>`. A request for an agent already measuring sets `again` (and adopts the newer `ctx` and `owner`) and returns the running `done`. The loop `do { again = false; ok = await once(...) } while (again)` deletes its map entry in `finally`. Both the sweep and the turn end go through this map.
4. **Concurrency:** every `bus.call(AGENT_FILES_USAGE_HOOK, ...)` runs inside one `createLimiter(FILES_MEASURE_CONCURRENCY)`.
5. **One measurement** (never throws; returns `true` only when a row was written):
   - Return `false` when the hook is not registered, the agent id is not usable (`usableAgentId`), the agent is tombstoned, or no owner resolves (owner = override ?? `resolveAgentOwner(ctx)`).
   - Call with `{ agentId }`.
   - `bytes` must be a finite number `>= 0`; otherwise warn `disk_quota_files_usage_invalid` and return `false`.
   - Re-check the tombstone, then `upsertUsage(owner, agentFilesSource(agentId), 'agent-files', bytes)`.
   - On any throw, warn `disk_quota_files_measure_failed` `{ agentId, err }`; the previous row stays.
6. **Sweep:** `sweepAgentFiles()` runs after `sweepWorkspaces()` in `reconcile()`. It needs `agents:list-personal-owners` AND the hook (else skip, debug log); it uses the same listing filter as `sweepWorkspaces` (`:453-460`) and `mapBounded(listed, SWEEP_CONCURRENCY, a => measureAgentFiles(<the same per-agent sweep ctx as :464-469>, a.ownerUserId))`, and adds its results to `measured`/`failed`.
7. **Delete:** `releaseAgentFiles(agentId)`:
   - Validate a non-empty string (else warn `disk_quota_agents_deleted_invalid`).
   - BEFORE any await: `deletedAgents.add(agentId)` and `ownerCache.delete(agentId)`.
   - Await `measuringFiles.get(agentId)?.done.catch(() => false)`.
   - `store.deleteAgentFilesUsage(agentId)` and a debug log; on a throw, error log `disk_quota_release_failed` `{ agentId, err }`.
   - `deletedAgents` is an in-process `Set` that is never cleared (TASK-719 precedent; agent ids are never reused).

- [ ] **Step 1: Write the failing tests.** `service.test.ts` uses `makeWorld({ services: { 'sandbox:user-files-usage': ..., 'agents:resolve': ..., 'agents:list-personal-owners': ... } })`. A "gated" stub is one that awaits a test-held promise and counts concurrent calls.
  - `'a turn end records an agent-files row charged to the agent's owner'` (personal) and `'... to the team for a team agent, never to the member who chatted'`.
  - `'the owner's total includes agent files, so an upload is refused once they fill the limit'`: limit 64 MB, provider answers 63 MB, then `admitBlobWrite(alice, 2 MB)` is `{ ok: false, code: 'storage-full' }`.
  - `'an agent whose owner cannot be resolved is charged to nobody'`: `agents:resolve` throws; no row for the acting user or anyone.
  - `'no provider: nothing is measured and nothing throws'`.
  - `'a provider error keeps the previous figure and logs disk_quota_files_measure_failed'`.
  - `'answers that are not a size record nothing'`: `{ bytes: -1 }`, `{ bytes: NaN }`, `{}`, `null`.
  - `'coalesces: three turn ends while one is measuring cause exactly one more measurement'`: the provider is called twice in total.
  - `'never more than FILES_MEASURE_CONCURRENCY measurements at once across agents'`: 5 agents gated; `maxInFlight === 2`; all 5 rows after release.
  - `'the sweep measures every listed personal agent's files with the listed owner'`: 3 listed, 1 throws, no `workspace:usage` registered, so `reconcile()` toEqual `{ measured: 2, failed: 1, blobsReleased: 0, blobReleaseAborted: false }`.
  - `'releaseAgentFiles waits for an in-flight measurement, drops the row for every owner, and nothing brings it back'`:
    - Gate a measurement of `agt_1`.
    - Start `releaseAgentFiles('agt_1')`; open the gate; await the release; there is no `agent-files:agt_1` row.
    - Then a turn end for `agt_1` plus `drain()`, and a sweep listing `agt_1`, write nothing.
  - `'releaseAgentFiles ignores a malformed id and never throws'`.
  - `plugin.test.ts`:
    - The manifest pin (subscribes order above; optionalCalls `[...existing, 'sandbox:user-files-usage']`).
    - `'chat:turn-end measures on the assistant turn end and not on the tool one'`.
    - `'agents:deleted drops the agent's agent-files row through the bus'`.
    - `'GET /settings/storage counts agent files under workspaceBytes'`.

- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @ax/disk-quota test` (Docker). Expected: FAIL.

- [ ] **Step 3: Implement** the behaviour above, then update the preset `subscribes` pin.

- [ ] **Step 4: Run** `pnpm --filter @ax/disk-quota test` and `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/preset.test.ts src/__tests__/blob-ledger-release-acceptance.test.ts src/__tests__/disk-quota-acceptance.test.ts` (Docker). Expected: PASS (existing reconcile `toEqual`s are unchanged because no provider is registered there).

- [ ] **Step 5: Commit** `feat(disk-quota): meter agent files at turn end and on the sweep; agents:deleted drops the row (TASK-993)`.

---

### Task 6: Prove the loop in the preset canary [tier: integration]

**Files:**
- Modify: `presets/k8s/src/__tests__/disk-quota-acceptance.test.ts`
  - `bootKernel(opts?: { userFilesRoot?: string })`, `:348-380`. When `userFilesRoot` is given, also push `createWorkspaceLocaldirPlugin({ root: userFilesRoot })`, `createSessionInmemoryPlugin()`, an ipc stub plugin registering `ipc:start`/`ipc:stop` (copy `acceptance.test.ts:3403-3420`) and `createSandboxSubprocessPlugin()`. The canary's preset config has no `filestore`, so there is no second `sandbox:resolve-mounts`.
  - Add `ON_LINUX` and a final `describe.skipIf(!ON_LINUX)('(7) agent files ...')` AFTER `(6)`. It replaces the shared kernel (`await live().shutdown(); kernel = await bootKernel({ userFilesRoot })`), so every existing helper keeps working. Update `(6)`'s "keep last" comment.
  - Update the file header (GATE/METER/FREE) for agent files and the absent `chat:start` gate.
- Modify: `presets/k8s/src/__tests__/preset.test.ts`: a new `it` beside the disk-quota one.
- Modify: `presets/k8s/src/index.ts:1052-1066`: rewrite the 7d comment. One per-person budget covers blobs, each agent's `/files` (measured after each turn and on the sweep through `sandbox:user-files-usage`, which `@ax/sandbox-k8s` registers; not write-enforced) and, until TASK-995, git workspaces. `blob:pre-put` and `workspace:pre-apply` are gated; `chat:start` is never vetoed; `agents:deleted` drops the agent-files row.

**Interfaces:**
- Consumes: everything from Tasks 2–5.

- [ ] **Step 1: Write the failing tests.**
  - `preset.test.ts` `'every hook @ax/disk-quota needs to meter agent files is produced in this preset (TASK-993)'`:
    - disk-quota's `optionalCalls` include `'sandbox:user-files-usage'`;
    - the plugins registering it are exactly `['@ax/sandbox-k8s']`;
    - the plugin registering `'agents:delete'` is `'@ax/agents'`;
    - `'@ax/ipc-http'` is loaded (it fires `chat:turn-end` through `@ax/ipc-core`).
  - `(7a) 'agent files are metered at turn end and count toward the owner; uploads are refused, chat is not, and cleaning up makes room'`, with owner `dq-user-files` and agent `dq-agt-files` in `agentOwners`:
    - Write `report.bin` (1 MiB random) and `sub/notes.txt` under `<userFilesRoot>/dq-agt-files/`.
    - Add a sibling `<userFilesRoot>/dq-agt-other/big.bin` (2 MiB) and a symlink `dq-agt-files/peek -> ../dq-agt-other`.
    - Fire `chat:turn-end` with `{ reason: 'user-message-wait', role: 'assistant' }`, then `drain()`. `ledgerRow(owner, 'agent-files:dq-agt-files')` has `kind: 'agent-files'` and `bytes` equal to the lstat oracle of the agent folder (sibling and link target excluded).
    - `setLimits({ limitMb: 64 })`, then `seedNearlyFull(owner)` (`seedLedger` already subtracts the agent-files row, so the total sits `HEADROOM_BYTES` under the limit). A 100 KB `blobPut` is refused with `message === blobFullMessage(MIN_LIMIT_BYTES - HEADROOM_BYTES, MIN_LIMIT_BYTES)`, and `chat:start` for the owner resolves `{ rejected: false }`.
    - `rm` `report.bin`; turn end plus `drain()`; the row shrinks; the same 100 KB `blobPut` is admitted.
  - `(7b) 'deleting the agent removes its files and its row, and a late turn end writes nothing'`:
    - Fire `agents:deleted` `{ agentId: 'dq-agt-files', ownerId: owner, ownerType: 'user' }`. The folder is gone (`@ax/sandbox-subprocess` cleanup) and the row is gone.
    - Keep `agentOwners` resolving the agent, so the tombstone (not the resolver) is what is proven. A further turn end plus `drain()` writes no row.

- [ ] **Step 2: Run them to see them fail.** `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/disk-quota-acceptance.test.ts src/__tests__/preset.test.ts` (Docker; `(7)` runs on Linux only, so on macOS only the preset assertion can fail here). Expected: FAIL before the wiring exists.

- [ ] **Step 3: Implement** the canary wiring and the index comment.

- [ ] **Step 4: Run** the same command. Expected: PASS (on macOS `(7)` reports skipped; CI runs it on Linux).

- [ ] **Step 5: Commit** `test(preset-k8s): disk-quota canary meters agent files end to end (TASK-993)`.

---

### Task 7: The words a person reads [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/lib/storage-copy.ts`
  - Header `:1-16`: drop "NOTHING here tells a person to delete anything" and say what is true now (the agent can clean up; an admin can raise the limit; there is no delete button).
  - `NEAR_LIMIT_BODY`, `FULL_BODY`, `STORAGE_FULL_SEND` (`:180-195`).
  - Delete the re-export and its comment (`:196-205`).
- Delete: `packages/channel-web/src/lib/storage-full-copy.ts` (no caller since TASK-989).
- Modify: `packages/channel-web/src/lib/storage-full.ts`: header `:1-19` (only the send route answers this refusal now), the `fallback` doc `:41-48`, and the `lib/routines.ts` mention `:64-70` (routines no longer read it).
- Modify: `packages/channel-web/src/components/workspace/save-refused-copy.ts:17-18`, comment only: drop the pointer to `STORAGE_FULL_RULES`; say only an admin can make room for a refused git save. Do not change `SAVE_REFUSED_COPY`.
- Modify: `packages/channel-web/src/lib/turn-error-labels.ts:86-93`, comment only: no longer emitted live since TASK-993 (chat is never turned away); kept so a refusal persisted before then replays as itself (the TASK-806 pattern). The label text is unchanged.
- Modify: `packages/channel-web/src/components/admin/StorageTab.tsx:26-29`, header comment only.
- Modify: `packages/disk-quota/src/messages.ts`: header `:1-14` and `blobFullMessage` `:56-62`. Leave `workspaceFullMessage` alone (TASK-995).
- Tests:
  - `packages/channel-web/src/lib/__tests__/storage-copy.test.ts` (`:163-217`)
  - `packages/channel-web/src/lib/__tests__/storage-full.test.ts` (`:3`, `:52-63`, `:109-110`: replace `STORAGE_FULL_RULES` with a local `const OTHER_FALLBACK = 'Some other surface\'s sentence.'`)
  - `packages/channel-web/src/components/admin/__tests__/StorageTab.test.tsx` (`:266-294`)
  - `packages/channel-web/src/lib/__tests__/turn-error-labels.test.ts:75-80` (comment)
  - `packages/disk-quota/src/__tests__/messages.test.ts`

**Copy** (draft; run `ux-design` on all four first and keep its improvements, but every asserted phrase below must survive):
- `NEAR_LIMIT_BODY`: "Once it's full, new uploads and published files won't be saved. To make room, ask your agent to clean up files it no longer needs, or ask an admin for more room."
- `FULL_BODY`: "New uploads and published files can't be saved until there's room. You can keep chatting: ask your agent to clean up files it no longer needs, or ask an admin for more room."
- `STORAGE_FULL_SEND`: "We couldn't send that message because your storage is full, so its attachment couldn't be saved. Messages without attachments still go through. To make room, ask your agent to clean up files it no longer needs, or ask an admin for more room."
- `blobFullMessage(used, limit)`: `` `You've used all of your storage (${formatBytes(used)} of ${formatBytes(limit)}), so that file wasn't saved. To make room, ask your agent to clean up files it no longer needs, or ask an admin for more room. Then try again.` ``

- [ ] **Step 1: Invoke `ux-design`** with the four sentences and their surfaces: the Storage tab notices, the composer after a refused send, and the upload/artifact refusal (which the agent also reads and relays). Settle the wording.

- [ ] **Step 2: Write the failing tests.**
  - `storage-copy.test.ts`:
    - The `sentences` list drops the two deleted constants.
    - Replace `'%s never tells anyone to delete anything'` with `'%s never tells a person to delete or remove anything'`, which asserts `not.toMatch(/\b(delet|remov)/i)`.
    - New `'the near-limit, full and send sentences point at the agent and an admin'`: each matches `/ask your agent to clean up files it no longer needs/i` and `/ask an admin for more room/i`.
    - `'the full notice says chat still works'`: `FULL_BODY` matches `/keep chatting/i` and does not match `/held|turned away/i`.
    - Keep the no-digits and no-jargon tests.
    - Delete the Rules/identity exact-text tests.
  - `StorageTab.test.tsx`:
    - near-limit: `toHaveTextContent("new uploads and published files won't be saved")` plus a regex for "ask your agent to clean up files it no longer needs".
    - full: `'Your storage is full'` and `/keep chatting/i`.
    - Replace `'never tells anyone to delete anything…'` with `'points at the agent and an admin, and never says delete'`.
  - `messages.test.ts`: `blobFullMessage(…)` matches both remedy phrases and still carries the two sizes.
  - The Task 6 canary asserts with `blobFullMessage(...)` itself, so it follows automatically.

- [ ] **Step 3: Run them to see them fail.** `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/storage-copy.test.ts src/lib/__tests__/storage-full.test.ts src/components/admin/__tests__/StorageTab.test.tsx` and `pnpm --filter @ax/disk-quota exec vitest run src/__tests__/messages.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement** the copy, the deletion and the comment edits. `git grep -n "storage-full-copy\|STORAGE_FULL_RULES\|STORAGE_FULL_IDENTITY" -- packages` must print nothing.

- [ ] **Step 5: Run** `pnpm --filter @ax/channel-web test` (whole package: `tsc` covers its tests) and `pnpm --filter @ax/disk-quota test`. Expected: PASS.

- [ ] **Step 6: Commit** `feat(copy): over-quota sentences point at the agent and an admin; drop dead storage-full copy (TASK-993)`.

---

### Task 8: Docs (as-built, ops alert, default) [tier: mechanical]

**Files:**
- Modify: `deploy/GKE.md`
  - Add a subsection `### Alert before the user-files share fills up` after "Provision the user-files Filestore (required)" (before `### Write the overrides and install`, `:610`). It covers:
    - why: the limit is measured after each turn, Filestore has no per-folder limit, so a share can fill between measurements; nothing in this repo creates alerts;
    - a policy JSON: `displayName`; one `conditionThreshold` with filter `resource.type = "filestore_instance" AND resource.label.instance_name = "ax-next-files" AND metric.type = "file.googleapis.com/nfs/server/used_bytes_percent"`, `COMPARISON_GT`, `thresholdValue: 80`, `duration: "300s"`, `ALIGN_MEAN` over `300s`; `notificationChannels: ["projects/<PROJECT_ID>/notificationChannels/<CHANNEL_ID>"]`;
    - `gcloud alpha monitoring policies create --project=$PROJECT_ID --policy-from-file=files-capacity-alert.json`, plus the Console fallback (Monitoring > Alerting > Create policy, the Filestore instance's percent-used metric, above 80 for 5 minutes);
    - when it fires: grow the share (`gcloud filestore instances update ax-next-files --project=$PROJECT_ID --zone=us-central1-a --file-share=name=vol1,capacity=<larger>`; Basic HDD grows in place and never shrinks), then check Settings > Storage for who uses the most.
  - `:651-654`: the default is 10 GB, and the limit covers a person's uploads and published files on this volume AND their agents' files on the user-files share, so size both.
- Modify: `docs/plans/2026-05-24-current-architecture.md`, "Storage limit" section `:444-517`:
  - The opening line: the per-owner budget spans blobs (and git workspaces until TASK-995) and each agent's `/files`.
  - Replace the `chat:start` veto bullet `:474-477` with "Over the limit, chat still works (TASK-993)": the veto is gone, `blob:pre-put` still refuses, the Storage tab warns, and the label survives only for replay.
  - Add an "Agent files are metered, not write-enforced (TASK-993)" bullet: the hook contract and its two realizations, `hostReadPath` needed on k8s, triggers, the `agent-files` kind folded into "Agent files", `agents:deleted`, and the Filestore alert backstop.
  - In "What frees storage" `:501-508`: add the agent cleaning up its own `/files` (re-measured at the next turn end or sweep), and replace "the refusal sentences never tell a person to delete anything" with the new rule (ask the agent or an admin; no delete button; never "delete an agent").
- Modify: `docs/plans/2026-10-29-agent-files-simplification-design.md` §12: add three `**As built (TASK-993):**` bullets after `:318`:
  - the hook, walk and triggers, the `agent-files` kind, the 10 GiB default, `hostReadPath` on k8s, and the 0-versus-error rule;
  - `storage-full-copy.ts` deleted (dead since TASK-989), where the copy lives now, `agents:deleted` dropping the `agent-files` row, and `workspace:deleted` staying until TASK-995;
  - the alert is documented in `deploy/GKE.md`.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Verify.** `pnpm test:scripts` (covers the public-repo address and deployment-specifics guards) passes. `git grep -n "default 1 GB" deploy docs/plans/2026-05-24-current-architecture.md` prints nothing.
- [ ] **Step 3: Commit** `docs: agent-files quota as built, Filestore capacity alert, 10 GB default (TASK-993)`.

---

## Out of scope (do not do here)

- Removing `kind='workspace'` rows (reset runbook card) and any git-tier quota code (TASK-995).
- A storage banner in chat; a team-agent sweep (same gap as TASK-690); a per-agent debounce; hard-link deduplication; a pod-per-call meter; a `hostReadPath` default.
- `AgentInstructions.tsx`'s `StorageFullError` branch (`:220`), which TASK-989 left unreachable: note it in the PR as a follow-up.

## PR notes the builder must include

- The boundary review and security notes above, and the "Premises corrected" list.
- **Deploy notes:**
  1. A stored `settings:disk-quota` overrides the new default. After deploying, open Settings > Storage. If the limit still reads 1 GB, an admin saved it earlier; set 10 GB there.
  2. `/files` is metered only where `sandbox.filestore.hostReadPath` is set (prod and kind set `/user-files`).
  3. Create the Filestore capacity alert from `deploy/GKE.md` once.
  4. Host-only code change, plus a values.yaml comment: no runner-image behaviour change.
