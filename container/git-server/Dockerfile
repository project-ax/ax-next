# syntax=docker/dockerfile:1.7
#
# @ax/workspace-git-server runtime image.
#
# What this image is:
#   - A Node 20+ HTTP listener that fronts a pinned `git` binary and serves
#     standard git smart-HTTP plus a tiny REST surface on port 7780.
#   - The storage tier of Phase 1's workspace redesign — one process per
#     StatefulSet replica, one PVC per replica, sharded by workspaceId on the
#     host side. Not a multi-tenant general-purpose git host.
#
# What this image is NOT:
#   - Not the host or runner image. Those stay slim and don't ship `git`.
#   - Not a base for ad-hoc git operations. It exposes only the routes our
#     host plugin speaks.
#   - Not loaded with secrets at build time. Bearer token + repo root come in
#     via env at run time (Helm Secret).
#
# Build context: the repo root (so the pnpm workspace + lockfile are visible).
# Build:
#   docker build -f container/git-server/Dockerfile -t ax-next/git-server:dev .
#
# Image hardening:
#   - Non-root UID/GID 1000:1000, /usr/sbin/nologin shell.
#   - Direct `node` exec as ENTRYPOINT — no shell wrapper, so SIGTERM from
#     kubelet reaches Node cleanly and the drain logic in listener.ts runs.
#   - apt lists wiped after install; no compilers; no curl/openssl/node-from-
#     apt — Node arrives via the official builder image.
#   - readOnlyRootFilesystem-compatible: writes go to /var/lib/ax-next/repo
#     (PVC mount) and /tmp (emptyDir) only.
#
# CI follow-up: pin the base image by digest (`debian:bookworm-slim@sha256:...`)
# and pin the `git` package version (`git=1:2.39.x-y`) once the chart's image
# build pipeline lands. For now we use tag-only + unpinned `git` so local
# builds keep working as Debian rolls patch releases.

# -----------------------------------------------------------------------------
# Stage 1: builder — pnpm deploy resolves workspace:* deps into a self-
# contained directory. We then build the package's TypeScript inside it.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

# pnpm via corepack — matches the version pinned in the repo's package.json
# packageManager field (we don't override here; corepack picks it up from
# the on-disk package.json once it's copied in).
RUN corepack enable

WORKDIR /workspace

# Copy the whole repo. Heavy-but-honest: pnpm needs the lockfile and every
# workspace package's manifest to resolve workspace:* edges. .dockerignore
# next to this Dockerfile prunes node_modules, dist, tests, .git, etc.
COPY . .

# pnpm deploy stamps a self-contained tree at /tmp/deploy with only the
# transitive prod deps of @ax/workspace-git-server resolved + copied in.
# The --legacy flag opts back into the pre-pnpm-v10 deploy semantics; the
# new behavior requires inject-workspace-packages=true on each workspace
# package, which isn't how this monorepo is configured. Switching the
# whole monorepo to injected deps is a separate change.
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @ax/workspace-git-server build \
 && pnpm --filter @ax/workspace-git-server deploy --prod --legacy /tmp/deploy

# -----------------------------------------------------------------------------
# Stage 2: runtime — slim base + git binary + the deployed package only.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# TODO: pin via CI image build (e.g. `git=1:2.39.5-0+deb12u2`). Tag-only for
# now so local `docker build` keeps working as Debian rolls patches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

# Non-root user. The node:bookworm-slim base ships with a `node` user already
# at UID 1000; we drop it and create our own `axgit` so the username matches
# the workload (`ps` output, `id` output, audit logs all read clearly) and so
# the shell is locked to nologin.
RUN userdel --remove node 2>/dev/null || true \
 && groupadd --gid 1000 axgit \
 && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin axgit \
 && mkdir -p /var/lib/ax-next/repo \
 && chown -R 1000:1000 /var/lib/ax-next \
 && mkdir -p /opt/ax-next/git-server \
 && chown -R 1000:1000 /opt/ax-next

COPY --from=builder --chown=1000:1000 /tmp/deploy /opt/ax-next/git-server

WORKDIR /opt/ax-next/git-server

USER 1000:1000

EXPOSE 7780

# Direct exec — SIGTERM reaches Node, drain logic runs.
ENTRYPOINT ["node", "/opt/ax-next/git-server/dist/server/main.js"]
