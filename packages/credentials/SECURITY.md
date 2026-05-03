# Security — `@ax/credentials`

This package stores secrets at rest. It registers three service hooks (`credentials:set`, `credentials:get`, `credentials:delete`) on the host-side bus, encrypts values with AES-256-GCM, and hands the ciphertext to whatever plugin owns `storage:set` / `storage:get` (today: `@ax/storage-sqlite`). It's the first piece of v2's secret-management story — API keys for `@ax/mcp-client`'s remote servers land here first, and everything heavier (KMS, OAuth token flows, per-agent scoping) comes later. This note captures the `security-checklist` walk for the Week 6.5e landing.

## Security review

- **Sandbox:** The plugin runs host-side and never touches sandbox-reachable surfaces itself. Its only reach is `storage:get` / `storage:set` on the bus — it does NOT call the network, spawn processes, or read files on its own. The value it persists is always ciphertext produced by `encryptWithKey`; plaintext never goes to storage, and storage never sees the key. The encryption key comes from `process.env.AX_CREDENTIALS_KEY`, which is read ONCE during `init()` and held in a closure; there's no re-read on each call, no logging of the key material, and no hook that exposes it. Sandbox subprocesses cannot invoke `credentials:get` directly — `@ax/ipc-server` exposes a fixed, enumerated set of handlers (`tool.*`, `event.*`, `session.next-message`, `session.get-config`, `conversation.store-runner-session`, `workspace.commit-notify`, `workspace.materialize`), and `credentials:*` is not among them. Adding credentials access over IPC would require a new handler plus the per-session auth story to land first. Sandboxes that legitimately need a secret see it only after a host plugin (e.g., `@ax/mcp-client`) has already resolved it and forwarded the concrete value on a different, scoped hop.

- **Injection:** Credential IDs are validated against `^[a-z0-9][a-z0-9_.-]{0,127}$` before they reach storage, so a caller cannot craft an ID that collides with a different plugin's storage-key namespace (we prefix every key with `credential:` on top of that). The plaintext VALUE is opaque bytes to this plugin — we never interpolate it into a shell, a SQL query, a URL, or a log line. Error messages on decrypt failure are static ("authentication tag mismatch", "ciphertext too short") and never echo the ciphertext, the key, or any part of the value; `decryptWithKey` catches the Node crypto exception and rethrows a scrubbed `PluginError` rather than letting the native error bubble up with whatever context it carries. Because AES-GCM is an AEAD, a tampered blob or a wrong key fails the auth tag before any plaintext is returned — there's no "partial decrypt" path a caller could observe.

- **Supply chain:** No new runtime dependencies. This package uses `node:crypto` from stdlib (`createCipheriv`, `createDecipheriv`, `randomBytes`) and `@ax/core` (workspace). Nothing to pin, nothing to audit beyond Node itself. AES-256-GCM is a standard AEAD construction: 32-byte key, 12-byte random IV per encryption (NIST SP 800-38D recommended length for GCM), 16-byte authentication tag. The stored blob layout is `IV || ciphertext || tag` — no custom framing, no version byte yet (see "What we don't know yet").

## Key management posture

`AX_CREDENTIALS_KEY` is an MVP env-var sentinel. It gets us to a working secret store without dragging in KMS clients, and it's a deliberate stopgap — production deploys will front this with a real KMS in Week 13+.

- **Shape.** 32 bytes. Accepted as either 64 hex characters or 44 base64 characters (`parseKeyFromEnv` sniffs which one you gave it). Anything else throws on plugin init with `code: 'invalid-key'`. Generate a fresh one with `openssl rand -hex 32` or `openssl rand -base64 32` and put it somewhere your process manager can hand it to the CLI — not in a file your editor will autosave into a git repo.
- **Lifetime.** Read exactly once, inside `init()`. If you rotate the env var under a running process, the plugin keeps using the old key until restart. This is intentional — live re-read would mean every `credentials:get` has to re-parse the env, which widens the window where the key material sits in V8's string table.
- **Rotation.** There is no `ax-next credentials rotate` command yet — that's a Task 21 follow-up. Today, rotation means: set a new `AX_CREDENTIALS_KEY`, restart the CLI, and re-set every stored credential (`ax-next credentials set <id>`). Anything encrypted under the old key will fail decrypt with `authentication tag mismatch` until it's replaced. When the rotate command lands, it will re-encrypt in place under a new key without requiring the user to remember each value.
- **Forward look.** Week 13+ replaces the env var with a KMS-backed key provider (cloud KMS, HashiCorp Vault, or similar). The `encryptWithKey` / `decryptWithKey` API is already shaped so the key can be sourced from anywhere — the env-var path is just the first implementation.

## Delete-tombstone caveat

`@ax/storage-sqlite` doesn't have a `storage:delete` hook yet. `credentials:delete` works around this by writing an encrypted-empty-string as a tombstone — `encryptWithKey(key, '')` — and `credentials:get` checks for an empty plaintext and reports the credential as not-found.

Consequences to know about:

- The storage row for a deleted credential stays in the SQLite file forever (well, until `storage:delete` lands). The blob is still encrypted under the current key, so the data is not plaintext-recoverable, but the existence of a credential with that ID is observable by anyone who can read the storage rows.
- `credentials:set('some-id', '')` is indistinguishable from a deleted credential. The `credentials:set` path rejects non-string values but not empty strings, so callers that legitimately want to store an empty value can't — don't store empty strings; they'll read back as "not found."
- When `storage:delete` lands, `credentials:delete` switches to calling it and this caveat goes away for new deletes. Existing tombstones from before the switch will need a one-shot cleanup — track alongside the rotate command.

## Known limits

- **No audit logging of credential reads.** Every `credentials:get` is silent. A future `@ax/audit-log` subscriber on `credentials:get` would close this — the hook bus already supports subscribers on service calls, and the plugin doesn't need to change to get audit coverage.
- **No per-credential ACL.** Anyone with bus access (i.e., any host-side plugin) can read any credential by ID. The plugin does NOT authenticate or authorize callers itself — the bus is assumed trusted, and cross-tenant / cross-agent scoping arrives with `@ax/auth` in Week 9.5. Until then, credentials are a shared namespace per CLI process.
- **No memory zeroization.** Node `Buffer` and V8 `string` are not guarded memory. The decrypted plaintext sits in V8's heap until GC; the key sits in the closure for the process lifetime. A core dump, a swap file, or a sufficiently motivated process-memory read will find both. Defenses against that class of attack (sealed secrets, HSM-backed decrypt) are a Week 13+ KMS concern, not something we pretend to solve here.
- **No ciphertext version byte.** The stored blob is raw `IV || ct || tag`. If we ever change algorithms (e.g., XChaCha20-Poly1305 for larger nonces), we'll need to add a version prefix and migrate existing blobs. Flagged below in "What we don't know yet."

## Boundary review

- **Alternate impl this hook could have:** `@ax/credentials-kms` — same three service hooks (`credentials:get` / `:set` / `:delete`), but backed by a cloud KMS decrypt call instead of local AES-GCM. The service hook signatures are plaintext-in / plaintext-out to the caller, so swapping the implementation requires no change at the call site.
- **Payload field names that might leak:** none. The service hooks use `id` (opaque string) and `value` (opaque string). No mention of `key`, `iv`, `tag`, `cipher`, `kms-arn`, `rotation-id`, or any other backend-specific vocabulary on the hook surface. The `credential:` storage-key prefix is an internal implementation detail of this plugin and does not appear in any hook payload.
- **Subscriber risk:** no subscribers today. If a future audit-log subscriber keys off the `id` field, that's fine — `id` is vendor-neutral. A subscriber that tried to peek at the raw ciphertext blob would have to intercept `storage:set` instead, and that's a different boundary.
- **Wire surface:** none. `credentials:*` is host-side only; it is NOT exposed on the IPC bridge to sandboxes. If we ever do expose it, the auth story (per-session scoping, per-credential ACL) has to land first.

## What we don't know yet

- Whether 128-bit AES-GCM auth tags are going to feel short in five years. They're fine today — NIST still recommends 128-bit tags as the default — but crypto advice moves, and we haven't versioned the blob format, so a format change means a migration.
- Whether the rotate command should double-encrypt during rollover (read under old key, write under new, one credential at a time) or snapshot the whole store. The former survives a mid-rotate crash; the latter is faster. We'll decide when we build it.
- Whether `AX_CREDENTIALS_KEY` should support a "primary + previous" pair for seamless rotation. Almost certainly yes, but we haven't designed the env-var shape for it yet — today you get one key, and rotation means downtime.
- How this plugin behaves under a multi-tenant host. Week 9.5's auth slice will tell us whether `credentials:get` needs a `tenantId` arg (breaking the current signature) or whether tenancy rides on the bus context. We don't want to guess wrong, so we haven't added tenant scoping yet.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
