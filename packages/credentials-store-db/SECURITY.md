# Security — `@ax/credentials-store-db`

This package is the default storage backend for `@ax/credentials`. It registers two service hooks (`credentials:store-blob:put`, `credentials:store-blob:get`) and persists ciphertext bytes through the existing `storage:get` / `storage:set` KV surface — prefixing every key with `credential:`. It exists so future vault / KMS backends can take over the same hook surface without re-routing through KV storage.

## Security review

- **Sandbox.** Host-side only. The plugin never touches the network, never spawns processes, never reads user-supplied paths. Its only reach is `storage:get` / `storage:set` on the bus. Sandboxes cannot invoke `credentials:store-blob:*` directly — the IPC server doesn't route any `credentials:*` action across the boundary, and Phase 1b doesn't change that.

- **Injection.** Credential IDs are validated against `^[a-z0-9][a-z0-9_.-]{0,127}$` before they reach storage, so a caller can't craft an ID that escapes the `credential:` storage-key namespace. The blob payload is opaque bytes — we never interpolate it, log it, or echo it on error. Validation rejects non-`Uint8Array` blobs at the boundary; `instanceof Uint8Array` is what `Buffer.from`-typed inputs already satisfy.

- **Supply chain.** No new runtime dependencies. The plugin uses only `@ax/core` (workspace) and the bus.

## Why this is a thin wrapper

This plugin doesn't add security on top of `storage:get` / `storage:set`. Encryption is owned by `@ax/credentials` (the facade), at-rest protection comes from whatever the storage backend gives us (today: a SQLite file with whatever filesystem permissions the user's umask grants). The point of the seam is **substitutability** — a vault-backed sibling registers `credentials:store-blob:*` against a real KMS without ever calling KV storage — not a new layer of defense.

## Boundary review

- **Alternate impl this hook could have:** `@ax/credentials-store-vault` — same two service hooks, but `:put` calls a Vault API and `:get` decrypts via a KMS key. Or `@ax/credentials-store-aws-sm` against AWS Secrets Manager. The seam is real because these wouldn't go through `storage:*` at all.

- **Payload field names that might leak:** none. `id` and `blob` are both opaque to this plugin — no `key`, `bucket`, `arn`, `rowid`, or backend-specific vocabulary on the hook surface. The `credential:` storage-key prefix is an internal implementation detail and never appears in any hook payload.

- **Subscriber risk:** no subscribers today. A future audit-log subscriber on `credentials:store-blob:get` would see only the `id` (vendor-neutral) and the ciphertext blob (already opaque); no plaintext exposure.

- **Wire surface:** none. `credentials:store-blob:*` is host-side only, never exposed on the IPC bridge to sandboxes.

## Limits / what we don't do yet

- **No `credentials:store-blob:delete`.** The design (Section 3 of `2026-04-27-agent-centric-simplification-design.md`) lists a delete hook in the eventual contract. Phase 1b doesn't ship it because the credentials facade still uses tombstone-via-put on top of the underlying KV store, and adding a half-wired hook would violate Invariant 3. Once `storage:delete` lands (or a vault backend genuinely implements deletion), the facade switches to calling `:delete` on this plugin and the tombstone goes away.

- **No `kind`, `userId`, `metadata`, or `expiresAt`.** The full credentials-row schema in the design is deferred to Phase 3, when OAuth lifecycle (`credentials:resolve:anthropic-oauth`) actually needs those columns. Phase 1b just creates the seam; the schema lands when it earns its weight.

- **No at-rest encryption.** Blobs come in pre-encrypted (the facade's job). If you swap in a vault backend later, the facade's AES-GCM step becomes redundant — we'll add a `backendDoesAtRestEncryption: boolean` flag at that point per Section 3 of the design.

## Security contact

vinay@canopyworks.com.
