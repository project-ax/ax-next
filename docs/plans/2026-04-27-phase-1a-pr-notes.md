# Phase 1a — PR notes

**Branch:** `feat/phase-1a-credential-proxy`
**Plan:** `docs/plans/2026-04-27-phase-1a-credential-proxy-impl.md`
**Design doc:** `docs/plans/2026-04-27-agent-centric-simplification-design.md` Section 1 + Section 2
**Security note:** `docs/plans/2026-04-27-phase-1a-security-note.md`

## What lands

Two new additive packages, ~1100 LOC ported from v1's `~/dev/ai/ax/src/host/`:

| Package | Role | v1 source |
|---|---|---|
| `@ax/credential-proxy` | Host-side MITM proxy: TLS termination + credential substitution + canary scan + private-IP block + DNS rebinding defense + per-session allowlist gate | `web-proxy.ts` (656 LOC) + `proxy-ca.ts` (124 LOC) + `credential-placeholders.ts` (122 LOC) |
| `@ax/credential-proxy-bridge` | Sandbox-side library: TCP↔Unix-socket relay so k8s pods can reach the host's proxy | `web-proxy-bridge.ts` (174 LOC) |

Both packages exercised end-to-end by an integration test: bridge → unix socket → proxy → MITM → mock LLM upstream. Substituted credential arrives at upstream; subscriber receives one `event.http-egress` with `classification: 'llm'`.

## What does NOT land (deferred per design Section 7)

- **No wiring into `cli/main.ts`** — the plugin is loaded only by its own tests this phase. **Phase 2** wires it into `agent-claude-sdk-runner` (~1 week).
- **No changes to `@ax/credentials`** — the existing `({id}) → {value}` hook shape stays. **Phase 1b** splits the plugin into facade + storage backend + per-kind resolvers and reshapes the hook contract.
- **No OAuth lifecycle** — Phase 3.

## Half-wired note (CLAUDE.md tension flagged in plan)

CLAUDE.md says *"either fully registered + tested + reachable from the canary acceptance test, or it doesn't merge."* Phase 1a is integration-tested but not loaded by the production CLI. Trade-off accepted per design Section 7 (`Risk: Low. New plugins, not loaded anywhere yet.`); Phase 2 closes the loop within ~1 week.

If Phase 2 stalls beyond a week, this PR turns into the trap the policy was written to prevent. Track explicitly.

## Boundary review

New service hooks: `proxy:open-session`, `proxy:rotate-session`, `proxy:close-session`.

- **Alternate impl this hook could have:** a different proxy backend — e.g., a per-pod sidecar instead of the shared-host listener that v2 ships, or a Cloud-NAT-based gateway with a real cert. Same hook surface, different transport + cert authority.
- **Payload field names that might leak:** `proxyEndpoint` (opaque URI string — `tcp://...` or `unix://...`), `caCertPem` (PEM string), `envMap` (`Record<string, string>` of placeholder values). None leak backend specifics.
- **Subscriber risk:** these are service hooks (one impl), so no subscriber risk on the `proxy:*` surface. The `event.http-egress` subscriber payload uses HTTP-generic fields (`host`, `path`, `status`, `requestBytes`, `responseBytes`, `durationMs`, `credentialInjected`, `classification`, `blockedReason`, `timestamp`) — nothing k8s-specific or backend-specific.
- **Wire surface:** none of these are IPC actions. Internal host hooks only.

## Security review

(See `docs/plans/2026-04-27-phase-1a-security-note.md` for the full walk.)

```
## Security review
- Sandbox: New host plugin tightens sandbox egress to per-session allowlist + private-IP block (incl. IPv4-mapped IPv6 unwrap, Azure IMDS, CGNAT). Real credentials never leave the host process — sandbox env contains placeholders only. Reduces capability vs. existing baseline.
- Injection: Untrusted bytes from sandbox flow through `SharedCredentialRegistry.replaceAllBuffer` (string-replace, no eval). Response path NEVER substitutes (I7 — verified at `listener.ts:542`). Audit event payload tags untrusted strings as data.
- Supply chain: Added `node-forge@^1.3.1` (X.509 cert ops, ~3M dl/wk, no install scripts) and `undici@^7` (already transitive; bridge promotes to direct dep). Caret pinning per project convention; tighter pins for credential-proxy a worthwhile follow-up.
```

## Invariants verified (from impl plan)

| | What | Where verified |
|---|---|---|
| I1 | Real credentials never leave host process | `acceptance.test.ts` — placeholder in sandbox env, real value at upstream |
| I2 | Allowlist is the only egress gate | `listener-http.test.ts`, `listener-connect-bypass.test.ts` — 403 on disallowed host |
| I3 | Private IP ranges blocked (incl. IPv4-mapped IPv6, Azure IMDS, CGNAT) | `private-ip.test.ts` (46 tests across CIDR ranges) |
| I4 | Canary scan aborts before forward + emits `blockedReason: 'canary'` | `listener-connect-mitm.test.ts` — upstream never receives, event captured |
| I5 | CA private key mode 0600 | `ca.test.ts` — `statSync(...).mode & 0o777 === 0o600` |
| I6 | Placeholders are 16 random bytes | `registry.test.ts` — regex `/^ax-cred:[0-9a-f]{32}$/` |
| I7 | No substitution on response path | `listener.ts:542` (response-side `targetTls.on('data')` writes without `replaceAllBuffer`) |
| I8 | Bridge contains zero policy | `bridge.ts` — no allowlist, no IP check, no substitution; pure relay |
| I9 | Plugin additive (no consumer wiring) | `cli/main.ts` untouched; integration test is the consumer |

## Stats

- 26 commits on the branch
- ~1100 LOC of v1 helpers ported into 2 new packages + supporting tests
- 76 new tests (67 in credential-proxy, 8 in credential-proxy-bridge, 1 integration)
- Total repo tests: 1607 → 1683 (no regressions)
- 30 files changed (all scoped to `packages/credential-proxy/`, `packages/credential-proxy-bridge/`, `docs/plans/`, `pnpm-lock.yaml`, `tsconfig.json`)
- `pnpm build` clean (root references include both new packages)
- `pnpm lint` clean
- `pnpm test` clean

## Follow-ups (don't block this PR)

- **Phase 2** — wire proxy + bridge into `agent-claude-sdk-runner`. Closes the half-wired window.
- **Tighter pinning** for `node-forge` (exact version vs caret) — credential-proxy is security-critical.
- **Corrupt-CA-on-disk recovery** — currently the CA-load path doesn't validate; a malformed PEM throws on first `forge.pki.privateKeyFromPem` call. v1 has the same shape.
- **Chunk-boundary substitution** — `replaceAllBuffer` is buffer-level. A placeholder split across two TCP chunks misses substitution + leaks to upstream as the literal `ax-cred:<hex>` (upstream returns 401, no security issue, but a usability/reliability concern). Same for canary scan.
- **`exactOptionalPropertyTypes`** — fixed for credential-proxy in this PR. There may be other packages with the same latent issue if they're not in root tsconfig refs; worth a sweep.
