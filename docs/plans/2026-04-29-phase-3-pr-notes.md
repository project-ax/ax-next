# Phase 3 — PR notes

**Branch:** `phase-3-oauth-slice`
**Plan:** `docs/plans/2026-04-29-phase-3-oauth-impl.md`
**Design doc:** `docs/plans/2026-04-27-agent-centric-simplification-design.md` Section 3 (credentials), Section 4 (OAuth lifecycle), Section 5 (rotate-session seam).
**Predecessors:** Phase 1b (PR #19 — credentials facade + store-db split, deferred reshape) and Phase 2 (PR #20 — credential-proxy + bridge wiring).

## What lands

The OAuth slice. Three structural pillars from the plan, plus the user-visible `ax-next credentials login anthropic` flow that proves they work end-to-end.

| Slice | Change |
|---|---|
| `@ax/credentials` | `credentials:get/set/delete` reshape to `(ref, { userId, kind?, ... })`. `:get` returns `string` directly (not `{ value }`). `:set` wraps payloads in a `{ kind, expiresAt?, metadata?, payloadB64 }` envelope before AES-GCM. `:get` decrypts, reads `kind`, dispatches to `credentials:resolve:<kind>` if the sub-service is registered (OAuth path); otherwise UTF-8-decodes the payload (api-key fast path). Per-`(userId, ref)` async mutex coalesces concurrent resolves so an OAuth refresh fires at most once. |
| `@ax/credentials-store-db` | Storage key shape is now `credential:<userId>:<ref>` (was `credential:<id>`). I14 — forward-compatible with multi-tenant; today's CLI hardcodes `userId='cli'`. |
| `@ax/credential-proxy` | Two `credentials:get` call sites adopt the new shape. `proxy:rotate-session` pulls `userId` from the stored `SessionConfig` (set at open time) — never from `ctx.userId`, which would let a different user-context resolve someone else's credentials. |
| `@ax/mcp-client` | `transports.ts:resolveCredentials` adopts the new shape. MCP servers run on behalf of the agent's user (`ctx.userId`). |
| `@ax/credentials-anthropic-oauth` | New plugin. Registers `credentials:resolve:anthropic-oauth` (refresh-if-needed inside a 5-minute buffer), `credentials:login:anthropic-oauth` (PKCE authorize-URL + verifier + state), `credentials:exchange:anthropic-oauth` (auth-code → token blob). Constants ported from v1 (CLIENT_ID, endpoints, scopes, redirect URI). |
| `@ax/chat-orchestrator` | `proxy:rotate-session` plumbing. After `proxy:open-session`, sessions whose agent has any non-`api-key` credential get flagged for per-turn rotation. `chat:turn-end` subscriber fires `proxy:rotate-session` for flagged sessions before the one-shot cancel. Fire-and-forget — a failing rotate logs a warning but doesn't abort the chat. api-key-only sessions stay in Phase 2 coarse mode. |
| `@ax/cli` | New `credentials login anthropic [<ref>]` subcommand. Binds `127.0.0.1:1455` (Anthropic-whitelisted redirect_uri), opens browser via `spawn` with arg array (no shell), validates state on callback (CSRF), exchanges code, stores blob via `credentials:set`. New `open-browser.ts` helper enforces an origin allowlist for the URL. The `set` subcommand now wraps the secret as `kind: 'api-key'`. |
| `@ax/cli/main` + `@ax/preset-k8s` | Both load `@ax/credentials-anthropic-oauth` unconditionally — purely additive (only dispatches for OAuth credentials). Half-wired window for the new plugin closes here. |
| `@ax/cli/dev-agents-stub` | Existing `requiredCredentials` override fully supports OAuth — JSDoc documents the override pattern. Three new regression tests pin behavior. |

End-to-end coverage: the CLI login test (`packages/cli/src/__tests__/credentials-login.test.ts`) round-trips through real sqlite + the real OAuth plugin. A separate gated suite (`packages/credentials-anthropic-oauth/src/__tests__/refresh.e2e.test.ts`) hits Anthropic's actual `/v1/oauth/token` endpoint when `AX_TEST_ANTHROPIC_OAUTH_REFRESH_TOKEN` is set; CI skips automatically.

## Open question §1 — RESOLVED (Task 7 spike)

`@anthropic-ai/claude-agent-sdk@0.2.119` honors `CLAUDE_CODE_OAUTH_TOKEN` (verified at `node_modules/.../sdk.mjs:105`). No SDK shim needed. Setting the env var alongside `ANTHROPIC_API_KEY=ax-cred:...` in the sandbox is sufficient — the proxy substitutes both placeholders mid-flight depending on which header the SDK sends.

## Open question §5 — RESOLVED (Task 11)

`chat:turn-end` already exists (Week 6.5+) and is already subscribed by the orchestrator. No new event emission was needed — the OAuth rotation just hooks into the existing turn-boundary signal.

## Half-wired windows — CLOSED

- **`@ax/credentials-anthropic-oauth`**: loaded by both `@ax/cli` (`packages/cli/src/main.ts`) and `@ax/preset-k8s` (`presets/k8s/src/index.ts`) in the same PR. Reachable from:
  - `ax-next credentials login anthropic` CLI subcommand (user-facing, integration-tested).
  - The OAuth-demo override pattern in `dev-agents-stub` (test-covered).
  - The (gated) e2e in `packages/credentials-anthropic-oauth/src/__tests__/refresh.e2e.test.ts`.

No new half-wired windows opened.

## Phase 1b prediction confirmed wrong

Phase 1a memory predicted `credentials:get` would reshape in 1b. Phase 1b memory updated to "deferred to Phase 3 when OAuth needs `kind`/`userId`/`resolve:<kind>`." This PR is that delivery.

## Boundary review — `credentials:get/set/delete` reshape

- **Alternate impl this hook could have:** vault-backed credentials backend (AWS Secrets Manager, GKE Secret Manager). `(ref, userId)` is the natural primary key for all such backends; the reshape is forward-compatible. (See design Section 3 "Pluggable backends".) Per-kind `:resolve:<kind>` dispatch is a clean seam — vault impls can register sibling sub-services for OAuth without touching the facade.
- **Payload field names that might leak:** none. `ref`, `userId`, `kind`, `payload` are all generic. Per-kind sub-services own provider-specific field names internally (`accessToken`, `refreshToken`); those don't appear on the facade boundary.
- **Subscriber risk:** none. `credentials:get/set/delete` are service hooks, not subscriber events. No subscribers to break.
- **Wire surface:** none. `credentials:*` are in-process facade hooks. Not exposed on the IPC bridge to sandboxes (sandbox-side code never calls credentials:* — that's Invariant I1 territory).

## Invariants verified (from impl plan)

| | What | Where verified |
|---|---|---|
| I1 | Real OAuth tokens never enter sandbox | proxy:open-session test asserts envMap contains `ax-cred:<hex>` placeholder, NOT a real token (existing Phase 2 coverage extends; Task 5 doesn't regress it) |
| I2 | No cross-plugin imports | `pnpm lint` clean; `@ax/credentials` imports nothing from `@ax/credentials-anthropic-oauth` (and vice versa); CLI reaches OAuth purely via `bus.call` |
| I3 | Reshape field names don't leak | This boundary review § |
| I4 | Boundary review recorded | this file |
| I5 | Capabilities explicit | `@ax/credentials-anthropic-oauth` manifest declares all three `registers:`; CLI declares `calls: ['credentials:login:anthropic-oauth', 'credentials:exchange:anthropic-oauth', 'credentials:set']` (implicit through the bus.call sites) |
| I6 | Half-wired window closes | Both CLI and k8s preset load the new plugin (Task 13); CLI login flow + gated e2e exercise it |
| I7 | Per-blob mutex serializes resolves | `packages/credentials/src/__tests__/plugin.test.ts` — concurrent `credentials:get` for same `(userId, ref)` only fires the resolver once; different keys run in parallel |
| I8 | 5-min refresh-buffer | `packages/credentials-anthropic-oauth/src/__tests__/plugin.test.ts` — cache hit when expiresAt > now+5min; refresh fires when within the buffer |
| I9 | Refresh failure surfaces structurally | Same test file — non-2xx token endpoint → `PluginError(oauth-refresh-failed)`, no silent retry |
| I10 | rotate-session fires only for OAuth sessions | `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts` — fires on chat:turn-end for OAuth credential, does NOT fire for api-key-only |
| I11 | Placeholder stable across rotation; safe browser open | Orchestrator doesn't propagate the rotate-returned envMap back to the sandbox; CLI `open-browser.ts` enforces origin allowlist + spawn-with-arg-array |
| I12 | Hard-cut reshape | `pnpm build` clean across all 47 workspace packages; tests pass; old `{ id }` shape rejected by handler |
| I13 | PKCE codeVerifier never logged/persisted/exported | `runLoginCommand` keeps verifier in local scope between :login and :exchange; never written to disk, never echoed to stdout/stderr |
| I14 | (userId, ref) storage key forward-compat for multi-user | `packages/credentials-store-db/src/__tests__/plugin.test.ts` — different userIds with same ref produce different storage keys |

## Stats

- 12 commits.
- 7 packages touched (credentials, credentials-store-db, credential-proxy, mcp-client, chat-orchestrator, cli, preset-k8s) + 1 new package (credentials-anthropic-oauth).
- New test coverage: credentials +5, credentials-store-db +1 (multi-user collision), credential-proxy +0 (existing tests updated to new shape), credentials-anthropic-oauth +12 (new) + 1 gated e2e, chat-orchestrator +4 (rotation), cli +9 (login flow + dev-agents-stub regression).
- `pnpm build` clean.
- `pnpm test` green across all touched packages — exactly one skipped suite, the gated OAuth refresh e2e.

## Follow-ups (don't block this PR)

- **Web-chat OAuth UI** — `POST /auth/oauth/start` + `GET /auth/oauth/callback` HTTP routes, "Connect Claude Max" button, cookie-keyed state stash. Phase 10–12 earns it. The hook surface is identical for web-chat; routes will live in `@ax/credentials-anthropic-oauth` and call the same `:login`/`:exchange` sub-services this PR registers.
- **`credentials:list` / `credentials:rotate` (force refresh)** — Defer until an admin UI / "switch account" flow needs them. Lazy refresh on `credentials:get` covers MVP.
- **Real Kysely-backed credentials schema** — Stay in `storage:get/set` shim shape. `expiresAt` lives encrypted inside the blob; queryable column lands when background expiry sweeps need it.
- **Cross-replica refresh coordination (postgres advisory locks)** — In-process per-blob mutex (I7) covers single-replica deployments. Multi-replica earns it.
- **Per-turn rotation stress test under heavy load** — Open question §2 in the design. The per-blob mutex is unit-tested for concurrent calls; production-scale stress test is a follow-up.
- **Native runner / `@ax/llm-proxy-anthropic-format` deletion** — Still Phase 5/6.
- **OpenAI OAuth or other sibling per-kind plugins** — Anthropic alone proves the seam.

## Operator notes

To use OAuth instead of an API key:

```bash
# 1. Set the encryption key (32 bytes, hex or base64).
export AX_CREDENTIALS_KEY=<your-key>

# 2. Run the OAuth flow. Opens a browser; binds 127.0.0.1:1455.
ax-next credentials login anthropic

# 3. Configure dev-agents-stub to use the OAuth credential. In ax.config.ts:
#    {
#      ...,
#      devAgentsStub: {
#        requiredCredentials: {
#          CLAUDE_CODE_OAUTH_TOKEN: { ref: 'anthropic-personal', kind: 'anthropic-oauth' },
#        },
#      },
#    }
#
# 4. Run the canary as usual:
ax-next "list this directory"
```

The orchestrator detects the non-`api-key` `kind` and enables per-turn rotation automatically. No flag.
