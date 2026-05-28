---
name: k8s-acceptance-loop
description: Use when the user wants to verify expected behavior in the browser UI against the local kind cluster `ax-next-dev` and iterate until it works. The verification mechanism is Playwright MCP — drive the chat UI (or whatever surface the user names) in a real browser, observe outcomes (console, network, DOM snapshot), and loop on failures. Picks between an image-rebuild loop (Dockerfile / chart / env / runner-side code) and a fast hostPath-mounted dist loop (host-side TypeScript only). Triggers on phrases like "get this working in the browser against ax-next-dev", "loop until the chat sends a response", "fix until the UI shows X", "use playwright to verify Y in the cluster", or any request to keep fixing until a browser-observable outcome passes. Works for scripted procedures in `deploy/MANUAL-ACCEPTANCE.md`, ad-hoc bug repros, or any scenario the user describes in UI terms.
---

# k8s acceptance loop (`ax-next-dev` kind cluster, Playwright-verified)

This skill is the loop you run when a browser-observable behavior should work against the local kind cluster but doesn't, and you want to keep fixing until it does. The user names the scenario (e.g., "send a chat message and the assistant references a bash tool execution"); you drive the UI via Playwright MCP and check that the named outcome actually appears.

Two iteration modes. Picking the right one on each failure dominates loop speed:

```
              ┌────────────────────────────────────┐
              │  drive scenario in browser via MCP │
              │  capture: snapshot, console, net,  │
              │  cluster logs                      │
              └─────────────────┬──────────────────┘
                                │
                          ┌─────▼──────┐
                          │  matched   │
                          │ expected?  │
                          └─┬────────┬─┘
                     yes ◀──┘        └──▶ no
                     │                     │
                     ▼                     ▼
                 ┌─────┐         ┌─────────────────┐
                 │done │         │  triage failure │
                 └─────┘         └────────┬────────┘
                                          │
                             ┌────────────┴────────────┐
                             ▼                         ▼
                       code-only?                non-code-only
                       (host TS only)            (Dockerfile / chart /
                             │                    env / runner code /
                             ▼                    image layout)
                   ┌──────────────────┐               │
                   │  fast loop       │               ▼
                   │  (hostPath mount │   ┌────────────────────────┐
                   │   + restart pod) │   │  image-rebuild loop    │
                   └────────┬─────────┘   │  (docker build, kind   │
                            │             │   load, rollout restart)│
                            │             └────────────┬───────────┘
                            └─────────────┬────────────┘
                                          │
                                     re-drive scenario
```

---

## 1. The loop

Before each run, write down:

1. **Which scenario, in browser-UI terms.** Phrase the expected outcome the way it appears to a user: "I send '<msg>' and the assistant's reply contains a tool-execution block whose output is `…`", or "after submitting the form the toast says 'saved' and the new row appears at the top of the list." The user supplies this. If they only gave you a vague goal, restate your interpretation and ask before looping — chasing the wrong target is the most expensive bug in this loop.
2. **What signals count as PASS.** At minimum: a DOM assertion (text/element visible) and absence of console errors. For chat-style scenarios add: an expected `POST /chat` (or equivalent) network response with the right shape. If the scenario also mutates server-side state (workspace, db row), pick one cluster-side probe to confirm — but the browser must be the primary signal.
3. **Which iteration mode is current.** Default to image-rebuild on the first cycle and after any chart/dockerfile/runner change. Default to fast loop after the first successful image build, while you're iterating on host TypeScript.

Then loop:

1. Verify cluster preconditions (§3) and the browser entry point (§4). If first run, set up.
2. Drive the scenario via Playwright MCP. Capture every observation as you go (§4) — you'll need them for triage.
3. Compare observations against the PASS criteria you wrote down. Be strict: "almost matches" means it failed.
4. On failure → triage (§2) → apply fix → restart pods (§5 or §6) → loop.
5. On pass → tear down any fast-loop overrides (§6) and rerun once against the rebuilt image to confirm the fix passes without the dev mount.

### When to stop the loop

- All scenario criteria pass against the rebuilt image (not just the fast-loop mount).
- Same root cause loops three times — escalate. Either the fix isn't actually applied (stale mount? wrong namespace? browser cached?) or the scenario expectation is wrong. Stop and re-read the criteria.
- Underlying environment is the problem (kind node OOM, docker daemon flaking, port-forward keeps dying) — fix the environment first.

---

## 2. Triage: which loop applies?

Always capture both browser-side and cluster-side signals before classifying. Browser-only or cluster-only views each lie about half the time.

### Browser-side capture (Playwright MCP)

```
browser_snapshot                  # accessibility tree of current state
browser_console_messages          # errors, warnings, the works
browser_network_requests          # all requests; look for 4xx/5xx and pending
browser_take_screenshot           # for the conversation log when describing
```

What to look for:

- **Console errors** with stack traces pointing at app code — usually host code. Fast loop.
- **`Failed to fetch` / `net::ERR_*`** — port-forward died, or CORS, or server crashed. Check cluster side before concluding.
- **HTTP 4xx from the API** with a structured error body — read the body. `csrf-failed:*`, `auth-required`, `validation-error` are configuration; `internal-error` is server crash.
- **HTTP 5xx** — almost always a host pod exception; jump to host logs.
- **DOM is wrong but no console / network errors** — usually a logic bug in render or state. Fast loop.
- **Page didn't even load** — port-forward, ingress, or pod not ready. Cluster side.

### Cluster-side capture

```bash
# Host pod
kubectl -n ax-next get pods -l app.kubernetes.io/component=ax-next-host
kubectl -n ax-next describe pod -l app.kubernetes.io/component=ax-next-host | tail -60
kubectl -n ax-next logs deploy/ax-next-host --tail=200

# Runner pods (if the scenario should have spawned one)
kubectl -n ax-next-runners get pods
kubectl -n ax-next-runners logs -l app.kubernetes.io/component=ax-next-runner \
  --tail=200 --all-containers --prefix

# If first install or schema change
kubectl -n ax-next get jobs
kubectl -n ax-next logs job/ax-next-postgres-init --tail=100
```

### Classification

| Browser signal | Cluster signal | Likely root | Loop |
|---|---|---|---|
| Console TS exception with app stack | Host log shows same exception | Host TS bug | **fast** |
| HTTP 5xx | `PluginError`, `ZodError`, `TypeError` in host log | Host TS bug | **fast** |
| HTTP 5xx | `missing service hook X` / `register collision` | Host wiring | **fast** |
| Wrong DOM, no errors anywhere | Logs clean | Render / state logic in host or web | **fast** |
| HTTP 4xx with `csrf-failed`, `origin-missing` | (n/a) | Request shape — fix the test driver, not the server | retry |
| `Failed to fetch` | Host CrashLoopBackOff with `Cannot find module`, `EACCES`, missing binary | Image layout / Dockerfile | **rebuild** |
| Page won't load at all | Helm install failed / rendered manifest wrong | Chart | **rebuild** |
| Tool call hangs / runner work doesn't happen | Runner pod CrashLoopBackOff or wrong runner behavior | Runner code (in-image) | **rebuild** (see §6 caveat) |
| Anything | `ImagePullBackOff` on `ax-next/agent:dev` | Image not loaded into kind | **rebuild** |
| Anything | Postgres init job failed | Init script / db | **rebuild** if init changed; otherwise check db pod |
| `gVisor disabled` warning | (n/a, kind only) | Not a failure — `kind-dev-values.yaml` documents it | ignore |

If genuinely ambiguous: do one image-rebuild cycle. The fast loop assumes a correct deployed image as its baseline; if the image is wrong, the fast loop hides it.

---

## 3. First-run cluster preconditions

Run these once per kind cluster, then again only if you tear it down. Defaults assume the kind canary scenario; substitute scenario-specific helm flags as needed.

```bash
# 0. Pick up env. API keys for the walk live in `.env.walk` at the repo root
#    (gitignored — never commit it). It holds ANTHROPIC_API_KEY (required for any
#    chat-touching scenario) plus scenario-specific provider/service keys
#    (e.g. LINEAR_API_KEY for the agent-authored-skills Linear walk). Source it:
set -a; . ./.env.walk; set +a
# Sanity-check the key the install needs is present (don't echo the value):
[ -n "$ANTHROPIC_API_KEY" ] || { echo "ANTHROPIC_API_KEY missing from .env.walk"; }

# 1. Kind cluster
kind get clusters | grep -q '^ax-next-dev$' || kind create cluster --name ax-next-dev

# 2. Build + load the agent image
docker build -t ax-next/agent:dev -f container/agent/Dockerfile .
kind load docker-image ax-next/agent:dev --name ax-next-dev

# 3. Build + load the storage-tier image (only needed for workspace.backend=http scenarios)
docker build -t ax-next/git-server:dev -f container/git-server/Dockerfile .
kind load docker-image ax-next/git-server:dev --name ax-next-dev

# 3b. Prune the untagged layers each `kind load` orphans on the node.
#     A walk loops through §5 many times; without this the kind node fills
#     up and `docker cp` starts failing with "no space left on device".
#     `make image` already does this automatically — the walk must too.
make kind-prune

# 4. Runner namespace (chart deliberately does NOT create it)
kubectl get ns ax-next-runners >/dev/null 2>&1 || kubectl create namespace ax-next-runners

# 5. Install or upgrade. `upgrade --install` is idempotent.
#    The flags below are the kind canary set; layer scenario-specific
#    --set flags on top (replicas, workspace.backend, channel-web, etc.).
helm upgrade --install ax-next deploy/charts/ax-next \
  --namespace ax-next --create-namespace \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set image.repository=ax-next/agent \
  --set image.tag=dev \
  --set credentials.key="$(openssl rand -base64 32)" \
  --set anthropic.apiKey="$ANTHROPIC_API_KEY" \
  --set http.cookieKey="$(openssl rand -hex 32)" \
  --set auth.devBootstrap.token="$(openssl rand -hex 16)"

# 6. Wait for host
kubectl wait -n ax-next --for=condition=Ready pod \
  -l app.kubernetes.io/component=ax-next-host --timeout=180s
```

For more elaborate scenarios (multi-replica + `workspace.backend=http`, channel-web, etc.) the helm flags differ — copy the matching block from `deploy/MANUAL-ACCEPTANCE.md` if it covers your case, or adapt from `deploy/charts/ax-next/values.yaml`.

---

## 4. Browser entry point + Playwright driver

The chart doesn't ship an Ingress on kind, so reach the public surface via port-forward.

### Standing up the entry point

```bash
# /chat + /health + /auth/* + /api/chat/* live on the public-http port (9090).
# The Service's :80 is the runner-IPC back-channel — NOT for browser traffic.
kubectl -n ax-next port-forward svc/ax-next-host 9090:9090 >/tmp/pf.log 2>&1 &
echo $! > /tmp/pf.pid

# Sanity-check before launching the browser
curl -fsS http://localhost:9090/health | jq .
```

If the scenario uses channel-web's Vite dev server pointing at the cluster (the supported web-UI path until static-files-in-image lands), start that locally with `AX_BACKEND_URL=http://localhost:9090` and point Playwright at the Vite URL instead.

### Driving the scenario

Use the Playwright MCP browser tools. For concrete call sequences (sign-in, send-and-wait-for-tool-output, multi-turn session, streaming, pure failure capture), see `references/playwright-recipes.md` and read the recipe that matches the scenario.

Typical loop body for a chat-style scenario:

1. `browser_navigate` to the entry URL (the port-forward, the Vite dev URL, or whatever the user named).
2. If auth is required, sign in. The kind canary uses `auth.devBootstrap.token` — POST it to `/auth/dev-bootstrap` to mint a session cookie before navigating, or do it through the UI if there's a sign-in surface.
3. `browser_snapshot` immediately after load to confirm the page rendered (not white-screen).
4. Drive the interaction (`browser_click`, `browser_type`, `browser_fill_form`, etc.).
5. `browser_wait_for` on the expected DOM signal (text, role, or selector). Don't sleep — wait for the actual condition.
6. `browser_console_messages` and `browser_network_requests` after each major step. Save these into the loop scratchpad.
7. Compare observed vs expected. Document the delta in your own notes before deciding the loop direction.

Notes on common gotchas in the driver:

- **CSRF.** State-changing requests issued from the page itself ride the `Origin` check; requests issued from outside the page (e.g., a curl probe) need `X-Requested-With: ax-admin` to satisfy the CSRF gate. Inside the browser this isn't your problem.
- **Cookies.** The session cookie is `HttpOnly` + `Secure`-when-https. Over plain `http://localhost:9090` the `Secure` attribute is dropped automatically by the http-server in dev mode. If the cookie isn't being set, check `Set-Cookie` in `browser_network_requests`.
- **Port-forward dies silently.** Whenever `Failed to fetch` appears, first thing to check is `tail /tmp/pf.log` and `ps -p $(cat /tmp/pf.pid)`. Restart it; don't assume the cluster is broken.
- **Browser cache.** After a fast-loop redeploy, refresh hard or `browser_navigate` again — service-worker'd / cached JS bundles can hide a fix.

---

## 5. Image-rebuild loop (the slow path)

Use when the fix touches:

- `container/agent/Dockerfile` or `container/git-server/Dockerfile`
- `deploy/charts/ax-next/templates/**`
- `deploy/charts/ax-next/values.yaml` or any `-f` overlay
- Any code under `packages/agent-claude-sdk-runner/` (runner pods bake this)
- `package.json` deps, `pnpm-lock.yaml`

```bash
docker build -t ax-next/agent:dev -f container/agent/Dockerfile .
kind load docker-image ax-next/agent:dev --name ax-next-dev

# Every `kind load` overwrites the `:dev` tag and leaves the previous image
# behind as an untagged `<none>` layer. Over a long walk these pile up until
# the kind node hits "no space left on device". `make image` prunes them
# automatically; the walk does the same after each load. (single source of
# truth: the prune logic lives in the Makefile's `kind-prune` target.)
make kind-prune

# If the chart changed, helm upgrade. If only image changed, restart is enough.
helm upgrade --install ax-next deploy/charts/ax-next \
  --namespace ax-next \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --reuse-values
kubectl rollout restart -n ax-next deployment/ax-next-host
kubectl rollout status  -n ax-next deployment/ax-next-host --timeout=120s

# Force any stale runner pods to recycle
kubectl -n ax-next-runners delete pod -l app.kubernetes.io/component=ax-next-runner --wait=false || true
```

Refresh the browser (or `browser_navigate` again) and re-drive the scenario.

**Why `rollout restart`, not `helm uninstall + install`:** uninstall regenerates `credentials.key`, which invalidates any encrypted credentials stored in postgres during this loop. Restart preserves the secret + PVC.

---

## 6. Fast loop (hostPath dist mount)

Use when the fix is **host-side TypeScript only** — no Dockerfile change, no chart change, no runner-side code change. Cuts a cycle from ~60–90s to ~5–10s.

### Caveat: runner pods are excluded

Runner pods are spawned by `@ax/sandbox-k8s/src/pod-spec.ts` with a hardcoded volume list (`tmp`, `permanent`, `ephemeral` emptyDirs). There's no env-var hook for an extra hostPath mount today. So the fast loop covers only the host pod's code. If the fix is in `packages/agent-claude-sdk-runner/` (or anything else loaded by the runner binary), use the rebuild loop instead.

If unsure: the runner binary path is whatever the host's startup resolves via `require.resolve('@ax/agent-claude-sdk-runner/dist/main.js')`. Anything in that package and its workspace deps is runner-side.

### One-time setup (per kind cluster)

The chart has no dev-mount field, so we patch the running deployment. The kind node is itself a docker container (`ax-next-dev-control-plane`); we copy a deploy tree into it, then patch the host Deployment to mount that path over `/opt/ax-next/host`.

```bash
# 1. Build a deployable tree locally — what the Dockerfile's builder stage
#    produces. pnpm deploy resolves workspace:* edges into a self-contained dir.
pnpm install --frozen-lockfile
pnpm --filter @ax/cli build
rm -rf .dev-mount/host
mkdir -p .dev-mount
pnpm --filter @ax/cli deploy --prod --legacy .dev-mount/host

# 2. Push the tree into the kind node.
docker cp .dev-mount/host/. ax-next-dev-control-plane:/mnt/ax-dev/

# 3. Patch the host Deployment to mount /mnt/ax-dev over /opt/ax-next/host.
kubectl -n ax-next patch deployment ax-next-host --type=json -p='[
  {"op":"add","path":"/spec/template/spec/volumes/-",
   "value":{"name":"dev-dist","hostPath":{"path":"/mnt/ax-dev","type":"Directory"}}},
  {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts/-",
   "value":{"name":"dev-dist","mountPath":"/opt/ax-next/host"}}
]'
kubectl -n ax-next rollout status deployment/ax-next-host --timeout=120s

# Verify the mount is live
kubectl -n ax-next exec deploy/ax-next-host -- ls /opt/ax-next/host/dist/main.js
kubectl -n ax-next exec deploy/ax-next-host -- stat -c %Y /opt/ax-next/host/dist/main.js
```

### Per-iteration

```bash
pnpm --filter @ax/cli build
rm -rf .dev-mount/host
pnpm --filter @ax/cli deploy --prod --legacy .dev-mount/host
docker cp .dev-mount/host/. ax-next-dev-control-plane:/mnt/ax-dev/
kubectl -n ax-next rollout restart deployment/ax-next-host
kubectl -n ax-next rollout status  deployment/ax-next-host --timeout=120s
```

Then re-drive the scenario in the browser. Remember: refresh / re-navigate so cached JS doesn't mask the change.

### Tearing down the fast loop

```bash
kubectl -n ax-next patch deployment ax-next-host --type=json -p='[
  {"op":"remove","path":"/spec/template/spec/volumes/'$(kubectl -n ax-next get deploy/ax-next-host -o json | jq '.spec.template.spec.volumes | map(.name == "dev-dist") | index(true)')'"},
  {"op":"remove","path":"/spec/template/spec/containers/0/volumeMounts/'$(kubectl -n ax-next get deploy/ax-next-host -o json | jq '.spec.template.spec.containers[0].volumeMounts | map(.name == "dev-dist") | index(true)')'"}
]'
```

Or simpler: `helm upgrade ... --reuse-values --recreate-pods` to reset the deployment to the chart's rendered shape.

**Always tear down the fast loop before claiming the fix passes acceptance.** A passing scenario against a hostPath-mounted dist isn't the same as one against the published image — the image build could still be broken. The last cycle of any fix must be against the rebuilt image.

---

## 7. Common gotchas

### Browser / driver

- **`Failed to fetch` after a redeploy.** Port-forward died. Restart, then re-navigate.
- **Stale UI behavior after fast-loop redeploy.** Browser cached the old bundle. Hard refresh or `browser_navigate` again.
- **HTTP 403 `csrf-failed:origin-missing`.** Only happens for cross-origin requests; from the loaded page it shouldn't. If you're seeing it from a curl probe inside the loop, add `-H 'X-Requested-With: ax-admin'`.
- **`auth-required` / 401 on every API call.** Sign-in didn't take. Check `Set-Cookie` in network requests; check `auth.devBootstrap.token` was passed to helm.
- **Snapshot shows the page but interactions don't take.** Some hydration / runtime error; check `browser_console_messages` first, host log second.

### Cluster

- **`gVisor disabled` warning.** Expected on kind — `kind-dev-values.yaml` sets `sandbox.runtimeClassName: ""`. Real-cluster acceptance must use a cluster with gVisor.
- **`ImagePullBackOff` after fast-loop teardown.** You forgot to `kind load docker-image` after rebuilding. The `:dev` tag exists locally but kind's containerd doesn't see it until you load.
- **Runner pod stuck `Pending`.** Usually `ax-next-runners` namespace doesn't exist. The chart deliberately doesn't create it.
- **`AX_HTTP_COOKIE_KEY required` crash loop.** Issue #39 made `http.cookieKey` mandatory; the kind values default it but custom overlays must set it.
- **`kubectl logs` shows nothing useful.** Try `--all-containers --prefix` and `--previous`. The agent image runs tini as PID 1 and node as a child; both produce log lines.
- **Postgres pod restarts.** Bitnami's image moved repos in late 2025; the chart pins `bitnamilegacy/postgresql`. If pulls fail, override `postgresql.image.*`.
- **`no space left on device` during `docker cp` / `kind load` mid-walk.** The kind node filled with untagged `<none>` layers from repeated rebuilds (each `kind load` orphans the prior image). Run `make kind-prune` to reclaim it; `make image` and §3b/§5 of this loop do this automatically, but a long walk can still outrun it — prune by hand if it bites. `docker exec ax-next-dev-control-plane df -h /` confirms the node's free space.

---

## 8. What this skill does NOT do

- It doesn't pick the scenario or the success criteria — the user names them in browser-UI terms. If they're vague, restate and confirm before looping.
- It doesn't replace automated tests in `presets/k8s/src/__tests__/acceptance.test.ts` (testcontainers, runs in CI, plugin chain only — no real runner pod, no browser).
- It doesn't deploy to a real cluster. Real-cluster verification is a separate procedure (gVisor, real ingress, real DNS) and the loops here aren't sufficient.
- It doesn't bypass the bug-fix-test policy in `CLAUDE.md`: every bug fixed in this loop needs a regression test added in the same change. The browser scenario passing is necessary but not sufficient — automated coverage is what keeps it from regressing.
