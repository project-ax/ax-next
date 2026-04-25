---
'@ax/workspace-git-core': minor
'@ax/workspace-git-http': minor
'@ax/workspace-protocol': minor
'@ax/workspace-git': patch
'@ax/preset-k8s': minor
'@ax/cli': minor
---

Multi-replica workspace via `@ax/workspace-git-http`.

We carved the existing `@ax/workspace-git` impl into a shared `@ax/workspace-git-core`
and built a multi-replica path on top: a host-side plugin that forwards every
`workspace:*` hook over HTTP to a dedicated git-server pod (single replica by design,
because exactly one process owns the bare repo). The four hooks stay storage-agnostic
(invariant I1); the `runWorkspaceContract` suite passes against both backends, and a
new multi-replica concurrency test proves three host plugins can race the same parent
and converge to a linear history.

- **`@ax/workspace-git-core`** — the impl extracted (mutex + `validatePath` +
  delta builder). No plugin manifest of its own. Two consumers: the in-process
  wrapper and the HTTP server.
- **`@ax/workspace-git`** — shrunk to a thin wrapper. Hook surface unchanged.
  The single-replica known-limit retired (the http variant addresses it).
- **`@ax/workspace-protocol`** — Zod schemas + per-action timeouts + base64
  codec + wire-error envelope for the HTTP transport.
- **`@ax/workspace-git-http`** — host-side plugin
  (`createWorkspaceGitHttpPlugin({baseUrl, token})`) registers the four hooks
  and forwards via HTTP; pod-side server (`createWorkspaceGitServer`) wraps
  the core, listens on TCP, single replica by design. Bearer auth via
  `crypto.timingSafeEqual` against a static service token (not session-resolved).
  Empty-turn short-circuit lives server-side so it can run after parent-CAS.
- **`@ax/preset-k8s`** — `workspace` config is now a discriminated union
  (`{backend: 'local', repoRoot}` or `{backend: 'http', baseUrl, token}`). The
  preset registers the matching plugin. New `workspaceConfigFromEnv()` helper
  reads `AX_WORKSPACE_BACKEND` + the http-mode env vars. New
  `loadK8sConfigFromEnv()` builds the full preset config from chart-stamped
  env (`DATABASE_URL`, `AX_K8S_HOST_IPC_URL`, `K8S_*`, `BIND_HOST`/`PORT`,
  `AX_LLM_*`, `AX_RUNNER_BINARY`, `AX_CHAT_TIMEOUT_MS`).
- **`@ax/cli`** — new `serve` subcommand. Boots the k8s preset and exposes a
  small HTTP front door: `GET /health` (no auth, k8s probe), `POST /chat`
  (optional bearer auth via `AX_SERVE_TOKEN`; runs one chat turn, returns
  `{sessionId, outcome}` JSON). Production lifecycle is SIGTERM-driven.
  This unblocks the chart's host pod (`command: ["node", "dist/cli/index.js",
  "serve", "--port", "8080"]`).

Helm chart adds `gitServer.enabled` + `workspace.backend: local|http` and ships
a new git-server Deployment / Service / PVC / ServiceAccount / NetworkPolicy /
Secret. The git-server pod runs non-root with a read-only rootfs and zero egress;
the NetworkPolicy admits host pods only — runner pods cannot reach it directly.
The auth Secret and PVC carry `helm.sh/resource-policy: keep` so an accidental
`helm uninstall` doesn't rotate the token under a running host pod or destroy
workspace history.

Manual-acceptance scenario added in `deploy/MANUAL-ACCEPTANCE.md` for
multi-replica chat — fully runnable now that `serve` ships.
