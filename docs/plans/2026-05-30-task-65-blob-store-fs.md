# TASK-65 — `blob:*` content-addressed store + `@ax/blob-store-fs` backend

**Epic:** out-of-git (design `docs/plans/2026-05-30-out-of-git-design.md` Part A, Phase 1)
**Branch:** `auto-ship/TASK-65-blob-store-fs`

## Problem

Ship the shared content-addressed blob substrate (design Part A) that the rest of the
epic (transcripts, attachments, artifacts, skill bundles) lands on. A storage-agnostic
`blob:*` service hook + an `fs` backend storing content-addressed files at
`<root>/<sha[0:2]>/<sha[2:4]>/<sha>`. Lift the content-addressed store core from
`workspace-git-server/src/server/lfs.ts` (sha256 addressing, streamed I/O, atomic
temp-then-rename, digest verification) with the git/LFS HTTP framing removed.

## Service hook surface (storage-agnostic — I1)

```
blob:put(ctx, { bytes: Uint8Array }) -> { sha256: string, size: number }   // idempotent on identical bytes
blob:get(ctx, { sha256: string }) -> { bytes: Uint8Array } | { found: false }
blob:stat(ctx, { sha256: string }) -> { size: number } | { found: false }
blob:delete(ctx, { sha256: string }) -> {}                                  // GC; unreferenced only
```

Payloads carry ONLY `sha256` / `bytes` / `size` — no backend vocab (no `bucket`, `oid`,
`lfs`, `pack`, `ref`, `commit`, `path`, `root`). Bytes are raw `Uint8Array` on the bus —
NOT base64 in a JSON field — so the eventual IPC binary wire (Part C) can carry them over
the `callBinary` octet-stream channel without re-encoding.

## Scope decision (logged to decisions.md)

The card mentions "its IPC/binary wire plumbing." The ONLY real runner-side caller of a
blob IPC action (artifact_publish / attachments → blob:put over IPC) is **Part C**, a
later card. Adding a `blob.*` IPC action now with no runner caller would be a half-wired
plugin (I3 violation — "no 'wire it later' infrastructure"). So this slice ships:

- the host-side `blob:*` **service hook** (the in-process bus surface), and
- the `@ax/blob-store-fs` backend, and
- a **canary round-trip caller** (`blob:put → blob:get`, digest + bytes verified) that
  proves the plugin is registered + reachable (I3 satisfied — the canary IS the wiring),

and **defers** the IPC `blob.*` binary action + `callBinary` request-direction extension
to the Part C card that introduces the first runner-side caller. The hook payload is
SHAPED for that wire today (raw `Uint8Array`, small JSON envelope) so the later card is
purely additive. Returned as a followup.

## Tasks

### Task 1 — Scaffold `@ax/blob-store-fs` package (no logic yet)
- `packages/blob-store-fs/{package.json,tsconfig.json,vitest.config.ts,SECURITY.md}`.
- `package.json`: `@ax/core` + `zod` runtime deps; `@ax/test-harness` + node/ts/vitest dev
  deps. ZERO new third-party runtime deps (node:crypto/fs only). Mirror storage-sqlite.
- `tsconfig.json`: extends base, `references: [{ path: '../core' }]`.
- Add `{ "path": "packages/blob-store-fs" }` to root `tsconfig.json` references.
- `SECURITY.md`: pre-commitment note (mirror storage-sqlite/SECURITY.md), the three-threat
  walk for this plugin.
- Test: package builds, manifest shape (registers the 4 hooks, calls/subscribes empty).

### Task 2 — Content-addressed fs store core (pure, testable)
- `src/store.ts`: `BlobStore` class/functions wrapping a root dir:
  - `blobPath(root, sha) -> <root>/<sha[0:2]>/<sha[2:4]>/<sha>`
  - `put(bytes) -> { sha256, size }` — hash bytes, mkdir -p shard, write to
    `<final>.tmp.<pid>.<uuid>`, fsync-then-rename (atomic), idempotent (rename over
    existing is fine; if final already exists, skip the write or overwrite atomically).
  - `get(sha) -> { bytes } | { found:false }` — read, **re-verify digest** (recompute
    sha256 of the bytes, reject with a `corrupt` PluginError on mismatch — do NOT return
    tampered bytes).
  - `stat(sha) -> { size } | { found:false }` — fs.stat.
  - `delete(sha) -> {}` — unlink (best-effort; ENOENT is a no-op so delete is idempotent).
  - `SHA256_REGEX = /^[a-f0-9]{64}$/` guards EVERY caller-supplied sha (get/stat/delete) —
    reject non-matching with `invalid-payload` BEFORE building any path (no traversal; the
    key is a content hash, never a caller path).
- TDD: tests for path layout, put idempotency (same bytes → same sha, stored once),
  get round-trip, **digest re-verification rejects a tampered/corrupt object**, stat
  found/not-found, delete removes + idempotent, invalid-sha rejection (incl. `..`,
  absolute, wrong-length, uppercase).

### Task 3 — Plugin wiring (`createBlobStoreFsPlugin`)
- `src/plugin.ts`: `createBlobStoreFsPlugin({ root: string }): Plugin`.
  - manifest `registers: ['blob:put','blob:get','blob:stat','blob:delete']`, calls [],
    subscribes [].
  - `init({ bus })`: mkdir -p root, register the 4 service hooks delegating to store.ts.
  - Each hook gets a `returns` zod schema (ARCH-13 drift-guard pattern) co-located here:
    `BlobPutOutputSchema`, `BlobGetOutputSchema` (`.passthrough()` not needed — bytes are
    a plain Uint8Array data field, model with `z.instanceof(Uint8Array)` like
    storage-sqlite's `StorageGetOutputSchema`), `BlobStatOutputSchema`, BlobDelete is `{}`.
  - `shutdown()`: no-op (no held resources).
- `src/index.ts`: export `createBlobStoreFsPlugin`, `BlobStoreFsConfig`, the I/O types,
  the output schemas.
- `src/__tests__/return-schemas.test.ts`: round-trip a populated value through each
  `returns` schema; bytes survive by reference (mirror storage-sqlite return-schemas).
- TDD: plugin test boots via createTestHarness({ plugins: [plugin] }), calls each hook
  through the bus, asserts behavior (round-trip, idempotent, stat, delete, corrupt-reject,
  invalid-sha-reject).

### Task 4 — Canary round-trip (I3 reachability proof)
- A canary test that boots the plugin through `bootstrap` (via createTestHarness) and
  performs `blob:put` → `blob:get` end to end against a real temp dir, asserting the
  returned sha + size and that the round-tripped bytes EQUAL the input. This is the
  "wire one real caller" the card mandates. Lives in the package's `src/__tests__/`
  (cheapest reachable proof; no Postgres/Docker needed — fs only).
- Idempotency leg: put the same bytes twice → same sha, one file on disk.

### Task 5 — eslint + lint hygiene
- No cross-plugin imports (only `@ax/core`, `zod`, `@ax/test-harness` in tests). The
  plugin needs NO entry in eslint's `no-restricted-imports` allowlist (it imports nothing
  cross-plugin). Confirm `pnpm lint` clean (modulo the known nested-worktree phantom).

## Verification (Phase 4 gate)
- `pnpm build` (full tsc project refs — the real cross-package type gate).
- `pnpm -F @ax/blob-store-fs test` (package suite green in isolation).
- `pnpm lint`.
- Confirm `git diff --name-only main...HEAD` = only `packages/blob-store-fs/**`, root
  `tsconfig.json`, the plan, and `.claude/memory/`.

## Out of scope (followups → handoff)
- IPC `blob.*` binary action + `callBinary` REQUEST-direction extension — Part C, when the
  first runner-side caller (artifact_publish / attachments) exists. (I3: no half-wired wire.)
- `@ax/blob-store-s3` backend — a later card per the design.
- Wiring `@ax/blob-store-fs` into `presets/k8s` — happens when a host-side consumer
  (attachments/artifacts/skills onto blob) needs it (Part C/D). Until then, wiring it into
  the preset with no consumer would be half-wired at the preset level.
- Reference-counted GC for blob:delete safety — design says "safe only when unreferenced";
  the reference tracking lives with the consumers (attachments/artifacts/skills rows), not
  this substrate.
