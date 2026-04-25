# Security — `@ax/database-postgres`

This package owns the `pg.Pool` and the shared `Kysely` instance for the postgres-backed plugin family (storage-postgres, session-postgres, audit-log, …). It registers one service hook (`database:get-instance`) on the host-side bus and hands every caller the same pooled, parametrized SQL client. No raw query construction, no shell, no filesystem reach beyond what `pg` opens for its socket. This note captures the `security-checklist` walk for the Week 7-9 landing.

## Security review

- **Sandbox:** The capability granted by this plugin is a `pg.Pool` opened against a caller-config'd `connectionString`, plus the `Kysely` wrapper around it. Nothing else. Pool size is bounded (default `max: 10`, override via config). No filesystem reach — `pg` opens a TCP socket (or a Unix domain socket if the connection string says so) and that's the entire FS surface. No process spawn, no `child_process` import in either `plugin.ts` or anywhere this plugin reaches. No env-var reads — `connectionString` arrives through plugin config, not `process.env`. No untrusted-string interpolation: every consumer of the returned `Kysely` instance issues queries through Kysely's query builder, which parameter-binds values via `pg`'s prepared-statement protocol. The `connectionString` typically embeds a password (`postgres://user:pw@host/db`); we never log it at info+ level (`grep -n connectionString` confirms it appears only inside `new pg.Pool({connectionString})` and the `validateConnectionString` shape check, never inside a `logger.*` call). If a future change adds logging, mask it.

- **Injection:** N/A — this plugin handles no model output, no tool output, no external-system input. It exposes a `Kysely<unknown>` instance and lets every consumer typed-cast it to their own schema. Consumers are responsible for parameterizing their own queries, which Kysely does by default for every `.where()`, `.values()`, and friends. The plugin itself never builds a query — it only owns the pool. If a caller goes off-piste and uses `sql\`...\`.execute(db)` with interpolated user input, that's their bug, not this plugin's surface.

- **Supply chain:** Two new runtime deps, both pinned exact: `kysely@0.28.16` (MIT, Sami Koskimäki + established Kysely org, ~6 years of releases, no install-time hooks — `npm view kysely@0.28.16 scripts` shows only `test`, `build`, `clean`, `prettier`, `bench:ts`, `test:*`, `build:*`, `script:*`; no `preinstall`, `install`, `postinstall`, or `prepare`) and `pg@8.20.0` (MIT, Brian Carlson + the node-postgres org, ~14 years of releases, the de facto postgres client for Node — `npm view pg@8.20.0 scripts` returns just `{ test: 'make test-all' }`, no install-time hooks). `pnpm why kysely` and `pnpm why pg` confirm both are direct deps of this package only; nothing else in the monorepo pulls them in transitively yet. Transitive surface for `pg` includes `pg-pool`, `pg-protocol`, `pg-types`, `pgpass`, `pg-connection-string`, `pg-int8` — all sub-packages of the same org or established type-codec libraries, none with install hooks at the resolved versions.

## Connection-string handling

The `connectionString` is the secret in this plugin's blast radius. We treat it like one.

- **Where it comes from.** Plugin config, set by the host process at construction time. Not from a hook payload, not from `process.env`, not from a file this plugin reads. The host is responsible for sourcing it (env var, secret manager, KMS) — we just hold whatever they hand us.
- **Where it goes.** Into `new pg.Pool({connectionString})` in `init()`. That's it. The pool stores it internally; subsequent queries reuse the parsed value. We don't keep our own copy outside the closure.
- **What we log.** Nothing about it. The plugin's only direct log calls (none today) would have to go through `ctx.logger`; if a future change adds connection logging, mask the password with the `pg-connection-string` parser before logging.
- **What `pg` logs.** `pg` itself does not log connection details at info-or-below. It does emit error messages on connect failure that may include the host:port (but not the password — the password is stripped by `pg-connection-string` before any error formatting). If you tail postgres server logs, `log_connections=on` will record the username and source IP, which is server-side and outside this plugin's control.

## Pool sizing and resource limits

`max: 10` by default, overridable via `config.poolMax`. Pool sizing is a denial-of-service surface — too small and a noisy plugin starves its peers; too large and a runaway query loop exhausts the postgres `max_connections` quota.

- **Default of 10.** Sized for a single-process MVP host. A multi-replica deploy may want to scale this down per-replica (because total connections = replicas × poolMax) and enforce the bound at the postgres side via `max_connections` and `pgBouncer`.
- **No idle timeout configured.** `pg`'s default is 10 seconds for `idleTimeoutMillis`; we don't override it. Long-running idle connections close on their own.
- **No statement timeout configured at the pool level.** Per-query timeouts are the consumer's responsibility — Kysely supports `db.executeQuery(...)` with `AbortSignal` for that. A future hardening pass may wire a default `statement_timeout` GUC at connection time.

## Boundary review

- **Alternate impl this hook could have:** `@ax/database-mysql` or `@ax/database-sqlite` — same `database:get-instance` service hook, same `Kysely<unknown>` return shape, different dialect under the hood. Consumers cast to their own schema at the edge; the schema is plugin-private, the dialect is private to whichever database plugin is loaded.
- **Payload field names that might leak:** none. The hook input is `{}` (no fields). The hook output is `{ db: Kysely<unknown> }` — a generic Kysely instance, no `pool`, `pg`, `connectionString`, `dialect`, or other postgres-specific vocabulary on the surface.
- **Subscriber risk:** none. There are no subscribers on `database:get-instance`; it's a service hook, not a notification.
- **Wire surface:** none. `database:*` is host-side only; it is NOT exposed on the IPC bridge to sandboxes.

## Known limits

- **No connection draining on shutdown.** When the kernel gains a plugin-shutdown lifecycle, we'll call `pool.end()` from there. Today, the process exits before anything can close gracefully; `pg` cleans up its own sockets via Node teardown. A long-running migration or in-flight query will be cut off mid-flight on SIGTERM, which is a correctness concern, not a security one.
- **No per-tenant pool isolation.** All consumers share the same pool. A multi-tenant deploy with strict isolation needs either per-tenant `database-postgres` instances (one pool each) or row-level security inside postgres. Week 9.5's auth slice will tell us which.
- **No TLS enforcement.** Whether the connection uses TLS is determined by the `connectionString` (`?sslmode=require`) and the postgres server's config. We don't enforce it on this side. Production deploys MUST set `sslmode=require` (or stricter) — a plaintext connection over an untrusted network is how credentials get scraped. We'll add a config-shape hint in a future hardening pass.

## What we don't know yet

- Whether we want a `database:get-pool` companion hook for plugins that need raw `pg.Pool` access (e.g., for `LISTEN` — though `eventbus-postgres` and `session-postgres` deliberately bypass this plugin for that, see their notes). If 3+ plugins ever need raw pool access, we'll add it; until then, keep the surface minimal.
- Whether the `Kysely<unknown>` cast at the edge is the right ergonomic. Each consumer plugin currently does `(shared as Kysely<MySchema>)` which is type-unsafe by definition. A typed-registry pattern (`db.as<MySchema>()`) is friendlier but adds API surface; we'll revisit when a third or fourth consumer lands.
- How this plugin behaves when postgres is unreachable at `init()` time. Today, `new pg.Pool()` is lazy — the first query fails, not the constructor. A future hardening pass may add an `init()`-time `SELECT 1` health check.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
