# `@ax/storage-sqlite` — Security review

This is the pre-commitment security note for the `@ax/storage-sqlite` plugin, written before any storage code lands. It exists because `CLAUDE.md` invariant #5 (capabilities are explicit and minimized) requires it, and because writing it now is cheaper than writing it after subscribers depend on the wrong shape.

## Design recap (what we're reviewing)

The plugin exposes two service hooks:

- `storage:get(ctx, { key: string }) → { value: Uint8Array | undefined }`
- `storage:set(ctx, { key: string; value: Uint8Array }) → void`

Backed by a single SQLite table `kv(key TEXT PRIMARY KEY, value BLOB, updated_at TEXT)`, via Kysely + better-sqlite3.

Configured by one field: `databasePath: string`. The plugin treats this as operator-supplied and trusted — it does not normalize, canonicalize, or sandbox the path.

No IPC transport, no subprocess, no network. No model I/O reaches this plugin. The stored `value` is opaque bytes; the plugin never parses or executes it.

## Security review

- **Sandbox:** New plugin opens one SQLite file at an operator-supplied `databasePath` and registers two service hooks (`storage:get`, `storage:set`). Reachable FS is one file, chosen by the operator at plugin registration — no caller-provided path ever reaches the filesystem. No process spawn, no network, no env reads, no handles crossing the hook bus (payload values are plain `Uint8Array`, not fds or sockets). SQL injection surface: all queries go through Kysely's parameterized API — no string concatenation, no raw SQL. Key collision / overwrite is by design (`kv` is last-write-wins keyed by `key`); callers that need isolation namespace their own keys.
- **Injection:** N/A — the plugin handles no model output, no tool output, no external API responses, and no user-uploaded content at its own boundary. Callers may pass untrusted bytes as `value`, and may pass caller-chosen strings as `key`. `key` is only ever used as a parameterized bind value against the `kv` table's `TEXT PRIMARY KEY` column; it is never interpolated into SQL, a shell command, a file path, or a prompt. `value` is stored as an opaque `BLOB` and returned as opaque `Uint8Array`; the plugin never parses, renders, or executes it. Callers that put untrusted bytes in must treat them as untrusted on read — the storage layer does not launder trust.
- **Supply chain:** Two new runtime deps, one new dev dep. All pinned with `^` caret ranges in `package.json`; exact versions are locked in `pnpm-lock.yaml` (the lockfile is the source of truth for what actually installs in CI).
  - `kysely@^0.27.4` — type-safe SQL query builder. No install scripts (no `postinstall`/`preinstall`/`prepare` that run code). Zero runtime deps. Maintained by Igal Klebanov, established project with broad adoption.
  - `better-sqlite3@^11.3.0` — synchronous SQLite bindings. Has a `prebuild-install`-based install step that downloads a prebuilt native binary for the host platform (and falls back to compiling from source). This is the standard shape for N-API native modules; the download is from the project's GitHub releases and the lockfile pins an `integrity` hash that catches tampered tarballs. Actively maintained (Joshua Wise / WiseLibs), widely used in the Node ecosystem.
  - `@types/better-sqlite3@^7.6.12` (dev) — types only, DefinitelyTyped-published, no runtime code.
  - Transitive surface to skim when the lockfile diff lands in Task 5: `bindings`, `prebuild-install`, and its download-helper deps (`simple-get`, `tar-fs`, etc.). These are the install-time attack surface; we'll eyeball the lockfile diff at scaffold time and flag anything unexpected.

## Threat-model walk (long form)

### 1. Sandbox escape / capability leakage

Capability surface introduced by this plugin:

| Capability | Shape | Bounded? |
|---|---|---|
| Filesystem write | Single file at `databasePath`, operator-supplied at plugin registration | Yes — one fixed path per plugin instance, not caller-influenced at hook-call time |
| Filesystem read | Same file | Yes — same bound |
| Process spawn | None | N/A |
| Network | None | N/A |
| Env access | None | N/A |
| Handles across hook bus | None — payloads carry `Uint8Array` data, not fds/sockets/capability tokens | N/A |

Failure-pattern check:

- **Path traversal:** `databasePath` is operator-trusted, not caller-trusted. Hook callers never influence the path — they only choose `key`, which is a table row identifier, not a filesystem thing. Status: not reachable from the hook surface.
- **Argv injection:** No process spawn. Status: N/A.
- **Env exfiltration:** No env reads. Status: N/A.
- **Handle leak:** Hook payloads are plain data (`string`, `Uint8Array`). No fds, sockets, or opaque handles cross the hook bus. Status: not applicable.
- **Path-as-token confusion:** There is no `path` field in any payload. `key` is a storage key, not a path, and its name reflects that. Status: not applicable.
- **SQL injection:** All queries go through Kysely's parameterized API. Even if `key` contained SQL-like characters, Kysely binds it as a parameter, not as literal SQL. We will not write any raw SQL in this plugin.

### 2. Prompt injection / untrusted content

Does any string in this code path originate outside the trust boundary?

- Model output: no — the plugin has no LLM client.
- Tool output: no — the plugin does not call tools; it is called by other code that may have been fed tool output, but that's the caller's problem to track.
- User-uploaded content: no — at this layer, values are just bytes; the plugin doesn't know or care where they came from.
- External API responses: no — no HTTP client.
- Third-party plugin output: not reached from inside this plugin.

Where do untrusted strings that *could* pass through (as `key` or `value`) end up?

- `key: string` → bound as a parameter to a `WHERE key = ?` or `INSERT INTO kv (key, ...)` statement via Kysely. Never interpolated into SQL, a shell, a file path, an HTTP URL, an HTML render, or a prompt.
- `value: Uint8Array` → written to a `BLOB` column and returned as `Uint8Array`. Never decoded, parsed, rendered, or concatenated into anything by this plugin.

Worst-case test: a caller passes `key: "'; DROP TABLE kv; --"` and `value: <1 MB of attacker-controlled bytes>`. Kysely binds `key` as a parameter, so the `DROP` never reaches the SQL planner. `value` is stored verbatim; the next `storage:get("'; DROP TABLE kv; --")` returns those same bytes. Nothing executes. Nothing leaks. The attacker has spent a row.

Status: the plugin does not handle model/tool/external content at its own boundary. N/A for prompt injection per se, with the caveat recorded above: callers that store untrusted bytes must treat them as untrusted on read. The storage layer does not launder trust.

### 3. Supply chain

`package.json` changes (to land in Task 5 / Task 6):

```
"dependencies": {
  "kysely": "^0.27.4",
  "better-sqlite3": "^11.3.0"
},
"devDependencies": {
  "@types/better-sqlite3": "^7.6.12"
}
```

Per-dep answers:

**`kysely@^0.27.4`**
- Pinned? Caret range in the manifest; exact version in `pnpm-lock.yaml`. Accepted — this is the repo's convention.
- Install scripts? None. (`package.json` `scripts` is build-only, not lifecycle.)
- Maintainer? Igal Klebanov; established TypeScript SQL builder with wide adoption.
- Runtime deps? Zero. Small transitive surface.

**`better-sqlite3@^11.3.0`**
- Pinned? Caret range in the manifest; exact version + integrity hash in `pnpm-lock.yaml`.
- Install scripts? Yes — native module with a `prebuild-install`-based install step that downloads a prebuilt binary from GitHub releases, falling back to local compile. This is standard for N-API modules. The lockfile's integrity hash catches tampered tarballs; the fallback compile uses the host's `node-gyp` toolchain. We accept this risk because (a) it's the ecosystem standard for SQLite in Node, (b) the alternative pure-JS SQLite implementations are slower and have their own native-binary stories, and (c) the integrity hash plus a trusted-publisher check gives us a meaningful defense.
- Maintainer? Joshua Wise / WiseLibs; actively maintained, widely used.
- Runtime deps? Small — `bindings`, `prebuild-install`, and their transitive helpers. To be eyeballed in the lockfile diff at Task 5 / Task 6.

**`@types/better-sqlite3@^7.6.12`** (dev)
- Pinned? Caret range; lockfile pins exact.
- Install scripts? None (DefinitelyTyped packages are types only).
- Maintainer? DefinitelyTyped community.
- Runtime deps? None — types only, not loaded at runtime.

Action for Task 5: when the lockfile diff lands, scan the new transitive entries (`pnpm why <pkg>` on anything unfamiliar) and flag anything that looks like a brand-new / low-download package or that introduces a second native-build path. We pin our dependencies because we have trust issues. Also because unpinned dependencies are how supply chain attacks happen, and we'd rather be paranoid than compromised.

## PR note (copy into the PR description)

```
## Security review
- Sandbox: New plugin opens one SQLite file at an operator-supplied databasePath and registers storage:get / storage:set. Reachable FS is one fixed path per plugin instance (never caller-influenced). No spawn, no network, no env, no handles across the hook bus. SQL goes through Kysely's parameterized API — no raw SQL.
- Injection: N/A — plugin handles no model/tool/external/user-uploaded content at its own boundary. Caller-supplied key is bound as a SQL parameter; caller-supplied value is stored as opaque BLOB and never parsed, rendered, or executed. Callers that store untrusted bytes must treat them as untrusted on read.
- Supply chain: Adds kysely@^0.27.4 (no install scripts, zero runtime deps), better-sqlite3@^11.3.0 (prebuild-install native module — standard for N-API, integrity-pinned in lockfile), and dev-only @types/better-sqlite3@^7.6.12. All pinned via caret ranges in package.json with exact versions in pnpm-lock.yaml. Transitive surface to eyeball in the lockfile diff at scaffold time.
```

## Concluding note

Storage path is operator-trusted; the plugin does not treat caller-supplied paths as untrusted input. Callers that accept path from untrusted input must validate before passing.
