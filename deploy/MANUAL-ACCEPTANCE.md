# Manual acceptance — Week 7–9 (k8s deployment shape)

> **Note (Phase 3, 2026-05-08):** This walkthrough still references the
> legacy `/auth/dev-bootstrap` endpoint, which is removed by Phase 3
> (k8s preset switched from `@ax/auth-oidc` to `@ax/auth-better` — the
> latter has no dev-bootstrap surface). The first-run flow is now the
> `@ax/onboarding` wizard at `/setup/*`. Phase 5 (Task 5.3) replaces
> this file with the wizard-based walkthrough; until then, this doc is
> stale for the auth/login section.


Automated CI exercises the postgres + workspace + session + eventbus plugin
chain via testcontainers (`presets/k8s/src/__tests__/acceptance.test.ts`). It
does NOT exercise a real runner pod. This file is the manual procedure for
proving the k8s preset can actually run a chat in a real cluster — kind for
dev verification, a real cluster for full acceptance.

We're a nervous crab. Don't ship without doing this.

## Prerequisites

- `kind` (or any k8s cluster you trust to receive a chart that creates pods).
- `kubectl`.
- `helm` 3.x.
- `docker` (running) for building the runner image.
- An Anthropic API key (we don't ship a default — you bring it).

## Goldenpath: kind

```bash
# 1. Build the agent image (host + runner share this one — see
#    container/agent/Dockerfile for the bundled-runner-binary layout).
docker build -t ax-next/agent:dev -f container/agent/Dockerfile .

# 2. Create a kind cluster + load the image
kind create cluster --name ax-next-dev
kind load docker-image ax-next/agent:dev --name ax-next-dev

# 3. Create the runner namespace. The chart does NOT create it (that's
#    intentional — the host's RBAC binding is scoped here, and we don't
#    want `helm uninstall` to take the namespace with it).
kubectl create namespace ax-next-runners

# 4. Install (or re-install) the chart into the ax-next namespace.
#    `upgrade --install` is idempotent — safe to re-run after a partial
#    failure without `helm uninstall` first. Every probe below assumes
#    the ax-next namespace, including the HTTP runner-IPC checks under
#    "Known gotchas".
#
#    Heads up: regenerating `credentials.key` on every run invalidates
#    any encrypted secrets in the database. That's fine for a from-
#    scratch kind run, but if you've seeded credentials and want to keep
#    them, pin the key once (e.g., to a file) and reuse it across runs.
helm upgrade --install ax-next deploy/charts/ax-next \
  --namespace ax-next --create-namespace \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set image.repository=ax-next/agent \
  --set image.tag=dev \
  --set credentials.key="$(openssl rand -base64 32)" \
  --set anthropic.apiKey="$ANTHROPIC_API_KEY"

# 5. Wait for the host pod to be Ready (postgres init job runs first; the
#    host Deployment waits on it).
kubectl wait -n ax-next --for=condition=Ready pod \
  -l app.kubernetes.io/component=ax-next-host --timeout=180s

# 6. Port-forward the host's public-http port (where /chat + /health live).
#    The host Service also exposes :80 for the runner-IPC back-channel —
#    that's not for human use, runner pods reach it cluster-internally.
kubectl port-forward -n ax-next svc/ax-next-host 9090:9090 &

# 7. Send a chat from the local CLI pointing at the cluster
ax-next chat --endpoint http://localhost:9090 "list the files in /workspace"
```

## Acceptance criteria

Any failure here blocks merge.

### Functional
- [ ] Chat returns a response. The response references a bash tool execution
      whose output is the actual file listing of the runner pod's workspace
      (which is empty by default — `ls /workspace` returns no entries, the
      assistant should say so coherently).
- [ ] `kubectl get pods -n ax-next-runners -l app.kubernetes.io/component=ax-next-runner`
      shows a runner pod was created and (after the chat ends) terminated
      within ~60s of the chat finishing.
- [ ] No stuck runner pods: 60s after the chat ends, the runner-namespace pod
      count is back to zero.

### State persistence
- [ ] A row landed in `session_postgres_v1_sessions`:
      ```bash
      kubectl exec -n ax-next deploy/ax-next-host -- \
        psql -U ax-next -d ax-next \
        -c "SELECT count(*) FROM session_postgres_v1_sessions;"
      ```
      Returns `count > 0`.
- [ ] A row landed in storage (audit log + chat-event log both write here):
      ```bash
      kubectl exec -n ax-next deploy/ax-next-host -- \
        psql -U ax-next -d ax-next \
        -c "SELECT count(*) FROM storage_postgres_v1_kv;"
      ```
      Returns `count > 0`.
- [ ] A workspace version was minted:
      ```bash
      kubectl exec -n ax-next deploy/ax-next-host -- \
        ls /workspace-data/repo.git/refs/heads/main
      ```
      File exists.

### Logs / hygiene
- [ ] No `level >= warn` lines in `kubectl logs -n ax-next deploy/ax-next-host`
      other than the expected gVisor-disabled warning if you're on a kind
      cluster without gVisor (the kind values.yaml turns gVisor off — that
      warning is OK; nothing else should be).

### Cleanup
- [ ] `helm uninstall ax-next -n ax-next` completes successfully.
- [ ] 60s after uninstall: `kubectl get pods -n ax-next` and
      `kubectl get pods -n ax-next-runners` both show zero `ax-next-*` pods.

## Real-cluster acceptance

Same procedure as kind, but:
- Use a cluster with gVisor available (or accept the documented degradation —
  see `packages/sandbox-k8s/SECURITY.md`).
- Don't pass `kind-dev-values.yaml`; tune resources for the cluster.
- Use a real ingress (`--set ingress.enabled=true --set ingress.host=...`).
- Bring an external postgres (`--set postgres.embedded.enabled=false --set
  postgres.external.connectionString=...`) or accept the embedded subchart
  for first-pass verification only.

## Known gotchas

- **HTTP runner-IPC.** After install, verify the host pod is binding the
  IPC listener:

  ```bash
  kubectl logs -n ax-next deploy/ax-next-host | grep ipc-http
  # expect: [ax/ipc-http] listening on http://0.0.0.0:8080
  ```

  Then verify a runner pod can reach it from inside the cluster. The
  simplest probe: launch a one-shot debug pod in the runner namespace:

  ```bash
  kubectl run debug --rm -it -n ax-next-runners \
    --image curlimages/curl --restart=Never -- \
    curl -sS http://ax-next-host.ax-next.svc.cluster.local/healthz
  # expect: {"ok":true}
  ```

  The end-to-end "chat returns a response" criterion requires the `serve`
  subcommand (now shipped — see "multi-replica chat" scenario below) and
  the agent image built from `container/agent/Dockerfile`. With the image
  loaded, port-forward into the host's Service and POST to `/chat`; the
  runner pod gets created, connects back over HTTP, and returns.

- **The embedded postgres** uses Bitnami's chart at version `16.7.27`,
  pinned to the `bitnamilegacy/postgresql` repository (Bitnami moved most
  images out of `bitnami/*` in late 2025). Override `postgresql.image.*`
  in values if you'd rather pull from somewhere else. See
  `deploy/charts/ax-next/SECURITY.md` for the full note.

- **Network policies** can interfere with kind's default CNI. The kind dev
  values disable NPs (`networkPolicies.enabled=false`). Real-cluster deploys
  must run on a CNI that enforces NPs (Calico, Cilium, etc.) — verify before
  enabling in prod.

## Scenario: multi-replica chat (workspace.backend=http)

This scenario proves that two host replicas can serve concurrent chat
requests against a shared workspace, and that the resulting git history
is linear with both sessions' writes visible. It exists to validate the
`workspace-git-http` slice — the dedicated git-server pod that owns the
bare repo, with each host replica forwarding workspace ops over HTTP so
we never have two writers racing on the same `.git`.

The `serve` CLI subcommand boots the k8s preset (postgres trio + workspace
+ sandbox-k8s + chat orchestrator + ipc-http + tools + LLM) and exposes a
small HTTP front door:

- `GET /health` — readiness/liveness probe (no auth).
- `POST /chat` — runs one chat turn, returns the outcome JSON.
  Auth: optional bearer token via `AX_SERVE_TOKEN`. If unset, `/chat` is
  open to anything that can route to the port — the chart's NetworkPolicy
  + ingress-off default still bound reach to in-cluster + port-forward,
  but for prod we recommend setting the token.

### Prerequisites

- A kind cluster (or any k8s cluster you trust) with `kubectl` configured.
- The agent image built and pushed to a registry the cluster can reach
  (build from `container/agent/Dockerfile` — same image is used for the
  host pod and the per-session runner pods).
- An Anthropic API key.

### Steps

1. Install (or upgrade) the chart with the multi-replica + http backend
   knobs flipped on:

   ```bash
   # http.cookieKey is required since issue #39 — without it the host
   # pod crash-loops on AX_HTTP_COOKIE_KEY required. Auth providers are
   # added at runtime via /admin/auth (Phase 3) — no helm flag needed.
   # onboarding.bootstrapToken pre-shares the wizard's claim token; if
   # omitted, @ax/onboarding generates one on first boot and prints it.
   helm upgrade --install ax-next deploy/charts/ax-next \
     --namespace ax-next --create-namespace \
     --set replicas=2 \
     --set workspace.backend=http \
     --set gitServer.enabled=true \
     --set image.repository=<your-registry>/ax-next/agent \
     --set image.tag=<your-tag> \
     --set credentials.key="$(openssl rand -base64 32)" \
     --set anthropic.apiKey="$ANTHROPIC_API_KEY" \
     --set http.cookieKey="$(openssl rand -hex 32)" \
     --set onboarding.bootstrapToken="$(openssl rand -hex 16)"
   ```

2. Wait for both host pods, the git-server pod, and postgres to be Ready:

   ```bash
   kubectl -n ax-next get pods -w
   ```

   Expected: 2 host pods (`ax-next-host-...`), 1 git-server pod
   (`ax-next-git-server-...`), and the postgres pod, all `1/1 Running`.

3. Port-forward into the host's public-http port from the local shell.
   `/chat` + `/health` live here (issue #39); the Service's :80 port is
   the runner-IPC back-channel and not for human traffic.

   ```bash
   kubectl -n ax-next port-forward svc/ax-next-host 9090:9090 &
   ```

4. Fire two concurrent chat requests against the host Service. The
   `serve` subcommand accepts `POST /chat` with a JSON body of
   `{"message": "<text>", "sessionId": "<optional>"}` — when `sessionId`
   is omitted, a fresh `serve-<uuid>` is minted server-side, so each
   request is independent:

   ```bash
   # X-Requested-With: ax-admin satisfies the http-server's CSRF gate on
   # state-changing methods (issue #39). Without it the request hits
   # csrf-failed:origin-missing and returns 403.
   curl -X POST http://localhost:9090/chat \
     -H 'Content-Type: application/json' \
     -H 'X-Requested-With: ax-admin' \
     -d '{"message":"hello from session A"}' &
   curl -X POST http://localhost:9090/chat \
     -H 'Content-Type: application/json' \
     -H 'X-Requested-With: ax-admin' \
     -d '{"message":"hello from session B"}' &
   wait
   ```

   Expected: both requests return HTTP 200 with a `{sessionId, outcome}`
   JSON body. Because `replicas: 2`, the Service load-balances the
   requests across both host pods — so we're genuinely exercising two
   writers landing through the single git-server.

   If `AX_SERVE_TOKEN` is set on the host pod, add
   `-H "Authorization: Bearer $AX_SERVE_TOKEN"` to each curl.

5. Verify both writes landed in the git-server's PVC. Two probes,
   either is fine:

   ```bash
   # Probe A: count commits directly from the git-server pod.
   kubectl -n ax-next exec deploy/ax-next-git-server -- node -e \
     "const git = require('isomorphic-git'); const fs = require('fs'); \
      git.log({fs, gitdir: '/var/lib/ax-next/repo/repo.git', ref: 'refs/heads/main'}) \
        .then(commits => console.log(commits.length))"
   ```

   Expected: at least 2 commits past whatever seed commit the chart's
   first boot may have created.

   ```bash
   # Probe B: ask the git-server's HTTP API directly.
   kubectl -n ax-next port-forward svc/ax-next-git-server 7780:7780 &
   curl -X POST http://localhost:7780/workspace.list \
     -H "Authorization: Bearer $(kubectl -n ax-next get secret ax-next-git-server-auth \
        -o jsonpath='{.data.token}' | base64 -d)" \
     -H 'Content-Type: application/json' \
     -d '{}' | jq .paths
   ```

   Expected: a list of paths reflecting both sessions' workspace state.

### Acceptance criteria

- [ ] Both concurrent `curl` calls return HTTP 200.
- [ ] The git-server pod's `main` ref shows ≥ 2 new commits after the
      requests complete.
- [ ] No host pod restarts during the run (`kubectl get pods -n ax-next`
      shows `RESTARTS = 0` for the host pods).
- [ ] No `level >= warn` lines in either host pod's logs other than the
      expected gVisor-disabled warning on kind.

### Cleanup

```bash
helm uninstall ax-next -n ax-next
```

The git-server PVC and its auth Secret persist on purpose — they carry
`helm.sh/resource-policy: keep` so an accidental `helm uninstall`
doesn't take the workspace history with it. Delete them by hand if a
clean slate is wanted:

```bash
kubectl -n ax-next delete pvc ax-next-git-server-repo
kubectl -n ax-next delete secret ax-next-git-server-auth
```

## Scenario: Credentials admin UI

This scenario walks the end-to-end credentials admin surface that landed
in the Week 10–12 admin-UI slice. We want to prove three things:

1. An admin can seed an `api-key` credential through the browser, no
   `kubectl edit secret` required.
2. A real chat actually picks that credential up — meaning the v2 scope
   axis (user → agent → global) is wired all the way through to the
   credential-proxy that the runner pod talks to.
3. Per-user "My credentials" are isolated — one user's row doesn't leak
   to another, and the admin surface stays admin-only.

We're a nervous crab. The whole point of the admin UI is to keep secrets
out of `helm --set ...` shell history and out of YAML, so this is the
scenario we hate skipping the most.

### Prerequisites

- The kind goldenpath above already booted. The host pod is Ready, and
  port-forward 9090 is live.
- `credentials.admin.enabled=true` on the chart values. The default is
  off — flip it on with `--set credentials.admin.enabled=true` on the
  `helm upgrade` from the goldenpath section. Without this flag the
  `/admin/credentials*` and `/settings/credentials*` routes don't mount,
  and the user menu's "Credentials" entries do nothing.
- The chat UI at `http://localhost:9090/` loads, and you can sign in.
  Dev-bootstrap (single shared admin user) is the simplest path; Google
  OIDC works too.

### Steps — admin: seed an api-key credential

1. Open `http://localhost:9090/` in a browser. Sign in if prompted.
2. Click your avatar (top-right) to open the user menu. The menu shows
   "My credentials" for everyone, plus an "Admin · Credentials" entry
   below the divider — that one is admin-only.
3. Click "Admin · Credentials". The Credentials admin tab opens with an
   (initially empty) list and an "Add credential" button.
4. Click "Add credential" → choose "api-key" from the kind menu.
5. Fill in the form:
   - **Scope:** `global` (visible to every user, the same as
     `ANTHROPIC_API_KEY` would have been).
   - **Ref:** `anthropic-api-key`.
   - **Secret:** paste a real Anthropic API key.
6. Click **Save**.

Expected:

- [ ] The credential appears in the list with `kind: api-key` and
      `scope: global`. We never echo the secret back — the list shows
      metadata only (kind, scope, ref, createdAt). If the secret shows
      up anywhere in the UI, that's a bug, stop and file it.
- [ ] `kubectl exec -n ax-next deploy/ax-next-host -- psql -U ax-next
      -d ax-next -c "SELECT count(*) FROM storage_postgres_v1_kv WHERE
      key LIKE 'credential:v2:%';"` returns `count = 1`. The blob is
      encrypted at rest with `AX_CREDENTIALS_KEY` — `psql` won't show
      plaintext, that's the point.

### Steps — admin: prove end-to-end resolution from a chat

This is the load-bearing one — it proves the credential the admin UI
just stored actually reaches the runner pod when it makes an LLM call.

1. Back in the chat UI, start a new conversation with the default
   agent.
2. Send any prompt that triggers an LLM call. "say hi" works.

Expected:

- [ ] The chat returns a response. (If we removed `--set
      anthropic.apiKey=...` from the helm install — see Task 7.2 —
      this proves the admin-seeded credential is the only path; no env
      fallback masking the result. If we kept it set, the env fallback
      could still serve, so this only proves "credentials work", not
      "admin-seeded credentials work" in that case. We recommend doing
      this scenario without the env-var set, on a fresh kind cluster,
      for the strongest proof.)
- [ ] A runner pod was spawned (`kubectl get pods -n ax-next-runners`)
      and exited cleanly within ~60s.
- [ ] No `level >= warn` lines about credentials in
      `kubectl logs -n ax-next deploy/ax-next-host`.

### Steps — admin: OAuth (anthropic-oauth)

Skip this if `@ax/credentials-anthropic-oauth` isn't loaded in the host
pod (it's optional — the kinds menu won't show "anthropic-oauth" unless
the plugin registered). The flow uses the web-paste pattern: the host
opens the Anthropic sign-in tab; we complete the flow there; we
copy-paste the resulting code back. We don't take a callback URL —
that keeps the host's network surface smaller.

1. From the Credentials admin tab, click "Add credential" →
   "anthropic-oauth".
2. The form shows an "Open Anthropic sign-in" button. Click it. A new
   tab opens to Anthropic's OAuth start URL with a PKCE challenge baked
   in.
3. In the new tab: complete the Anthropic flow (sign in, approve).
4. Anthropic shows a code on the final page. Copy it.
5. Back in the original tab, paste the code into the form and click
   **Submit**.

Expected:

- [ ] The new entry shows up in the list with `kind: anthropic-oauth`.
- [ ] Sending a chat that hits `anthropic` resolves through the OAuth
      credential rather than the api-key (verifiable from the host
      pod's logs — it'll log which kind resolved). If the api-key is
      also present at the same scope, the api-key wins (one-row-per-
      ref means the admin should delete the api-key first if they want
      OAuth to take over).

### Steps — non-admin: My credentials

This proves the per-user surface is actually per-user — admin reads can
see it (because they list any scope), but a non-admin user only sees
their own.

Caveat: the dev-bootstrap auth path mints a single shared user with
`role='admin'`. There's no way to be a non-admin via the wizard.
Two real-cluster options to actually test the non-admin path:

- **Google OIDC.** Sign in as a second Google account that the chart
  hasn't promoted to admin. New users default to `role='user'`.
- **Manual SQL flip.** As admin, sign in once as a second account
  (still via Google or another provider), then
  `kubectl exec -n ax-next deploy/ax-next-host -- psql -U ax-next
  -d ax-next -c "UPDATE auth_better_v1_users SET role='user'
  WHERE email='other@example.com';"`. Sign out + back in as that user.

Once signed in as a non-admin:

1. Click the avatar → user menu. Confirm the admin "Settings" entry is
   absent (UI affordance only — the server enforces ACL too, see
   below).
2. Click "Credentials". A settings panel opens with a credentials list
   scoped to this user.
3. Add an api-key with `ref: my-personal-key` and any payload.

Expected:

- [ ] The new credential shows up in the list with `scope: user`.
- [ ] The admin user (separate browser session) sees this row in the
      Credentials admin tab too — their list spans every scope.
- [ ] The non-admin user does NOT see the global `anthropic-api-key`
      we seeded earlier, even though it would resolve for them at
      chat time. (Listing is per-scope; resolution walks the chain.
      We don't conflate the two.)

### Steps — ACL probe

Belt-and-suspenders check that the server enforces what the UI hides.
With the non-admin user signed in, hit the admin route directly:

```bash
# session cookie from the non-admin browser, copied via DevTools
curl -i -H "Cookie: <non-admin-session-cookie>" \
  http://localhost:9090/admin/credentials
```

Expected: HTTP 403. If this returns 200 with someone else's
credential metadata, that's a security bug — stop and file it before
shipping.

### Acceptance criteria

- [ ] Admin api-key seed → list shows the row, no plaintext.
- [ ] Chat returns a response after the seed, proving end-to-end
      resolution.
- [ ] Admin OAuth seed (when the plugin is loaded) → list shows the
      row with `kind: anthropic-oauth`.
- [ ] Non-admin "My credentials" creates a `scope: user` row that's
      visible to the admin's full list and invisible to other
      non-admin users.
- [ ] `GET /admin/credentials` returns 403 for the non-admin session.

### Cleanup

The credentials live in postgres. `helm uninstall` does NOT delete
postgres data by default (the PVCs hang around). To wipe seeded
credentials:

```bash
kubectl exec -n ax-next deploy/ax-next-host -- \
  psql -U ax-next -d ax-next \
  -c "DELETE FROM storage_postgres_v1_kv WHERE key LIKE 'credential:v2:%';"
```

The encryption key (`AX_CREDENTIALS_KEY` in the host Secret) is
`helm.sh/resource-policy: keep` — surviving uninstall on purpose, so
that ciphertext we left behind is still decryptable. Delete the
Secret by hand if a true clean slate is wanted.

## When this passes, do
1. Update the PR description's acceptance section with the date + cluster
   used + a copy of the `psql` count outputs.
2. Mark Task 21 complete.
