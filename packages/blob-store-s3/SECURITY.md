# `@ax/blob-store-s3` — Security review

This is the security note for the `@ax/blob-store-s3` plugin — the S3-compatible
backend for the content-addressed `blob:*` store (out-of-git design, Part A,
Phase 6). It's the SECOND backend behind the same storage-agnostic hook surface
`@ax/blob-store-fs` (TASK-65) defined; this one targets MinIO (dev parity in
kind), GCS via its S3-compatible endpoint (the likely GKE prod home, with
Workload Identity = no static keys), AWS S3, and R2.

It exists because `CLAUDE.md` invariant #5 (capabilities are explicit and
minimized) requires it, because this plugin stores untrusted content
(attachments, agent artifacts, skill bundles), and because it pulls in the one
new third-party dependency the whole out-of-git design adds
(`@aws-sdk/client-s3`) — the kind of thing we want to be paranoid about up
front, not after it ships.

## Design recap (what we're reviewing)

The plugin registers the same service hooks the fs backend does (identical
payloads — that's the point of the abstraction): `blob:put`, `blob:put-internal`,
`blob:get`, `blob:stat`, `blob:list`, `blob:retire`, `blob:purge`. There is no
`blob:delete` any more (TASK-778): deleting is two-phase, and only the retired
copy can ever be deleted.

- `blob:put(ctx, { bytes: Uint8Array }) → { sha256, size }` — content-addressed; idempotent on identical bytes. Since TASK-690 this is the `@ax/core` facade (`registerBlobPutFacade`) over the backend's own `blob:put-internal`: it fires the veto `blob:pre-put { size }` first (the per-person storage limit can refuse; nothing is written), then the backend, then the observe-only `blob:stored { sha256, size }`. The backend itself still has no size cap and no notion of an owner.
- `blob:get(ctx, { sha256: string }) → { bytes: Uint8Array } | { found: false }` — digest re-verified on read
- `blob:stat(ctx, { sha256: string, restore?: boolean }) → { size } | { found: false }` — `restore: false` reports a retired copy's size without moving it; a non-boolean `restore` is `invalid-payload`
- `blob:list(ctx, { state: 'live' | 'retired', after?, limit }) → { items, next? }` — the GC's enumeration seam, over either namespace
- `blob:retire(ctx, { sha256: string }) → {}` — move live → retired (CopyObject, then DeleteObject of the live key). Missing = no-op. Nothing is gone yet: `blob:get` / `blob:stat` that miss the live key move a retired copy back (restore on miss) and serve it.
- `blob:purge(ctx, { sha256: string }) → {}` — delete the RETIRED copy for good. Its key is built only by `retiredBlobKey`, so it cannot address a live blob, even one of the same sha. Whether anyone still holds the sha is the caller's (the GC's) call.

Backed by content-addressed objects at `<keyPrefix><sha[0:2]>/<sha[2:4]>/<sha>`
inside a single S3 bucket; retired copies live at
`<keyPrefix>retired/<sha[0:2]>/<sha[2:4]>/<sha>`. put/get/stat are single
idempotent object ops (HeadObject / PutObject / GetObject), and the content
address guarantees identical bytes land at identical keys, so concurrent hosts
pointed at the same bucket converge.

**Retire and restore are not atomic on S3.** S3 has no rename, so each move is
CopyObject then DeleteObject — two requests. Most interleavings are harmless and
tested (a put racing a retire, two readers restoring at once, a restore losing
to a purge: 1000-round randomized race test, plus targeted cases). The residual
we know about: a SECOND retire of the same sha racing a restore could in
principle drop both copies (restore copies retired → live; the retire copies
live → retired; the restore deletes retired; the retire deletes live). The GC is
the only retire caller and holds a sweep-wide advisory lock, so this needs two
GC sweeps working the same sha at the same moment. We state it rather than
pretend it can't happen.

Configured by: `bucket`, optional `endpoint` / `region` / `forcePathStyle` /
`keyPrefix`, and optional `accessKeyId` / `secretAccessKey`. The bucket /
endpoint / region are operator-supplied and trusted — they are NEVER hook
payload fields (invariant I1). No subprocess. The stored `bytes` are opaque; the
plugin never parses, renders, or executes them.

## Security review (PR note)

```markdown
## Security review
- Sandbox: New plugin reaches exactly ONE S3 bucket at ONE operator-supplied endpoint over HTTPS, registering blob:put/get/stat/list/retire/purge (no blob:delete). The only caller-influenced part of any object key is the sha256, regex-gated to `^[a-f0-9]{64}$` BEFORE a key is built — it can't contain `/`, `..`, NUL, or any key metacharacter, so no key injection / cross-prefix escape. No spawn, no filesystem writes, no caller-supplied env reads. Credentials come from the SDK's default provider chain (Workload Identity / IRSA / GKE metadata) when static keys are unset — the prod posture is NO static keys in the tree; MinIO dev keys live in a k8s Secret, injected at runtime, never committed.
- Injection: Stores untrusted content (attachments / artifacts / skill bundles) as OPAQUE bytes — never parsed, rendered, shell-interpolated, executed, or concatenated into a prompt by this plugin. blob:get RE-VERIFIES the sha256 digest on read and REJECTS (throws `corrupt`) a tampered/swapped object rather than returning it, so a bucket-side object swap or bitrot can't serve bad bytes under a valid-looking hash. Callers that store untrusted bytes must still treat them as untrusted on read — the store doesn't launder trust.
- Supply chain: ONE new dependency, `@aws-sdk/client-s3`, EXACT-pinned to `3.1057.0` (no `^`/`~`). Official AWS package (maintainers amzn-oss / aws-sdk-bot, published since 2020). Zero install lifecycle scripts across its entire @aws-sdk/@smithy transitive tree (verified: 0 postinstall/preinstall/install/prepare hooks in 32 packages). `pnpm audit --audit-level moderate` is clean on the pinned range. The fs backend adds nothing here.
```

## Threat-model walk (long form)

### 1. Sandbox escape / capability leakage

Capability surface introduced by this plugin:

| Capability | Shape | Bounded? |
|---|---|---|
| Network | HTTPS to ONE bucket at ONE operator-supplied endpoint (MinIO Service URL / GCS / AWS / R2) | Yes — endpoint + bucket are fixed plugin config, never a payload field; the only caller-influenced bit of a request is the object key, which is a validated sha256 |
| Object write | PutObject under `<keyPrefix><sha[0:2]>/<sha[2:4]>/<sha>` | Yes — key leaf is a validated 64-char lowercase-hex string that can't escape the prefix |
| Object read | GetObject of the same addressed key | Yes — same bound |
| Object copy | CopyObject live ↔ retired key of the same validated sha, within the same bucket (`CopySource` = `<bucket>/<key>`, URL-encoded per segment) | Yes — both keys derive from one validated sha; the source bucket is the configured one |
| Object delete | DeleteObject of the live key (only inside `retire`, after its copy succeeded) or the retired key (`purge`, and a restore's cleanup) | Yes — `purge` builds its key only via `retiredBlobKey`, so it cannot address the live key |
| Process spawn | None | N/A |
| Filesystem | None — this backend writes no local files | N/A |
| Env access | None *by this plugin* — the SDK's credential provider chain may read AWS env / metadata, but the plugin code reads no caller-supplied env name | Yes — no `process.env[userInput]` anywhere |
| Credentials | Static keys ONLY when both `accessKeyId` + `secretAccessKey` are explicitly configured (dev / MinIO, from a Secret); otherwise the SDK default provider chain (Workload Identity) supplies them | Yes — no static keys in the tree for the prod path |
| Handles across hook bus | None — payloads carry `Uint8Array` data, not fds/sockets/clients | N/A |

Failure-pattern check:

- **Key / path traversal:** The blob key is a content hash, NOT a caller path.
  Every caller-supplied sha (`blob:get` / `blob:stat` / `blob:retire` / `blob:purge` / `blob:list`'s `after`) is
  validated against `^[a-f0-9]{64}$` BEFORE any key is built. A 64-char
  lowercase-hex string can't contain `/`, `..`, NUL, or any key metacharacter —
  so `<keyPrefix><sha[0:2]>/<sha[2:4]>/<sha>` always resolves strictly inside
  the configured prefix. `blob:put` derives the sha from the bytes itself, so
  the caller never names a key there at all. The regression tests feed
  `../`-laden, NUL-bearing, wrong-length, and uppercase keys and assert they're
  rejected **before** any S3 call is issued. Status: not reachable.
- **Argv injection:** No process spawn. Status: N/A.
- **Env exfiltration:** No caller-supplied env reads. The plugin reads no env at
  all; the AWS SDK's provider chain reads fixed, well-known AWS env names and
  the cloud metadata endpoint — none caller-influenced. Status: not applicable.
- **Credential exposure:** Static keys are accepted only via explicit config
  (dev / MinIO, sourced from a k8s Secret, injected at runtime). The prod path
  leaves them unset so Workload Identity / IRSA / metadata supplies short-lived
  creds — no long-lived static keys in env, code, a bundle, a blob, or git. The
  plugin never logs credentials and `buildS3Client` never echoes them.
- **Handle leak:** Hook payloads are plain data (`string`, `Uint8Array`). No
  fds, sockets, or S3 client handles cross the bus. Status: not applicable.
- **Path-as-token confusion:** There is no `path` (or `bucket` / `endpoint`)
  field in any payload. `sha256` is a content hash, named as such; it is
  validated as a hash, not resolved as a location. Status: not applicable.
- **SSRF via endpoint:** The endpoint is operator config, not caller input — a
  model/tool can't point the client at an attacker-chosen host. Status: bounded
  (config, not payload).

### 2. Prompt injection / untrusted content

This plugin's whole job is to store untrusted content — uploaded attachments,
agent-published artifacts, and (later) skill bundles. So "N/A" is not honest
here; we walk it.

Where untrusted bytes flow:

- `bytes: Uint8Array` (on `blob:put`) → hashed in-process, uploaded to an S3
  object verbatim. Never decoded, parsed, rendered, executed, shell-interpolated,
  concatenated into a prompt, or used as a path. Stored as opaque bytes.
- `bytes` (returned by `blob:get`) → handed back verbatim to the caller. The
  plugin doesn't interpret them.
- `sha256` (caller-supplied) → validated as hex, used only to compute an object
  key. Never interpolated into SQL, a shell, an HTTP URL beyond the key path, an
  HTML render, or a prompt.

The one ACTIVE defense this layer adds: **digest re-verification on read.**
`blob:get` recomputes the sha256 of the bytes it read and rejects (throws
`corrupt`) if it doesn't match the requested hash — backend-agnostic, exactly as
the fs backend does. So even if an attacker (or bitrot, or a misconfigured
lifecycle rule) swaps an object in the bucket, the store refuses to serve bytes
that don't match their content address. (Worst-case test: write `"evil swap"`
over a stored object's key in the bucket; the test asserts `blob:get` throws
`corrupt`, never returns the swapped bytes.) We deliberately do NOT trust the
server's own checksum — content-addressing integrity is OUR invariant, enforced
client-side regardless of which S3-compatible server is behind the endpoint.

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

One new third-party dependency: **`@aws-sdk/client-s3`**.

- **Pinned?** Yes — EXACT `3.1057.0` in `package.json` (no `^`/`~`). The manifest
  range is the source of truth; an upgrade must be a deliberate edit, not a
  silent float. (The repo's "pin everything we can" posture.)
- **Install-time scripts?** None. The published package's `scripts` field holds
  only dev/build/test scripts (`build`, `test`, …) — NO `postinstall`,
  `preinstall`, `install`, or `prepare` lifecycle hook. Verified across the whole
  pulled-in `@aws-sdk/@smithy` transitive tree: 0 install hooks across 32
  packages. No network calls at install.
- **Maintainer history?** Official AWS package — maintainers `amzn-oss
  <osa-3p@amazon.com>` and `aws-sdk-bot`, first published 2020-01-14, one of the
  most-downloaded npm packages. Not a fresh / low-trust package.
- **Transitive deps?** The new surface is the modular `@aws-sdk/*` +
  `@smithy/*` packages (the v3 SDK is deliberately modular so you pull only the
  S3 client, not the monolithic v2 SDK), plus small leaf utils
  (`fast-xml-parser`, `tslib`, `uuid`, `bowser`, `strnum`). The lockfile diff is
  scoped to this importer block + that tree — no unrelated peer churn. `pnpm
  audit --audit-level moderate` (the CI gate) reports **no known
  vulnerabilities** on the pinned range.

For tests, we hand-roll an in-memory `FakeS3Client` rather than pulling in
`aws-sdk-client-mock` — adding a mocking dev dep would be new supply-chain
surface for zero behavioral gain, and the fake models exactly the six-command
contract the store exercises (now including CopyObject, plus an optional async
jitter so the race tests genuinely interleave).

Dev deps (`@ax/test-harness`, `@types/node`, `typescript`, `vitest`) match the
repo's standard ranges and are not loaded at runtime.

Status: **one new dependency, exact-pinned, audit-clean, zero install scripts,
official-maintainer, modular transitive surface.** Bounded and reviewed.

## Concluding note

The S3 blob store is a content-addressed integrity layer over object storage,
not a content-safety layer. It guarantees you read back exactly the bytes whose
hash you asked for (or a hard error), it never lets a caller-supplied key escape
its bucket prefix, and it reaches exactly one bucket at one operator-configured
endpoint with no static keys in the tree on the prod path. It does NOT vouch for
what those bytes mean — consumers that hand a blob's content to a model, a
renderer, or a shell must treat it as untrusted. We're the paranoid friend who
double-checks the object's hash matches before handing it over; we're not
promising there's nothing scary inside the box you asked us to hold.
