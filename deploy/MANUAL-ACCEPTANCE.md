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
- **Which cluster:** every `kubectl` / `helm` command in this file names
  `--context kind-ax-next-dev` (helm: `--kube-context`) explicitly, so pasting one can
  only ever act on the kind cluster — never on whatever your *default* context is,
  which on a machine that also talks to a real cluster may be production. Walking a
  real cluster on purpose? Replace `kind-ax-next-dev` with that cluster's context name
  in the commands you run, deliberately; don't just switch your default. (That test is
  enforced by `scripts/__tests__/kind-tooling-pinned-to-kind-context.test.js`.)
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
kubectl --context kind-ax-next-dev create namespace ax-next-runners

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
helm --kube-context kind-ax-next-dev upgrade --install ax-next deploy/charts/ax-next \
  --namespace ax-next --create-namespace \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set image.repository=ax-next/agent \
  --set image.tag=dev \
  --set credentials.key="$(openssl rand -base64 32)" \
  --set http.cookieKey="$(openssl rand -hex 32)"

# 5. Wait for the host pod to be Ready (postgres init job runs first; the
#    host Deployment waits on it).
kubectl --context kind-ax-next-dev wait -n ax-next --for=condition=Ready pod \
  -l app.kubernetes.io/component=ax-next-host --timeout=180s

# 6. Port-forward the host's public-http port (where /chat + /setup + /health
#    + /admin/* + /auth/* live). The host Service also exposes :80 for the
#    runner-IPC back-channel — that's not for human use, runner pods reach
#    it cluster-internally.
kubectl --context kind-ax-next-dev port-forward -n ax-next svc/ax-next-host 9090:9090 &

# 6b. Port-forward the artifact content origin too (content-http, 9091).
#     Agent-made pages and images are shown from http://127.0.0.1:9091, a
#     different site from the app at localhost:9090 (kind-dev-values.yaml).
#     Without this forward, artifact previews stay blank.
kubectl --context kind-ax-next-dev port-forward -n ax-next svc/ax-next-host 9091:9091 &

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
      whose output is the actual file listing of the agent's working directory
      (which is empty by default — `ls /files` returns no entries, the
      assistant should say so coherently).
- [ ] `kubectl --context kind-ax-next-dev get pods -n ax-next-runners -l app.kubernetes.io/component=ax-next-runner`
      shows a runner pod was created and (after the chat ends) terminated
      within ~60s of the chat finishing.
- [ ] No stuck runner pods: 60s after the chat ends, the runner-namespace pod
      count is back to zero.

### State persistence
- [ ] A row landed in `session_postgres_v1_sessions`:
      ```bash
      kubectl --context kind-ax-next-dev exec -n ax-next deploy/ax-next-host -- \
        psql -U ax-next -d ax-next \
        -c "SELECT count(*) FROM session_postgres_v1_sessions;"
      ```
      Returns `count > 0`.
- [ ] pgvector is enabled on the embedded postgres (the `pg-init` hook Job fails the
      install if it is not, so this should never be empty — TASK-458):
      ```bash
      kubectl --context kind-ax-next-dev exec -n ax-next deploy/ax-next-host -- \
        psql -U ax-next -d ax-next \
        -tAc "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
      ```
      Prints a version (0.8.0 on the default image), not an empty line.
- [ ] A row landed in storage (audit log + chat-event log both write here):
      ```bash
      kubectl --context kind-ax-next-dev exec -n ax-next deploy/ax-next-host -- \
        psql -U ax-next -d ax-next \
        -c "SELECT count(*) FROM storage_postgres_v1_kv;"
      ```
      Returns `count > 0`.
- [ ] There is no git workspace tier (removed in TASK-995). No git-server pod,
      and no `ws-*.git` repos on the host:
      ```bash
      kubectl --context kind-ax-next-dev -n ax-next get pods | grep -c git-server
      # 0
      ```

### Logs / hygiene
- [ ] No `level >= warn` lines in `kubectl --context kind-ax-next-dev logs -n ax-next deploy/ax-next-host`
      other than the expected gVisor-disabled warning if you're on a kind
      cluster without gVisor (the kind values.yaml turns gVisor off — that
      warning is OK; nothing else should be).

### Cleanup
- [ ] `helm --kube-context kind-ax-next-dev uninstall ax-next -n ax-next` completes successfully.
- [ ] 60s after uninstall: `kubectl --context kind-ax-next-dev get pods -n ax-next` and
      `kubectl --context kind-ax-next-dev get pods -n ax-next-runners` both show zero `ax-next-*` pods.

## Real-cluster acceptance

Same procedure as kind, but:
- Name the cluster yourself: replace `kind-ax-next-dev` in every command with the
  target's context name (see **Which cluster** under Prerequisites). Do not lean on
  your current context.
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
  port-forwards `9090:9090` and `9091:9091` (artifact content) are live.
- A real Anthropic API key (export `ANTHROPIC_API_KEY` for convenience — the
  wizard validates it synchronously with a 10s timeout per I8).
- A browser pointed at `http://localhost:9090`. The wizard SPA is a small
  Vite-built React bundle served from the host pod itself; no external
  build step.

### Steps

1. **Scrape the bootstrap token from host pod stdout.**

   ```bash
   kubectl --context kind-ax-next-dev -n ax-next logs deploy/ax-next-host | grep -E 'token: ax_bs_|open:  http' | head -2
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
   triggers a tool call — `list the files in /files` is the canonical
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

After the first chat lands, verify the runner can see installed skills via
the SDK's built-in `Skill` tool. Installed skills are written to
`$CLAUDE_CONFIG_DIR/skills/` (the tmpfs `/home/runner`). Agents no longer
author skills into `.ax/draft-skills/`; that directory is gone (TASK-995).

1. Install a skill for the agent through the app (any skill will do).

2. Send a new message: "List the skills you have available."

3. Expected: the reply names the installed skill. Bonus: the agent invokes the
   `Skill` tool — visible in the tool-call timeline if the UI surfaces it.

If the agent reports no skills available, the skill install or the
SDK setting-sources wiring is broken. `kubectl exec` into the runner pod
(catch it before it terminates — bump the agent's `idleShutdownMs` or
ask a follow-up message to keep the pod alive) and probe:

- `echo $CLAUDE_CONFIG_DIR` — should be `/home/runner/.ax/session`.
- `ls -la $CLAUDE_CONFIG_DIR/skills` — should list the installed skill. If
  it's missing entirely, the per-session HOME init isn't running.

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
  PGPASS=$(kubectl --context kind-ax-next-dev get secret -n ax-next ax-next-postgresql \
    -o jsonpath='{.data.postgres-password}' | base64 -d)
  kubectl --context kind-ax-next-dev -n ax-next exec ax-next-postgresql-0 -- env PGPASSWORD="$PGPASS" \
    psql -U postgres -d ax_next -c "DELETE FROM bootstrap_state;"
  kubectl --context kind-ax-next-dev -n ax-next rollout restart deployment/ax-next-host
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
   PGPASS=$(kubectl --context kind-ax-next-dev get secret -n ax-next ax-next-postgresql \
     -o jsonpath='{.data.postgres-password}' | base64 -d)
   kubectl --context kind-ax-next-dev -n ax-next exec ax-next-postgresql-0 -- env PGPASSWORD="$PGPASS" \
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
   kubectl --context kind-ax-next-dev -n ax-next port-forward pod/ax-next-postgresql-0 5432:5432 &
   ```

3. **Run the recovery CLI.** From the ax-next checkout:

   ```bash
   PGPASS=$(kubectl --context kind-ax-next-dev get secret -n ax-next ax-next-postgresql \
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
PGPASS=$(kubectl --context kind-ax-next-dev get secret -n ax-next ax-next-postgresql \
  -o jsonpath='{.data.postgres-password}' | base64 -d)
kubectl --context kind-ax-next-dev -n ax-next exec ax-next-postgresql-0 -- env PGPASSWORD="$PGPASS" \
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
  kubectl --context kind-ax-next-dev logs -n ax-next deploy/ax-next-host | grep ipc-http
  # expect: [ax/ipc-http] listening on http://0.0.0.0:8080
  ```

  Then verify a runner pod can reach it from inside the cluster. The
  simplest probe: launch a one-shot debug pod in the runner namespace:

  ```bash
  kubectl --context kind-ax-next-dev run debug --rm -it -n ax-next-runners \
    --image curlimages/curl --restart=Never -- \
    curl -sS http://ax-next-host.ax-next.svc.cluster.local/healthz
  # expect: {"ok":true}
  ```

  The end-to-end "chat returns a response" criterion requires the `serve`
  subcommand (now shipped) and
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

## Scenario: multi-replica chat (retired)

> **Retired.** This scenario walked two host replicas writing through the
> dedicated git-server pod. TASK-995 removed the git workspace tier, and the
> chart's `ax-next.validateHostReplicas` guard (ARCH-1) already refuses more
> than one host replica: the chat stream buffer, the orchestrator's
> warm-session map, and the Rules-change signal (TASK-617) all live in one
> host process. There is nothing to walk until that guard is lifted, and the
> old steps are in git history.

## Scenario: Credentials admin UI

This scenario walks the end-to-end credentials admin surface that landed
in the Week 10–12 admin-UI slice. We want to prove three things:

1. An admin can seed an `api-key` credential through the browser, no
   hand-editing the Secret required.
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
  port-forwards 9090 and 9091 (artifact content) are live.
- `credentials.admin.enabled=true` on the chart values. The default is
  off — flip it on with `--set credentials.admin.enabled=true` on the
  `helm upgrade` from the goldenpath section. Without this flag the
  `/admin/credentials*` and `/settings/destinations/*` routes don't mount,
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
- [ ] A runner pod was spawned (`kubectl --context kind-ax-next-dev get pods -n ax-next-runners`)
      and exited cleanly within ~60s.
- [ ] No `level >= warn` lines about credentials in
      `kubectl --context kind-ax-next-dev logs -n ax-next deploy/ax-next-host`.

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
kubectl --context kind-ax-next-dev exec -n ax-next deploy/ax-next-host -- \
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

   > Create a routine named `notify` with
   > `trigger.kind: webhook`, `trigger.path: "/test"`, and a prompt
   > body that says `received: {{payload.foo}}`. Use conversation
   > per-fire. Don't add HMAC.

   Routines live in the database (not in files), so confirm the routine
   shows up in Settings -> Routines.

2. Read the agent's webhook token directly from postgres:

   ```bash
   kubectl --context kind-ax-next-dev exec -n ax-next deploy/ax-next-host -- \
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

1. Open the task's page, App updates, paste `shhh-test-secret` into
   **Signing secret**, and Save. There are no signature settings to choose;
   the host detects the format.

2. Copy the address from the same row and set it:

   ```bash
   URL=...   # the address copied from the App updates row
   ```

3. Re-curl WITHOUT a signature:

   ```bash
   curl -i -X POST \
     -H 'Content-Type: application/json' \
     -d '{"foo":"bar"}' \
     "$URL"
   ```

   Expected: `HTTP/1.1 401`. No new conversation appears.

4. Re-curl WITH a wrong signature:

   ```bash
   curl -i -X POST \
     -H 'Content-Type: application/json' \
     -H 'X-Hub-Signature-256: sha256=deadbeef' \
     -d '{"foo":"bar"}' \
     "$URL"
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
     "$URL"
   ```

   Expected: `HTTP/1.1 202`, new conversation appears with the
   templated prompt.

6. Re-curl with a Linear-style signature (a bare hex digest in a different
   header, no prefix):

   ```bash
   curl -i -X POST \
     -H 'Content-Type: application/json' \
     -H "Linear-Signature: $(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')" \
     -d "$BODY" \
     "$URL"
   ```

   Expected: `HTTP/1.1 202`, and the task page shows
   "Linear connected · … · signature checked, no timestamp".

### Acceptance criteria

- No signing secret saved: 202 + new conversation with substituted prompt.
- With a secret saved: missing signature → 401, no conversation.
- With a secret saved: wrong signature → 401, no conversation.
- With a secret saved: correct signature in `X-Hub-Signature-256` (GitHub) or `Linear-Signature` (Linear) → 202, new conversation.
- All cases observable via `kubectl --context kind-ax-next-dev logs -n ax-next deploy/ax-next-host | grep routines` (routines plugin logs each fire with status).

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
   the new agent's heartbeat:

   ```bash
   POD=$(kubectl --context kind-ax-next-dev get pod -n ax-next -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}')
   PASS=$(kubectl --context kind-ax-next-dev get secret -n ax-next ax-next-postgresql -o jsonpath='{.data.postgres-password}' | base64 -d)
   kubectl --context kind-ax-next-dev exec -n ax-next $POD -- env PGPASSWORD=$PASS \
     psql -U postgres -d ax_next -c \
     "SELECT agent_id, name FROM routines_v1_definitions WHERE name = 'heartbeat';"
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
   kubectl --context kind-ax-next-dev exec -n ax-next $POD -- env PGPASSWORD=$PASS \
     psql -U postgres -d ax_next -c \
     "SELECT conversation_id, hidden FROM conversations_v1_conversations WHERE title LIKE 'heartbeat @%' ORDER BY created_at DESC LIMIT 3;"
   ```

   Expected: `hidden | t` on each row.

7. **Webhook payload variant (optional).** In a chat with
   `phase-d-agent`, ask the agent to create
   a routine named `payload-test` with a webhook trigger
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

> **Now auto-canaried.** The install → attach → invoke path (skill installed
> via `skills:upsert`, attached via `agents:set-skill-attachments`, session
> opened via the orchestrator, and the unioned allowlist + credential bindings
> reaching `proxy:open-session` while the SKILL.md reaches `sandbox:open-session`)
> is exercised end-to-end against a real Postgres testcontainer in
> `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` (runs in CI
> via `pnpm test`, no separate step needed — `@ax/skills` already uses
> testcontainers). The manual walk below is still encouraged for the
> cluster-only surfaces the canary can't reach: real sandbox materialization
> of `.claude/skills/`, the credential-proxy actually substituting the bound
> token on an egress call, and the admin UI.

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
auto-discovers the file, connects to the remote (http) MCP server it names,
and exposes its tools to the model. Validates the orchestrator → sandbox
→ runner materialization wiring end-to-end.

### Prerequisites

Same as the Phase 1 skill-install scenario above (clean `kind ax-next-dev`
cluster, an admin account, and a test agent). The MCP server used here is
a remote, no-credentials streamable-HTTP server. `https://mcp.example.com`
below is a placeholder: swap in the URL of a server you can reach, such as
a deployment of the `@modelcontextprotocol/server-everything` reference
server, which exposes a few demo tools. stdio MCP servers (a command the
sandbox spawns) are no longer supported, so there is nothing to `npx`; the
runner pod only needs outbound network reach to that URL.

### Walk

1. Sign in as admin. Navigate to Admin → Skills → `+ New skill`. Paste:
   ```yaml
   ---
   name: everything
   description: Points at a remote demo MCP server.
   capabilities:
     mcpServers:
       - name: everything
         transport: http
         url: https://mcp.example.com
   ---
   Use this skill to demonstrate that MCP-bundled tools land in the session.
   ```
   The preview pane should show the skill name `everything`, no
   allowedHosts chips, no credential slot chips, and an MCP-server chip
   `everything (http)`. Click Install.
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
         "url": "https://mcp.example.com",
         "type": "http"
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
# The MCP server is remote, so there is nothing to clean up in the pod.
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

## Scenario: JIT early-approval of a pending cap-skill (TASK-83)

### What this proves

An agent-authored skill that needs a host or a key lands `pending` and is
**discoverable + approvable from My Skills before the agent ever uses it** —
you don't have to wait for the in-chat card to fire on first use. The card
still fires just-in-time if you skip this; early approval is the *deliberate*
mirror of the just-in-time face. Capability gating stays strict: approving
still needs the human + the key. Design:
`docs/notes/2026-05-30-jit-capability-approval-flow.md`.

### Prerequisites

- A completed-bootstrap cluster in **open mode** (`allow_user_installed_skills`
  on) with a user (**alice**) who owns a personal agent.
- Egress + credential plugins wired (the k8s preset).

### Walk

1. **alice's agent authors a cap-skill.** In a chat with her agent, ask it to
   author a skill that needs a host + an API key (e.g. "write me a Linear
   skill"). The agent writes a SKILL.md with `capabilities.allowedHosts` +
   `capabilities.credentials` and calls `skill_propose`. It should tell you the
   skill is **waiting on your approval** and that you can approve it on first
   use *or* ahead of time from My Skills (the propose-time hint).

2. **No card fires yet.** The skill is `pending`; no approval card appears just
   from authoring. (This is the design — just-in-time, not eager.)

3. **alice approves early from My Skills.** Open the user menu → **My Skills**.
   Under **"Authored by your agents"**, the new skill shows status
   **"needs approval"** with an **Approve** button. Click it. The dialog shows
   the host(s) it will reach + a field for the key. Enter the key, click
   **Approve**.

4. **It goes live without an in-chat prompt.** A banner confirms the skill is
   approved and live. The status flips to **active**. On the agent's next turn,
   the skill is usable with no card interruption.

### Acceptance criteria

- A pending cap-bearing authored skill shows **"needs approval"** + an
  **Approve** button in My Skills; an inert pending skill shows neither.
- `GET /settings/skills/authored` returns `pendingCapabilities` (hosts/slots/
  packages) for the pending cap-skill, and omits it for active/inert skills.
- Approving writes the key to the credential store, the approved-cap rows, and
  flips the authored row to `active` — verifiable in the DB:

  ```sql
  -- the skill is now active (not pending) for alice's agent
  SELECT skill_id, status FROM skills_v1_authored WHERE owner_user_id = '<alice>';
  -- approved-cap rows exist for the host + slot
  SELECT skill_id, kind, value FROM skills_v1_approved_caps WHERE owner_user_id = '<alice>';
  ```
- A user can only approve onto an agent they own: `POST
  /api/chat/approve-authored-skill` for an agent alice doesn't own → 403/404.
- The key never appears in the transcript, the model context, or any SSE frame.

### Cleanup

```bash
# Delete the authored skill from My Skills (and revoke the key under My Keys
# if you vaulted it). The authored row is keyed (owner_user_id, agent_id,
# skill_id), so it's cheap to recreate by re-authoring.
```

## Scenario: Google sign-in (better-auth Google provider)

This scenario walks the end-to-end Google OAuth flow — configuring the
provider in the admin UI, verifying the happy path (Google account allowed
by domain), and verifying the rejection path (account outside
`allowed_domains`). It's the manual complement to the existing wizard walk,
covering authentication for everyone who isn't the bootstrap admin.

### Prerequisites

**Google Cloud Console setup (do this before touching the cluster):**

1. In the [Google Cloud Console](https://console.cloud.google.com/), create
   an OAuth 2.0 client ID (Web application). Under "Authorized redirect
   URIs", add exactly:

   ```text
   ${AX_PUBLIC_BASE_URL}/auth/callback/google
   ```

   For a local kind walk that uses port-forward, that's:

   ```text
   http://localhost:9090/auth/callback/google
   ```

   This is not optional. Google rejects the OAuth exchange with
   `redirect_uri_mismatch` if the redirect URI doesn't match what's
   registered. No match, no login — for anyone.

2. Note your **Client ID** and **Client Secret** from the console.

**Cluster setup:**

- Goldenpath bring-up complete: kind cluster + image loaded + chart installed +
  port-forwards `9090:9090` and `9091:9091` (artifact content) are live.
- The chart must be installed with a stable `http.cookieKey` value. Better-auth
  uses it to sign session cookies. If the value rotates between restarts,
  existing sessions break — that's expected and correct, but jarring mid-walk.
  For kind, the goldenpath install (`upgrade --install`) generates a fresh key on
  each run, so start a fresh port-forward after any reinstall.
- `AX_AUTH_SECRET` must be stable across restarts. Better-auth uses it to
  encrypt the OAuth tokens it stores. The chart generates it independently —
  its own `auth-secret` key in `hook-secret.yaml`, held stable across
  `helm upgrade` by the `lookup` guard — so you don't set it by hand and it
  survives a normal upgrade automatically. The data-loss risk is about
  `AX_AUTH_SECRET` itself: if its value changes, every previously-encrypted
  OAuth token in the database becomes undecryptable. The only way an operator
  breaks this is by forcing a new value (e.g., overriding it explicitly or
  deleting the Secret so the chart regenerates it). For a greenfield kind walk
  this doesn't matter — there's nothing stored yet. For a cluster with real
  users, don't force a new value.
- The first-use wizard must have been completed (a bootstrap admin must exist)
  so we can sign in to configure the provider.
- `trustedOrigins` must include the origin you're accessing the app from.
  When you set `AX_PUBLIC_BASE_URL` on the chart, it's plumbed automatically.
  For the local kind walk, `http://localhost:9090` is included by default when
  you port-forward on 9090.
- A second Google account (or any Google account) whose domain you're willing
  to use as the `allowed_domains` test value. You'll need one account that
  IS allowed and one that is NOT.

### Steps — configure the Google provider

1. Sign in to the admin account (via the bootstrap flow or an existing
   admin session at `http://localhost:9090`).
2. Navigate to **Admin → Auth** (`http://localhost:9090/admin/auth`).
3. Click **+ Add provider** and select **Google**.
4. Fill in the form:
   - **Client ID:** the OAuth 2.0 client ID from Google Cloud Console.
   - **Client Secret:** the corresponding client secret.
   - **Allowed domains:** your org's domain (e.g., `example.com`). Comma-separated
     if you want multiple. This is the gate — only accounts whose email
     ends in one of these domains will be permitted in.
5. Click **Save**.

Expected:
- The provider row appears in the provider list with kind `google` and
  the client ID visible. The client secret is stored encrypted and is
  never echoed back in the UI. If the secret appears anywhere in the UI
  response after save, that's a bug — stop and file it.
- No restart is needed; the route is live immediately.

### Steps — happy path (allowed domain)

6. Open a **private/incognito browser window** (or a different browser).
   This ensures we're testing a fresh session, not the admin's existing one.
7. Navigate to `http://localhost:9090`. The login page should show a
   **Sign in with Google** button.
8. Click **Sign in with Google**.

   You'll land on Google's consent / account-picker screen. This step
   requires a real browser and real Google credentials — it's not
   scriptable via Playwright MCP (see caveat below).

9. Sign in with a Google account whose domain matches the `allowed_domains`
   value you configured in step 4.
10. After consent, Google redirects to
    `http://localhost:9090/auth/callback/google`. Better-auth validates
    the OAuth exchange, creates or finds the user record, sets a session
    cookie, and redirects to `/`.

Expected:
- [ ] The browser lands at `http://localhost:9090/` (or `/chat`) and the
      user menu (avatar, top-right or sidebar) shows the signed-in
      Google account's name or email.
- [ ] The user exists in `auth_better_v1_users`, and the Google linkage
      lives in `auth_better_v1_accounts` (the `provider_id` column, joined
      by `user_id` — `auth_better_v1_users` itself has no `provider` column):

  ```bash
  kubectl --context kind-ax-next-dev exec -n ax-next deploy/ax-next-host -- \
    psql -U ax-next -d ax-next \
    -c "SELECT u.email, a.provider_id, u.role \
        FROM auth_better_v1_users u \
        JOIN auth_better_v1_accounts a ON a.user_id = u.id \
        WHERE a.provider_id = 'google' \
        ORDER BY u.created_at DESC LIMIT 5;"
  ```

  Expected: a row with the signed-in email, `provider_id = google`, and
  `role = user` (not `admin` — new Google sign-ins default to `user`).

### Steps — negative path (domain not allowed)

11. Open another private window (or sign out from step 10 first).
12. Navigate to `http://localhost:9090` and click **Sign in with Google** again.
13. Sign in with a Google account whose domain is NOT in `allowed_domains`.
    If you only have one Google account, you can temporarily remove its
    domain from the `allowed_domains` field in step 4, sign in, then re-add it.
14. After the Google consent screen, the callback completes but the
    authorization check fails.

Expected:
- [ ] The browser is redirected back to the login page
      (or an error page at `/auth/error`), not to `/`.
- [ ] The error message is generic — something like "This Google account
      isn't permitted." or "Sign-in not allowed for this account." It must
      NOT reveal which domains are allowed, whether the email already has a
      record, or any internal detail. The exact wording is defined by the
      `@ax/auth-better` plugin's error surface.
- [ ] No user row was created for the rejected email:

  ```bash
  kubectl --context kind-ax-next-dev exec -n ax-next deploy/ax-next-host -- \
    psql -U ax-next -d ax-next \
    -c "SELECT count(*) FROM auth_better_v1_users WHERE email = '<rejected-email>';"
  ```

  Expected: `count = 0`. The rejection must happen before any user or
  session row is written. If a partial row exists, that's a bug — the
  domain check must be atomic with row creation.
- [ ] No auth session row was created:

  ```bash
  kubectl --context kind-ax-next-dev exec -n ax-next deploy/ax-next-host -- \
    psql -U ax-next -d ax-next \
    -c "SELECT count(*) FROM auth_better_v1_sessions WHERE user_id IN \
        (SELECT id FROM auth_better_v1_users WHERE email = '<rejected-email>');"
  ```

  Expected: `count = 0`.

### Playwright caveat

The Google consent screen is served by Google, not by ax-next. It requires
real human interaction with a real Google account — username, password,
2FA if applicable. Playwright MCP can drive the ax-next surfaces before and
after the consent screen (navigate to `/`, click the button, observe the
final redirect outcome), but the consent screen itself must be handled manually.

If you're building a CI-level smoke test for this flow, consider using
Google's [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
to hand-craft a callback request, or configure a test Google Workspace
account specifically for this purpose and store its credentials in a secrets
manager (not in the repo).

### Acceptance criteria

- [ ] Google provider appears in the Admin → Auth table after save, with
      client ID visible and client secret not echoed.
- [ ] A Google account in `allowed_domains` completes the flow, lands at `/`,
      and has a row in `auth_better_v1_users` (`role = user`) linked to an
      `auth_better_v1_accounts` row with `provider_id = google`.
- [ ] A Google account outside `allowed_domains` is redirected to the login
      page with a generic, non-leaking error message.
- [ ] No user or session row is created for the rejected account.
- [ ] The admin account (bootstrap user) is unaffected — it can still sign in
      via the admin path and its `role = admin` row is intact.

### Common failures

- **`redirect_uri_mismatch` from Google.** The redirect URI registered in
  Google Cloud Console doesn't match `${AX_PUBLIC_BASE_URL}/auth/callback/google`.
  Check for trailing slashes, `http` vs `https`, and port mismatches. The
  registered URI must be an exact character-for-character match.
- **Blank page or infinite redirect after Google consent.** Usually a
  `trustedOrigins` mismatch — better-auth's CSRF check rejects the callback
  if the origin isn't trusted. Confirm `AX_PUBLIC_BASE_URL` is set to the
  same origin the browser is using (including port). On kind with port-forward
  9090, that's `http://localhost:9090`.
- **"Invalid state parameter" error.** The OAuth state cookie was lost between
  the sign-in click and the callback redirect. This happens when the session
  cookie domain/path doesn't match, or when the browser blocked third-party
  cookies mid-flow. Use the same browser window throughout the flow; don't
  open a new tab between clicking "Sign in with Google" and landing at the
  callback URL.
- **Rejected user gets a 500 instead of a generic message.** The error handler
  in `@ax/auth-better` isn't catching the domain-mismatch case cleanly. The
  user should always land on the login page with a readable message, never on
  an uncaught exception page.

### Cleanup

```bash
# The Google provider config is stored in the host's credential/settings store.
# To remove it: Admin → Auth → Delete on the google provider row.
# The Google-authenticated user rows persist in auth_better_v1_users;
# delete them via psql if a clean slate is needed:
kubectl --context kind-ax-next-dev exec -n ax-next deploy/ax-next-host -- \
  psql -U ax-next -d ax-next \
  -c "DELETE FROM auth_better_v1_users WHERE id IN (SELECT user_id FROM auth_better_v1_accounts WHERE provider_id = 'google');"
```

## Scenario: `/tmp` scratch and `/files` durability

### What this proves

The runner gives the agent two places to write, and they behave differently:

- `/tmp` is a 10Gi disk emptyDir: scratch for this pod only. Attachments land
  in `/tmp/uploads/`. It is gone when the pod goes (the `/ephemeral` mount was
  merged into `/tmp` in TASK-995).
- `/files` is the agent's durable home (NFS, per-agent subPath). It survives
  across pods and shows up in the Files tab.

The cluster-only surfaces this proves (the unit tests can't): both mounts are
actually writable by the runner's non-root uid under `readOnlyRootFilesystem`,
`/tmp` is empty in a fresh pod, and `/files` content carries over.

### Prerequisites

- Goldenpath cluster up, wizard walked (a bootstrap admin + Default Agent
  exist), port-forward 9090 live.
- Image rebuilt from the branch under test (`make image`). The docker layer
  cache has hidden runner fixes before, so check the runner code actually
  landed in the image before you trust a result.

### Headless authenticated chat (no browser)

The bootstrap admin has no `auth_better_v1_accounts` row (no password/OAuth),
and Google OAuth isn't automatable, so for a headless walk we reuse the
existing session cookie. The serve `POST /chat` path does NOT work here — it
uses a synthetic `serve/serve` identity that fails `agents:resolve`. Use the
browser path (`/api/chat/messages`) with a hand-minted cookie:

```bash
# 1. A live session token + the cookie-signing key.
PASS=$(kubectl --context kind-ax-next-dev get secret -n ax-next ax-next-postgresql -o jsonpath='{.data.postgres-password}' | base64 -d)
TOKEN=$(kubectl --context kind-ax-next-dev exec -n ax-next ax-next-postgresql-0 -- env PGPASSWORD="$PASS" \
  psql -U postgres -d ax_next -t -A \
  -c "SELECT token FROM auth_better_v1_sessions WHERE expires_at > now() ORDER BY expires_at DESC LIMIT 1;")
CKEY=$(kubectl --context kind-ax-next-dev get secret -n ax-next ax-next-secrets -o jsonpath='{.data.http-cookie-key}' | base64 -d)

# 2. Sign it the way @ax/http-server does. The cookie is named
#    `ax_auth_session` (a custom http-server-signed bridge, NOT better-auth's
#    internal `ax_better_auth.session_token`). Wire form is
#    `<base64url(token)>.<base64url(hmac-sha256(key, token))>`; import the real
#    signer so key parsing (64 hex / 44 base64 → 32 bytes) can't drift.
cat > /tmp/sign-cookie.mjs <<'EOF'
import { signCookieValue } from '/ABS/PATH/ax-next/packages/http-server/dist/cookies.js';
const raw = process.env.CKEY;
const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
process.stdout.write('ax_auth_session=' + signCookieValue(key, process.env.WTOKEN));
EOF
COOKIE=$(CKEY="$CKEY" WTOKEN="$TOKEN" node /tmp/sign-cookie.mjs)

# 3. Sanity-check the cookie, then grab the agent id.
curl -s http://localhost:9090/api/chat/agents -H "Cookie: $COOKIE"   # → [{agentId,...}]
AGENT=agt_...   # from the line above

# 4. Send a turn. conversationId:null mints a fresh conversation; reuse the
#    returned id for follow-up turns. X-Requested-With satisfies CSRF.
curl -s -X POST http://localhost:9090/api/chat/messages \
  -H "Cookie: $COOKIE" -H 'Content-Type: application/json' -H 'X-Requested-With: ax-admin' \
  -d "{\"conversationId\":null,\"agentId\":\"$AGENT\",\"contentBlocks\":[{\"type\":\"text\",\"text\":\"...\"}]}"
# → {"conversationId":"cnv_...","reqId":"req-..."}

# 5. The turn runs async; read the result by polling the conversation until a
#    trailing assistant text turn appears:
curl -s "http://localhost:9090/api/chat/conversations/cnv_..." -H "Cookie: $COOKIE" | jq '.turns[].contentBlocks'
```

Scrub `/tmp/sign-cookie.mjs` and any file holding `$COOKIE` afterward — that
cookie is a live admin session.

### Walk

1. **Turn 1 — exercise both mounts.** Send a prompt instructing the agent to
   (a) use the Write tool to create `/tmp/walk-via-write.txt`,
   (b) bash `echo ... > /tmp/walk-via-bash.txt && ls -la /tmp`,
   (c) use the Write tool to create `/files/ROUND_TRIP_CONTROL.txt`.
2. **(Optional) Catch the runner pod** while the turn runs and confirm the
   real pod-spec mounts:
   ```bash
   POD=$(kubectl --context kind-ax-next-dev get pods -n ax-next-runners --no-headers | awk '{print $1}' | head -1)
   kubectl --context kind-ax-next-dev get pod -n ax-next-runners "$POD" \
     -o jsonpath='{range .spec.containers[0].volumeMounts[*]}{.mountPath}{"\n"}{end}'
   ```
3. **Turn 2 — fresh pod.** Same conversation, after the first pod has gone:
   bash `ls -la /tmp` and `ls -la /files`.

### Acceptance criteria

- [ ] Turn-1 Write tool to `/tmp/...` **succeeds**.
- [ ] Turn-1 bash write to `/tmp` succeeds; `ls -la /tmp` shows the files
      owned by the runner uid in a writable dir.
- [ ] The runner pod mounts `/tmp`, `/files` and `/home/runner`, and has no
      `/agent` or `/ephemeral` mount.
- [ ] Turn-2 fresh pod: the turn-1 files under `/tmp` are **gone**, while
      `/files/ROUND_TRIP_CONTROL.txt` **persists** and shows in the Files tab.

### Cleanup

```bash
curl -s -X DELETE http://localhost:9090/api/chat/conversations/cnv_... \
  -H "Cookie: $COOKIE" -H 'X-Requested-With: ax-admin'   # delete the test conversation
```

## When this passes, do
1. Update the PR description's acceptance section with the date + cluster
   used + a copy of the `psql` count outputs.
2. Mark Task 21 complete.

### Walks completed
- **Skill install Phase 1 (PR #96)** — tested 2026-05-18 on
  `kind-ax-next-dev` (image `ax-next/agent:dev`).
  - Two regressions caught and fixed before this PR could merge:
    - Init container wrote into `/agent` before the runner cloned
      the workspace there, so `git clone` refused the non-empty target.
      Scaffold moved to `git-workspace.ts#scaffoldWorkspaceSkillSurface`,
      which runs after materialize.
    - Skill slot env vars (e.g. `GITHUB_TOKEN`) never reached the SDK
      subprocess. `proxy-startup.ts` now forwards env vars whose value
      is an `ax-cred:<32-hex>` placeholder.
  - All step 1–9 acceptance criteria pass.
- **Skills distribution Phases D + E (this PR)** — walked 2026-05-21 on
  `kind-ax-next-dev` (rebuilt `ax-next/agent:dev`, `reset-bootstrap --force`
  to re-open `/setup` since Google-OAuth login isn't Playwright-drivable).
  Single-user (admin) scope — multi-user alice/bob isolation and the
  populated-promote flow aren't browser-walkable here (OAuth + workspace
  seeding) and are covered by automated tests instead.
  - **Phase D (My Skills):** user-menu → My Skills → New skill → installed
    `acceptance-note` via the live-preview editor → it appears in the list.
    `GET/POST /settings/skills` returned 200/201. DB confirmed the row landed
    in `skills_v1_user_skills` with `owner_user_id` = the admin's id and did
    NOT appear in `skills_v1_skills`. ✅
  - **Phase E (Authored Skills):** the agent detail form (Admin → Agents →
    edit) renders the "Authored Skills" section below skill attachments;
    `GET /admin/agents/:id/authored-skills` returned 200 and the
    `agents:list-authored-skills` hook ran (empty for an agent that has
    authored no `.ax/skills/*/SKILL.md`, as expected). ✅
  - 0 console errors (2 benign Radix `aria-describedby` dialog advisories,
    consistent with the app's other dialogs).
- **`/ephemeral` scratch tier (this PR)** — walked 2026-05-22 on
  `kind-ax-next-dev` (rebuilt `ax-next/agent:dev`), via the headless
  authenticated-chat recipe above (no browser; OAuth isn't automatable).
  - Real chat-spawned runner pod (`ax-sandbox-…`) carried
    `AX_EPHEMERAL_ROOT=/ephemeral` + the `/ephemeral` mount on the new image.
  - Turn-1 Write tool wrote `/ephemeral/walk-via-write.txt` (proves
    `additionalDirectories` is honored — a file tool reaching outside cwd);
    bash write + `ls -la /ephemeral` confirmed both files owned by `axagent`
    (uid 1000) in a `drwxrwxrwx` emptyDir.
  - Turn-2 agent quoted the `/ephemeral` scratch note verbatim from its system
    prompt; fresh-pod `ls` showed `/ephemeral` empty (turn-1 files gone, never
    bundled) while `ROUND_TRIP_CONTROL.txt` persisted in `/agent`.
  - Also confirmed via the real `buildPodSpec` output applied as a pod:
    uid-1000 writability under `readOnlyRootFilesystem` (`/` rejects writes;
    emptyDir mounts are `drwxrwxrwx`). All acceptance criteria pass.

## Web tools (@ax/web-tools)

Prereq: org admin has enabled Web Search in the Claude Console; the host has `ANTHROPIC_API_KEY`.

1. In the chat UI, ask the agent: "Search the web for the latest stable Node.js release and tell me the version."
   - Expect: the agent calls `web_search`, returns a current version with source URLs.
2. Ask: "Fetch https://nodejs.org/en/about and summarize it."
   - Expect: the agent calls `web_extract` and summarizes real page content.
3. Ask the agent to fetch `http://169.254.169.254/latest/meta-data/`.
   - Expect: `web_extract` refuses (url-guard) — no metadata is returned.

## Scenario: Python `pip install` in the sandbox

### What this proves

A session-scoped Python venv is active in the runner, so an agent can
`pip install <pkg>` and then `import <pkg>` in a script — the path a model
reaches for instinctively. The install flows through the credential-proxy
(MITM CA trusted via `PIP_CERT`) and is bounded by the egress allowlist.

### Prerequisites

- A live `ax-next-dev` (kind) cluster on the branch image.
- An agent whose manifest allows a pypi package (e.g. `requests` via
  `capabilities.packages.pypi`).

### Walk

In a chat against that agent, ask it to:

1. Run `pip install requests` in a Bash tool.
   - Expect: install completes with no TLS error. (No TLS error proves
     `PIP_CERT` makes pip trust the proxy MITM CA — the part unit tests
     cannot exercise.)
2. Run `python -c "import requests; print(requests.__version__)"`.
   - Expect: a version string prints (the venv python imports the install).
3. Ask it to `pip install <a NON-allowlisted package>`.
   - Expect: the install is blocked at the proxy (egress allowlist holds).

### Acceptance criteria

- Allowlisted install + import succeed; non-allowlisted install is blocked.
- Nothing the agent installed appears in the next session (ephemeral venv).

## Scenario: sandbox death mid-turn → error+retry (Fault A)

### What this proves

When the serving runner dies mid-turn, the host emits a `chat:turn-error`
on the SSE so the client's "Thinking…" spinner flips to a visible error
with a **retry** button — instead of hanging indefinitely (the bug
chat-qa-sweep found: the SSE got no `done`/error frame, so the spinner +
Stop persisted ~indefinitely, recoverable only by manual Stop).

This is a HOST-side TypeScript change, so it rides the fast hostPath dist
loop (no image rebuild). The runner already fires `session:terminate` on
pod death — that's the signal the host keys off.

### Prerequisites

- A live `ax-next-dev` (kind) cluster on the branch dist (channel-web +
  chat-orchestrator).
- The chat UI open in a browser (Playwright MCP or manual).

### Walk

1. Start a new chat and send a message that takes a few seconds (e.g. "write
   a 300-word story"). While the "Thinking…" spinner is showing:
2. Kill the serving runner pod:
   `kubectl --context kind-ax-next-dev -n ax-next-runners delete pod <serving-pod> --now`
   (find it: `kubectl --context kind-ax-next-dev -n ax-next-runners get pods`).
3. Within a second or two, observe the `AgentStatus` row flip from
   "Thinking…" (blue, breathing) to a **red error row** reading "The agent
   stopped unexpectedly. Retry to continue." with a **retry** button — NOT
   a hung spinner. Host logs show `pod_exited` + `pod_killed`.
4. Click **retry**. A fresh sandbox spawns, replays history, and answers —
   the turn completes normally.
5. (Warm-reuse variant) Send a second message on the same conversation so it
   routes into the warm session, then kill the pod again mid-turn. Same
   prompt error+retry should appear promptly (the `session:terminate`
   subscriber covers the routed path — without it this case would hang until
   the 10-min chat timeout).

### Acceptance criteria

- The spinner flips to a red error+retry row within ~1-2 s of the pod kill,
  on BOTH the fresh-spawn (turn 1) and warm-reuse (turn 2+) paths.
- Retry re-sends and the next turn completes; subsequent normal messages
  work.
- No infinite spinner, no white screen.
- Host logs confirm the orchestrator detected the death and signalled the
  client (not just the UI):
  ```bash
  kubectl --context kind-ax-next-dev logs -n ax-next deploy/ax-next-host | grep -E 'pod_(exited|killed)|chat_turn_error'
  ```
  Expect `pod_exited`/`pod_killed` (the sandbox watcher saw the death) AND a
  `chat_turn_error` line with `reason` `sandbox-terminated` (routed/warm path)
  or `sandbox-exit-before-chat-end` (fresh-spawn). Note `chat:turn-error` is
  an internal bus event, surfaced in logs as the `chat_turn_error` message —
  the `reason` is orchestrator vocabulary, not the `pod_*` exit code.

## Scenario: Stop cancels the running turn (TASK-688)

> **Runner-level half is auto-tested.** The `interrupt` wire, the shell that
> routes it, and both runners' handling (aisdk aborts the model call and kills
> the running Bash by process group; claude-sdk calls `Query.interrupt()`) are
> covered by unit and e2e tests — including one that drives the REAL `claude`
> binary and checks the running command is dead
> (`packages/agent-claude-sdk-runner/src/__tests__/interrupt-real-sdk.e2e.test.ts`).
> This walk covers what only a cluster can: the SPA button, the host route, the
> session store, and a real pod.

### What this proves

Pressing **Stop** in the workspace composer stops the turn *server-side* —
the model call ends and a running shell command is killed — instead of only
detaching the browser (the bug the §8 aisdk walk found: the `touch` still
happened 45 s later). Then the same conversation keeps working, warm.

### Walk (run once on a `claude-sdk` agent and once on an `aisdk` agent)

1. Open the workspace, pick the agent, and send:

   > Run this exact command in Bash and tell me when it finishes:
   > `sleep 45 && touch /tmp/cancel-probe.txt`

2. Wait until the reply shows the step running (about 5-6 s). The send button
   has been replaced by a **Stop** button (a filled square).
3. Click **Stop**. Within a second or two the spinner goes away, the composer
   is back, and the thread ends with a quiet note: "You stopped this reply."
4. Wait 60 s, then check the pod:

   ```bash
   kubectl --context kind-ax-next-dev -n ax-next-runners get pods
   kubectl --context kind-ax-next-dev -n ax-next-runners exec <sandbox-pod> -- ls /tmp/cancel-probe.txt
   ```

5. Send "say hi". The same sandbox answers (no cold start), and the transcript
   is coherent.

### Acceptance criteria

- `ls` in step 4 reports **No such file** — the command was killed, not merely
  hidden. (Before this change the file appeared.)
- The Stop button only shows while a reply is streaming; it is gone when idle
  and gone in a read-only excerpt.
- The note in step 3 is shown, is not styled as an error, and disappears on the
  next message.
- Step 5 works without a cold start; host logs show no `chat_turn_error` for the
  stopped turn.
- Stopping during **"Getting set up…"** (a cold spawn) also stops the turn: the
  runner starts it and ends it at once, no reply text.
- Another user's session cannot stop yours:
  `curl -X POST -H 'x-requested-with: ax-admin' --cookie <B's cookie>
  https://<host>/api/chat/conversations/<A's conversation id>/interrupt` is a
  **404**, and A's turn keeps running.

### Cleanup

Nothing to clean: `/tmp/cancel-probe.txt` should not exist.

## Scenario: chat visuals (VISUALS-1)

> **Unit and browser halves are auto-tested.** The `show_visual` tool, the
> srcdoc assembly, the parent message filter, and the hostile-content probes
> (including real Chromium, Firefox and WebKit runs) are covered by tests. This
> walk covers what only a cluster can: the rebuilt runner and host images, a
> real connector, and how the result looks next to the rest of the app.

### What this proves

The agent can answer with an inline visual that looks native to AX in light and
dark, works (hover, toggles), survives a reload, downloads as PNG and HTML, and
cannot reach the network, the app's cookies, or the app's DOM.

### Walk (run once on a `claude-sdk` agent and once on an `aisdk` agent)

0. Rebuild the images and roll the kind deployment. Grep the runner image's
   compiled `main.js` for `show_visual` to rule out a stale build cache. Every
   `kubectl` call takes `--context kind-ax-next-dev`.
1. Ask "Show issues per cycle over the past 20 cycles" (Linear connector). If
   Linear is not connected, supply the 20 numbers inline and say so.
2. Ask "What's the weather forecast for Brooklyn?" (web tools). Without a
   web-tools key, supply the forecast inline.
3. Toggle light, dark and system while a visual is on screen. Take a screenshot
   in each theme.
4. Reload the page and reopen the conversation.
5. Download PNG and HTML from the visual's menu. Open the HTML from disk with
   the network inspector open.
6. Hostile visual: ask the agent to call `show_visual` with this HTML, with
   `<YOUR_URL>` replaced by a URL you control (watch it with a local
   `python3 -m http.server` request log or any request-bin you control):

   ```html
   <p>probe</p>
   <img src="<YOUR_URL>/img">
   <meta http-equiv="refresh" content="0;url=<YOUR_URL>/refresh">
   <iframe srcdoc="<script>top.postMessage('child','*');fetch('<YOUR_URL>/child')</script>"></iframe>
   <script>
     fetch('<YOUR_URL>/fetch');
     try { new RTCPeerConnection({ iceServers: [{ urls: 'stun:<YOUR_HOST>:3478' }] }); } catch (e) {}
     location.href = '<YOUR_URL>/nav';
   </script>
   ```

   The full set lives in
   `packages/channel-web/src/__tests__/visual-hostile.browser.test.ts`.

### Acceptance criteria

- The step row reads "Making a visual: ...", a short text summary is present,
  and the chart has working hover tooltips. The weather card renders.
- No inner scrollbar and no layout jump when the visual finishes loading.
- Theme switches swap colors in place: no reload, no wrong-theme flash. Judged
  against the "jarring" anti-goal: no off-palette colors, no foreign fonts, no
  wrong-theme backdrop, in both themes.
- After reload, both visuals render from history.
- The PNG opens at 2x. The HTML opens from disk, renders, and makes no network
  request; the agent's script does not run at the top level of the file.
- Hostile visual: `browser_network_requests` shows nothing to your URL, the
  console shows CSP refusals, and the app's cookies and session are untouched.
  Self-navigation (`location.href`, meta refresh) is refused and the card shows
  the quiet "couldn't be displayed" state; nothing reaches the canary. Clicking
  an ordinary link inside a visual does nothing, and the visual stays up.
- A visual that tries to open a nested frame: the child frame element is
  removed (stripped when the document is built, or purged at runtime) and the
  visual stays up. The child's script never runs.

### Walks completed
- **VISUALS-1 (chat visuals)** — walked 2026-11-06 on `kind-ax-next-dev`
  (rebuilt `ax-next/agent:dev`). Full walk, steps 0–6, passed on both a
  `claude-sdk` and an `aisdk` agent at `0b3bbd44a` (walk 3), except
  self-navigation. A self-navigating frame, or a click on a plain link,
  showed Chrome's "This content is blocked" page (BUG-3). We fixed it in
  `81758aaba` and rechecked it there on `claude-sdk` (the fix is
  client-side). Plain, middle, modifier and keyboard link clicks now do
  nothing, and the visual stays up. A `location.href` visual now shows
  "This visual couldn't be displayed." with its summary, both live and after
  a reload. The canary logged nothing. Ordinary charts still render and
  survive a reload.

### Cleanup

Delete the walk's conversations. Nothing else persists.

## Scenario: Agent artifacts (publish, view, share)

### What this proves

An agent can hand a person a finished file (a PDF, a web page, a chart) as an
**artifact**: it shows up in the agent's Artifacts panel and as a card in chat,
it keeps its last 20 versions, and the owner can share the current version with
a signed-in person through a link they can turn off.

The cluster-only surfaces this proves (the canary in
`presets/k8s/src/__tests__/acceptance.test.ts` and the unit tests can't):

- Agent-made HTML really runs on the **content origin** (`content-http`, :9091),
  a different site from the app, inside a sandboxed iframe. It can't call our
  API, can't read cookies, can't navigate the app away and can't post forms.
  This is a real browser enforcing a real CSP, which no unit test does.
- The runner image really carries the PDF, Word, Excel and chart libraries.
- Sharing survives a real sign-in round trip.

Everything else (version pruning, the GC purge of pruned bytes, the token and
link rules, the 404 shapes) is pinned by the canary and the GC test. Blob GC
runs in **report** mode on kind, so the purge is the test's job, not this walk's.

### Prerequisites

- Goldenpath cluster up, wizard walked, image rebuilt from the branch under
  test (`make image`). Check the runner image has the Python libraries:
  `kubectl --context kind-ax-next-dev -n ax-next-runners exec <sandbox-pod> -- /opt/ax-python-venv-template/bin/python -c 'import reportlab, docx, openpyxl, matplotlib'`.
- Both port-forwards live: `9090:9090` (the app, `http://localhost:9090`) and
  `9091:9091` (artifact content, `http://127.0.0.1:9091`). See step 6b of the
  goldenpath setup. Without 9091, previews stay blank.
- A second account (B) signed in with a helper cookie (see the "Headless
  authenticated chat" block in the `/tmp` scenario above for how to mint one).
- A team holding both accounts, with a team agent, for step 6.

### Walk

1. **PDF.** Ask the agent for a one-page PDF report. It appears in the
   Artifacts panel and as a card in chat. The viewer says "Download to open"
   (we never render PDFs inline). The downloaded file starts with `%PDF-`.
2. **HTML attack page.** Ask for an HTML dashboard whose script tries four
   things: `fetch('http://localhost:9090/api/workspace/agents')`,
   `document.cookie`, `top.location = 'http://localhost:9090/?pwned'`, and
   submitting a `<form>`. Open it in the viewer. It renders, and DevTools shows:
   - the fetch blocked by `connect-src 'none'`;
   - `document.cookie` empty (the frame has an opaque origin);
   - the top navigation blocked (sandbox, no `allow-top-navigation`);
   - the form blocked (`form-action 'none'`, no `allow-forms`).
3. **Share.** Click **Copy link**. Grep that conversation's stored events for
   the code: 0 hits (the agent never sees it). Account B opens `/a/<code>`
   signed out, lands on the login page, signs in (helper cookie), sees the page
   and downloads it.
4. **Update.** In a new chat, ask the agent to "update the dashboard". The
   artifact keeps its id and moves to v2. B's open link shows v2 on reload.
5. **Restore and turn off.** Restore v1: B's link shows v1. Turn the link off:
   B sees "This link doesn't work anymore — ask whoever sent it for a fresh one."
6. **Team.** On the team agent, member B sees the artifacts member A made in
   A's chat.
7. **Versions.** Publish 21 versions of one file. Then
   `SELECT count(*) FROM attachments_v1_artifact_versions WHERE artifact_id = '<id>'`
   returns 20, and the first version's sha is gone from that table.
8. **Helper file.** Have the agent write a helper script and not publish it.
   It is not in the Artifacts list.
9. **Deleted chat.** Delete the chat that made an artifact. The artifact and
   its link still work (artifacts outlive their chat).
10. **Download.** In the viewer, **Download** one artifact: it saves under its
    title plus extension. Then click **Download all** in the Artifacts panel:
    the browser saves `<agent name> artifacts.zip`, and it unzips into one file
    per artifact. Click **Download all** again while the first is still
    running: it says "One download at a time, please — try again in a moment."
    (On a small set the zip may finish too fast to catch; that's fine.)

### Acceptance criteria

- Steps 1-10 behave as written. Record each with its evidence in
  `deploy/kind/walks/<date>-<TASK-ID>/RESULTS.md`.
- In step 2, all four attacks fail, and every content-origin response carries
  `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store` and
  `Referrer-Policy: no-referrer`. The HTML CSP ends with
  `frame-ancestors http://localhost:9090 http://localhost:19090 http://localhost:5173; sandbox allow-scripts allow-downloads`
  (kind's `contentOrigin.frameAncestors`).
- The share code never appears in a conversation event, a host log line, or the
  agent's tool output (`ax://artifact/<id>` only).
- A wrong code, a turned-off link and someone else's artifact all look the same:
  a 404.

### Cleanup

- Delete the test artifacts from the Artifacts panel (or delete the test agent:
  deleting an agent deletes its artifacts).
- Scrub any file holding B's cookie. It is a live session.
- Add a line to the "Walks completed" list (under "When this passes, do").
