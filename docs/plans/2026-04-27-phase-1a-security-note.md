# Phase 1a security note — credential-proxy + bridge

**Date:** 2026-04-27
**Branch:** `feat/phase-1a-credential-proxy`
**Packages reviewed:** `@ax/credential-proxy` (host-side plugin), `@ax/credential-proxy-bridge` (sandbox-side library)
**Status:** All three threat models pass with documented mitigations. Two follow-ups noted (chunk-boundary edge case, exact-pin tightening) — neither blocks merge.

This note walks the three threat models from the `security-checklist` skill (sandbox escape / capability leakage, prompt injection / untrusted content, supply chain). The final block at the bottom is the structured one-line summary for PR description copy-paste.

## 1. Sandbox escape / capability leakage

### `@ax/credential-proxy` (host-side)

- **Filesystem paths:** two write surfaces, both host-controlled config — `caDir` (default `~/.ax/proxy-ca/`) for CA persistence, and the listen-socket path when listening on a Unix socket. Neither is sandbox input. The CA private key is persisted with mode `0600` (verified by test); cert and key live in PEM files at known names (`ca.key`, `ca.crt`). No path is ever taken from a sandbox-supplied string.
- **Network destinations:** outbound TCP only to hostnames that appear in some registered session's allowlist. `resolveAndCheck` blocks the usual private ranges — `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (cloud metadata), `168.63.0.0/16` (Azure IMDS), `100.64.0.0/10` (CGNAT, RFC 6598), `0/8`, plus the IPv6 equivalents and IPv4-mapped IPv6 unwrap. Inbound listener is bounded to `127.0.0.1` (TCP mode) or a Unix socket on the host filesystem (Unix mode).
- **DNS rebinding:** defended. `resolveAndCheck` returns the resolved IP, and the listener uses that IP for the actual `net.connect` / `tls.connect`. There is no second DNS lookup at connect time, so an attacker can't get the second resolution to point at a private IP after the first one passed the check. SNI on the upstream TLS handshake still uses the original hostname (vhost-correct). The SECURITY docstring on `resolveAndCheck` calls this out so future callers don't accidentally re-resolve.
- **Process spawn / env reads:** none. The proxy runs entirely in-process and never reads `process.env` at runtime.
- **Handles passed across boundaries:** all string-shaped — `proxyEndpoint` is a URI, `caCertPem` is PEM text, `envMap` is `Record<string, string>` of placeholder→envname pairs. No file descriptors, no opaque handles. The `SharedCredentialRegistry` holds placeholder→real string mappings in-process only; it is never serialized to disk or to the bus.

### `@ax/credential-proxy-bridge` (sandbox-side)

- **Filesystem paths:** read-only access to a single Unix socket path supplied by the sandbox runner (per the design doc, via `AX_PROXY_UNIX_SOCKET`). The path is a connection target, not a directory walk — no traversal vector.
- **Network destinations:** inbound listener bound to `127.0.0.1:0` (loopback ephemeral, works even with `--network=none`). Outbound only to the configured Unix socket. The bridge does not open its own outbound TCP — every byte tunnels through the host proxy, where the allowlist + private-IP gates run.
- **Process spawn / env reads:** none.
- **Policy:** zero. The bridge is a pure relay. All security checks live host-side in the proxy (per invariant I8 from the Phase 1a plan: "the bridge knows nothing about credentials, allowlists, or policy"). This means a compromised sandbox can't bypass policy by patching the bridge — the gates aren't there.

### Net capability change

This work **reduces** sandbox reach. Before Phase 1a, a sandbox with raw network access could reach any host its DNS resolver could find. After: outbound is gated by per-session allowlist + private-IP block, and real credentials never enter the sandbox env (placeholders only). The expansion is host-side: the proxy now has write access to `caDir` and binds a listen socket. Both are host-controlled config and bounded.

### Concrete failure-pattern checks

- **Path traversal:** N/A — no caller-controlled paths from the sandbox side.
- **Argv injection:** N/A — no process spawn anywhere.
- **Env exfiltration:** N/A — no env reads keyed by caller-supplied names.
- **Handle leak:** N/A — payloads are strings/numbers/Sets, no FDs.
- **Path-as-token confusion:** `proxyEndpoint` is documented as a URI and recipients use it as a connection target. `caCertPem` is documented as PEM text and recipients write it to a sandbox trust store. Neither is dereferenced as a filesystem path.

## 2. Prompt injection / untrusted content

The proxy sees two categories of untrusted bytes from the sandboxed agent:

- **Request bytes (sandbox → upstream):** substituted via `SharedCredentialRegistry.replaceAllBuffer`, which is a host-side string-replace over UTF-8-decoded buffer content. No `eval`, no template interpolation, no shell. The substitution is buffer-level and **not parser-aware**: a placeholder split across two TCP chunks will be missed and forwarded to upstream as the literal `ax-cred:<hex>` string. Worst case: upstream returns 401. The real credential never escapes the host. Documented in the code as an accepted MVP tradeoff.
- **Response bytes (upstream → sandbox):** passed through to the client unmodified. **Never** substituted (per invariant I7: "responses are read-only — the proxy must not write placeholder→real swaps on the response path"). Verified in `listener.ts`: the upstream `targetTls.on('data')` handler writes to `clientTls` directly without touching `replaceAllBuffer`.

### Where untrusted strings end up

- **Substituted request body → upstream.** That's the intended target. Nothing host-side parses, evaluates, or shell-interpolates the bytes.
- **Response body → client.** Also the intended target. The proxy does nothing dangerous with response bytes — if a malicious tool returned `"; rm -rf ~; echo "` in JSON, the proxy passes it through and the client (sandboxed agent runtime) is responsible for not feeding response strings to a shell. The proxy isn't a shell, so this doesn't fire here.
- **Audit event payload → subscribers.** The `event.http-egress` payload carries `host`, `path`, `method`, `status`, `blockedReason`, `sessionId`, `userId` — all derived from request metadata. Any subscriber that renders these into HTML / SQL / a prompt must escape; the proxy's contract is that these are data, not commands. No subscriber inside this PR does anything dangerous with them (they're emitted via the bus, not formatted into anything).
- **CONNECT target hostname:** parsed via `target.split(':')` then validated by `net.isIP` + `dns.promises.lookup` in `resolveAndCheck`. No shell interpolation, no string concatenation into a command line.

### Canary scan, same caveat

The MITM path scans decrypted request chunks for per-session canary tokens. Same chunk-boundary tradeoff as substitution: a canary split across two TCP chunks would not be detected. This is defense-in-depth (we still have the allowlist + private-IP gates as the primary controls), and we accept it for MVP. Documented in code. A future revision could buffer enough bytes to span a token width before forwarding, at the cost of latency on long-poll responses.

## 3. Supply chain

### New entries — `packages/credential-proxy/package.json`

- **`node-forge@^1.3.1`** (runtime) — pure-JS X.509 cert generation, used for the MITM root CA and per-domain leaf certs. Maintained by Digital Bazaar, ~3M weekly downloads on npm. We verified it has **no `postinstall` / `preinstall` / `prepare` scripts**. Zero runtime deps.
- **`@types/node-forge@^1.3.11`** (devDep) — type definitions only, no runtime code.
- **`@ax/credential-proxy-bridge: workspace:*`** (devDep) — workspace-internal package, used by the integration test in Task 17. Not external.
- **`undici@^7.25.0`** (devDep) — official Node.js HTTP client (Node core team), used by integration tests to drive proxy traffic. Already present in the project's lockfile transitively before this PR.

### New entries — `packages/credential-proxy-bridge/package.json`

- **`undici@^7.0.0`** (runtime) — same package as above, this time a direct runtime dep because the bridge uses `undici.fetch` with a Unix-socket Agent for HTTP forwarding (Node's built-in `fetch` doesn't expose `socketPath` cleanly).

### Pinning

We're using caret ranges (`^`), which match the project convention. The lockfile pins exact versions; the manifest range governs upgrade behavior. For `credential-proxy` specifically — which mints certs and substitutes credentials — there's a defensible argument for tightening to exact pins so a transitive `node-forge` upgrade can't ship via lockfile refresh without a deliberate review. We're flagging this as a follow-up rather than blocking the PR. If we adopt exact pinning anywhere, this package is the right place to start.

### Transitive surface

`node-forge` has zero runtime deps. `undici` brings a small set of transitive deps (`@fastify/busboy` and a handful of others), all already present in the project's lockfile from earlier work — no fresh entries land with this PR.

---

## Security review

- **Sandbox:** Reduces sandbox reach — outbound network gated by per-session allowlist + private-IP block (`127/8`, `10/8`, `169.254/16`, `168.63.0.0/16`, `100.64.0.0/10`, IPv6 link-local + IPv4-mapped); credentials replaced by `ax-cred:<hex>` placeholders so real values never enter sandbox env; bridge is a pure relay with zero policy (all gates host-side).
- **Injection:** Untrusted request bytes from the sandbox are buffer-level string-replaced by `SharedCredentialRegistry.replaceAllBuffer` (no eval, no shell, no parser); response bytes are passed through unmodified and never substituted (I7); chunk-boundary split of placeholders or canary tokens is a documented accepted MVP tradeoff (worst case: upstream 401, no credential leak).
- **Supply chain:** Two new direct runtime deps — `node-forge@^1.3.1` (MITM cert generation, zero runtime deps, no install scripts, ~3M weekly downloads from Digital Bazaar) and `undici@^7.0.0` (bridge HTTP forwarding via Unix socket, Node core team); caret-pinned per project convention with lockfile exact-pinning, and tightening `credential-proxy` to exact pins flagged as a non-blocking follow-up.
