# `ax-next/git-server` container

The runtime image for `@ax/workspace-git-server` — the storage tier of the
Phase 1 workspace redesign. It bundles `git` (apt-installed) plus the
package's compiled HTTP listener, listening on port `7780`. The host plugin
talks to it over standard git smart-HTTP plus a tiny REST surface for repo
lifecycle.

The `git` package is currently UNPINNED. A TODO in the Dockerfile commits
to locking it to a specific Debian-stable version once the CI image-build
pipeline lands; until then this Dockerfile is suitable for dev and the
parallel-canary slice but should not be the long-term production image.

It is deliberately a separate image from the host/runner — those stay slim
and don't need `git`. We ship one image per tier so each tier's CVE budget is
its own.

## What's in the box

- `node:20-bookworm-slim` base (multi-stage; final stage is the same slim
  base with `git` installed via apt + the deployed package).
- A non-root `axgit` user (UID/GID `1000:1000`, `nologin` shell).
- The package's compiled output + production-only `node_modules`, resolved
  via `pnpm deploy` so `workspace:*` deps are flattened into a self-contained
  `/opt/ax-next/git-server/`.
- No baked-in secrets. The bearer token + repo root come in at run time via
  env (the chart wires them from a Helm Secret + a PVC mount).

## Building

Run from the **repo root** — the build context needs `pnpm-workspace.yaml` and
the workspace packages.

```bash
docker build -f container/git-server/Dockerfile -t ax-next/git-server:dev .
```

The `.dockerignore` next to the Dockerfile prunes the heavy bits
(`node_modules`, `dist`, `__tests__`, `.git`, top-level scratch images).

## Local smoke test

The image needs two env vars: a writable repo root and a bearer token.

```bash
docker run --rm -d --name ax-git-server \
  -p 7780:7780 \
  -e AX_GIT_SERVER_REPO_ROOT=/var/lib/ax-next/repo \
  -e AX_GIT_SERVER_TOKEN=test \
  ax-next/git-server:dev

# Health probe — no auth required:
curl -sS http://localhost:7780/healthz
# {"status":"ok"}

docker stop ax-git-server
```

If the curl returns `200 {"status":"ok"}`, the image is live and the drain
logic, regex validation, and paranoid git env are all wired. The full
end-to-end push/clone flow is exercised by the package's integration tests
(`pnpm --filter @ax/workspace-git-server test`), not by `docker run`.

## Deployment

The Helm chart wires this image into a `StatefulSet` with one PVC per
replica, gated on `gitServer.experimental.gitProtocol`. Templates have
landed at:

- `deploy/charts/ax-next/templates/git-server/statefulset.yaml`
- `deploy/charts/ax-next/templates/git-server/service-headless.yaml`
- `deploy/charts/ax-next/templates/networkpolicies/git-server-experimental-network.yaml`

The toggle is OFF by default — the chart still ships the legacy
single-replica `Deployment` until operators flip
`gitServer.experimental.gitProtocol=true`. Both tiers render in parallel
during the canary phase; once promoted, the legacy `Deployment` is
removed in a follow-up PR.

## Caveats and TODOs

- **Pin the `git` apt package.** Today we install unpinned `git`; CI image
  builds will pin a specific Debian-stable version (`git=1:2.39.x-y`) once
  the build pipeline is in place.
- **Pin the base image by digest.** `node:20-bookworm-slim` is tag-only
  here. CI promotes it to `node:20-bookworm-slim@sha256:...`.
- **No `HEALTHCHECK` directive.** Kubernetes liveness/readiness probes own
  this; an in-image `HEALTHCHECK` would just be redundant noise in the pod
  state.
