# Manual acceptance — k8s deployment shape

Automated CI exercises the postgres + workspace + session + eventbus plugin
chain via testcontainers (`presets/k8s/src/__tests__/acceptance.test.ts`). It
does NOT exercise a real runner pod, the wizard, or the chat UI. This file
is the manual procedure for proving the k8s preset can actually run a chat
in a real cluster — kind for dev verification, a real cluster for full
acceptance.

We're a nervous crab. Don't ship without doing this.

The canonical first-run flow is the `@ax/onboarding` wizard at `/setup/*`.
The "Goldenpath: kind" section below is the bare-minimum infra bring-up;
the **First-use wizard** scenario further down is the operator-facing
walkthrough you should run at least once whenever the wizard, auth-better,
or the host's bootstrap path changes.

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
# `http.cookieKey` is required (issue #39). Bootstrap token is optional —
# if omitted, @ax/onboarding generates one and prints it to host stdout
# on first boot.
helm upgrade --install ax-next deploy/charts/ax-next \
  --namespace ax-next --create-namespace \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set image.repository=ax-next/agent \
  --set image.tag=dev \
  --set credentials.key="$(openssl rand -base64 32)" \
  --set http.cookieKey="$(openssl rand -hex 32)"

# 5. Wait for the host pod to be Ready (postgres init job runs first; the
#    host Deployment waits on it).
kubectl wait -n ax-next --for=condition=Ready pod \
  -l app.kubernetes.io/component=ax-next-host --timeout=180s

# 6. Port-forward the host's public-http port (where /chat + /setup + /health
#    + /admin/* + /auth/* live). The host Service also exposes :80 for the
#    runner-IPC back-channel — that's not for human use, runner pods reach
#    it cluster-internally.
kubectl port-forward -n ax-next svc/ax-next-host 9090:9090 &

# 7. Walk the first-use wizard at http://localhost:9090/setup. See the
#    "First-use wizard" scenario below for the full operator-facing
#    procedure (token scrape, 3-step wizard, first chat).
```

## Acceptance criteria

Any failure here blocks merge. These criteria assume the **First-use wizard
scenario** below has been completed end-to-end, since the wizard is the only
path to a chat-capable state on a fresh cluster.

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

## Scenario: First-use wizard (canonical)

This is the canonical first-use flow. After `helm install` the host pod
boots into a `bootstrap_state.status = pending` posture and exposes the
wizard at `/setup/*`. The operator follows a one-time URL, picks an admin
identity, supplies an Anthropic API key, and lands ready to chat with a
Default Agent. After completion, every `/setup/*` path returns 410 Gone (I11)
— the wizard is one-shot.

### Prerequisites

- Goldenpath bring-up complete: kind cluster + image loaded + chart installed +
  port-forward `9090:9090` is live.
- A real Anthropic API key (export `ANTHROPIC_API_KEY` for convenience — the
  wizard validates it synchronously with a 10s timeout per I8).
- A browser pointed at `http://localhost:9090`. The wizard SPA is a small
  Vite-built React bundle served from the host pod itself; no external
  build step.

### Steps

1. **Scrape the bootstrap token from host pod stdout.**

   ```bash
   kubectl -n ax-next logs deploy/ax-next-host | grep -E 'token: ax_bs_|open:  http' | head -2
   # [ax-onboarding] First-run bootstrap:
   #   token: ax_bs_<base64url>
   #   open:  http://0.0.0.0:9090/setup?token=ax_bs_<...>
   ```

   The "open" URL stamps the bind address (`0.0.0.0:9090`). For browser use
   substitute `localhost` (or set `--set onboarding.publicBaseUrl=https://<your-host>`
   on `helm install` to bake the right URL into the banner).

2. **Open the magic link** in the browser:

   ```
   http://localhost:9090/setup?token=ax_bs_<...>
   ```

   The SPA auto-claims on mount: it POSTs `{ token }` to `/setup/claim`,
   the backend atomically transitions `bootstrap_state` from `pending`
   to `claimed`, sets a short-lived `ax_bootstrap_session` cookie, and
   the SPA navigates to Step 2 (admin). The token is stripped from the
   URL bar via `history.replaceState` so a refresh doesn't re-leak it.

3. **Step "Create your admin account":** fill in name + email and submit.
   The SPA POSTs `/setup/admin`, the backend calls
   `auth:create-bootstrap-user` on `@ax/auth-better`, and the SPA
   navigates to Step 3.

   Expected:
   - The form accepts plain ASCII names. Email is validated structurally
     (`/^[^@\s]+@[^@\s]+$/`).
   - On HTTP 401 the SPA shows "Bootstrap session expired" — that means the
     bootstrap-session cookie was lost (e.g., the operator opened a new
     incognito window mid-flow). Restart from Step 1.

4. **Step "Connect Anthropic":** paste the API key, accept the default
   model selections (Haiku for fast, Sonnet for default), submit.

   This is the load-bearing step. The backend:
   - Calls `llm:probe-credential` — a real `Authorization: x-api-key …`
     hit against `https://api.anthropic.com/v1/models` with a 10s
     `AbortController` timeout (Invariant I8).
   - On success, runs ONE `db:transact` that creates the credential row,
     creates the Default Agent, stores the fast-model selection, and
     fires `bootstrap:complete` (Invariant I9 — credential + agent +
     completion are atomic).
   - On bad key: HTTP 200 with `{ ok: false, reason: 'credential-invalid' }`.
     SPA shows "That API key was rejected." No DB writes happen.
   - On timeout: HTTP 200 with `{ reason: 'credential-validation-timeout' }`.

   Expected:
   - With a valid key, the SPA navigates to "You're all set."
   - The "Open chat →" button takes the operator to `/`.

5. **Send the first chat.** From `http://localhost:9090/`, the chat UI
   should be reachable as the freshly-minted admin. Type any prompt that
   triggers a tool call — `list the files in /workspace` is the canonical
   probe.

### Acceptance criteria

- [ ] Stdout scrape returns a token shaped `ax_bs_<base64url>`.
- [ ] Loading `/setup?token=...` advances past Step 1 within ~2s without an
      "Invalid token" error.
- [ ] Step "Create admin" succeeds; the post-step network log shows
      `POST /setup/admin → 200`.
- [ ] Step "Connect Anthropic" with a valid key succeeds; the network log
      shows `POST /setup/model → 200` with `{ ok: true }`.
- [ ] Reloading `/setup` after the wizard returns HTTP 410 Gone
      (Invariant I11). Probe:

      ```bash
      curl -i http://localhost:9090/setup
      # HTTP/1.1 410 Gone
      ```

- [ ] The chat UI at `/` returns a response that references the bash tool
      execution. Runner pod lifecycle matches the goldenpath acceptance
      criteria (one runner spawned, terminated within ~60s).

#### Phase 0: SDK skill discovery (I-P0-1/3/4/5)

After the first chat lands, verify the runner can see workspace-authored
skills via the SDK's built-in `Skill` tool. Phase 0 only wires the discovery
path — the install loop (Phase 1+) populates `$CLAUDE_CONFIG_DIR/skills/`
later. For now we prove the workspace half of that surface is reachable.

1. In the chat UI, ask the agent to write a skill file:
   - Path: `.ax/skills/canary-skill/SKILL.md` (NOT `.claude/skills/…` — that
     surface is a host-owned symlink; agents write to `.ax/skills/`).
   - Frontmatter: `name: canary-skill`, `description: <anything>`.
   - Body: `When asked, mention "canary-skill" by name.`

2. Send a new message: "List the skills you have available."

3. Expected: the reply names `canary-skill`. Bonus: the agent invokes the
   `Skill` tool — visible in the tool-call timeline if the UI surfaces it.

If the agent reports no skills available, the symlink scaffolding or the
SDK setting-sources wiring is broken. `kubectl exec` into the runner pod
(catch it before it terminates — bump the agent's `idleShutdownMs` or
ask a follow-up message to keep the pod alive) and probe:

- `ls -la /permanent/.claude/skills` — should be a symlink to `../.ax/skills`.
- `cat /permanent/.ax/skills/canary-skill/SKILL.md` — should be readable.
- `echo $CLAUDE_CONFIG_DIR` — should be `/home/runner/.ax/session`.
- `ls -la $CLAUDE_CONFIG_DIR/skills` — should exist. Phase 0 leaves it
  empty; if it's missing entirely, the per-session HOME init isn't running.

### Common failures

- **`token: ax_bs_…` line is missing from stdout.** The plugin generates a
  token only when `bootstrap_state` is empty AND `AX_BOOTSTRAP_TOKEN` is
  not set. If the chart was installed with `onboarding.bootstrapToken=...`
  the operator already knows the token (it was supplied from outside).
  If the table has a stale `pending` or `claimed` row from a previous
  install, restart with a clean DB — see "Recovery" scenario below.
- **`/setup` returns 410 immediately on a fresh install.** Means
  `bootstrap_state.status = completed` already. Either the chart was
  reinstalled over a non-empty PVC, or someone walked the wizard already.
  Use `ax admin reset-bootstrap --force` (recovery scenario below) to
  re-mint a token, OR wipe the bootstrap_state row in postgres.
- **Step 4 hangs for ~10s and shows "Validation timed out".** The host pod
  cannot reach `api.anthropic.com` — egress NetworkPolicy or DNS issue. On
  kind, this usually means the cluster lost outbound networking; recreate
  the cluster.
- **Step 4 shows "credential-invalid" with a key the operator believes is
  good.** The probe hits `/v1/models` — confirm the key has model-list
  scope and is not revoked. The cleanest probe outside the wizard:
  `curl https://api.anthropic.com/v1/models -H 'x-api-key: <key>' -H 'anthropic-version: 2023-06-01'`.

### Cleanup

The wizard is one-shot. To re-walk it on the same cluster, either:

- Use `ax admin reset-bootstrap --force` from the operator host (recovery
  scenario below), OR
- Wipe the row directly:

  ```bash
  PGPASS=$(kubectl get secret -n ax-next ax-next-postgresql \
    -o jsonpath='{.data.postgres-password}' | base64 -d)
  kubectl -n ax-next exec ax-next-postgresql-0 -- env PGPASSWORD="$PGPASS" \
    psql -U postgres -d ax_next -c "DELETE FROM bootstrap_state;"
  kubectl -n ax-next rollout restart deployment/ax-next-host
  # New token printed in fresh stdout.
  ```

Note: the second path nukes the row outright; on next boot, the plugin
treats the cluster as never-onboarded and re-mints a token. The first
path (`reset-bootstrap`) is idempotent and safer when there are existing
admin users you want to keep — it only flips `bootstrap_state` to
`pending`, leaving `auth_better_v1_users` intact.

## Scenario: Recovery — lost bootstrap token

This is the operator-facing escape hatch when the bootstrap token has been
lost (e.g., the host pod restarted before the operator scraped stdout, or
the token-file mount disappeared). The CLI re-mints a fresh token and
flips `bootstrap_state` back to `pending` so the wizard works again.

The default `--force`-less form respects Invariant I6 (one-way state
machine): it refuses to reset a `completed` row. `--force` is the
explicit override for "we want to redo the wizard even though there's
already an admin".

### Prerequisites

- Goldenpath bring-up complete; the host pod is Ready.
- Database is reachable from wherever you're running `ax-next`. Either
  `DATABASE_URL` is exported in your shell pointing at the in-cluster
  postgres (via port-forward) or you're running the CLI inside the host
  pod itself.

### Steps — bootstrap pending, token lost

This is the common case. You ran `helm install`, the host pod printed the
token, but you never recorded it. `bootstrap_state.status` is still
`pending`, no admin exists yet.

1. **Confirm the lost-token scenario.**

   ```bash
   PGPASS=$(kubectl get secret -n ax-next ax-next-postgresql \
     -o jsonpath='{.data.postgres-password}' | base64 -d)
   kubectl -n ax-next exec ax-next-postgresql-0 -- env PGPASSWORD="$PGPASS" \
     psql -U postgres -d ax_next \
     -c "SELECT id, status FROM bootstrap_state;"
   # id | status
   # ---+---------
   #  1 | pending
   ```

   If `status` is `completed`, this isn't the lost-token scenario —
   you already have an admin. Use the `--force` variant below if you
   genuinely want to redo the wizard.

2. **Port-forward the postgres pod** so the local CLI can reach it
   (skip if you already have one, e.g., via a bastion):

   ```bash
   kubectl -n ax-next port-forward pod/ax-next-postgresql-0 5432:5432 &
   ```

3. **Run the recovery CLI.** From the ax-next checkout:

   ```bash
   PGPASS=$(kubectl get secret -n ax-next ax-next-postgresql \
     -o jsonpath='{.data.postgres-password}' | base64 -d)
   DATABASE_URL="postgres://postgres:${PGPASS}@127.0.0.1:5432/ax_next" \
   AX_PUBLIC_BASE_URL="http://localhost:9090" \
     pnpm --filter @ax/cli exec ax-next admin reset-bootstrap
   ```

   Expected stdout (matches the first-boot banner exactly):

   ```
   [ax-onboarding] First-run bootstrap:
     token: ax_bs_<base64url>
     open:  http://localhost:9090/setup?token=ax_bs_<...>
   ```

4. **Walk the wizard** at the printed URL. Same flow as the canonical
   first-use scenario.

### Steps — bootstrap completed, want to redo

For when an admin already exists but you'd like to re-run the wizard
(e.g., on a dev cluster you want to reset without dropping the DB).

`auth:create-bootstrap-user` rejects unconditionally if any admin row
exists (`packages/auth-better/src/plugin.ts` — the guard fires on
`role = 'admin'` regardless of how that row got there). So a
`--force` reset on its own is NOT enough — you must clear out the
existing admin first.

```bash
# 1. Drop existing admin users so the wizard's create-bootstrap-user
#    guard doesn't reject the second walk.
PGPASS=$(kubectl get secret -n ax-next ax-next-postgresql \
  -o jsonpath='{.data.postgres-password}' | base64 -d)
kubectl -n ax-next exec ax-next-postgresql-0 -- env PGPASSWORD="$PGPASS" \
  psql -U postgres -d ax_next \
  -c "DELETE FROM auth_better_v1_users WHERE role = 'admin';"

# 2. Mint a fresh bootstrap token.
DATABASE_URL=... AX_PUBLIC_BASE_URL=... \
  pnpm --filter @ax/cli exec ax-next admin reset-bootstrap --force

# 3. Walk the wizard at the printed URL.
```

The CLI prints the same banner as a first-boot. `bootstrap_state.status`
flips from `completed` back to `pending`, and the wizard's admin step
will succeed because there's no longer an admin row to collide with.

If you skip step 1, the wizard's "Create admin" step fails with HTTP
500 / `admin-already-exists` and the wizard stalls. The CLI itself
still succeeds — it has no view into `auth_better_v1_users` and isn't
the right layer to enforce that.

### Acceptance criteria

- [ ] Without `--force`, against a `completed` row, the CLI exits 1 with
      `error: bootstrap already completed; use --force to reset anyway`.
      The DB row is unchanged.
- [ ] Without `--force`, against a `pending` or `claimed` row, the CLI
      exits 0, prints the banner, and `bootstrap_state.token_hash` has
      a new value.
- [ ] With `--force`, against a `completed` row, the CLI exits 0, prints
      the banner, and `bootstrap_state.status` is now `pending`.
- [ ] After the CLI exits, opening the printed URL in the browser
      advances past the gate step within ~2s.

### Common failures

- **`admin reset-bootstrap: DATABASE_URL is unset.`** The CLI is
  postgres-only; there's no sqlite fallback. Set `DATABASE_URL` to
  your postgres connection string and try again.
- **`admin reset-bootstrap: unexpected init failure: …`** (or any
  `PluginError` message bubbling up from `@ax/database-postgres`).
  The CLI couldn't reach the postgres URL. Confirm the port-forward
  is alive (`ps -p $(cat /tmp/pf.pid)` if you set one), the password
  in `DATABASE_URL` matches the secret, and the user has access to
  the `ax_next` database.
- **Browser still shows "Setup already completed" after `reset-bootstrap`.**
  Almost always a stale browser cookie or a cached SPA bundle. Hard-refresh
  the page (`Cmd+Shift+R` / `Ctrl+Shift+R`) and re-open the new magic link.
  The plugin reads `bootstrap_state` per request — no kernel restart is
  needed for the CLI's effect to take.

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

## Scenario: multi-replica chat (workspace.backend=git-protocol)

This scenario proves that two host replicas can serve concurrent chat
requests against a shared workspace, and that the resulting git history
is linear with both sessions' writes visible. It exists to validate the
`@ax/workspace-git-server` slice — the dedicated git-server pod that
owns the bare repo, with each host replica forwarding workspace ops
over the standard git wire protocol so we never have two writers
racing on the same `.git`. (The legacy `http` backend was retired
2026-05-04; `git-protocol` is the supported multi-replica backend.)

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
     --set workspace.backend=git-protocol \
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

## Scenario: Receive a webhook (Routines Phase C)

Phase C ships the third routine trigger kind — webhooks. Phase D will
add a Routines tab to the admin UI; for now, URL discovery is via a
direct DB query.

### Prerequisites

- Goldenpath cluster is up; `ax` chat works end-to-end.
- An agent exists (the wizard's default chat agent is fine).
- Encryption: `AX_CREDENTIALS_KEY` is set in the host Secret (already
  the case for any goldenpath cluster).

### Steps — no-HMAC route

1. Open a chat with the default agent. Tell it to create a routine
   file. Suggested prompt:

   > Create `.ax/routines/notify.md` with frontmatter
   > `trigger.kind: webhook`, `trigger.path: "/test"`, and a prompt
   > body that says `received: {{payload.foo}}`. Use conversation
   > per-fire. Don't add HMAC.

   Confirm the agent committed the file via the chat output
   (workspace apply landed).

2. Read the agent's webhook token directly from postgres:

   ```bash
   kubectl exec -n ax-next deploy/ax-next-host -- \
     psql -U ax-next -d ax-next -c \
     "SELECT agent_id, webhook_token FROM agents_v1_agents WHERE webhook_token IS NOT NULL;"
   ```

   Expected: one row with a non-NULL `webhook_token` (~43-char URL-safe
   base64).

3. POST to the route:

   ```bash
   TOKEN=...   # value from step 2
   curl -i -X POST \
     -H 'Content-Type: application/json' \
     -d '{"foo":"bar"}' \
     http://localhost:9090/webhooks/$TOKEN/test
   ```

   Expected: `HTTP/1.1 202` immediately. (The agent run is
   fire-and-forget.)

4. Refresh the chat sidebar. A new per-fire conversation appears
   within ~1 second titled `test @ <ISO timestamp>`. Open it.
   The first user turn contains `received: bar` (the `{{payload.foo}}`
   substitution).

### Steps — HMAC variant

1. Store a webhook secret via the credentials admin UI:
   - scope: global
   - kind: api-key
   - ref: `gh-webhook-secret`
   - value: `shhh-test-secret`

2. Edit `.ax/routines/notify.md` (chat with the agent or `git push`)
   to add an `hmac` block:

   ```yaml
   trigger:
     kind: webhook
     path: "/test"
     hmac:
       secretRef: gh-webhook-secret
       header: "X-Hub-Signature-256"
       algorithm: sha256
       prefix: "sha256="
   ```

3. Re-curl WITHOUT a signature:

   ```bash
   curl -i -X POST \
     -H 'Content-Type: application/json' \
     -d '{"foo":"bar"}' \
     http://localhost:9090/webhooks/$TOKEN/test
   ```

   Expected: `HTTP/1.1 401`. No new conversation appears.

4. Re-curl WITH a wrong signature:

   ```bash
   curl -i -X POST \
     -H 'Content-Type: application/json' \
     -H 'X-Hub-Signature-256: sha256=deadbeef' \
     -d '{"foo":"bar"}' \
     http://localhost:9090/webhooks/$TOKEN/test
   ```

   Expected: `HTTP/1.1 401`. No new conversation.

5. Re-curl WITH a correct signature:

   ```bash
   SECRET=shhh-test-secret
   BODY='{"foo":"bar"}'
   SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
   curl -i -X POST \
     -H 'Content-Type: application/json' \
     -H "X-Hub-Signature-256: $SIG" \
     -d "$BODY" \
     http://localhost:9090/webhooks/$TOKEN/test
   ```

   Expected: `HTTP/1.1 202`, new conversation appears with the
   templated prompt.

### Acceptance criteria

- Without HMAC: 202 + new conversation with substituted prompt.
- HMAC missing header → 401, no conversation.
- HMAC wrong signature → 401, no conversation.
- HMAC correct signature → 202, new conversation.
- All four cases observable via `kubectl logs -n ax-next deploy/ax-next-host | grep routines` (routines plugin logs each fire with status).

### Cleanup

```bash
# Remove the test routine via chat or git push.
# The agent's webhook_token persists (it's lazy-generated, not
# scoped to this routine). Leave it in place unless rotating;
# a future admin UI will provide a rotate button.
```

## Scenario: Observe + manually fire a routine (Phase D)

Validates the Routines modal + heartbeat seed end-to-end against
`ax-next-dev`. This is the Phase D companion to the Phase C webhook
scenario above — same cluster, same auth path; just observability +
manual fire.

### Prerequisites

- Image rebuilt from current `main`. **Use `--no-cache`** when in doubt
  — runner-side caching has bitten Phase B/C before. (Phase D doesn't
  touch the runner, but the discipline applies to the host image too.)
- Host pod rolled out; port-forward on 9090.
- Goldenpath wizard already walked (a bootstrap admin exists).

### Steps

1. Sign in via the admin user (Phase C scenario's session works fine).
2. Create a fresh agent via the chat sidebar's "New agent" flow (or
   the admin UI's agent panel). Use displayName `phase-d-agent`.
3. Within ~2 seconds, confirm `routines_v1_definitions` got a row for
   the new agent at `.ax/routines/heartbeat.md`:

   ```bash
   POD=$(kubectl get pod -n ax-next -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}')
   PASS=$(kubectl get secret -n ax-next ax-next-postgresql -o jsonpath='{.data.postgres-password}' | base64 -d)
   kubectl exec -n ax-next $POD -- env PGPASSWORD=$PASS \
     psql -U postgres -d ax_next -c \
     "SELECT agent_id, path, name FROM routines_v1_definitions WHERE path = '.ax/routines/heartbeat.md';"
   ```

   Expected: one row per agent ever created (including the new one).

4. Click the avatar dropdown at the bottom-left of the sidebar →
   **Routines**. The Routines modal opens. The new agent's heartbeat
   appears as a row with last-status `—`, last-run `never`, trigger
   chip `interval 24h`.
5. Click **Fire now** on the heartbeat row. Within a few seconds:
   - The row's last-status flips to `silenced` (heartbeat's
     `silenceToken: HEARTBEAT_OK` triggers the silence path).
   - Expand the row → one fire row appears with timestamp, status
     `silenced`, triggerSource `manual`, and the rendered prompt
     body visible (the heartbeat template's body verbatim — no
     `{{payload.*}}` substitutions since this is a manual fire
     without payload).
6. Confirm the heartbeat's per-fire conversation is **not** in the
   chat sidebar's session list. Verify the row exists in
   `conversations_v1_conversations` with `hidden=t`:

   ```bash
   kubectl exec -n ax-next $POD -- env PGPASSWORD=$PASS \
     psql -U postgres -d ax_next -c \
     "SELECT conversation_id, hidden FROM conversations_v1_conversations WHERE title LIKE 'heartbeat @%' ORDER BY created_at DESC LIMIT 3;"
   ```

   Expected: `hidden | t` on each row.

7. **Webhook payload variant (optional).** In a chat with
   `phase-d-agent`, ask the agent to create
   `.ax/routines/payload-test.md` with a webhook trigger
   (`trigger.kind: webhook`, `trigger.path: "/payload-test"`) and a
   prompt body of `received: {{payload.foo}}`. In the Routines modal,
   click **Fire now** on that row → JSON form opens → paste
   `{"foo": "bar"}` → Submit. Confirm the resulting fire row's
   `renderedPrompt` is `received: bar`.

### Acceptance criteria

- New agent triggers heartbeat seed; `routines_v1_definitions` gains
  a heartbeat row within 2 seconds.
- Routines modal lists the new heartbeat with the trigger chip and
  `—` / never.
- Fire now on the heartbeat produces a `silenced` row visible in the
  expanded panel, with `renderedPrompt` populated.
- The fire's conversation is hidden from the chat sidebar (`hidden=t`
  in DB).
- (Optional) Webhook Fire now with payload renders the template into
  `renderedPrompt` correctly.

### Cleanup

```bash
# The new agent + its workspace remain — they're cheap. Delete them
# via the admin UI if a clean slate is wanted.
# The seeded heartbeat.md is part of the agent's workspace; deleting
# the agent drops it. The agent's webhook_token (lazy-generated)
# also goes with it.
```

## Scenario: Install a skill, attach to agent, chat (Phase 1 skill-install)

### What this proves

Admin installs a skill via /admin/skills, attaches it to an agent (binding
its credential slots to existing credentials), opens a chat, and the runner
sees the SKILL.md materialized + the proxy substitutes the bound credential
when the model calls the skill's allowedHost. Validates I-P1-1..8 in a
real cluster.

### Walk

1. Sign in as admin. Navigate to Admin → Credentials. Add a credential
   `kind=api-key`, `scope=global`, `ref=gh-pat`, with any string for value
   (the bytes don't have to be a real PAT for this walk — the proxy will
   substitute and the upstream will 401, which is fine for the gate check).
2. Navigate to Admin → Skills (new tab in the sidebar). Click `+ New skill`.
   Paste:
   ```yaml
   ---
   name: github
   description: Access the GitHub REST API with a personal access token.
   capabilities:
     allowedHosts:
       - api.github.com
     credentials:
       - slot: GITHUB_TOKEN
         kind: api-key
         description: GitHub PAT.
   ---
   Use this skill to call the GitHub REST API.
   ```
   The live preview pane should show `github`, the allowedHost chip
   `api.github.com`, and the slot `GITHUB_TOKEN (api-key)`. Click Install.
3. Confirm `github` appears in the Skills table with the host and slot
   chips populated.
4. Navigate to Admin → Agents, pick any test agent, scroll to the Skills
   section. Click `+ Attach skill`, pick `github`. A slot-binding row
   appears: `GITHUB_TOKEN ← [Select credential ▾]`. Pick `gh-pat`. Click
   `Save attachments`.
5. Open a chat with that agent and ask something benign: "Try to fetch
   https://api.github.com/users/torvalds and tell me the response status."
6. Verify in the network panel that the agent's tool call to api.github.com
   was permitted by the proxy (the proxy substitutes the placeholder with
   the credential value). The upstream may return 401 if the PAT is fake —
   that's fine; we're checking that the proxy DIDN'T return 403 (allowedHost
   gate) and that the substitution happened (no placeholder leaked to GitHub).
7. Navigate back to Admin → Skills. Click Delete on the `github` row.
   Verify the API returns 409 with "skill is attached" — the delete is
   blocked because the agent still has it attached.
8. Detach the skill from the agent (Skills section → trash icon → Save).
   Retry delete in the Skills tab. Verify it succeeds (204).
9. (Optional) `kubectl exec` into the runner pod for the session you opened
   in step 5 and confirm `$CLAUDE_CONFIG_DIR/skills/github/SKILL.md` exists
   with mode 0444, and the parent `skills/` dir is mode 0555.

### Acceptance criteria

- Skill installs via UI; appears in the table with host + slot chips.
- Attach + save succeeds; the agent record gains a
  `skill_attachments[].skillId='github'` row.
- Chat session opens without termination outcomes (skill-resolve-failed,
  skill-binding-missing, skill-slot-collision are all clear).
- Proxy permits the api.github.com tool call (no 403 from the proxy).
- skills:delete is blocked when the skill is attached (409); succeeds
  after detach (204).
- (Optional cluster-side) SKILL.md exists at the expected path inside
  the runner pod with the expected modes.

### Cleanup

```bash
# Delete the test agent + the github skill + the gh-pat credential
# via the admin UI. All three are scoped to this walk and cheap to recreate.
```

## Scenario: MCP-bundled skill (Phase B — capabilities.mcpServers)

### What this proves

A skill that declares `capabilities.mcpServers` produces a per-skill
`.mcp.json` next to `SKILL.md` inside the runner. The Claude SDK
auto-discovers the file, spawns the bundled MCP server in the sandbox,
and exposes its tools to the model. Validates the orchestrator → sandbox
→ runner materialization wiring end-to-end.

### Prerequisites

Same as the Phase 1 skill-install scenario above (clean `kind ax-next-dev`
cluster, an admin account, and a test agent). The MCP server used here is
`@modelcontextprotocol/server-everything`, a no-credentials reference
server that prints a few demo tools — it's fetched via `npx -y` at session
start, so the runner pod needs outbound network reach to npm (already true
on the goldenpath kind cluster).

### Walk

1. Sign in as admin. Navigate to Admin → Skills → `+ New skill`. Paste:
   ```yaml
   ---
   name: everything
   description: Bundles the @modelcontextprotocol/server-everything demo MCP server.
   capabilities:
     mcpServers:
       - name: everything
         transport: stdio
         command: npx
         args: ['-y', '@modelcontextprotocol/server-everything']
   ---
   Use this skill to demonstrate that MCP-bundled tools land in the session.
   ```
   The preview pane should show the skill name `everything`, no
   allowedHosts chips, no credential slot chips, and an MCP-server chip
   `everything (stdio: npx)`. Click Install.
2. Navigate to Admin → Agents → test agent → Skills section. Attach the
   `everything` skill. No credential bindings are needed (the skill
   declares zero `capabilities.credentials`). Save.
3. Open a chat with that agent. Ask: "List the MCP tools you can call.
   Just the names." Expect the response to mention tools from
   `server-everything` — at minimum `echo`, `add`, and `printEnv` (the
   exact tool list is the SDK's `everything` reference contract; check
   the README at `@modelcontextprotocol/server-everything` if it drifts).
4. Ask the agent to call one of those tools, e.g. "Use the echo tool with
   message 'phase-b acceptance'." The agent should issue a tool call and
   echo the message back in its response.
5. (Optional cluster-side) `kubectl exec` into the runner pod for the
   session opened in step 3 and confirm
   `$CLAUDE_CONFIG_DIR/skills/everything/.mcp.json` exists with mode 0444,
   and its content shape is:
   ```json
   {
     "mcpServers": {
       "everything": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-everything"],
         "env": {}
       }
     }
   }
   ```
6. Detach the skill from the agent (Skills section → trash → Save).
   Open a new chat. Ask again: "List the MCP tools you can call." The
   `echo` / `add` / `printEnv` tools should NO LONGER appear — verifying
   that the materialization is gated on attachment, not baked into the
   sandbox image.
7. Delete the skill via the Admin → Skills tab.

### Acceptance criteria

- Skill installs via UI; the MCP-server chip appears on the row.
- Attach + save succeeds; the agent's session opens without termination.
- Step 3: the agent lists MCP tools sourced from `everything`.
- Step 4: a `tools/call` to one of those tools returns the expected
  payload (echo round-trip is the cleanest assertion).
- Step 5: `.mcp.json` exists, mode 0444, content matches the shape above.
- Step 6: after detach, a fresh session does NOT have those tools.

### Cleanup

```bash
# Detach + delete the test skill + delete the test agent via the admin UI.
# The MCP server binary was npx-fetched into the pod's npm cache; pod
# teardown removes it.
```

## Scenario: Skill versioning + refresh (Phase C — sourceUrl)

### What this proves

A skill that declares a `sourceUrl` in its manifest persists it through
storage. Whenever the admin opens the Skills tab, the UI fires
`/admin/skills/:id/check-update` for each skill carrying a sourceUrl;
when the remote manifest's `version:` is higher than what's stored, an
"Update available" badge appears with an inline "Update" button.
Clicking the button POSTs `/admin/skills/:id/refresh-from-source`, which
fetches the manifest, re-validates it through the existing parser, and
upserts the new body + version. Latest-wins — no per-attachment pinning.

### Prerequisites

Same as the Phase 1 + Phase B scenarios above (clean `kind ax-next-dev`,
admin account). You also need somewhere to host a static SKILL.md file
the cluster's runner can reach via HTTPS — a public Gist works fine.
Two revisions are needed:

- **v1**: a SKILL.md with `version: 1` at any https URL of your choice.
- **v2**: the same file at the same URL, edited later to bump `version: 2`
  and change at least one visible line of the body.

A Gist works well: a single file at
`https://gist.githubusercontent.com/<you>/<gist-id>/raw/<commit>/SKILL.md`
(omit the commit segment to point at the latest revision so you can edit
in place between the two stages).

### Walk

1. Host v1 of the skill at your chosen https URL. The file must contain
   a `sourceUrl: <url>` line in its manifest pointing back at the same
   URL so refresh stays a no-op-but-idempotent operation:
   ```yaml
   ---
   name: heartbeat-v
   description: Daily check-in skill (versioning demo, v1).
   version: 1
   sourceUrl: https://gist.githubusercontent.com/you/abc/raw/SKILL.md
   ---
   Use this skill to demonstrate sourceUrl-driven refresh.
   Body v1.
   ```
2. Sign in as admin. Navigate to Admin → Skills → `+ New skill`. Paste
   the v1 content. Click Install. Confirm the row appears with
   `defaultAttached: false`. No "Update available" badge should appear
   — the stored version (1) matches the remote version (1).
3. Replace the hosted file with v2 (keep the URL stable):
   ```yaml
   ---
   name: heartbeat-v
   description: Daily check-in skill (versioning demo, v2).
   version: 2
   sourceUrl: https://gist.githubusercontent.com/you/abc/raw/SKILL.md
   ---
   Use this skill to demonstrate sourceUrl-driven refresh.
   Body v2 — this line is new.
   ```
4. Reload the Admin → Skills tab. Confirm:
   - "Update available: v2" Badge appears on the `heartbeat-v` row.
   - An "Update" Button appears in the action cell.
5. Click Update. While the request is in flight, the button should be
   disabled. When the call returns, the badge should disappear and the
   row's "Updated" timestamp should refresh.
6. Click the pencil (Edit) icon on the row. The SkillEditor's body
   preview should show "Body v2 — this line is new." The version field
   should now be `2`. Cancel out of the editor.
7. Replace the hosted file with a v3 that introduces a malformed
   manifest (e.g., set `version: -1`). Reload the Skills tab.
   - Either no badge appears (the check-update call surfaces an error
     server-side; the UI swallows per-skill check failures silently) OR
     a 4xx surfaces in the global error Alert when you click Update.
   - The stored row should NOT mutate from v2 — bad remote content
     never overwrites a working skill.

### Acceptance criteria

- Skill installs via UI with `sourceUrl` persisting through the GET payload.
- After bumping the remote `version:`, the Badge + Update button appear on
  the next refresh of the tab.
- Clicking Update bumps the stored `version` to match the remote version
  AND updates the bodyMd (verify via the SkillEditor preview).
- A malformed remote does NOT corrupt the stored row.
- (Optional) `kubectl exec` into the host pod and `psql` the
  `skills_v1_skills` row:
  ```sql
  SELECT skill_id, version, source_url IS NOT NULL FROM skills_v1_skills
   WHERE skill_id = 'heartbeat-v';
  ```
  Expected: version=2, source_url=t.

### Cleanup

```bash
# Delete the heartbeat-v skill via the admin UI; remove or unpublish the
# Gist if you don't want the demo content around.
```

## Scenario: User-installable skill (Phase 1 follow-up D — user scope)

### What this proves

A regular (non-admin) user can install their own private skill that only
their own agents can see — without bugging an admin. The global namespace
(`/admin/skills`) stays separate, and one user's private skills are invisible
to everyone else. If user-scoped rows ever leaked into another user's view or
into the admin global list, that's a privacy bug, and this walk catches it.

### Prerequisites

- A completed-bootstrap cluster with at least two real user accounts (call
  them **alice** and **bob**) plus the **admin**.
- Each of alice and bob owns at least one agent they can open a chat session
  with.

### Walk

1. **alice installs a private skill.** Log in as alice. Open the user menu
   (top-left avatar) → **My Skills**. The panel opens (it's a dialog, not a
   separate page). Click **New skill** and paste a minimal SKILL.md:

   ```markdown
   ---
   name: alice-notes
   description: Alice's private note-taking helper.
   version: 1
   ---
   # alice-notes

   When asked, summarize the conversation into three bullet points.
   ```

   Save. It should appear in alice's **My Skills** list.

2. **alice's agent sees it.** Attach `alice-notes` to one of alice's agents
   (admin → agent → skill attachments, or however attachment is surfaced for
   the owner), then open a chat session with that agent. The resolved skill
   set for the session should include `alice-notes` (verify the skill body
   shows up in the materialized `.claude/skills/` surface, or that the agent
   can act on the instruction).

3. **bob sees nothing of alice's.** Log in as bob. Open the user menu →
   **My Skills**. The list is **empty** (bob installed none). There is no
   trace of `alice-notes`.

4. **bob's agent does NOT see alice's skill.** Open a chat session with one
   of bob's agents. `alice-notes` must NOT be in the resolved set (bob can't
   attach it — it isn't visible to him — and even a same-named id wouldn't
   resolve to alice's row for bob).

5. **admin global list is unchanged.** Log in as admin → **Skills**
   (`/admin/skills`). Only global skills appear; `alice-notes` is NOT listed
   there. (User-scoped skills never surface in the admin global namespace.)

### Acceptance criteria

- alice can create / edit / delete skills under **My Skills**; they round-trip.
- A direct DB check confirms alice's row lands in `skills_v1_user_skills` with
  `owner_user_id` = alice's id (NOT in `skills_v1_skills`):

  ```sql
  SELECT owner_user_id, skill_id FROM skills_v1_user_skills;
  SELECT skill_id FROM skills_v1_skills;  -- alice-notes must NOT appear here
  ```
- bob's **My Skills** is empty; `GET /settings/skills` as bob returns no alice
  rows; `GET /settings/skills/alice-notes` as bob → 404.
- admin `/admin/skills` shows only global skills (no user-scoped rows).
- On id collision (alice installs a `github` skill while a global `github`
  exists), alice's agents resolve to **alice's** copy (user-wins).

### Cleanup

```bash
# As alice, delete alice-notes via My Skills. Detach it from her agent first
# if attached. The user-scoped row is keyed (owner_user_id, skill_id) so it's
# cheap to recreate.
```

## When this passes, do
1. Update the PR description's acceptance section with the date + cluster
   used + a copy of the `psql` count outputs.
2. Mark Task 21 complete.

### Walks completed
- **Skill install Phase 1 (PR #96)** — tested 2026-05-18 on
  `kind-ax-next-dev` (image `ax-next/agent:dev`).
  - Two regressions caught and fixed before this PR could merge:
    - Init container wrote into `/permanent` before the runner cloned
      the workspace there, so `git clone` refused the non-empty target.
      Scaffold moved to `git-workspace.ts#scaffoldWorkspaceSkillSurface`,
      which runs after materialize.
    - Skill slot env vars (e.g. `GITHUB_TOKEN`) never reached the SDK
      subprocess. `proxy-startup.ts` now forwards env vars whose value
      is an `ax-cred:<32-hex>` placeholder.
  - All step 1–9 acceptance criteria pass.
