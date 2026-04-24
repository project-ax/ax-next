# Security — `@ax/ipc-server`

`@ax/ipc-server` is the inbound surface from the untrusted sandbox into the host. Every request hits Zod validation and a bearer-token auth middleware before any hook fires. This note is the walk produced under the `security-checklist` skill at package landing time (Week 6.5a).

## Security review

- **Sandbox:** New listening unix socket. Bound to a per-session private tempdir (mode `0700`, created via `fs.mkdtemp`), so only the host user can connect. Socket path is never logged above `debug`. Every request requires a bearer token matching the session store; unknown tokens return `401` without consuming the request body. Body size capped at 4 MiB (matches `@ax/core`'s `MAX_FRAME`, invariant I11); requests exceeding return `413` before the body is fully read. `Content-Type: application/json` required on POST; other types return `415`. Only POST (RPCs) and GET (long-poll) are accepted; everything else is `405`. Long-poll timeout capped server-side at 30 s (I12); client can't pin a request open indefinitely. Server's idle socket timeout is set above 30 s so long-polls aren't killed mid-flight.
- **Injection:** Every inbound payload is Zod-parsed via `@ax/ipc-protocol` before any subscriber or service fires. Tool output and LLM output crossing back over IPC are treated as untrusted strings (per ax-conventions I5); they reach `chat:end` subscribers unchanged, never interpolated into another subprocess or SQL. Auth-token values are never echoed in error responses — the auth middleware's 401 body carries a generic `SESSION_INVALID` envelope without the offending token. Request bodies are read into a capped Buffer; no streaming into shell / filesystem / DB.
- **Supply chain:** No new runtime dependencies. Node built-ins `http`, `net`, `fs`, `crypto`, `os`, `path` only. `zod` already a transitive dep via `@ax/core` and directly via `@ax/ipc-protocol`. No postinstall scripts in this package. pnpm-lock diff: zero new entries.

## Known scope limits (Task 3)

- No TLS — this package is unix-socket-only; k8s HTTP transport lands in `@ax/sandbox-k8s` (Week 7–9) with mTLS on top.
- No IP allow-list, no rate limits — the auth boundary IS the allow-list (only a valid session token grants access), and a token is only mintable via `session:create` which is an in-process call from the orchestrator.
- No dispatcher — Task 3 wires the listener + auth only. Task 4 fills in the per-action handlers and their Zod validation.
