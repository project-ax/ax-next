# Security — `@ax/eventbus-postgres`

This package is the cross-replica peer of `@ax/eventbus-inprocess`. It registers two service hooks (`eventbus:emit`, `eventbus:subscribe`) on the host-side bus and delivers payloads via postgres `LISTEN/NOTIFY`. Each plugin instance opens one dedicated `pg.Client` (NOT the shared pool — `LISTEN` needs a connection that isn't returned mid-listen), and reconnects with exponential backoff if the link drops. This note captures the `security-checklist` walk for the Week 7-9 landing.

## Security review

- **Sandbox:** This plugin opens exactly one `pg.Client` per plugin instance, against a caller-config'd `connectionString`. No filesystem reach, no spawn, no env-var reads. All `LISTEN`/`UNLISTEN` go through `pg.escapeIdentifier()` on a channel name that's already passed an allowlist regex (`/^[a-zA-Z0-9_]+$/`); all `NOTIFY` calls go through `pg_notify($1, $2)` with both args parameter-bound by the `pg` protocol — belt-and-braces against identifier injection (the regex catches it at the surface, the parameter binding makes it structurally impossible at the wire). Payload is JSON-encoded and capped at 8000 bytes (postgres's documented `NOTIFY` hard limit); over-cap calls reject early with a structured `PluginError` rather than silently truncating server-side. Reconnect backoff is bounded `1s → 2s → 4s → 8s → 16s → 30s` with the timer `unref()`'d so a dead postgres doesn't hold the process alive.

- **Injection:** Subscriber payloads originate from whoever calls `eventbus:emit` — could be model output, tool output, host code, or another plugin. We JSON-serialize on the producer side and `JSON.parse()` on the consumer side, so payloads cross the wire as text but reach subscribers as parsed values. Subscribers receive the parsed JSON and own their own safe handling (don't shell-interpolate it, don't render it as HTML without escaping, etc.). The plugin itself never executes a payload, never logs it at info+, never interpolates it into anything other than the `pg_notify` call (parameter-bound). One thing to flag explicitly: postgres `LISTEN/NOTIFY` payloads are observable by ANY postgres role with `LISTEN` privilege on the channel — not a bug in this plugin, but worth knowing if you put secrets in payloads (don't put secrets in payloads).

- **Supply chain:** One direct runtime dep, `pg@8.20.0`, already pinned exact and audited by the `@ax/database-postgres` security review (see `packages/database-postgres/SECURITY.md` for the full provenance — `npm view pg@8.20.0 scripts` returns just `{ test: 'make test-all' }`, no install hooks; Brian Carlson + the node-postgres org, ~14 years of releases). No new transitive surface introduced by this package — `pnpm why pg` shows it as a direct dep of both `@ax/database-postgres` and `@ax/eventbus-postgres`, same version resolved.

## Sandbox / capability scope

The capability budget is one TCP connection to postgres, one channel-name allowlist, and one byte cap. Concretely:

### Channel-name allowlist

Every channel name passed to `eventbus:emit` or `eventbus:subscribe` must match `/^[a-zA-Z0-9_]+$/`. Anything else throws `PluginError(code: 'invalid-channel')` before any SQL touches the wire. This is enforced in `assertChannel()` (`plugin.ts:172-180`) and applied at BOTH hook boundaries.

Why we belt-and-braces this:
- `LISTEN`/`UNLISTEN` take a SQL identifier, not a parameter. We pass it through `pg.escapeIdentifier()` (`listener.ts:123`) which is the documented-safe way to embed a caller-supplied identifier into a SQL statement. So even if the regex were missing, escapeIdentifier would still defend.
- `pg_notify(text, text)` takes both args as parameters; we bind them with `$1, $2` (`listener.ts:152`). So even if the channel name had SQL meta-characters, the wire protocol prevents injection on the emit side.
- The regex on top of these two defenses is for "no surprises" — it means a channel name in code-review looks like an identifier, full stop. A reviewer doesn't have to think "is this safe" for every emit/subscribe call.

### Payload byte cap

`Buffer.byteLength(json, 'utf8') > 8000` rejects with `PluginError(code: 'payload-too-large')` (`plugin.ts:93-100`). Postgres's documented `NOTIFY` payload limit is 8000 bytes (after `NAMEDATALEN` math). Going over silently truncates or errors at the server; we reject early so the producer gets a clean `PluginError` instead of a confused `pg-protocol` exception.

### Dedicated client + reconnect

The `Listener` class (`listener.ts`) holds a single `pg.Client` for the lifetime of the plugin instance. It is NOT a pooled connection — pool connections can be returned mid-listen, dropping all subscriptions. On `client.on('error')` we drop the dead client and schedule a reconnect with exponential backoff (`1s, 2s, 4s, 8s, 16s, 30s` cap, `listener.ts:84`). On reconnect we re-issue `LISTEN` for every channel that still has a local subscriber. Subscribers never see the disconnect; emissions delivered while we were down are LOST (LISTEN/NOTIFY is best-effort, not durable — this is a postgres semantic, not something we can paper over).

The reconnect timer is `unref()`'d (`listener.ts:96-98`) so a dead postgres doesn't keep the Node process alive. `shutdown()` clears the timer, ends the client, and clears the channel map.

### No pool sharing

We deliberately do NOT use `@ax/database-postgres`'s `database:get-instance` for this — see `plugin.ts` header comment. A `LISTEN` binding is to a specific connection; if the pool returns it to its idle set, the binding is gone. So this plugin opens its own dedicated `pg.Client` and holds it forever (modulo reconnect). The connection-string config is therefore SEPARATE from the database plugin's connection-string — they can be the same string in practice, and usually will be, but the plugin doesn't enforce that.

## Injection / untrusted content

Payloads on this hook MAY carry untrusted content — tool output, model output, user input crossing a trust boundary, etc. Here's how it flows:

1. **Producer side.** `eventbus:emit({channel, payload})` accepts `payload: unknown`. We `JSON.stringify` it and check the byte length. We do NOT inspect the payload's contents, scrub it, or try to validate "is this safe."
2. **Wire.** The JSON string is passed as `$2` to `pg_notify($1, $2)`. Parameter-bound. Postgres stores it in the per-channel queue.
3. **Listener side.** `Client.on('notification')` fires (`listener.ts:101`); we look up the channel's local subscribers and call each handler with `JSON.parse(payload)` (`plugin.ts:131-132`). Parse errors are logged and dropped — a malformed payload doesn't crash the listener or take out other subscribers.
4. **Subscriber side.** Each handler is fired in its own try/catch so a throwing handler doesn't take out its peers (`plugin.ts:142-147`). Handlers receive the parsed value and own safe handling from there.

What a malicious payload can NOT do here:
- Inject SQL — payloads are parameter-bound on emit and never used as identifiers.
- Crash the listener — parse failures are caught and logged.
- Take out peer subscribers — each handler is isolated in try/catch.
- Bypass the channel allowlist — `assertChannel` runs on both emit and subscribe.

What a malicious payload CAN still do, for which the subscriber owns the defense:
- Be huge-but-under-8000-bytes (DoS via per-message JSON.parse cost — bounded by the cap).
- Be a JSON object whose fields cause a buggy subscriber to crash, exfil data, or shell-interpolate. Subscribers own their own threat model on the parsed value.

### Postgres-side observability

`LISTEN/NOTIFY` payloads are observable by any postgres role that has `LISTEN` privilege on the channel. By default, any role connected to the database can `LISTEN` on any channel — there's no per-channel `GRANT`. If you have multiple tenants in the same database and you don't want tenant A to see tenant B's notifications, you need:

- Separate databases per tenant (the cleanest), OR
- Per-tenant channel-name prefixes plus a CONVENTION that consumers only LISTEN on their own prefix (defense-in-depth, not a real boundary), OR
- A different transport (durable queue, message broker) — `eventbus-postgres` is best-effort and not built for cross-tenant secrecy.

This is a postgres semantic, not a bug in this plugin. We flag it so callers know not to put cross-tenant secrets into NOTIFY payloads.

## Supply chain

One direct runtime dep:

- `pg@8.20.0` — already covered by `@ax/database-postgres`'s security note. Same pin (`"pg": "8.20.0"`, no `^` or `~`). Same maintainer audit (Brian Carlson + node-postgres org). Same install-hook check (`npm view pg@8.20.0 scripts` returns `{ test: 'make test-all' }` only — no `preinstall`, `install`, `postinstall`, or `prepare`). `pnpm why pg` confirms it resolves to the same version across `@ax/database-postgres`, `@ax/eventbus-postgres`, and (transitively, dev-only) `@ax/storage-postgres`'s tests.

No transitive new surface introduced beyond what the pg review already covered. `@types/pg@8.20.0` is a dev dep (types only, not in the runtime path).

## Boundary review

- **Alternate impl this hook could have:** `@ax/eventbus-inprocess` (already shipped, covers single-process), `@ax/eventbus-redis` (using Redis pub/sub), `@ax/eventbus-nats` (NATS subjects). Same hook signatures, different transport. Cross-replica delivery is the use case that motivates the postgres impl over inprocess; the surface stays storage-agnostic.
- **Payload field names that might leak:** none. The service hook surface is `{channel: string, payload: unknown}` for emit and `{channel: string, handler: function}` for subscribe. No `notify`, `listen`, `pg_notify`, `oid`, `lsn`, or other postgres-specific vocabulary on the surface.
- **Subscriber risk:** the SECOND-ORDER subscribers (handlers passed into `eventbus:subscribe`) receive parsed JSON. They MUST treat it as untrusted. If a subscriber shell-interpolates the payload or passes it as a tool argument the model didn't originate, they own that injection. The hook surface itself is fine.
- **Wire surface:** none on the IPC bridge. `eventbus:*` is host-side only.

## Known limits

- **Best-effort delivery only.** `LISTEN/NOTIFY` is not durable. Notifications emitted while a subscriber's listener is reconnecting are lost. If durability matters, we need a different plugin (queue table with cursor + pollers) — which is exactly what `@ax/session-postgres` does for its inbox.
- **No flow control.** A producer that emits a million messages in a tight loop will fill postgres's notify queue (8000 bytes × `max_notify_queue_pages` × `BLCKSZ`) and start blocking emitters. We don't rate-limit on this side; if abuse becomes a thing we'd add a per-channel token-bucket.
- **Connection-string secret.** Same caveat as the database plugin: the connection string typically embeds a password, and we don't log it. If a future change adds connection logging, mask the password.
- **`shutdown()` is the only escape hatch today.** Production callers should NOT depend on `shutdown()`; tests use it to drain the LISTEN client before stopping the testcontainer. When the kernel gains a plugin-shutdown lifecycle, this moves there.

## What we don't know yet

- Whether channel-name namespacing (e.g., `tenantA_*`) should be enforced in code rather than left to convention. The regex allows underscores, which is enough for prefixing — but we don't validate that the prefix matches the caller's tenant. Week 9.5's auth slice will tell us whether we need to.
- Whether the 8000-byte cap is too small in practice. Most current callers are well under it (workspace-applied notifications, session-inbox NOTIFY pings — all small). If we ever want to ship larger payloads, we'd switch to a separate "fetch by ID" pattern: NOTIFY a small ID, the subscriber reads the full payload from a row.
- Whether to expose a `eventbus:health` hook for callers to introspect connection state. Today the listener's connection state is internal; if a runtime want to expose "are we connected to postgres," we'd need a hook. Not yet asked for.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
