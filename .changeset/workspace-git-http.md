---
'@ax/workspace-git-core': minor
'@ax/workspace-git-http': minor
'@ax/workspace-protocol': minor
'@ax/workspace-git': patch
'@ax/preset-k8s': minor
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
  reads `AX_WORKSPACE_BACKEND` + the http-mode env vars.

Helm chart adds `gitServer.enabled` + `workspace.backend: local|http` and ships
a new git-server Deployment / Service / PVC / ServiceAccount / NetworkPolicy /
Secret. The git-server pod runs non-root with a read-only rootfs and zero egress;
the NetworkPolicy admits host pods only — runner pods cannot reach it directly.
The auth Secret and PVC carry `helm.sh/resource-policy: keep` so an accidental
`helm uninstall` doesn't rotate the token under a running host pod or destroy
workspace history.

Manual-acceptance scenario added in `deploy/MANUAL-ACCEPTANCE.md`. Note: that
scenario depends on a `serve` CLI subcommand that doesn't exist in the cli
yet — a separate slice will land it.
