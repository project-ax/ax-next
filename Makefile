# Makefile — ax-next kind cluster dev loops.
#
# Two iteration modes:
#
#   make dev-fast   — Rebuild the channel-web SPA, push the dist-web
#                     bundle to the kind node's hostPath mount, ensure
#                     the host deployment is patched to overlay
#                     /opt/ax-next/host/web with that mount, restart
#                     pod. Cycle ~5-10s. Covers SPA changes only —
#                     the host TypeScript and runner pods come from
#                     the in-image deploy tree. For host-TS or
#                     runner-side changes, use `make image`.
#
#                     This deliberately does NOT try to overlay the
#                     entire /opt/ax-next/host directory: the
#                     `pnpm deploy --legacy` tree leaves workspace
#                     symlinks that point back into packages/, which
#                     `docker cp` rejects and `tar -h` follows into
#                     unbounded recursion. Scoping the fast loop to
#                     just the SPA sidesteps both.
#
#   make image      — Rebuild the docker image, load into kind,
#                     remove any active fast-loop mount, restart pod.
#                     Cycle ~60-90s. This is the path that mirrors
#                     what production would actually ship. Always run
#                     this once before claiming a fix passes
#                     acceptance — a scenario that passes against
#                     the dev mount can still fail against the
#                     rebuilt image (Dockerfile drift, missing files
#                     in package `files:`, etc.).
#
# Both targets assume the kind cluster `ax-next-dev` is running and
# the helm release `ax-next` is installed (see
# `deploy/MANUAL-ACCEPTANCE.md` for first-time setup).
#
# They act ONLY on that cluster (kube context `kind-ax-next-dev`), by name, and
# refuse — before doing any work — if your kubeconfig has no such context. Your
# DEFAULT context is never consulted; see "Which cluster" below.

KIND_CLUSTER     := ax-next-dev
KIND_NODE        := $(KIND_CLUSTER)-control-plane
NAMESPACE        := ax-next
DEPLOYMENT       := ax-next-host
IMAGE            := ax-next/agent:dev
DOCKERFILE       := container/agent/Dockerfile
DEV_MOUNT_NODE   := /mnt/ax-dev/web
DEV_VOLUME_NAME  := dev-web
HOST_MOUNTPOINT  := /opt/ax-next/host/web
SPA_DIST         := packages/channel-web/dist-web

# ─── Which cluster do the kind targets touch? Only kind-$(KIND_CLUSTER). ────────────────
# Every kubectl/helm call in this file goes through the variables below, which name the
# context ON THE COMMAND LINE, so the caller's DEFAULT context is never consulted. That is
# not paranoia: on a machine that also talks to a real cluster the default is often not
# kind (one maintainer's is the live GKE cluster — a bare `rollout restart` from these
# very targets once restarted the production host). Do not write a bare call here:
# scripts/__tests__/kind-tooling-pinned-to-kind-context.test.js fails if you do.
#
# (Keep the tool names out of echo strings and recipe text too; that test reads this file.)
KUBE_CONTEXT     := kind-$(KIND_CLUSTER)
KUBECTL          := kubectl --context $(KUBE_CONTEXT)
HELM             := helm --kube-context $(KUBE_CONTEXT)

# ─── GKE deploy (real cluster — see deploy/GKE.md) ──────────────────────────
# `make gke-deploy` builds a linux/amd64 image, pushes it to your Artifact
# Registry, and helm-upgrades the GKE release. Env-specific values live in
# gke-values.local.yaml (gitignored) — the image repo is READ from it so this
# committed Makefile stays project-agnostic.
#
# Tag = the current git short SHA: immutable + unique per commit, so each deploy
# re-pulls cleanly (no `:dev` + IfNotPresent staleness) and the running image
# maps straight back to a commit. Commit before deploying; for an uncommitted
# spin pass GKE_TAG=... explicitly.
#
# Secrets are NOT passed: the chart's Secret is lookup-stable, so an UPGRADE
# reuses the credentials.key / cookie key already in the cluster. (First install
# is the explicit `helm install` in deploy/GKE.md, which seeds them.)
GKE_VALUES        := deploy/charts/ax-next/gke-values.yaml
GKE_LOCAL_VALUES  := deploy/charts/ax-next/gke-values.local.yaml
GKE_RELEASE       := ax-next
GKE_PLATFORM      := linux/amd64
GKE_IMAGE_REPO    ?= $(shell awk '/^image:/{f=1} f&&/repository:/{print $$2; exit}' $(GKE_LOCAL_VALUES) 2>/dev/null)
GKE_TAG           ?= $(shell git rev-parse --short HEAD)

# The cluster to deploy to, by kube-context name — REQUIRED, never inferred. This target used
# to follow whatever context happened to be current, which is the failure mode the kind block
# above exists to prevent (a stale default sends the deploy to the wrong cluster), so it now
# takes the name explicitly:   make gke-deploy GKE_CONTEXT=<your context>
# It is not a committed default because the name is specific to one deployment and this repo
# is public (see scripts/__tests__/no-deployment-specifics-committed.test.js).
#
# Two properties the tests pin (scripts/__tests__/kind-tooling-pinned-to-kind-context.test.js):
#  - The value reaches the shell through the ENVIRONMENT (`"$$GKE_CONTEXT"`, exported below), never
#    pasted into shell text, so a quote or a space in it cannot be re-parsed as code.
#  - GKE_KUBECTL / GKE_HELM HARD-STOP when no context was named, so a new target that forgets
#    `gke-guard` gets a loud error, not `--context ''` (which kubectl reads as "the default").
GKE_CONTEXT       ?=
export GKE_CONTEXT
GKE_REQUIRE       = $(if $(GKE_CONTEXT),,$(error REFUSING: say which cluster to deploy to: make gke-deploy GKE_CONTEXT=<context>))
GKE_KUBECTL       = $(GKE_REQUIRE) kubectl --context "$$GKE_CONTEXT"
GKE_HELM          = $(GKE_REQUIRE) helm --kube-context "$$GKE_CONTEXT"

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# Run prerequisites in the order they are written, even under `make -j`. `dev-fast: kube-guard
# build-spa` is only "guard first" if nothing is allowed to start beside the guard.
.NOTPARALLEL:

.PHONY: help dev-fast image dev-mount-up dev-mount-down rollout build-spa kind-prune reset-bootstrap gke-deploy dev-kind-memory-nfs kube-guard gke-guard

help:
	@echo "Targets:"
	@echo "  dev-fast           Rebuild SPA + push to kind dev-mount + restart pod (~10s)."
	@echo "  image              Full docker rebuild + reload, drops fast mount (~90s)."
	@echo "  kind-prune         Remove dangling image layers from the kind node."
	@echo "  reset-bootstrap    Wipe bootstrap + admin/agent/credential rows; print fresh token."
	@echo "  dev-mount-up       Patch the deployment to add the dev-web mount."
	@echo "  dev-mount-down     Remove the dev-web mount from the deployment."
	@echo "  rollout            Restart the host deployment and wait for it."
	@echo "  dev-kind-memory-nfs  Build+load+apply the dev NFS server that facts memory needs on kind."
	@echo "  gke-deploy         Build+push linux/amd64 image (tag=git SHA) + upgrade the GKE release."
	@echo "                     Needs GKE_CONTEXT=<your context>; it never follows your current one."
	@echo ""
	@echo "Every target above except gke-deploy acts ONLY on the kind cluster $(KIND_CLUSTER)"
	@echo "(context $(KUBE_CONTEXT)), whatever your default kube context is."

# ----------------------------------------------------------------------------
# kube-guard / gke-guard — fail LOUDLY, and before any slow work, when the
# cluster a target names is not one this kubeconfig knows.
#
# The pinned variables already make a missing context a hard error at the first
# call; the guard exists so the error arrives BEFORE a 90s `docker build` +
# `kind load`, and says what to do about it. The context list is read through the
# pinned variable on purpose (a `config` subcommand ignores the flag and just lists
# your contexts), so there is still no bare call in this file.
#
# Written as a single `|| { ...; exit 1; }` line rather than leaning on
# .SHELLFLAGS: macOS ships GNU Make 3.81, which ignores it.
# ----------------------------------------------------------------------------
kube-guard:
	@$(KUBECTL) config get-contexts -o name | grep -Fxq -- '$(KUBE_CONTEXT)' || { \
	  echo "REFUSING: your kubeconfig has no context named '$(KUBE_CONTEXT)', so there is no kind cluster to act on."; \
	  echo "  Create it:       kind create cluster --name $(KIND_CLUSTER)"; \
	  echo "  or re-add it:    kind export kubeconfig --name $(KIND_CLUSTER)"; \
	  echo "  This Makefile never falls back to your current context: that is how a bare command reaches the wrong cluster."; \
	  exit 1; }

# The empty-context check below is a BACKSTOP, not the message you will normally see: make expands a
# whole recipe before running it, and the third line uses $(GKE_KUBECTL), so with no context
# GKE_REQUIRE's $(error REFUSING: …) stops make first. The check stays so this guard still refuses
# if that third line is ever rewritten.
gke-guard:
	@test -n "$$GKE_CONTEXT" || { \
	  echo "REFUSING: say which cluster to deploy to:  make gke-deploy GKE_CONTEXT=<context>"; \
	  echo "  (Your context names are listed by the 'config get-contexts' command of your kube CLI.)"; \
	  echo "  This target does not follow your current context: a stale default would send the deploy to the wrong cluster."; \
	  exit 1; }
	@case "$$GKE_CONTEXT" in kind-*) echo "REFUSING: '$$GKE_CONTEXT' is a kind cluster, not GKE. Use the kind targets for kind."; exit 1;; esac
	@$(GKE_KUBECTL) config get-contexts -o name | grep -Fxq -- "$$GKE_CONTEXT" || { \
	  echo "REFUSING: your kubeconfig has no context named '$$GKE_CONTEXT'."; \
	  echo "  Fetch it with 'gcloud container clusters get-credentials ...' (deploy/GKE.md Step 0), or fix the name."; \
	  exit 1; }

# ----------------------------------------------------------------------------
# dev-fast — SPA-only fast loop
# ----------------------------------------------------------------------------
dev-fast: kube-guard build-spa
	@echo "==> Pushing $(SPA_DIST) to $(KIND_NODE):$(DEV_MOUNT_NODE)"
	docker exec $(KIND_NODE) sh -c 'rm -rf $(DEV_MOUNT_NODE) && mkdir -p $(DEV_MOUNT_NODE)'
	# `docker cp` copies the source dir's *contents* when the path ends with `/.`.
	# No symlinks in dist-web (vite outputs plain files), so this is safe.
	docker cp $(SPA_DIST)/. $(KIND_NODE):$(DEV_MOUNT_NODE)/
	@$(MAKE) --no-print-directory dev-mount-up
	@$(MAKE) --no-print-directory rollout
	@echo "==> Fast loop ready. Hard-refresh the browser to bypass cached JS."

build-spa:
	@echo "==> Building @ax/channel-web SPA"
	pnpm --filter @ax/channel-web build

# ----------------------------------------------------------------------------
# image — full image rebuild loop
# ----------------------------------------------------------------------------
image: kube-guard
	@echo "==> Building docker image $(IMAGE)"
	docker build -t $(IMAGE) -f $(DOCKERFILE) .
	@echo "==> Loading image into kind cluster $(KIND_CLUSTER)"
	kind load docker-image $(IMAGE) --name $(KIND_CLUSTER)
	@$(MAKE) --no-print-directory dev-mount-down
	@$(MAKE) --no-print-directory rollout
	@$(MAKE) --no-print-directory kind-prune
	@echo "==> Image deployed. Bundle hash baked into the image:"
	@docker run --rm --entrypoint cat $(IMAGE) /opt/ax-next/host/web/index.html \
	  | grep 'assets/index' || true

# ----------------------------------------------------------------------------
# kind-prune — drop dangling image layers from the kind node
#
# Every `kind load docker-image` overwrites the tagged image, leaving
# the previous version behind as an untagged `<none>` image. The layers
# stick around in containerd's content store until pruned. After ~15
# rebuild cycles the node accumulates ~10 GB of stale agent-image
# layers and starts hitting "no space left on device" during
# `docker cp` to /mnt/ax-dev. `make image` calls this automatically;
# run it manually if the node fills up between rebuilds.
# ----------------------------------------------------------------------------
kind-prune:
	@echo "==> Pruning untagged images on $(KIND_NODE)"
	@DANGLING=$$(docker exec $(KIND_NODE) crictl images --output json \
	  | jq -r '.images[] | select((.repoTags // []) | length == 0) | .id'); \
	if [ -z "$$DANGLING" ]; then \
	  echo "==> Nothing to prune"; \
	else \
	  echo "$$DANGLING" | xargs -I{} docker exec $(KIND_NODE) crictl rmi {} >/dev/null; \
	  COUNT=$$(echo "$$DANGLING" | wc -l | tr -d ' '); \
	  echo "==> Pruned $$COUNT untagged image(s)"; \
	fi
	@docker exec $(KIND_NODE) df -h / | tail -1

# ----------------------------------------------------------------------------
# dev-mount-up / dev-mount-down — toggle the dev-web hostPath mount
#
# Both targets are idempotent so they can be invoked safely from other
# targets without tracking state. JSON-patch is constructed as a
# single-line string because make passes recipes line-by-line (or in
# one shell with -c), and embedded literal newlines inside an
# unquoted -p= argument are fragile across make versions.
# ----------------------------------------------------------------------------

PATCH_ADD := [{"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"$(DEV_VOLUME_NAME)","hostPath":{"path":"$(DEV_MOUNT_NODE)","type":"Directory"}}},{"op":"add","path":"/spec/template/spec/containers/0/volumeMounts/-","value":{"name":"$(DEV_VOLUME_NAME)","mountPath":"$(HOST_MOUNTPOINT)"}}]

dev-mount-up: kube-guard
	@if $(KUBECTL) -n $(NAMESPACE) get deploy/$(DEPLOYMENT) -o json | jq -e '.spec.template.spec.volumes // [] | map(.name == "$(DEV_VOLUME_NAME)") | any' >/dev/null; then \
	  echo "==> Dev mount already present — skipping patch"; \
	else \
	  echo "==> Patching deployment to add $(DEV_VOLUME_NAME) mount → $(HOST_MOUNTPOINT)"; \
	  $(KUBECTL) -n $(NAMESPACE) patch deployment $(DEPLOYMENT) --type=json -p='$(PATCH_ADD)'; \
	fi

# Index lookups happen at remove time because a previous `kubectl edit`
# might have shuffled the volume list — patching by hard-coded index
# would be brittle. Also handles a legacy `dev-dist` mount left over
# from an earlier iteration of this Makefile.
dev-mount-down: kube-guard
	@set -e; \
	for VOL_NAME in $(DEV_VOLUME_NAME) dev-dist; do \
	  if ! $(KUBECTL) -n $(NAMESPACE) get deploy/$(DEPLOYMENT) -o json | jq -e --arg n "$$VOL_NAME" '.spec.template.spec.volumes // [] | map(.name == $$n) | any' >/dev/null; then \
	    continue; \
	  fi; \
	  VOL_IDX=$$($(KUBECTL) -n $(NAMESPACE) get deploy/$(DEPLOYMENT) -o json | jq --arg n "$$VOL_NAME" '.spec.template.spec.volumes | map(.name == $$n) | index(true)'); \
	  MOUNT_IDX=$$($(KUBECTL) -n $(NAMESPACE) get deploy/$(DEPLOYMENT) -o json | jq --arg n "$$VOL_NAME" '.spec.template.spec.containers[0].volumeMounts | map(.name == $$n) | index(true)'); \
	  echo "==> Removing $$VOL_NAME mount (volumes[$$VOL_IDX], volumeMounts[$$MOUNT_IDX])"; \
	  $(KUBECTL) -n $(NAMESPACE) patch deployment $(DEPLOYMENT) --type=json -p="[{\"op\":\"remove\",\"path\":\"/spec/template/spec/containers/0/volumeMounts/$$MOUNT_IDX\"},{\"op\":\"remove\",\"path\":\"/spec/template/spec/volumes/$$VOL_IDX\"}]"; \
	done

# ----------------------------------------------------------------------------
# rollout — restart host deployment and wait
# ----------------------------------------------------------------------------
rollout: kube-guard
	$(KUBECTL) -n $(NAMESPACE) rollout restart deployment/$(DEPLOYMENT)
	$(KUBECTL) -n $(NAMESPACE) rollout status  deployment/$(DEPLOYMENT) --timeout=120s

# ----------------------------------------------------------------------------
# dev-kind-memory-nfs — stand up the dev-only in-cluster NFS server that the
# facts-memory preset needs (TASK-576: `host.preset: memory` is now the
# chart's default, and `kind-dev-values.yaml` points `memory.exports` at this
# server's pinned ClusterIP). Run this BEFORE the first `helm install` on a
# fresh kind cluster, or the host pod hangs on a mount it can't reach. See
# `deploy/kind/memory-nfs/README.md` for what this stands up and why it's
# dev-only (privileged, unauthenticated, backed by an emptyDir).
#
# Idempotent: `kubectl apply` on an already-running server is a no-op.
# ----------------------------------------------------------------------------
MEMORY_NFS_IMAGE := ax-next/memory-nfs:dev

dev-kind-memory-nfs: kube-guard
	@echo "==> Building + loading the dev NFS server image"
	docker build -t $(MEMORY_NFS_IMAGE) deploy/kind/memory-nfs
	kind load docker-image $(MEMORY_NFS_IMAGE) --name $(KIND_CLUSTER)
	@echo "==> Applying the dev NFS server + Service"
	$(KUBECTL) apply -f deploy/kind/memory-nfs/nfs-server.yaml
	$(KUBECTL) -n $(NAMESPACE) rollout status deploy/ax-next-memory-nfs

# ----------------------------------------------------------------------------
# reset-bootstrap — execute `ax-next admin reset-bootstrap --force` inside
# the running host pod.
#
# Why exec-in-pod and not the local CLI binary: the cleanup-cascade fires
# `bootstrap:reset-cleanup` on the running pod's HookBus; the auth /
# agents / credentials subscribers that wipe their tables only exist
# in-process inside that pod. Running the CLI locally against the kind
# postgres would reset bootstrap_state but leave the admin user, the
# default agent, and the Anthropic credential intact.
#
# Requires the new image (post `make image`). On an old image the
# fan-out hook isn't fired and you get the half-cleaned state that
# triggered this target's existence.
# ----------------------------------------------------------------------------
reset-bootstrap: kube-guard
	@echo "==> Resetting bootstrap inside $(DEPLOYMENT) on $(KUBE_CONTEXT)"
	$(KUBECTL) -n $(NAMESPACE) exec deploy/$(DEPLOYMENT) -- \
	  node /opt/ax-next/host/dist/main.js admin reset-bootstrap --force
	@echo "==> Open the printed claim URL OR refresh https://localhost:9090 — App.tsx will redirect to /setup."

# ----------------------------------------------------------------------------
# gke-deploy — build+push the agent image to Artifact Registry and upgrade the
# GKE release. See the GKE deploy block near the top for the variable contract
# (image repo read from gke-values.local.yaml, tag = git SHA, secrets reused via
# the lookup-stable Secret, and GKE_CONTEXT — required, never inferred).
# Full first-time setup: deploy/GKE.md.
#
# `gke-guard` runs first: it refuses a missing/kind/unknown context before the
# image is built or pushed, and every cluster call below names the SAME context,
# so nothing can change between the check and the use.
#
# Reuses NAMESPACE / DEPLOYMENT (ax-next / ax-next-host) from the kind block —
# the release name + objects are the same on GKE.
# ----------------------------------------------------------------------------
gke-deploy: gke-guard
	@test -f "$(GKE_LOCAL_VALUES)" || { echo "ERROR: $(GKE_LOCAL_VALUES) missing — put your env overrides there (deploy/GKE.md Step 6)."; exit 1; }
	@test -n "$(GKE_IMAGE_REPO)" || { echo "ERROR: image.repository not found in $(GKE_LOCAL_VALUES); set it there or pass GKE_IMAGE_REPO=..."; exit 1; }
	@echo "==> Target kube context: $$GKE_CONTEXT"
	@git diff --quiet HEAD 2>/dev/null || echo "==> WARNING: working tree is dirty; tag $(GKE_TAG) is the last commit. Commit, or pass GKE_TAG=... for a unique image."
	@echo "==> Building + pushing $(GKE_IMAGE_REPO):$(GKE_TAG) ($(GKE_PLATFORM))"
	docker buildx build --platform $(GKE_PLATFORM) -t $(GKE_IMAGE_REPO):$(GKE_TAG) -f $(DOCKERFILE) --push .
	@echo "==> Upgrading release $(GKE_RELEASE) → image.tag=$(GKE_TAG)"
	$(GKE_HELM) upgrade --install $(GKE_RELEASE) deploy/charts/ax-next --namespace $(NAMESPACE) \
	  -f $(GKE_VALUES) -f $(GKE_LOCAL_VALUES) \
	  --set image.tag=$(GKE_TAG)
	$(GKE_KUBECTL) -n $(NAMESPACE) rollout status deployment/$(DEPLOYMENT) --timeout=300s
	@echo "==> Deployed $(GKE_IMAGE_REPO):$(GKE_TAG)"
