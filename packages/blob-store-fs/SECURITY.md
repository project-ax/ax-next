# `@ax/blob-store-fs` — Security review

This is the security note for the `@ax/blob-store-fs` plugin — the filesystem
backend for the content-addressed `blob:*` store (out-of-git design, Part A). It
exists because `CLAUDE.md` invariant #5 (capabilities are explicit and
minimized) requires it, and because this plugin stores untrusted content
(attachments, agent artifacts, skill bundles) — the kind of thing we want to be
paranoid about up front, not after it ships.

## Design recap (what we're reviewing)

The plugin exposes four service hooks:

- `blob:put(ctx, { bytes: Uint8Array }) → { sha256, size }` — content-addressed; idempotent on identical bytes
- `blob:get(ctx, { sha256: string }) → { bytes: Uint8Array } | { found: false }` — digest re-verified on read
- `blob:stat(ctx, { sha256: string }) → { size } | { found: false }`
- `blob:delete(ctx, { sha256: string }) → {}` — GC; safe only when unreferenced (caller's responsibility)

Backed by content-addressed files at `<root>/<sha[0:2]>/<sha[2:4]>/<sha>`. This
is the content-addressed store from `workspace-git-server/src/server/lfs.ts`
with the git/LFS HTTP protocol framing removed — it already did sha256
addressing, streamed I/O, atomic temp-then-rename, and digest verification.

Configured by one field: `root: string`. The plugin treats this as
operator-supplied and trusted — it does not normalize, canonicalize, or sandbox
it (mirrors `storage-sqlite`'s `databasePath`).

No IPC transport (yet — the binary wire is a later card, Part C), no subprocess,
no network. The stored `bytes` are opaque; the plugin never parses, renders, or
executes them. Zero new third-party dependencies — `node:crypto` + `node:fs`
only.

## Security review (PR note)

```markdown
## Security review
- Sandbox: New plugin opens files under one operator-supplied `root` dir and registers blob:put/get/stat/delete. The ONLY caller-influenced part of any path is the sha256, which is regex-gated to `^[a-f0-9]{64}$` BEFORE a path is built — it can't contain `/`, `..`, NUL, or any path metacharacter, so no traversal. No spawn, no network, no env reads, no handles across the hook bus (payloads carry plain Uint8Array). Atomic temp-then-rename on write; a unique `.tmp.<pid>.<uuid>` suffix so concurrent puts of the same content can't corrupt each other.
- Injection: Stores untrusted content (attachments / artifacts / skill bundles) as OPAQUE bytes — never parsed, rendered, shell-interpolated, or executed by this plugin. blob:get RE-VERIFIES the sha256 digest on read and REJECTS (throws `corrupt`) a tampered/corrupted object rather than returning it, so an on-disk swap or bitrot can't serve bad bytes under a valid-looking hash. Callers that store untrusted bytes must still treat them as untrusted on read — the store doesn't launder trust.
- Supply chain: N/A — zero new dependencies. Uses only Node built-ins (`node:crypto`, `node:fs`); `@ax/core` + `zod` are already repo deps.
```

## Threat-model walk (long form)

### 1. Sandbox escape / capability leakage

Capability surface introduced by this plugin:

| Capability | Shape | Bounded? |
|---|---|---|
| Filesystem write | Files under one `root` dir, operator-supplied at registration; leaf name is a validated sha256 | Yes — root is fixed per instance; the only caller-influenced path component is a 64-char lowercase-hex string that can't escape the shard |
| Filesystem read | Same dir | Yes — same bound |
| Filesystem delete | Same dir | Yes — same bound (`unlink` of one validated path) |
| Process spawn | None | N/A |
| Network | None | N/A |
| Env access | None | N/A |
| Handles across hook bus | None — payloads carry `Uint8Array` data, not fds/sockets/capability tokens | N/A |

Failure-pattern check:

- **Path traversal:** The blob key is a content hash, NOT a caller path. Every
  caller-supplied sha (`blob:get` / `blob:stat` / `blob:delete`) is validated
  against `^[a-f0-9]{64}$` BEFORE any path is built. A 64-char lowercase-hex
  string can't contain `/`, `..`, NUL, a drive root, or any other path
  metacharacter — so `<root>/<sha[0:2]>/<sha[2:4]>/<sha>` always resolves
  strictly inside `root`. `blob:put` derives the sha from the bytes itself, so
  the caller never names a path there at all. The regression test feeds
  `../`-laden, NUL-bearing, wrong-length, and uppercase keys and asserts they're
  rejected. Status: not reachable.
- **Argv injection:** No process spawn. Status: N/A.
- **Env exfiltration:** No env reads. Status: N/A.
- **Handle leak:** Hook payloads are plain data (`string`, `Uint8Array`). No
  fds, sockets, or opaque handles cross the bus. Status: not applicable.
- **Path-as-token confusion:** There is no `path` field in any payload. `sha256`
  is a content hash, named as such; it is validated as a hash, not resolved as a
  location. Status: not applicable.
- **Atomicity / partial-write exposure:** Writes go to a per-call temp file
  (`<final>.tmp.<pid>.<uuid>` — unique so two concurrent puts of the same content
  can't share/clobber a temp) and are published with an atomic `rename`. A reader
  never sees a partially-written object, and a crashed write leaves only an
  orphan temp (cleaned up on the failure path), never a corrupt final object.

### 2. Prompt injection / untrusted content

This plugin's whole job is to store untrusted content — uploaded attachments,
agent-published artifacts, and (later) skill bundles. So unlike `storage-sqlite`,
"N/A" is not honest here; we walk it.

Where untrusted bytes flow:

- `bytes: Uint8Array` (on `blob:put`) → hashed, written to a `BLOB`-equivalent
  file verbatim. Never decoded, parsed, rendered, executed, shell-interpolated,
  concatenated into a prompt, or used as a path. Stored as opaque bytes.
- `bytes` (returned by `blob:get`) → handed back verbatim to the caller. The
  plugin doesn't interpret them.
- `sha256` (caller-supplied) → validated as hex, used only to compute a storage
  path. Never interpolated into SQL, a shell, an HTTP URL, an HTML render, or a
  prompt.

The one ACTIVE defense this layer adds: **digest re-verification on read.**
`blob:get` recomputes the sha256 of the bytes it read and rejects (throws
`corrupt`) if it doesn't match the requested hash. So even if an attacker (or
bitrot) tampers an object on disk, the store refuses to serve bytes that don't
match their content address — a tampered blob is a hard error, not silent bad
data. (Worst-case test: write `"evil swap"` over a stored object's file; the
test asserts `blob:get` throws `corrupt`, never returns the swapped bytes.)

What this layer does NOT do (by design, and the caller must know): it does not
sanitize, scan, or sandbox the *content* of a blob. A blob holding a malicious
SKILL.md or a poisoned attachment is stored and returned faithfully. Trust
laundering is not this layer's job — the skill scanner, the attachment renderer,
and the materialization gate (design Parts C/D) are where content is treated as
untrusted on read. The store's contract is integrity (you get back exactly the
bytes whose hash you asked for), not safety of those bytes.

Status: real risk considered, bounded — content stored opaque + integrity-checked
on read; semantic safety of content is the consumer's responsibility, stated
loudly above and in the hook docs.

### 3. Supply chain

No `package.json` third-party additions. Runtime deps are `@ax/core`
(`workspace:*`) and `zod` (`^3.23.8`) — both already pervasive in the repo. The
store uses only Node built-ins (`node:crypto` for sha256, `node:fs` for I/O).
Dev deps (`@ax/test-harness`, `@types/node`, `typescript`, `vitest`) match the
repo's standard ranges and are not loaded at runtime.

Status: **N/A — zero new third-party dependencies; no new transitive surface in
the lockfile diff.**

## Concluding note

The blob store is a content-addressed integrity layer, not a content-safety
layer. It guarantees you read back exactly the bytes whose hash you asked for
(or a hard error), and it never lets a caller-supplied key escape the root dir.
It does NOT vouch for what those bytes mean — consumers that hand a blob's
content to a model, a renderer, or a shell must treat it as untrusted. We're the
paranoid friend who checks the lock is the right lock; we're not promising
there's nothing scary inside the box you asked us to hold.
