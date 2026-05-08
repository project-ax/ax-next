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

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

.PHONY: help dev-fast image dev-mount-up dev-mount-down rollout build-spa

help:
	@echo "Targets:"
	@echo "  dev-fast        Rebuild SPA + push to kind dev-mount + restart pod (~10s)."
	@echo "  image           Full docker rebuild + reload, drops fast mount (~90s)."
	@echo "  dev-mount-up    Patch the deployment to add the dev-web mount."
	@echo "  dev-mount-down  Remove the dev-web mount from the deployment."
	@echo "  rollout         Restart the host deployment and wait for it."

# ----------------------------------------------------------------------------
# dev-fast — SPA-only fast loop
# ----------------------------------------------------------------------------
dev-fast: build-spa
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
image:
	@echo "==> Building docker image $(IMAGE)"
	docker build -t $(IMAGE) -f $(DOCKERFILE) .
	@echo "==> Loading image into kind cluster $(KIND_CLUSTER)"
	kind load docker-image $(IMAGE) --name $(KIND_CLUSTER)
	@$(MAKE) --no-print-directory dev-mount-down
	@$(MAKE) --no-print-directory rollout
	@echo "==> Image deployed. Bundle hash baked into the image:"
	@docker run --rm --entrypoint cat $(IMAGE) /opt/ax-next/host/web/index.html \
	  | grep 'assets/index' || true

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

dev-mount-up:
	@if kubectl -n $(NAMESPACE) get deploy/$(DEPLOYMENT) -o json | jq -e '.spec.template.spec.volumes // [] | map(.name == "$(DEV_VOLUME_NAME)") | any' >/dev/null; then \
	  echo "==> Dev mount already present — skipping patch"; \
	else \
	  echo "==> Patching deployment to add $(DEV_VOLUME_NAME) mount → $(HOST_MOUNTPOINT)"; \
	  kubectl -n $(NAMESPACE) patch deployment $(DEPLOYMENT) --type=json -p='$(PATCH_ADD)'; \
	fi

# Index lookups happen at remove time because a previous `kubectl edit`
# might have shuffled the volume list — patching by hard-coded index
# would be brittle. Also handles a legacy `dev-dist` mount left over
# from an earlier iteration of this Makefile.
dev-mount-down:
	@set -e; \
	for VOL_NAME in $(DEV_VOLUME_NAME) dev-dist; do \
	  if ! kubectl -n $(NAMESPACE) get deploy/$(DEPLOYMENT) -o json | jq -e --arg n "$$VOL_NAME" '.spec.template.spec.volumes // [] | map(.name == $$n) | any' >/dev/null; then \
	    continue; \
	  fi; \
	  VOL_IDX=$$(kubectl -n $(NAMESPACE) get deploy/$(DEPLOYMENT) -o json | jq --arg n "$$VOL_NAME" '.spec.template.spec.volumes | map(.name == $$n) | index(true)'); \
	  MOUNT_IDX=$$(kubectl -n $(NAMESPACE) get deploy/$(DEPLOYMENT) -o json | jq --arg n "$$VOL_NAME" '.spec.template.spec.containers[0].volumeMounts | map(.name == $$n) | index(true)'); \
	  echo "==> Removing $$VOL_NAME mount (volumes[$$VOL_IDX], volumeMounts[$$MOUNT_IDX])"; \
	  kubectl -n $(NAMESPACE) patch deployment $(DEPLOYMENT) --type=json -p="[{\"op\":\"remove\",\"path\":\"/spec/template/spec/containers/0/volumeMounts/$$MOUNT_IDX\"},{\"op\":\"remove\",\"path\":\"/spec/template/spec/volumes/$$VOL_IDX\"}]"; \
	done

# ----------------------------------------------------------------------------
# rollout — restart host deployment and wait
# ----------------------------------------------------------------------------
rollout:
	kubectl -n $(NAMESPACE) rollout restart deployment/$(DEPLOYMENT)
	kubectl -n $(NAMESPACE) rollout status  deployment/$(DEPLOYMENT) --timeout=120s
