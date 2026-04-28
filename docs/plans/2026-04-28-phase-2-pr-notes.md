# Phase 2 — PR notes

**Branch:** `phase-2-runner-proxy-wiring`
**Plan:** `docs/plans/2026-04-28-phase-2-runner-proxy-wiring-impl.md`
**Design doc:** `docs/plans/2026-04-27-agent-centric-simplification-design.md` Section 1 + Section 5
**Predecessor:** Phase 1a (PR #1) — credential-proxy + bridge shipped without consumer wiring; this PR closes that loop.

## What lands

The credential-proxy + bridge that Phase 1a shipped get wired into the SDK runner's startup path:

| Slice | Change |
|---|---|
| `@ax/chat-orchestrator` | Per-`agent:invoke` proxy lifecycle: `proxy:open-session` after `agents:resolve`, before `sandbox:open-session` (carrying a `proxyConfig` blob). `proxy:close-session` in `finally` (I7). Soft-dep gated via `bus.hasService` so non-credential-proxy presets stay supported until Phase 5/6. |
| `@ax/sandbox-subprocess` | New optional `proxyConfig` field on `OpenSessionInput`. When set, writes the MITM CA PEM to a per-session tmpfile and injects `HTTPS_PROXY` / `HTTP_PROXY` / `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `AX_PROXY_*` / `envMap` into the runner env. CA cleanup piggybacks on the existing tempdir rm. |
| `@ax/agent-claude-sdk-runner` | Reads `AX_PROXY_ENDPOINT` / `AX_PROXY_UNIX_SOCKET`; `AX_LLM_PROXY_URL` becomes optional XOR. Bridge mode (`AX_PROXY_UNIX_SOCKET`) starts `@ax/credential-proxy-bridge` and rewrites `HTTP(S)_PROXY` in-process. Direct mode (`AX_PROXY_ENDPOINT`) is a no-op — sandbox-subprocess set the env at spawn. Both modes drop `ANTHROPIC_BASE_URL` and call `api.anthropic.com` directly through `HTTPS_PROXY` (I8). The placeholder `ax-cred:<hex>` flows as `ANTHROPIC_API_KEY`. |
| `@ax/cli` | Loads `@ax/credential-proxy` on `cfg.llm === 'anthropic'` (TCP loopback). Mock-LLM path keeps the legacy in-sandbox llm-proxy — loading the proxy in mock mode would force the SDK runner onto direct-egress and turn every canary into a real network call. |
| `@ax/cli/dev-agents-stub` | Default agent now returns `allowedHosts: ['api.anthropic.com']` and `requiredCredentials: { ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' } }`. Users seed the credential before the canary works: `ax-next credentials set anthropic-api`. |
| `@ax/preset-k8s` | Loads `@ax/credential-proxy` on a Unix socket (default `/var/run/ax/proxy.sock`, overridable via `K8sPresetConfig.credentialProxy.socketPath` + the `AX_PROXY_SOCKET_PATH` env var). |
| `@ax/audit-log` | Subscribes to `event.http-egress` and persists one row per egress (key `egress:<sessionId>:<timestamp>`). |

End-to-end coverage: a new gated test (`packages/cli/src/__tests__/credential-proxy.e2e.test.ts`) round-trips a real Anthropic call through the credential-proxy when `AX_TEST_ANTHROPIC_KEY` is set; CI skips automatically.

## Phase 1a half-wired window — CLOSED

Phase 1a (PR #1) shipped `@ax/credential-proxy` and `@ax/credential-proxy-bridge` without any consumer wiring. This PR closes that window:

- `@ax/cli` (`packages/cli/src/main.ts`) loads the proxy plugin on the `cfg.llm === 'anthropic'` branch.
- `@ax/preset-k8s` (`presets/k8s/src/index.ts`) loads the proxy plugin (Unix socket).
- `@ax/chat-orchestrator` calls `proxy:open-session` per `agent:invoke` and closes it in `finally` (I7).
- `@ax/agent-claude-sdk-runner` reads the proxy env, starts the bridge if needed (k8s mode), and redirects SDK calls through `HTTPS_PROXY` (drops `ANTHROPIC_BASE_URL` per I8).
- `@ax/audit-log` persists each `event.http-egress` fire.

Both Phase 1a packages are now reachable from the canary acceptance test in the CLI preset (and the gated real-API e2e). Half-wired window: closed.

## Boundary review — `OpenSessionInput.proxyConfig` (new field)

- **Alternate impl this hook could have:** a vault-backed proxy that exposes a different endpoint shape (e.g. `vault://<role>` URI). The `endpoint`/`unixSocketPath` split keeps the wire surface flexible without committing to a specific protocol — a third variant could land as `proxyConfig.endpoint = 'vault://...'` without renames.
- **Payload field names that might leak:** none. `endpoint` is a generic URI; `unixSocketPath` is a generic path; `caCertPem` is a generic standard format; `envMap` is a generic key-value map. No git/k8s/sqlite vocabulary.
- **Subscriber risk:** sandbox-subprocess is the only consumer today. Future k8s sandbox (Phase 7-9) will consume the same shape. No subscribers parse `endpoint` for protocol semantics — it's passed verbatim into `HTTPS_PROXY`.
- **Wire surface:** none. `OpenSessionInput` is in-process only; not exposed on the IPC bridge to sandboxes (the runner reads the resolved env, not the input shape).

## Invariants verified (from impl plan)

| | What | Where verified |
|---|---|---|
| I1 | Real credentials never enter sandbox process | sandbox-subprocess `open-session.test.ts` (env-injection test reads ANTHROPIC_API_KEY = ax-cred:<hex> placeholder, NOT a real key); I9 audit on the runner side (placeholder forwarded, IPC bearer never sent upstream) |
| I2 | No cross-plugin imports | `pnpm lint` clean; orchestrator + sandbox-subprocess each define their own `ProxyConfig` shape |
| I3 | `proxyConfig` field names don't leak backend | Boundary review § (this file) |
| I4 | Boundary review recorded | this file's "Boundary review" section |
| I5 | Capabilities explicit | orchestrator uses `bus.hasService` runtime check (soft dep); manifest unchanged. sandbox-subprocess manifest unchanged (it receives the resolved blob — no proxy-hook calls) |
| I6 | Half-wired window closed | "Phase 1a half-wired window — CLOSED" § (this file); CLI canary loads both packages |
| I7 | `proxy:close-session` always fires | orchestrator test "calls proxy:close-session in finally even when sandbox:open-session throws" |
| I8 | SDK runner stops setting `ANTHROPIC_BASE_URL` when proxy is wired | `proxy-startup.test.ts` "direct mode: no ANTHROPIC_BASE_URL" + "bridge mode: no ANTHROPIC_BASE_URL" |
| I9 | `AX_LLM_PROXY_URL` optional XOR | `env.test.ts` covers all three modes (legacy, AX_PROXY_ENDPOINT only, AX_PROXY_UNIX_SOCKET only) + the all-missing failure |
| I10 | Bridge mode rewrites `HTTP(S)_PROXY` | `proxy-startup.test.ts` "bridge mode: starts the bridge, rewrites process.env.HTTPS_PROXY" |

## Out-of-scope (deferred)

These were called out as Phase 2 non-goals in the impl plan and remain so:

- **`proxy:rotate-session` plumbing.** Single-turn flow doesn't rotate; Phase 3 (OAuth) earns it.
- **K8s deployment manifests** (helm chart updates for proxy Unix socket + emptyDir mount). The preset wires the plugin; the chart needs a follow-up PR.
- **Native runner deletion.** `@ax/agent-native-runner` and `@ax/llm-proxy-anthropic-format` stay loaded for the native runner. Phase 5/6 deletes them.
- **`credentials:get` reshape to `(ref, { userId })`.** Still Phase 3 (OAuth) work; the proxy calls credentials with the current `{id} → {value}` shape.
- **Allowlist enforcement at the agents-resolve boundary in production.** The dev stub returns a hardcoded allowlist; the real `@ax/agents` plugin's `Agent` shape doesn't yet have `allowedHosts` / `requiredCredentials` columns. Phase 9.5+ extends real `@ax/agents`. In the meantime, k8s deploys with this PR see proxy:open-session called with empty allowlist + empty credentials → all egress blocked. **Documented operator action: seed at least one agent record with the right shape before running canary.**
- **Canary token integration.** Open question §7 in the design — defer until a concrete threat model justifies it.

## Stats

- 8 commits on the branch
- 7 packages touched + 1 preset
- ~12 new tests (orchestrator: 5; sandbox-subprocess: 4; runner: 5; CLI wiring: 1; e2e: 1 gated)
- ~190 LOC of new test code; ~280 LOC of new production code
- `pnpm build` clean
- `pnpm test` clean across all touched packages

## Follow-ups (don't block this PR)

- **Helm chart updates** for the credential-proxy Unix socket emptyDir mount on host + sandbox pods.
- **Real `@ax/agents` schema migration** to add `allowed_hosts text[]` and `required_credentials jsonb` columns + matching admin UI fields. Without this, k8s production deploys can't seed proxy-aware agents.
- **Phase 5/6** — delete `@ax/agent-native-runner` + `@ax/llm-proxy-anthropic-format` once the SDK runner is the only path. The legacy branches in `proxy-startup.ts` and `setupProxy()` go with them.
- **Phase 3** — OAuth credential refresh + the `credentials:get` reshape. `proxy:rotate-session` plumbing earns its weight here.
