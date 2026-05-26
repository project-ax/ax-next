# Phase 2 — workspace redesign host plugin

Closes the half-wired window opened by PR #30. Phase 1 shipped the sharded git-server storage tier behind `gitServer.experimental.gitProtocol` but never registered a host plugin that talked to it — production kept using the legacy `@ax/workspace-git-http` path. This PR promotes the package's test-only adapter into a real, registered, production-grade host plugin (`createWorkspaceGitServerPlugin`), wires it into `@ax/preset-k8s`'s `createK8sPlugins`, and extends the Helm chart so flipping a single boolean switches the entire stack — host plugin plus storage tier — over together.

Reference: `docs/plans/2026-05-01-workspace-redesign-design.md` and `docs/plans/2026-05-01-workspace-redesign-phase-2-plan.md`.

## Summary

- New host plugin `createWorkspaceGitServerPlugin` (in `@ax/workspace-git-server/src/client/plugin.ts`) registers the four `workspace:*` hooks against the new sharded git-server tier. Same package shape as `@ax/workspace-git-http` (server + plugin co-located).
- Plugin composes a shared `GitEngine` (extracted from Phase 1's `plugin-test-only.ts`) + a per-workspace bare-mirror cache with LRU eviction (default 64 entries) + a retry-wrapped REST lifecycle client.
- `@ax/preset-k8s` extended with a third workspace backend `git-protocol`. Picked at deploy time from new env vars `AX_WORKSPACE_GIT_SERVER_URL` and `AX_WORKSPACE_GIT_SERVER_TOKEN`.
- Helm chart additions: experimental ClusterIP Service in front of the StatefulSet (single stable URL — sharding deferred per Q5), host deployment env-var branch for `git-protocol`, NetworkPolicy egress rule from host to the experimental tier, plus a guardrail that fails `helm template` if `backend=git-protocol` is set without both required toggles.
- Workspace-id derivation: `ws-<sha256(userId + '/' + agentId)[0..16]>`. Stable across host restarts; pinned by 5 hand-chosen test vectors. Total length 19 chars; regex-safe by construction.
- Sharding deferred per Phase 2 plan §Q5. Plugin takes a single `baseUrl: string`. Phase 1's `shardForWorkspace`/`shardUrl` primitives stay in `shared/` but are unused by the host plugin until N>1 becomes load-bearing.
- Multi-replica concurrency proven: three production-plugin instances racing on the same `parent: v0` see exactly one winner per round; losers retry via `cause.actualParent`; final history is linear.
- Subscriber boundary leak detection: a dedicated test pins that no 40-hex oid strings escape into `WorkspaceDelta` outside the opaque `before`/`after` `WorkspaceVersion` tokens.
- Acceptance test parallel to the existing local case: `git-protocol backend boots and completes a chat` boots an in-process `@ax/workspace-git-server` plus the new plugin and runs through the chat-end recorder.

459 tests in `@ax/workspace-git-server`, 46 in `@ax/preset-k8s`, 16 in `@ax/chart-tests`, all green.

## Open question resolutions (per the plan)

| # | Question | Resolution |
|---|---|---|
| Q1 | Plugin location: same package vs. extracted | Same package (`@ax/workspace-git-server/src/client/plugin.ts`). Mirrors `@ax/workspace-git-http`'s shape exactly. No new package edge needed. |
| Q2 | Workspace-id derivation | SHA-256 first 16 hex chars of `(userId, '/', agentId)`, prefixed `ws-`. Deterministic, regex-safe by construction, immune to agentId-collisions across users. |
| Q3 | Mirror cache lifetime | Per-plugin-instance with LRU eviction (default `cacheMaxEntries: 64`). Cold-start cost: one `git fetch` per active workspace. Tempdir-scoped; metadata only, no secrets. |
| Q4 | Retry policy | Mirrors `@ax/workspace-git-http`'s retry shape (extracted into shared `retry.ts`). Outer-op retry with backoff (5 attempts, 100ms → cap 30s). Git-internal retries left to `git`'s own machinery. CAS mismatch → `parent-mismatch`, never retried by the plugin. |
| Q5 | Sharding | Deferred. Plugin takes `baseUrl: string`; chart adds a ClusterIP Service in front of the STS. When/if N>1 becomes load-bearing, the routing layer lands then alongside the operational re-sharding tooling that the design already deferred. |
| Q6 | Canary surface | Global toggle only (`gitServer.experimental.gitProtocol` + `workspace.backend=git-protocol`). No per-team A/B for MVP. Rollback is one helm command. |
| Q7 | Acceptance test reach | Added `it('git-protocol backend boots and completes a chat')` in `presets/k8s/src/__tests__/acceptance.test.ts` parallel to the local case. Half-wired-window discipline says CI must reach the new plugin. |

## Boundary review (per CLAUDE.md)

The four canonical `workspace:*` hook signatures are unchanged from Phase 1. New surfaces in this PR get the review:

- **`workspaceIdFor(ctx)`:** internal derivation (not a hook), but load-bearing for repo-naming stability across host restarts. Pinned by 5 hand-chosen test vectors. Stability is documented in the source comment — changing the derivation strands existing repos on the storage tier.
- **`workspace:apply` `PluginError` shape:** the `code: 'parent-mismatch'` error now carries `cause.actualParent` matching the legacy `@ax/workspace-git-http`'s shape exactly. Subscribers' retry-on-CAS loops are portable across both host plugins; no one keys off backend-specific fields.
- **`WorkspaceDelta` subscriber surface:** unchanged from Phase 1's contract. New `subscriber-no-leak.test.ts` pins that no 40-hex oid strings escape into `JSON.stringify(delta)` outside the opaque `before`/`after` `WorkspaceVersion` tokens. If we ever leak a sha into a delta field, this test catches it.
- **Bearer token wire surface:** lands in the host pod via `valueFrom.secretKeyRef` (Helm-managed Secret); never logged. Defense-in-depth `_sanitizeTokenLeak` scrubs the token from any error's `.message` and `.stack` before re-throw. Pinned by 5 unit tests covering each documented behavior.

## Security review

```
## Security review
- Sandbox: Phase 2 introduces process-spawn capability on the HOST pod scoped to the literal command 'git' with fixed-argv shape. Caller-derived elements (workspaceId, path, oid, remoteUrl) are all regex-safe by construction. HOST_GIT_ENV is a full env replacement (NOT { ...process.env, ... }) — GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, HOME=/nonexistent, GIT_TERMINAL_PROMPT=0, PATH explicit. Per-workspace bare mirror cache lives in tempdir; mirror dirs hold only public git metadata (commits, trees, blobs). Author identity enforced sandbox-side via env vars (every commit's author = 'ax-runner'). NetworkPolicy egress permits the host pod to reach the experimental git-server tier (added in this PR — Critical issue surfaced in code review and fixed before merge); without the new rule, default-on NetworkPolicy would block backend=git-protocol traffic.
- Injection: Token lands in the host pod via valueFrom.secretKeyRef (Helm-managed Secret); never logged, never appears in any error message. The lifecycle REST client and git smart-HTTP transport already discipline against leak; defense-in-depth _sanitizeTokenLeak scrubs token from err.message/err.stack before re-throw, pinned by 5 unit tests covering each documented behavior. Workspace-id derivation is a SHA-256 hash of authenticated session fields, not user-controlled. Commit messages (`reason` field of workspace:apply) flow into git commit -m as a single argv element (opaque bytes); subscribers viewing WorkspaceDelta.reason in Phase 3+ must treat it as untrusted text.
- Supply chain: Zero new npm runtime deps in Phase 2 (the plugin uses @ax/core types + Node stdlib + the package's own internals). New runtime dependency: the git binary on the HOST pod's image (Phase 1 shipped it on the storage tier; Phase 2 adds it to the host). Pin via the host pod's base image; same monthly + critical-CVE rebase cadence as Phase 1. CVE-2024-32002 / CVE-2024-32004 N/A — host plugin only fetches/pushes against bearer-authed endpoints, never clones from untrusted sources. protocol.allow=never in HOST_GIT_ENV is defense-in-depth regardless.
```

## Half-wired window — CLOSED (was OPEN at Phase 1)

- Window opened by: PR #30 (Phase 1, workspace-git-server scaffold).
- Closed by: this PR (Phase 2).
- New plugin loaded by: `@ax/preset-k8s`'s `createK8sPlugins(config)` when `config.workspace.backend === 'git-protocol'`.
- Test/canary that reaches it:
  - `packages/workspace-git-server/src/__tests__/contract.test.ts` (production factory; 9 contract assertions)
  - `packages/workspace-git-server/src/__tests__/multi-replica.test.ts` (3 replicas, concurrency)
  - `packages/workspace-git-server/src/__tests__/subscriber-no-leak.test.ts` (boundary review enforcement)
  - `presets/k8s/src/__tests__/acceptance.test.ts` (`git-protocol backend boots and completes a chat`)
  - `deploy/charts/ax-next/__tests__/render.test.ts` (chart render assertions for the new branch + guardrail failure modes)
- User-facing surface: `gitServer.experimental.gitProtocol` chart toggle is now load-bearing — it gates BOTH the StatefulSet (Phase 1) AND the host's plugin selection (this PR) when `workspace.backend=git-protocol`.
- Operator runbook: `docs/runbooks/2026-05-01-workspace-git-server-canary.md` — replaces the "window OPEN" section with the Phase 2 two-toggle posture.

## Migration & rollback

- **Phase 2 (this PR):** Host plugin registered; chart toggle gates host AND storage tier together. Operators flip `gitServer.experimental.gitProtocol=true` + `workspace.backend=git-protocol` to switch over.
- **Phase 3+ next:** Bundle wire on the sandbox-host axis. Skill validator. Identity validator. Decommission legacy.

Same-day rollback if a soak window surfaces a problem:

```
helm upgrade ... \
  --reuse-values \
  --set gitServer.experimental.gitProtocol=false \
  --set workspace.backend=http
```

The new STS PVCs persist (`helm.sh/resource-policy: keep`). No data migration between legacy and git-protocol tiers in this PR — they are parallel paths, not in-place migrations.

## Test plan

- [x] `pnpm build` exits 0.
- [x] `pnpm --filter @ax/workspace-git-server test` — 459 tests, 21 files, all green.
- [x] `pnpm --filter @ax/preset-k8s test` — 46 tests, 3 files, all green.
- [x] `pnpm --filter @ax/chart-tests test` — 16 tests, 1 file, all green (helm CLI required on PATH).
- [x] Acceptance test boots in-process server through `@ax/preset-k8s` and completes a chat round-trip with the chat-end recorder.
- [x] Multi-replica concurrency: three production-plugin instances racing on `parent: v0` → exactly one wins per round; losers retry via `cause.actualParent`; final history linear.
- [x] Subscriber boundary leak detection: no 40-hex strings in `JSON.stringify(delta)` outside the opaque `before`/`after` keys.
- [x] Helm render with all four cases (`local`, `http`, `git-protocol` both-toggles-on, `http`+`experimental.gitProtocol=true` canary-preflight).
- [x] Helm guardrail fails `helm template` when `backend=git-protocol` is set without both required toggles.
- [x] Host pod's NetworkPolicy egress includes the experimental git-server selector when both toggles are on.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
