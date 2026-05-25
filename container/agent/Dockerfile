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
# Base image: digest-pinned (content-addressed). Both stages pin
# `node:20-bookworm-slim` to the multi-arch OCI index digest below so a
# mutated/re-pushed tag can't swap the bytes out from under us; the
# `20-bookworm-slim` tag stays inline for human eyes. The `docker-build` CI
# lane (.github/workflows/ci.yml) builds this image on every change that
# touches it, so the pin is exercised on every PR. To bump Node: pick the new
# tag, re-resolve its index digest with
# `docker buildx imagetools inspect node:<tag>` (the top-level `Digest:`, NOT a
# per-platform manifest digest — that would lock the image to one arch), and
# update both FROM lines + this comment in lockstep.

# -----------------------------------------------------------------------------
# Stage 1: builder — pnpm deploy resolves workspace:* deps into a self-
# contained tree. We then build the cli's TypeScript (project references
# walk transitively, so this also builds @ax/agent-claude-sdk-runner +
# every other workspace dep on the cli's path).
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder

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
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

# ca-certificates: HTTPS_PROXY → credential-proxy → api.anthropic.com.
# tini: clean PID-1 reaping for the short-lived Claude SDK children the
# runner spawns.
#
# All five apt deps are version-pinned (was: unpinned, floated with the
# pocket) so the install is reproducible — the signed Debian archive already
# content-addresses each .deb by checksum on download; the pin makes WHICH
# .deb deterministic. Versions are the current Debian bookworm/main binaries
# (resolved from the signed Packages index); refresh them in lockstep when the
# base image rolls to a newer point release. Caveat: a hard `=version` pin
# breaks the build once a point release supersedes one of these and drops the
# old from the pocket. The `docker-build` CI lane (.github/workflows/ci.yml)
# builds this image on every change that touches it, so such a rot turns CI red
# instead of failing silently — bump the pins here when it does.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates=20230311+deb12u1 \
      tini=0.19.0-1+b3 \
      git=1:2.39.5-0+deb12u3 \
      git-lfs=3.3.0-1+deb12u1 \
      python3=3.11.2-1+b1 \
 && rm -rf /var/lib/apt/lists/*
# `git` is needed by the host pod's @ax/ipc-core workspace.materialize
# handler (it runs `git bundle` to seed the runner's /permanent dir at
# session start) AND by runner pods themselves (they spawn `git` to
# materialize and to ship per-turn diffs). The original Dockerfile
# header noted git would live only in the storage-tier image; that's
# now wrong — workspace.materialize runs on the host. Comment-only
# header at the top of this file should be updated when that lands as
# its own change.
#
# `git-lfs` is needed by runner pods to checkout LFS-tracked files
# (user-uploaded attachments under `.ax/uploads/**`, agent artifacts
# matching the LFS .gitattributes) so they materialize as their real
# bytes rather than as LFS pointer text. The runner runs
# `git lfs install --local` in /permanent after clone (see
# packages/agent-claude-sdk-runner/src/git-workspace.ts).

# Non-root user. The node:bookworm-slim base ships with a `node` user at
# UID 1000; we drop it and create our own `axagent` so usernames in `ps`,
# `id`, and audit logs read clearly, and so the shell is locked to nologin.
RUN userdel --remove node 2>/dev/null || true \
 && groupadd --gid 1000 axagent \
 && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin axagent \
 && mkdir -p /opt/ax-next/host \
 && chown -R 1000:1000 /opt/ax-next

# Persisted PATH convention: put `$HOME/bin` on PATH so binaries the agent
# installs there are found in later sessions.
#
# IMPORTANT — the load-bearing path is NOT this file. At runtime the agent's
# `$HOME` is the git-bundled workspace tier (`/permanent`, set on the SDK
# subprocess by the runner — see agent-claude-sdk-runner/src/main.ts), and the
# SDK's Bash tool runs a NON-INTERACTIVE shell that does NOT source `.bashrc`.
# So `$HOME/bin` actually reaches the agent's PATH via the explicit subprocess
# env the runner builds (home-bin-env.ts). This `.bashrc` exists for any
# INTERACTIVE / `BASH_ENV`-driven shell and as the human-discoverable
# convention.
#
# We APPEND `$HOME/bin` (not prepend) for the same reason home-bin-env.ts does:
# `$HOME` is a model-writable, restored-across-sessions dir, so a leading entry
# would let an injected `$HOME/bin/git` (etc.) persistently shadow the trusted
# image binary. Appending keeps installed tools discoverable while the system
# bins win on name collisions. Idempotent: the `case` guard skips the append if
# `$HOME/bin` is already on PATH (no unbounded growth on re-source). Keep this
# in sync with home-bin-env.ts — the Dockerfile-guard test
# (scripts/__tests__/dockerfile-home-bin-path.test.js) asserts it stays present.
RUN printf '%s\n' \
      '# ax agent: ensure $HOME/bin (persisted workspace tier) is on PATH' \
      'case ":$PATH:" in' \
      '  *":$HOME/bin:"*) ;;' \
      '  *) PATH="$PATH:$HOME/bin" ;;' \
      'esac' \
      'export PATH' \
      > /home/axagent/.bashrc \
 && chown 1000:1000 /home/axagent/.bashrc \
 && chmod 0644 /home/axagent/.bashrc

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

# uv/uvx: ephemeral on-demand runner for skill-declared python CLIs (capabilities.packages.pypi).
# Digest-pinned (content-addressed) — the `0.11.16` tag stays for human eyes; the `@sha256:…`
# is the multi-arch OCI index digest that tag resolved to, so a mutated/re-pushed tag can't
# swap the bytes out from under us. To bump uv: pick the new tag, then re-resolve its digest
# with `docker buildx imagetools inspect ghcr.io/astral-sh/uv:<tag>` and update both here.
COPY --from=ghcr.io/astral-sh/uv:0.11.16@sha256:440fd6477af86a2f1b38080c539f1672cd22acb1b1a47e321dba5158ab08864d /uv /uvx /usr/local/bin/

# Bake a relocatable, pre-seeded Python venv (pip/setuptools/wheel) so runner
# sessions get a working venv OFFLINE — copied to the ephemeral tier at runtime
# (see python-venv.ts). uv 0.11.16's `--seed` fetches the seed wheels from pypi,
# which the egress-locked sandbox can't reach at runtime; doing it at BUILD time
# (pypi reachable) + `--relocatable` (location-independent scripts) means the
# runtime copy needs no network and works for every agent. Build now REQUIRES
# pypi reachable at image-build time.
RUN uv venv --seed --relocatable /opt/ax-python-venv-template \
 && chown -R 1000:1000 /opt/ax-python-venv-template

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
