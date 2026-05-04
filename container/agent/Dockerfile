# syntax=docker/dockerfile:1.7
#
# @ax/cli + @ax/agent-claude-sdk-runner runtime image (the "agent" image).
#
# What this image is:
#   - The shared image for the ax-next host pod AND the per-session runner
#     pods. The host runs `node /opt/ax-next/host/dist/main.js serve`. Runner
#     pods are spawned by @ax/sandbox-k8s with `node <abs path to runner>`
#     where the path is resolved at host startup via require.resolve from
#     the cli's deploy tree. Same image on both sides means that absolute
#     path exists in the runner pod too.
#   - A slim Node 20+ image with ca-certificates (so HTTPS_PROXY → the
#     credential-proxy → api.anthropic.com works) and tini as PID 1 (the
#     runner spawns short-lived Claude SDK children — we want clean reaping).
#
# What this image is NOT:
#   - Not the storage-tier image — that's container/git-server/Dockerfile,
#     which ships the `git` binary. We don't.
#   - Not loaded with secrets at build time. ANTHROPIC_API_KEY,
#     AX_CREDENTIALS_KEY, DATABASE_URL all come in via env at run time
#     (Helm Secret).
#   - Not a frontend bundler. channel-web/dist is NOT baked in here today.
#     The supported web-UI dev path is to run channel-web's Vite server
#     locally with AX_BACKEND_URL pointed at the cluster (see
#     packages/channel-web/vite.config.ts). Static-files-in-image lands
#     when the chart exposes `staticFiles.dir` on its `config:` block.
#
# Build context: the repo root (so the pnpm workspace + lockfile are
# visible to the builder stage).
#
# Build:
#   docker build -f container/agent/Dockerfile -t ax-next/agent:dev .
#
# Image hardening:
#   - Non-root UID/GID 1000:1000, /usr/sbin/nologin shell.
#   - tini as PID 1 (ENTRYPOINT is `tini --` only — see CMD/ENTRYPOINT note
#     near the bottom). SIGTERM reaches Node cleanly; orphaned grandchildren
#     of the Claude SDK runner subprocess get reaped instead of zombifying.
#   - apt lists wiped after install; no compilers; no curl/openssl from apt.
#   - readOnlyRootFilesystem-compatible: writes only go to /tmp (emptyDir)
#     and /home/axagent (writable; the credential-proxy CA dir defaults to
#     ~/.ax/proxy-ca, so the home dir needs to be writable OR the chart
#     overrides AX_PROXY_CA_DIR onto a mounted volume).
#
# CI follow-up: pin the base image by digest (`node:20-bookworm-slim@sha256:...`)
# once the image build pipeline lands. Tag-only for now so local builds keep
# working as Node rolls patch releases.

# -----------------------------------------------------------------------------
# Stage 1: builder — pnpm deploy resolves workspace:* deps into a self-
# contained tree. We then build the cli's TypeScript (project references
# walk transitively, so this also builds @ax/agent-claude-sdk-runner +
# every other workspace dep on the cli's path).
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

# pnpm via corepack — the version pinned in the repo's root package.json
# packageManager field is picked up automatically once that file is on disk.
RUN corepack enable

WORKDIR /workspace

# Copy the whole repo. Heavy-but-honest: pnpm needs the lockfile and every
# workspace package's manifest to resolve workspace:* edges. The
# .dockerignore next to this Dockerfile prunes node_modules, dist, tests,
# .git, etc., so this is mostly source.
COPY . .

# Build then deploy. `pnpm --filter @ax/cli build` walks tsc project
# references, so this transitively builds @ax/agent-claude-sdk-runner and
# every other workspace dep.
#
# `pnpm --filter @ax/channel-web build` runs tsc + Vite for the SPA
# bundle. tsc-alone (which the cli's reference graph would do) emits the
# server-side TS to dist/, but the Vite step that produces dist-web/ is a
# separate command. Without it, the static-files plugin's `dir` would
# resolve to a missing path at runtime.
#
# `pnpm deploy --prod --legacy /tmp/deploy` stamps a self-contained tree
# with only the prod deps of @ax/cli resolved + copied in. channel-web's
# `files: ["dist", "dist-web"]` brings the SPA bundle along. The --legacy
# flag opts back into the pre-pnpm-v10 deploy semantics; the new behaviour
# requires inject-workspace-packages=true on every workspace package, which
# isn't how this monorepo is configured. Switching the whole monorepo to
# injected deps is a separate change.
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @ax/cli build \
 && pnpm --filter @ax/channel-web build \
 && pnpm --filter @ax/cli deploy --prod --legacy /tmp/deploy

# -----------------------------------------------------------------------------
# Stage 2: runtime — slim base, no toolchain, deployed tree only.
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# ca-certificates: HTTPS_PROXY → credential-proxy → api.anthropic.com.
# tini: clean PID-1 reaping for the short-lived Claude SDK children the
# runner spawns. Both pinned only to major version via apt — CI follow-up
# is to pin to specific package versions once the image build pipeline
# lands.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini git \
 && rm -rf /var/lib/apt/lists/*
# `git` is needed by the host pod's @ax/ipc-core workspace.materialize
# handler (it runs `git bundle` to seed the runner's /permanent dir at
# session start) AND by runner pods themselves (they spawn `git` to
# materialize and to ship per-turn diffs). The original Dockerfile
# header noted git would live only in the storage-tier image; that's
# now wrong — workspace.materialize runs on the host. Comment-only
# header at the top of this file should be updated when that lands as
# its own change.

# Non-root user. The node:bookworm-slim base ships with a `node` user at
# UID 1000; we drop it and create our own `axagent` so usernames in `ps`,
# `id`, and audit logs read clearly, and so the shell is locked to nologin.
RUN userdel --remove node 2>/dev/null || true \
 && groupadd --gid 1000 axagent \
 && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin axagent \
 && mkdir -p /opt/ax-next/host \
 && chown -R 1000:1000 /opt/ax-next

COPY --from=builder --chown=1000:1000 /tmp/deploy /opt/ax-next/host

# Stable path for the channel-web SPA bundle. `pnpm deploy --legacy`
# buries workspace packages under
# `node_modules/.pnpm/@ax+channel-web@file+.../node_modules/@ax/channel-web/`
# — a path with pnpm-internal bits that the chart can't reliably stamp
# without coupling to pnpm's layout. Copy the bundle directly from the
# builder's source tree to a stable, chart-friendly location instead.
# The chart's default `channelWeb.bundleDir` points here.
COPY --from=builder --chown=1000:1000 /workspace/packages/channel-web/dist-web /opt/ax-next/host/web

WORKDIR /opt/ax-next/host

USER 1000:1000

# The host pod listens here. Runner pods don't expose ports inbound — they
# dial back to the host's IPC URL. Documented for clarity; the chart sets
# containerPort separately.
EXPOSE 8080

# tini sits alone in ENTRYPOINT so consumers can override the program
# without dropping zombie reaping. Kubernetes `args` only replaces CMD, not
# ENTRYPOINT, so both the host pod (chart's `host.args`) and runner pods
# (@ax/sandbox-k8s `args: ['node', <abs path>]`) keep tini as PID 1. CMD is
# the host-pod default so `docker run ax-next/agent:dev` does the obvious
# thing locally.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/ax-next/host/dist/main.js", "serve", "--port", "8080"]
