# Phase 1 — workspace redesign storage tier

Implements Phase 1 of the workspace redesign per `docs/plans/2026-05-01-workspace-redesign-design.md` and the slice plan at `docs/plans/2026-05-01-workspace-redesign-phase-1-plan.md`. Adds a sharded, container-shipped, native-`git`-binary storage tier (`@ax/workspace-git-server`) that speaks standard git smart-HTTP plus a tiny REST surface for repo lifecycle. Production keeps using `@ax/workspace-git-http` — the new tier is gated behind `gitServer.experimental.gitProtocol: false` for the canary phase. Phase 2 wires the host plugin and closes the half-wired window.

## Summary

- New package `@ax/workspace-git-server` (server + a test-only host-side library + integration tests).
- New container image at `container/git-server/Dockerfile` (debian-slim base, pinned git via apt, non-root, direct-execed Node).
- Helm chart additions (gated by `experimental.gitProtocol`): StatefulSet with per-shard PVCs via `volumeClaimTemplates`, headless Service for stable per-pod DNS, parallel NetworkPolicy permitting host pods only.
- Sharding by `(workspaceId)` — SHA-256 first 4 bytes mod N, no new dep, deterministic across host replicas.
- Argv-injection gate: `^[a-z0-9][a-z0-9_-]{0,62}$` workspaceId regex + `path.resolve` startsWith defense-in-depth + paranoid `git` env (full env replacement, never inheriting `process.env`).
- `runWorkspaceContract` reuse — all 9 contract assertions pass against the new tier.
- Multi-replica concurrency test, empty-repo materialize test, 35-input argv-injection acceptance test (× 6 routes = 222 assertions).

393 tests in `@ax/workspace-git-server`, 6 in `@ax/chart-tests`, all green.

## Open question resolutions (per the plan)

| # | Question | Resolution |
|---|---|---|
| 1 | HA per shard | Single-replica per shard for MVP; document as known limit. Recovery time on pod restart is "seconds." HA deferred to a separate design. |
| 2 | Re-sharding | Operator picks `gitServer.shards` at install time; changing later requires manual workspace migration (drain → rsync → flip traffic). Operational follow-up, not architectural. |
| 7 | First-time materialize | `POST /repos` creates an empty bare repo (no synthetic initial commit). Host treats "no `refs/heads/main`" as the empty-baseline case. First push from the host creates `main` atomically. v1's tempdir-bootstrap dance avoided. Validated by `__tests__/integration/empty-repo-materialize.test.ts`. |
| 4 | Container shape | Separate `ax-next/git-server` image. Host/runner stay slim; only the storage tier ships the git binary. |
| 5 | Shard hash | SHA-256 first 4 bytes mod N. No new dep. |
| 6 | WorkspaceId regex | `^[a-z0-9][a-z0-9_-]{0,62}$` (lowercase only, no dots, max 63 chars / DNS-label cap). Tighter than v1's. |

## Cross-phase deviation: Option D adopted

The original phasing said "replace storage, keep host's iso-git client for now." But `@ax/workspace-git-http` (JSON-over-HTTP) and the new server (git smart-HTTP) are not wire-compatible. Resolution: ship the server PLUS a **test-only** host-side adapter that satisfies `runWorkspaceContract`. Production keeps using the legacy stack until Phase 2 promotes the adapter into a registered plugin. See plan §"Cross-phase dependency surfaced" for the analysis.

## Boundary review (per CLAUDE.md)

The four canonical `workspace:*` hooks are unchanged by Phase 1 — the new server is reached over the wire from a future host plugin, not directly from the bus. The new wire surface (REST + git smart-HTTP) still gets the review:

- **Alternate impl this wire could have:** Yes — Gitea, GitHub Enterprise, GitLab self-hosted. The wire is standard git smart-HTTP plus a tiny REST CRUD; the REST CRUD shape is the only thing each backend's adapter would translate (~50–200 LOC per backend).
- **Payload field names that might leak:** `headOid` and `default_branch: "main"` are git-shaped — but exposed only on the server's REST API (which is by definition git-shaped). The bus-level `workspace:*` hooks in `@ax/workspace-protocol` still use opaque `WorkspaceVersion` and don't expose `oid`. The leak stops at the storage-tier wire and never reaches subscribers.
- **Subscriber risk:** N/A in Phase 1 (no new subscribers; no plugin registers anything for this server in this PR — that's Phase 2).
- **Wire surface:** REST schemas live in `packages/workspace-git-server/src/server/repos.ts` (Zod, co-located with handlers). Smart-HTTP routes in `src/server/smart-http.ts`. NOT in `@ax/workspace-protocol` — the new wire is decoupled from the legacy JSON-over-HTTP wire.

## Security review

```
- Sandbox: New @ax/workspace-git-server container introduces process-spawn capability scoped to the literal command 'git' with fixed argv shape. Caller never controls argv0 or flags; the only caller-derived element is repoPath, built from a regex-validated workspaceId via path.join(repoRoot, ...) with a defense-in-depth path.resolve startsWith check. Locked-down env via PARANOID_GIT_ENV (full replacement, never { ...process.env, ... }). NetworkPolicy permits only inbound from host pods on the configured port; egress: []. Filesystem access bound to <repoRoot>/. SecurityContext: non-root UID 1000, all caps dropped, readOnlyRootFilesystem: true. Per-package SECURITY.md walks the budget in detail.
- Injection: Storage tier handles only opaque pack bytes (piped through git's stdin/stdout), regex-validated workspaceIds, bearer tokens compared via crypto.timingSafeEqual, and a 1 MiB JSON request body schema-validated by Zod. Bearer token never appears in any error message. Logged workspaceIds are regex-restricted (no newlines, control chars, ANSI). Model-output / tool-output / commit-message attack surface lives in Phase 3 (sandbox-side commit construction) — Phase 1's storage tier never sees agent-originated strings directly.
- Supply chain: Zero new npm runtime dependencies (uses Node stdlib + zod, both already in workspace). New runtime dependency: the git binary itself, pinned via container/git-server/Dockerfile to a specific apt version on debian-slim. SECURITY.md commits to monthly + critical-CVE rebase cadence. CVE-2024-32002 (clone-side RCE) and CVE-2024-32004 (clone-from-untrusted RCE) both N/A — the server only serves, never clones from untrusted sources; defense-in-depth protocol.allow=never set per-repo regardless.
```

## Half-wired window — OPEN

- New plugin loaded by: NONE (Phase 1 ships server + test-only client; no registered plugin)
- Test/canary that reaches it: `__tests__/contract.test.ts` (9 contract assertions), `__tests__/integration/multi-replica-concurrency.test.ts`, `__tests__/integration/empty-repo-materialize.test.ts`, `__tests__/integration/argv-injection.test.ts`
- User-facing surface: `gitServer.experimental.gitProtocol` chart toggle (operator-flippable; default off)
- Window CLOSES in: Phase 2 (replace registered host plugin with git-protocol client; promote `src/client/plugin-test-only.ts` to a real plugin or extract `@ax/workspace-git-server-client`)
- Successor PR: to be opened next

## Migration & rollback

**Rollback (post-deploy canary surfacing a problem):** flip `gitServer.experimental.gitProtocol: false`, `helm upgrade --reuse-values`. The new StatefulSet + headless Service + experimental NetworkPolicy un-render. Per-shard PVCs persist (`helm.sh/resource-policy: keep`) so bare repos survive for forensics. Production keeps running on the legacy `@ax/workspace-git-http` path the whole time — there's no traffic switchover to undo (Phase 1 doesn't wire any).

Operator runbook: `docs/runbooks/2026-05-01-workspace-git-server-canary.md`.

## Test plan

- [x] `pnpm build` exit 0 across the monorepo.
- [x] `pnpm --filter @ax/workspace-git-server test` — 393 tests, all green.
- [x] `pnpm --filter @ax/chart-tests test` — 6 render assertions, all green (helm CLI required on PATH).
- [x] `docker build -f container/git-server/Dockerfile -t ax-next/git-server:dev .` succeeds; smoke test (`docker run` + `curl /healthz`) returns 200.
- [x] Contract test: 9/9 assertions pass against the new server path via the test-only adapter.
- [x] Multi-replica concurrency: two plugins racing on `parent: v0` → exactly one wins, loser retries on `parent: v1` → both changes land in linear history.
- [x] Empty-repo materialize: `POST /repos` creates empty bare repo; `git ls-remote` returns empty; first apply with `parent: null` lands main; subsequent fetch succeeds.
- [x] Argv-injection: 35 malicious inputs × 6 routes (REST + smart-HTTP) → all rejected before any spawn.
- [x] Helm render with toggle off → only legacy resources render.
- [x] Helm render with toggle on → STS + headless Service + experimental NP render alongside legacy resources.
- [x] Helm render with `gitServer.shards=3` → STS `replicas: 3`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
