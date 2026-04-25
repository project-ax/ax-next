# Security — `@ax/storage-postgres`

This package is the postgres-backed peer of `@ax/storage-sqlite`. It registers two service hooks (`storage:get`, `storage:set`) on the host-side bus and persists opaque bytes into a single `storage_postgres_v1_kv` table behind the shared `Kysely` instance owned by `@ax/database-postgres`. Bytes go in, bytes come out — nothing in between interprets them. This note captures the `security-checklist` walk for the Week 7-9 landing.

## Security review

- **Sandbox:** This plugin's reach is exactly one postgres table — `storage_postgres_v1_kv`, schema-prefixed and migrations-pinned to literal SQL (see `migrations.ts`). It does NOT open its own pool, does NOT take a `connectionString` directly, and never spawns a process or reads a file. The only capability it grants is "writeable BYTEA store, keyed by string." All SQL flows through Kysely's query builder, which parameter-binds via `pg`'s prepared-statement protocol — no string concatenation of caller input into queries. The migration is a single literal `CREATE TABLE IF NOT EXISTS ...` issued via `sql\`\``, and the table prefix (`storage_postgres_v1_*`) is a constant in this plugin, not derived from any input.

- **Injection:** Tool output and LLM output may eventually flow into the `value` parameter of `storage:set` — for example, an audit-log subscriber writing tool-result blobs, or `@ax/credentials` writing AES-GCM ciphertext that ultimately wraps API keys the model handed to a tool. We treat that input as opaque bytes: it's stored as `BYTEA` via `Buffer.from(value)`, never interpolated into a shell, a path, a URL, a log line, or a second query. On read it comes back as `Uint8Array` with the same defensive copy. The `key` parameter is also typed `string` and parameter-bound, so a malicious key like `'); DROP TABLE ...; --` lands in the row literally as those characters and does nothing else.

- **Supply chain:** No new direct deps beyond `@ax/core` (workspace) and `kysely@0.28.16` (already pinned and audited by the `@ax/database-postgres` security review — see `packages/database-postgres/SECURITY.md`). This plugin does NOT pull in `pg` directly; it reaches the pool via the bus's `database:get-instance` hook, so the `pg` review also lives with the database plugin. `pnpm why kysely` and `pnpm why pg` confirm no new transitive surface from this package.

## Sandbox / capability scope

The capability budget is one schema-prefixed table and zero of everything else. Concretely:

- **Filesystem:** none. We don't open files. We don't even have a filesystem reach to validate.
- **Network:** none directly. The shared `Kysely` instance has a TCP connection to postgres, but we don't open it — `@ax/database-postgres` does, and consumers including this plugin reach it through the bus.
- **Process spawn:** none. No `child_process` import.
- **Env vars:** none read.
- **Other plugins:** one — `database:get-instance` is in the manifest's `calls` list. That's the entire inter-plugin surface. We don't import `@ax/database-postgres` at runtime (Invariant 2); the bus is the API.

## Injection / untrusted content

The two strings in this code path are `key` and `value`:

- **`key: string`** — caller-supplied. We don't validate its shape (a future hardening pass may add a regex; today it's untyped beyond `typeof === 'string'` at the boundary). It's parameter-bound into Kysely's `.where('key', '=', key)` and `.values({key, ...})`. Worst case for a malicious key is a collision with another consumer's key namespace — that's a logical bug for the host to solve via key prefixing (e.g., `@ax/credentials` prefixes with `credential:`), not an injection vector. SQL injection is structurally impossible here because the parameter binding is at the `pg` protocol layer.
- **`value: Uint8Array`** — caller-supplied bytes. May originate from tool output, model output, or anywhere. Stored verbatim as `BYTEA`. Read back verbatim. We never decode it as JSON, never interpret it as a shell command, never log it, never interpolate it into anything. A blob containing `$(rm -rf /)` is just bytes that go into the table and come back out as the same bytes.

What about subscribers? There are no subscriber hooks on `storage:get` / `storage:set` today. If a future audit-log subscriber observes these, the `value` field is `Uint8Array` (typed) — subscribers must NOT shell-interpolate it or treat it as a code blob.

## Supply chain

No new direct dependencies. The runtime dep list in `package.json`:

- `@ax/core` — workspace, kernel.
- `kysely@0.28.16` — already covered by `@ax/database-postgres`'s security note. Same pin, same audit.

There's no `pg` import in this package's source; `npm view pg` etc. are all done in the database-postgres review. `pnpm why kysely` shows it as a direct dep of both `@ax/database-postgres` and `@ax/storage-postgres` — same version resolved, no duplication.

Dev deps (`@ax/database-postgres`, `@ax/test-harness`, `@testcontainers/postgresql@11.14.0`, `vitest`, etc.) are not on the production critical path. `@testcontainers/postgresql` only loads in tests; if it ever ends up in `dependencies`, that's a regression and the dep audit needs redoing.

## Boundary review

- **Alternate impl this hook could have:** `@ax/storage-sqlite` (already the in-tree peer), `@ax/storage-redis`, `@ax/storage-s3` — same `storage:get` / `storage:set` hooks, different backend. The hook signatures (`{key: string}` → `{value: Uint8Array | undefined}`) and (`{key: string, value: Uint8Array}` → `void`) are storage-agnostic. The fact that THIS plugin uses postgres is plugin-internal; `@ax/credentials` and any future consumer can swap impls without code change.
- **Payload field names that might leak:** none. Hook payloads use `key` (opaque string) and `value` (opaque bytes). No `row_id`, `oid`, `bucket`, `namespace`, `table`, `pg_*`, or `BYTEA`-flavored vocabulary on the surface. The `storage_postgres_v1_kv` table name and the `key` column are plugin-internal.
- **Subscriber risk:** no subscribers today. A future subscriber must treat `value` as opaque bytes — not as JSON, not as text, not as a code blob.
- **Wire surface:** none. `storage:*` is host-side only; sandboxes do NOT call it directly.

## Migration posture

`runStorageMigration(db)` issues `CREATE TABLE IF NOT EXISTS storage_postgres_v1_kv (...)` with a literal SQL string — no interpolation, no caller input. The `v1` in the prefix is the schema version. When the shape needs to change incompatibly, we add a `v2` table and a forward-only migration; we do NOT mutate v1 in place, because old code may still be reading it during a rolling deploy. (See `migrations.ts` for the doc-comment.)

## Known limits

- **No `storage:delete` yet.** Same caveat as `@ax/storage-sqlite`. `@ax/credentials` works around it with an empty-ciphertext tombstone. When `storage:delete` lands, it'll be added across both storage plugins simultaneously.
- **No size cap on values.** A consumer can write a 1GB blob and we'll happily accept it (well, until postgres rejects it at ~1GB per `BYTEA`). Practical exploit surface is denial-of-service against disk space; if we observe abuse, we'll add a per-call size cap.
- **No per-key ACL.** Anyone with bus access can read or write any key. Cross-tenant scoping arrives with `@ax/auth` in Week 9.5.
- **Single shared Kysely instance.** All consumers share the same pool (managed by `@ax/database-postgres`). A pathological key range scan or a missing index can starve other plugins; for the MVP this is acceptable, but a multi-tenant deploy will want per-tenant pools or row-level security.

## What we don't know yet

- Whether the `key`-as-opaque-string contract will hold under multi-tenant. If a future schema needs `(tenant_id, key)` as a composite primary key, that's a forward-only `v2` migration — but it also changes the hook signature, which is a breaking change. Week 9.5 will tell us.
- Whether `value` should grow a content-type tag. Today consumers know the byte format because they wrote it (e.g., `@ax/credentials` knows it's `IV || ciphertext || tag`). A future feature that lets consumers introspect "what shape is this blob" would need a versioned envelope; we haven't designed one.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
