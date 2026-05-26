# Workspace redesign — Phase 1 implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Replace the storage tier with a sharded, container-shipped, native-git-binary backend (`@ax/workspace-git-server`) that speaks standard git smart-HTTP plus a tiny REST surface for repo lifecycle, while `@ax/workspace-git-http` keeps shipping in parallel for canary A/B + rollback.

**Architecture:**

- A new package `@ax/workspace-git-server` with three subtrees: `src/server/` (HTTP + git-spawn server, container entrypoint), `src/client/` (host-side library that maps `workspace:*` ops to git protocol; not registered as a plugin in this PR), and `src/__tests__/` (unit + integration; reuses `runWorkspaceContract` via a per-test plugin factory).
- A new container image with the `git` binary pinned via the base image. The HTTP server invokes `git upload-pack` / `git receive-pack` via `child_process.spawn` (argv-array form, never shell), mirroring v1's operational shape. Bearer auth + workspace-id validation gate every route.
- Helm chart switches the `gitServer` resource from `Deployment` (`replicas: 1` hardcoded) to a `StatefulSet` with `replicas: <gitServer.shards>`, a headless `Service` for stable per-shard DNS, per-replica PVC via `volumeClaimTemplates`, and a `preStop`/`terminationGracePeriodSeconds` pair tuned for in-flight push drain. NetworkPolicy stays ingress-host-only / egress-empty.
- Deployment is gated by `gitServer.experimental.gitProtocol: false` (default off). Existing `workspace.backend: local | http` paths stay the production default. Operators flip the toggle for canary, flip it back for rollback.

**Tech stack:** TypeScript (Node 20+), `child_process.spawn` (argv-array only), Node `http`, `crypto.timingSafeEqual`, Zod (already present), Vitest, Helm. No new runtime deps if avoidable — re-use `zod` and Node built-ins. The `git` binary itself is pinned via the base image (debian-slim recommended).

---

## Open questions (need user decision before code)

The design doc lists 7. Phase 1 most directly intersects with three; my recommended answers:

1. **HA per shard (Q#1).** Single-replica per shard is acceptable for MVP. PVC is `ReadWriteOnce`, so even adding `replicas > 1` per shard would require a new architecture (consensus-backed bare repo). Document as known limit; surface in `SECURITY.md` and chart values comment. Recovery time on pod restart is "seconds" (same property today's single-replica `gitServer` has). **Recommend: defer HA to a separate design.**
2. **Re-sharding (Q#2).** Operator picks `gitServer.shards` at install time; changing it requires manual workspace migration (drain → rsync bare repos to new shard layout → flip traffic). Document as "operational follow-up, not architectural." **Recommend: Phase 1 ships with shards: 1 default; multi-shard works but no automated rebalancing.**
3. **First-time materialize (Q#7).** Two choices:
   - (a) `POST /repos` creates a fully empty bare repo (no initial commit). Host's first clone fails because there's no `refs/heads/main`; host treats "no remote ref yet" as the empty-baseline case and starts from an empty workspace. The first `git push` from the host creates `refs/heads/main` atomically.
   - (b) `POST /repos` synthesizes an empty initial commit (v1's approach via the temp-clone-and-push dance in `http-server.js:245-273`). Repo always has `main` immediately.

   **Recommend (a).** It's the cleanest contract — `POST /repos` is purely repo-creation, no implicit history. The host's clone-or-empty case is a 5-line check (`git ls-remote` → if no `main`, skip clone). Avoids the v1 hack of running git commands in a tempdir to bootstrap. Empty-repo case is exercised by an integration test.

**Other open questions to confirm:**

4. **Container shape — same image as host/runner, or separate image?** The current chart (`values.yaml:108`) reuses the host image: `command: ["node", "/opt/ax-next/git-server/index.js"]`. That works only because workspace-git-http's server is pure-Node (no git binary needed). Phase 1 needs the `git` binary in the image. **Recommend: split into a dedicated image `ax-next/git-server` with its own Dockerfile**, mirroring v1's `container/git-server/Dockerfile` shape. Host/runner stays slim (no need to ship git there).
5. **Hashing primitive for shard routing.** v1 used MD5; the design example shows CRC32. **Recommend: SHA-256 first 4 bytes mod N** — already available in Node's `crypto`, no new dep, sufficient distribution at our scale, no hash-attack surface (workspace IDs are first-party).
6. **WorkspaceId regex.** The v1 server allows `[a-zA-Z0-9_.-]+` with no length cap. **Recommend tighter: `^[a-z0-9][a-z0-9_-]{0,62}$`** — lowercase only (filesystem-safe on case-insensitive volumes), no dots (avoid `..` traversal entirely), max 63 chars (DNS label cap, gives us room to use them as DNS components later).

If any of these recommendations are wrong, flag before coding starts.

---

## Cross-phase dependency surfaced

The design's phasing says Phase 1 = "replace storage tier, keep host's iso-git client for now." But:

- The current host plugin `@ax/workspace-git-http` speaks **JSON-over-HTTP** to the storage tier (`workspace.apply` request body is `{ changes: WireFileChange[], parent, reason }`).
- The new storage tier speaks **standard git smart-HTTP** (`POST /<id>.git/git-receive-pack` with packfile bytes).
- They are not wire-compatible. A workspace served by `@ax/workspace-git-http` cannot suddenly point at `@ax/workspace-git-server` as a drop-in.

Three resolution options:

- **Option A (split):** Phase 1 ships server-only with no real consumer in-PR. Violates I3 (half-wired plugin / window-open feedback memory).
- **Option B (combine 1+2):** Replace storage tier and host plugin in one PR. Bigger but no half-wired window. Loses the "ship in parallel for canary" property.
- **Option D (chosen — see below):** Phase 1 ships the server **plus** a test-only host adapter that satisfies `runWorkspaceContract`. The new server is exercised end-to-end by tests. Chart toggle defaults OFF; production keeps using `@ax/workspace-git-http`. **No registered plugin** wires up to the new server in this PR — that's Phase 2's job. The half-wired-window discipline is satisfied by:
  - Integration tests boot the server, exercise create → push → fetch → delete + the full `runWorkspaceContract` suite (mirroring `workspace-git-http`'s contract test pattern).
  - Chart toggle is wired (`gitServer.experimental.gitProtocol: false`), so operators flipping it on get a working tier.
  - PR description's "Half-wired window" section explicitly states the window stays OPEN until Phase 2 closes it by replacing the registered host plugin.

**Recommend Option D.** Preserves the original phasing intent (storage-tier-first, ship-in-parallel) while keeping the consumer real (tests + operator-flippable toggle). Phase 2 closes the window.

---

## Package shape and naming

**New package:** `packages/workspace-git-server/`

```
packages/workspace-git-server/
├── package.json          # @ax/workspace-git-server, peerDeps @ax/core
├── SECURITY.md           # capability budget walked at scaffold (per patterns.md)
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts          # public exports (client only — server entry is its own bin)
    ├── shared/
    │   ├── workspace-id.ts       # validateWorkspaceId regex + constants
    │   └── shard.ts              # shardForWorkspace(id, n) — used by client + tests
    ├── server/
    │   ├── auth.ts               # ports workspace-git-http/server/auth.ts (bearer + timingSafeEqual)
    │   ├── repos.ts              # POST/DELETE/GET /repos handlers
    │   ├── smart-http.ts         # GET /info/refs + POST /git-{upload,receive}-pack
    │   ├── handlers.ts           # router that dispatches request → above
    │   ├── listener.ts           # http.createServer + start/stop + drain logic
    │   ├── main.ts               # CLI entry (env-driven, mirrors workspace-git-http/main.ts)
    │   └── __tests__/
    └── client/
        ├── shard-router.ts       # consistent-hash → shard URL
        ├── repo-lifecycle.ts     # POST/DELETE/GET /repos REST client
        ├── git-ops.ts            # spawn-based git fetch/push/clone-mirror against a shard
        ├── plugin-test-only.ts   # test-only Plugin factory for runWorkspaceContract (NOT exported)
        └── __tests__/
```

Naming notes:

- `@ax/workspace-git-core` (iso-git wrapper, current) keeps shipping unchanged. Phase 5 deletes it.
- `@ax/workspace-git-http` (current host plugin + JSON-over-HTTP server) keeps shipping unchanged. Phase 5 deletes both.
- The new package contains both server (container side) and a client library; the client library is **not registered as a plugin** in Phase 1. Phase 2 either grows it into a plugin or extracts a separate `@ax/workspace-git-server-client` plugin package.

**Container shape:** new `container/git-server/Dockerfile` (separate from the host image) with:

- Base `debian-slim:bookworm`. **Recommend debian-slim** for git CVE patch cadence — Alpine's `git` package lags upstream more often. Lock with explicit version in apt: `git=1:2.39.x-y`.
- Non-root user (UID 1000), `mkdir -p /var/lib/ax-next/repo`, ownership.
- Copy compiled `dist/server/main.js` + minimal node_modules (production-only zod) into `/opt/ax-next/git-server/`.
- `ENTRYPOINT ["node", "/opt/ax-next/git-server/main.js"]`. No shell wrapper — direct exec lets `SIGTERM` reach Node cleanly.
- `EXPOSE 7780`. `HEALTHCHECK` not needed (k8s probes handle it).

---

## Repo lifecycle REST surface

All endpoints require `Authorization: Bearer <AX_GIT_SERVER_TOKEN>` validated via `crypto.timingSafeEqual`. Same auth helper shape as `workspace-git-http/server/auth.ts`. Body limit 1 MiB (matching workspace-git-http). All bodies/responses are JSON unless explicitly noted.

### `POST /repos`

Create a bare repo for a workspace. Returns 409 if it already exists.

**Request:**
```ts
const CreateRepoRequestSchema = z.object({
  workspaceId: z.string(),  // validated against WORKSPACE_ID_REGEX — see argv-injection section
}).strict();
```

**Responses:**
- `201 Created`:
  ```json
  { "workspaceId": "abc-123", "createdAt": "2026-05-01T12:34:56Z" }
  ```
- `400 Bad Request` — invalid `workspaceId` (regex fail, missing field, body > 1 MiB)
- `401 Unauthorized` — bearer auth fail
- `409 Conflict` — repo already exists for this `workspaceId`
- `500 Internal Server Error` — git init failed (rare; disk full, etc.)

**Server-side behavior:**
- Validate `workspaceId` against regex BEFORE any filesystem touch.
- Resolve `path.join(repoRoot, `${workspaceId}.git`)`; assert `path.resolve()` of the result starts with `repoRoot + path.sep` (defense-in-depth).
- `spawn('git', ['init', '--bare', '--initial-branch=main', repoPath], { env: PARANOID_GIT_ENV })`.
- After init, write per-repo locked-down `config`:
  ```
  receive.denyDeletes=true
  receive.denyNonFastForwards=true
  core.hooksPath=/dev/null
  protocol.allow=never
  uploadpack.allowAnySHA1InWant=false
  ```
- Repo has no commits and no `refs/heads/main` yet — the first `git push` from a host creates `main` (open question Q#7 resolution (a)).
- On `git init` failure, attempt `rm -rf` of any partial dir (best-effort; mirrors v1 line `http-server.js:285-295`).

### `GET /repos/<workspaceId>`

Return repo metadata. Used by the host to decide whether to `git fetch` (existing) or skip-and-treat-as-empty.

**Responses:**
- `200 OK`:
  ```json
  { "workspaceId": "abc-123", "exists": true, "headOid": "deadbeef..." }
  ```
  `headOid` is `null` when the repo exists but has no `refs/heads/main` yet (first-time materialize case).
- `404 Not Found` — no repo for that `workspaceId`.
- `400 / 401` — same as POST.

**Server behavior:** validate id; check `fs.existsSync(repoPath)`; if exists, `spawn('git', ['-C', repoPath, 'rev-parse', '--quiet', '--verify', 'refs/heads/main'])`, capture stdout. Empty stdout → `headOid: null`.

### `DELETE /repos/<workspaceId>`

Remove a workspace's repo. Idempotent: 204 whether or not it existed.

**Responses:**
- `204 No Content` — deleted (or didn't exist).
- `400 / 401` — same as POST.

**Server behavior:** validate id, resolve path, defense-in-depth startsWith check, `fs.rm(repoPath, { recursive: true, force: true })`.

### Health probe — `GET /healthz`

Unauthenticated. Returns `200 {"status":"ok"}`. Mirrors workspace-git-http for liveness/readiness probe re-use.

### Error envelope

Mirrors the workspace-protocol error shape so client error handling is consistent:

```ts
const ErrorResponseSchema = z.object({
  error: z.string(),                  // short tag: "invalid_workspace_id" | "unauthorized" | etc.
  message: z.string(),                // human-readable, no token / path leak
}).strict();
```

Token NEVER appears in any error message — invariant carried over from workspace-git-http auth.ts.

---

## Git protocol surface

Standard git smart-HTTP, three routes, same auth.

### `GET /<workspaceId>.git/info/refs?service=git-upload-pack|git-receive-pack`

Discovery. Spawns:

`git -c protocol.allow=never -c safe.directory=<repo> {upload-pack|receive-pack} --stateless-rpc --advertise-refs <repo>`

Wraps the response in pkt-line format (`# service=git-{upload,receive}-pack\n` + flush packet) per RFC 5816, exactly like v1 `http-server.js:118-127`.

### `POST /<workspaceId>.git/git-upload-pack`

Fetch (host pulls from server). Spawns `git -c ... upload-pack --stateless-rpc <repo>`. Pipes request body → git stdin, git stdout → response. Sets `Content-Type: application/x-git-upload-pack-result`.

### `POST /<workspaceId>.git/git-receive-pack`

Push (host pushes to server). Same pattern as upload-pack. Bare repo's `receive.denyDeletes=true` + `receive.denyNonFastForwards=true` (set at create time) enforce linear-history server-side. **No `http.receivepack=true`** override at spawn time — pushing is allowed because the bare repo's config + auth gates it; the v1 `-c http.receivepack=true` flag is for git's *client-side* default of refusing pushes over HTTP, which doesn't apply here since we're invoking `receive-pack` directly, not behind `git http-backend`.

### Spawn policy (applies to all four `git ...` invocations above)

```ts
const PARANOID_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  PATH: '/usr/bin:/bin',           // explicit, no inheritance from caller
} as const;

function spawnGit(args: string[], opts: { stdio: ... }) {
  return spawn('git', args, {
    env: PARANOID_GIT_ENV,           // not { ...process.env, ... } — full replacement
    stdio: ...,
  });
}
```

**Argv0 is always the literal string `'git'`**, never caller-influenced. Subcommand args are constants from the route handler. The only caller-derived value in argv is the validated repo path.

---

## Argv-injection prevention

The single most important defense: validate `workspaceId` BEFORE it ever becomes a filesystem path or argv element.

```ts
// src/shared/workspace-id.ts
export const WORKSPACE_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function validateWorkspaceId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !WORKSPACE_ID_REGEX.test(id)) {
    throw new InvalidWorkspaceIdError(/* sanitized: don't echo input */);
  }
}
```

Layers:

1. **Route-level validation.** Every route handler that takes a `workspaceId` (in URL path, query, or body) calls `validateWorkspaceId(id)` first. Failure → 400 with sanitized error. URL-path extraction uses an explicit regex `^\/([a-z0-9][a-z0-9_-]{0,62})\.git\/...` so the URL parser itself rejects bad IDs.
2. **Path resolution defense-in-depth.** `repoPathFor(id)` does `const p = path.join(repoRoot, `${id}.git`); if (!path.resolve(p).startsWith(path.resolve(repoRoot) + path.sep)) throw new Error('path traversal')`. Even if the regex is buggy, this catches escape.
3. **Argv arrays only.** Every git invocation uses the explicit array form `spawn('git', [...args])`. The shell-form child_process functions and any string-command form of spawn are forbidden across the package — argv-array is the only allowed shape.
4. **No `--` boundary needed because no caller-controlled flags.** Subcommand flags are all constants from the handler; only the positional repo path is caller-derived.
5. **Lint:** add an `eslint.config.mjs` rule under `packages/workspace-git-server/` that bans the shell-form child_process APIs and any `spawn`/`spawnSync` invocation whose first argument is a string containing whitespace (best-effort regex). Lint catches future drift.

Test coverage:
- Property-style tests with a list of nasty inputs: `../`, `..\\`, `;rm`, `$(echo)`, ``\`whoami\``, ` `, leading/trailing whitespace, very long strings, non-ASCII, empty, null, undefined, numbers, objects.
- Each input must round-trip to 400 with no observable side effect (no path created, no git invoked).

---

## Helm chart additions

**Replaces** `deploy/charts/ax-next/templates/git-server/deployment.yaml` (today: `Deployment` with hardcoded `replicas: 1` + Recreate strategy).

### `templates/git-server/statefulset.yaml`

```yaml
{{- if and .Values.gitServer.enabled .Values.gitServer.experimental.gitProtocol }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "ax-next.gitServerComponentName" . }}
spec:
  serviceName: {{ include "ax-next.gitServerComponentName" . }}-headless
  replicas: {{ .Values.gitServer.shards }}
  podManagementPolicy: Parallel       # rolling restarts can drain in parallel
  updateStrategy:
    type: RollingUpdate
  selector: ...
  template:
    spec:
      terminationGracePeriodSeconds: {{ .Values.gitServer.terminationGracePeriodSeconds | default 60 }}
      containers:
      - name: git-server
        image: {{ include "ax-next.gitServerImage" . }}    # NEW helper — separate image from host
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "kill -TERM 1 && sleep $((TERM_GRACE - 5))"]
        ...
        env:
        - name: AX_GIT_SERVER_HOST
          value: "0.0.0.0"
        - name: AX_GIT_SERVER_PORT
          value: {{ .Values.gitServer.port | quote }}
        - name: AX_GIT_SERVER_REPO_ROOT
          value: {{ .Values.gitServer.mountPath | quote }}
        - name: AX_GIT_SERVER_TOKEN
          valueFrom: ...
        - name: AX_GIT_SERVER_SHARD_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['apps.kubernetes.io/pod-index']  # k8s 1.28+
        securityContext:
          runAsUser: 1000
          runAsNonRoot: true
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities: { drop: [ALL] }
        volumeMounts:
        - name: repo
          mountPath: {{ .Values.gitServer.mountPath }}
        - name: tmp
          mountPath: /tmp
      volumes:
      - name: tmp
        emptyDir: { sizeLimit: 256Mi }     # bumped from 64Mi — pack tmp files
  volumeClaimTemplates:
  - metadata:
      name: repo
      annotations: { helm.sh/resource-policy: keep }
    spec:
      accessModes: [ReadWriteOnce]
      resources: { requests: { storage: {{ required "..." .Values.gitServer.storage }} }}
      storageClassName: {{ .Values.gitServer.storageClassName | default "" }}
{{- end }}
```

### `templates/git-server/service-headless.yaml` (new)

```yaml
{{- if and .Values.gitServer.enabled .Values.gitServer.experimental.gitProtocol }}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "ax-next.gitServerComponentName" . }}-headless
spec:
  clusterIP: None
  selector: ...
  ports:
  - name: git
    port: {{ .Values.gitServer.service.port }}
    targetPort: git
{{- end }}
```

This gives stable per-pod DNS: `<sts-name>-0.<headless-svc>.<ns>.svc.cluster.local`.

### `templates/git-server/service.yaml` (existing — keep as fallback)

Existing ClusterIP Service stays for the legacy `gitServer` (workspace-git-http path) until Phase 5 deletes it. The two services (ClusterIP and headless) coexist, gated by the `experimental.gitProtocol` toggle on the StatefulSet.

### `templates/git-server/pvc.yaml` (existing — leave alone for now)

The existing single-PVC remains for the legacy path. The new StatefulSet's `volumeClaimTemplates` create per-replica PVCs (`repo-<sts-name>-0`, `repo-<sts-name>-1`, ...). Phase 5 will delete the old PVC template once legacy is gone.

### `templates/networkpolicies/git-server-network.yaml` (modify)

Existing template's `podSelector` matches the legacy Deployment. Add a parallel rule for the StatefulSet pods (same component label so the existing matcher works — verify by checking `ax-next.selectorLabels` output). Egress stays `[]`. No code change if labels match.

### `values.yaml` additions

```yaml
gitServer:
  enabled: false           # unchanged
  experimental:
    gitProtocol: false     # NEW — gates the StatefulSet path
  shards: 1                # NEW — replicas of the StatefulSet
  port: 7780
  service:
    port: 7780
  storage: 10Gi            # per-shard
  terminationGracePeriodSeconds: 60   # bumped from 30
  ...
image:
  repository: ax-next/agent     # unchanged for host/runner
gitServerImage:
  repository: ax-next/git-server  # NEW — separate image for the storage tier
  tag: ""                          # empty → Chart.appVersion
  pullPolicy: IfNotPresent
```

A new `_helpers.tpl` entry `ax-next.gitServerImage` resolves repo+tag (mirroring `ax-next.image`).

### RBAC

No new RBAC. The git-server StatefulSet pods don't talk to the k8s API. The existing `ServiceAccount` (`templates/git-server/serviceaccount.yaml`) is reusable as long as it's at the namespace level, not Deployment-scoped.

---

## Host-side sharding routing layer

Lives in `src/client/shard-router.ts` (used by the test-only Plugin in Phase 1 and inherited by Phase 2's host plugin).

```ts
import { createHash } from 'node:crypto';

export function shardForWorkspace(workspaceId: string, shards: number): number {
  if (shards < 1) throw new Error('shards must be >= 1');
  // SHA-256 first 4 bytes mod N — uniform-enough distribution at our scale,
  // no new dependency, deterministic across host replicas.
  const hash = createHash('sha256').update(workspaceId).digest();
  const top4 = hash.readUInt32BE(0);
  return top4 % shards;
}

export function shardUrl(opts: {
  serviceName: string;          // e.g., "ax-next-git-server-headless"
  namespace: string;
  port: number;
  shardIndex: number;
}): string {
  return `http://${opts.serviceName.replace(/-headless$/, '')}-${opts.shardIndex}.${opts.serviceName}.${opts.namespace}.svc.cluster.local:${opts.port}`;
}
```

Tests:
- Determinism: same input → same shard across 1000 calls.
- Range: shard always in `[0, shards)`.
- Distribution: 10000 random workspace IDs across 4 shards land within ±5% of uniform.

The Phase 2 plugin will read shard count + service config from chart-stamped env vars (mirroring `workspaceConfigFromEnv()`'s pattern in `@ax/preset-k8s`). Phase 1 doesn't wire env-driven config — the test-only Plugin takes them as constructor args.

---

## Test strategy

### Unit tests (per-file)

- `shared/workspace-id.test.ts` — regex accept/reject table; argv-injection inputs all rejected.
- `shared/shard.test.ts` — determinism, range, distribution.
- `server/auth.test.ts` — port from `workspace-git-http/server/auth.test.ts`; no behavior changes.
- `server/repos.test.ts` — POST/DELETE/GET against an in-process server with a tempdir repoRoot. Verifies status codes, body shapes, idempotency, error envelope, no token leak in errors.
- `server/smart-http.test.ts` — discovery + upload-pack against a tempdir-bare-repo with a known commit; verifies pkt-line preamble, content-type, exit codes.

### Integration tests (boot real server in-process)

`__tests__/integration/lifecycle.test.ts` — boots `createWorkspaceGitServer`, then runs through:
- POST `/repos {workspaceId}` → 201
- GET `/repos/<id>` → 200 `{exists:true, headOid:null}`
- `git push` from a tempdir source clone → succeeds, creates `refs/heads/main`
- GET `/repos/<id>` → 200 `{exists:true, headOid:<oid>}`
- `git fetch` from a fresh tempdir mirror → succeeds, `FETCH_HEAD` matches
- DELETE `/repos/<id>` → 204
- GET `/repos/<id>` → 404
- POST `/repos {workspaceId}` (same id, after delete) → 201 (recreate works)

`__tests__/integration/empty-repo-materialize.test.ts` — open question Q#7 acceptance:
- POST `/repos`
- Host attempts `git ls-remote` → empty output (no `main`)
- Host's "treat as empty baseline" path: skip clone, start sandbox with empty workspace
- First push creates `main`
- Subsequent fetches succeed

`__tests__/integration/multi-replica-concurrency.test.ts` — open question Q#1 acceptance:
- Boot ONE server (one shard)
- TWO host clients clone the same workspace
- Each makes a different change, both push concurrently
- ONE push wins; the OTHER push fails with non-fast-forward (or `--force-with-lease` mismatch)
- Loser fetches, rebases, retries → succeeds
- Final history is linear; both changes present

`__tests__/integration/argv-injection.test.ts` — security acceptance:
- Table of 30+ malicious workspace IDs
- For each: POST `/repos {workspaceId: <input>}` → 400, no filesystem side effect, no git spawned (verified via spy on `child_process.spawn`)
- Repeat against URL-path routes (`GET /<input>.git/info/refs`) — 400 from URL regex.

### `runWorkspaceContract` reuse

`__tests__/contract.test.ts` — mirrors `workspace-git-http`'s contract test pattern:
```ts
runWorkspaceContract('@ax/workspace-git-server', () =>
  createTestOnlyGitServerPlugin({
    boot: async () => {
      const server = await createWorkspaceGitServer({ ... });
      return { baseUrl: ..., token: ..., shards: 1 };
    },
  }),
);
```

`createTestOnlyGitServerPlugin` lives in `src/client/plugin-test-only.ts`. Its `workspace:apply` impl:
1. POST `/repos` if workspace not yet created.
2. Maintain a per-workspace local mirror in a tempdir.
3. `git fetch` shard URL → mirror.
4. Build a working tree from `parent` + apply `FileChange[]`.
5. `git commit -m <reason>` with `GIT_AUTHOR_NAME=ax-runner` env enforced.
6. `git push --force-with-lease=refs/heads/main:<parent> shard-url HEAD:refs/heads/main`.
7. Return new oid as `WorkspaceVersion`, build `WorkspaceDelta` by diffing tree.

This is "Phase 2 prototype quality" — good enough to satisfy the contract, not yet wired up as a real plugin. **Lives in `src/client/`, NOT `src/client/__tests__/`**, because the contract test imports it. NOT exported from `index.ts` so it can't be registered by mistake.

### What is NOT tested in Phase 1

- Validators (`workspace:pre-apply` + skill validator) — Phase 3.
- Bundle wire (sandbox-host axis) — Phase 3.
- `ax-runner` author host-side enforcement — Phase 3.
- A registered host plugin replacing `@ax/workspace-git-http` — Phase 2.

---

## Boundary review (per `CLAUDE.md`)

The four canonical `workspace:*` hooks are **unchanged** by Phase 1 — the new server is reached over the wire from a future host plugin, not directly from the bus. So strictly speaking, Phase 1 doesn't introduce a new hook surface. But the new wire surface (REST + git smart-HTTP) deserves the same review:

- **Alternate impl this wire could have:** Yes — Gitea, GitHub Enterprise, GitLab self-hosted. The wire is standard git smart-HTTP plus a tiny REST CRUD; the REST CRUD shape is the only thing each backend's adapter would translate (~50–200 LOC per backend). Two concrete second/third impls are already named in the design doc.
- **Payload field names that might leak:**
  - `workspaceId` — generic, not git-specific. ✓
  - `headOid` — leaks "git" vocabulary. **Justify:** `headOid` is exposed only on the *server's* REST API, which is by definition git-shaped. The *bus-level* `workspace:*` hooks in `@ax/workspace-protocol` already use opaque `WorkspaceVersion` and don't expose `oid`. The leak stops at the storage-tier wire and never reaches subscribers.
  - `default_branch: "main"` — leaks git semantics. Same justification: server-internal, not bus-level.
- **Subscriber risk:** N/A in Phase 1 (no new subscribers). When Phase 2 wires the host plugin, the plugin's responsibility is to translate `WorkspaceVersion` → oid internally, and never let an oid escape into a subscriber-visible payload. Phase 2 plan must include a test that asserts this.
- **Wire surface:** REST schemas live in `packages/workspace-git-server/src/server/repos.ts` (Zod schemas co-located with handlers). Smart-HTTP routes live in `src/server/smart-http.ts`. **Not** in `@ax/workspace-protocol` — that package is for the legacy JSON-over-HTTP wire and shouldn't carry the new wire's schemas (avoid coupling the two protocols).

---

## Security review (per `security-checklist`)

```
## Security review
- Sandbox: New @ax/workspace-git-server container introduces process-spawn capability scoped to the literal command 'git' with fixed argv shape `[ '-c', flags..., subcommand, ...const_args, repoPath ]`. Caller never controls argv0 or flags; the only caller-derived element is repoPath, built from a regex-validated workspaceId via path.join(repoRoot, ...) with a defense-in-depth path.resolve startsWith check. Locked-down env via PARANOID_GIT_ENV (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, HOME=/nonexistent, PATH explicit). NetworkPolicy permits only inbound from host pods on the configured port; egress: []. Filesystem access bound to <repoRoot>/. No new fd / handle passing. SECURITY.md per-package walks the budget in detail.
- Injection: Storage tier handles only opaque pack bytes (piped through git's stdin/stdout) plus regex-validated workspaceIds and a small JSON request body schema-validated by Zod. Bearer token compared via crypto.timingSafeEqual; never appears in any error message (shape carried over from workspace-git-http auth.ts). Logged workspaceIds are regex-restricted (no newlines, control chars, ANSI), preventing log injection. The model-output / tool-output / commit-message attack surface lives in Phase 3 (sandbox-side commit construction) — Phase 1's storage tier never sees agent-originated strings.
- Supply chain: New @ax/workspace-git-server package introduces no new npm dependencies (uses Node stdlib + zod, both already in the repo). New runtime dependency: the git binary itself, pinned via the new container/git-server/Dockerfile to a specific apt version (debian-slim recommended for CVE patch cadence). Document base-image rebase cadence in SECURITY.md (e.g., monthly + on critical CVE). Recent git CVEs to watch: CVE-2024-32002 (RCE via crafted submodule symlink — mitigated by paranoid env disabling protocol.allow), CVE-2024-32004 (clone-from-untrusted — N/A, server only serves, never clones from untrusted source).
```

---

## Migration & rollback

### Migration (Phase 1 → Phase 2 → ... → Phase 5)

- **Phase 1 (this PR):** Ship the new server + chart toggle. Default OFF. Existing `workspace.backend: local | http` paths unchanged. Tests validate the server end-to-end via the test-only Plugin.
- **Phase 2:** Replace host's workspace plugin with one that registers `workspace:apply/read/list/diff` against the new server. Sandbox-host wire still `FileChange[]` (translated host-side to git ops). Canary one workspace (one user, one team) for a soak window.
- **Phase 3:** Add bundle wire on sandbox-host axis. Add `git status`-based diff in the sandbox runner. Skill validator subscriber lands in same PR.
- **Phase 4:** Identity validator subscriber.
- **Phase 5:** Decommission `@ax/workspace-git-http`, `@ax/workspace-git`, `@ax/workspace-git-core`, the legacy Deployment template, the legacy ClusterIP Service template, the legacy single-PVC template. Helm `helm.sh/resource-policy: keep` on the legacy PVC means data isn't lost; operator manually deletes the legacy PVC after confirming migration.

### Rollback (post-deploy canary surfacing a problem)

Three escalation rungs:

1. **Same-day:** flip `gitServer.experimental.gitProtocol: false` in the operator's Helm values, `helm upgrade`. The new StatefulSet + headless Service un-render. Existing host plugins (`@ax/workspace-git-http`) keep serving via the legacy Deployment + ClusterIP Service. **No data loss** — the new shards' PVCs have `helm.sh/resource-policy: keep` so the bare repos persist for forensics.
2. **If only one shard is bad:** scale that one StatefulSet ordinal to 0 manually (`kubectl scale sts ... --replicas N-1` is not how STS works — instead, cordon traffic by quarantining workspaces to other shards via a feature flag on the host plugin). Phase 1 doesn't ship this fine-grained rollback; if needed, escalate to (1).
3. **If the canary surfaces a data-corruption bug:** the legacy `@ax/workspace-git-http` workspace is the source of truth for non-canary workspaces (the new tier has been serving zero production traffic). For the canary workspace, restore from the most recent backup (operational concern — not in MVP scope per design doc Q#1; for MVP, the canary workspace is one we can afford to lose).

### Pre-flip checklist (operator runbook — write as part of the PR)

Before flipping `experimental.gitProtocol: true`:

- [ ] Verify chart renders both legacy and new templates with toggle off (no resource churn).
- [ ] Verify chart renders cleanly with toggle on (StatefulSet, headless Service, per-shard PVCs).
- [ ] Verify test suite passes (`pnpm test --filter @ax/workspace-git-server`).
- [ ] `helm upgrade --dry-run` shows the expected diff and nothing else.
- [ ] Have the rollback `helm` command ready to paste.

---

## Half-wired window discipline (per feedback memory)

- **What ships in this PR:** the server + container + chart resources + test-only client adapter + tests.
- **What stays half-wired until Phase 2:** the host-side plugin registration. No `@ax/cli/main.ts` or `@ax/preset-k8s/index.ts` import of the new package. This is **explicitly named** in the PR description's "Half-wired window — OPEN" section, with Phase 2 named as the closer.
- **Why this is acceptable as a window-OPEN case (not a violation):** the new plugin is exercised by integration tests + chart toggle. No "wire it later" code in production paths. Phase 2 has a dated successor (next PR after this one).

PR description template (mirror Phase B PR #29's shape):

```markdown
## Half-wired window — OPEN
- New plugin loaded by: NONE (Phase 1 ships server + test-only client; no registered plugin)
- Test/canary that reaches it: __tests__/integration/lifecycle.test.ts + __tests__/contract.test.ts
- User-facing surface: gitServer.experimental.gitProtocol toggle (operator-flippable; default off)
- Window CLOSES in: Phase 2 (replace registered host plugin with git-protocol client)
- Successor PR: <link or "to-be-opened-after-this-one">
```

---

## Bite-sized TDD tasks

Each task is 2–5 minutes. Commit per task. Order matters where it does (later tasks build on earlier ones).

### Task 1: Scaffold `@ax/workspace-git-server` package

**Files:**
- Create: `packages/workspace-git-server/package.json`
- Create: `packages/workspace-git-server/tsconfig.json`
- Create: `packages/workspace-git-server/vitest.config.ts`
- Create: `packages/workspace-git-server/src/index.ts` (empty placeholder export)
- Modify: `tsconfig.json` (add `references` entry)
- Modify: `pnpm-workspace.yaml` (no change — already globbed under `packages/*`)

**Steps:**
1. Mirror `packages/workspace-git-http/` shape — copy `tsconfig.json`, `vitest.config.ts`, prune `src/`.
2. `package.json`: `name: "@ax/workspace-git-server"`, `peerDependencies: {"@ax/core": "*"}`, `dependencies: {zod: "^3"}` (or whatever existing pin is — copy from sibling), bin field omitted (no CLI yet).
3. `pnpm install` to wire workspace.
4. `pnpm build --filter @ax/workspace-git-server` succeeds (empty package compiles).
5. **Commit:** `feat(workspace-git-server): scaffold package`

### Task 2: Drop SECURITY.md at scaffold time

**Files:** Create `packages/workspace-git-server/SECURITY.md`.

Mirror `packages/workspace-git-http/SECURITY.md` shape. Walk the three threat models per `security-checklist` skill output above. Document the paranoid env, the regex, the path-resolve defense, the base-image rebase cadence.

**Commit:** `docs(workspace-git-server): SECURITY.md at scaffold`

### Task 3: workspaceId regex (failing test)

**File:** `packages/workspace-git-server/src/shared/workspace-id.test.ts`

Includes accept cases (`a`, `a-b`, `a_b`, `1abc`, `abc-123`, 63-char strings), reject cases (empty, leading-dash, leading-underscore, uppercase, dot, slash, `..`, space, 64-char, NUL, command substitution, backticks, semicolons, newlines, CR, zero-width-space), non-string types, and a "no echo of input in error message" check (no log injection).

Run: `pnpm test --filter @ax/workspace-git-server` → FAIL (module missing).

**Commit:** `test(workspace-git-server): workspaceId regex spec`

### Task 4: workspaceId implementation (test passes)

**File:** `packages/workspace-git-server/src/shared/workspace-id.ts`

```ts
export const WORKSPACE_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export class InvalidWorkspaceIdError extends Error {
  constructor() {
    super('invalid workspaceId');
    this.name = 'InvalidWorkspaceIdError';
  }
}

export function validateWorkspaceId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !WORKSPACE_ID_REGEX.test(id)) {
    throw new InvalidWorkspaceIdError();
  }
}
```

Run: tests pass.

**Commit:** `feat(workspace-git-server): workspaceId regex + validator`

### Task 5: Path-traversal defense (failing test)

**File:** `packages/workspace-git-server/src/shared/repo-path.test.ts`

Test that:
- Valid id → `<repoRoot>/<id>.git` resolved path.
- Even if a (hypothetically buggy) caller bypasses the regex and passes `../foo`, `repoPathFor` rejects via `path.resolve` startsWith check.

**Commit:** `test(workspace-git-server): repo-path traversal defense spec`

### Task 6: Path-traversal defense (impl)

**File:** `packages/workspace-git-server/src/shared/repo-path.ts`

```ts
import { join, resolve, sep } from 'node:path';

export function repoPathFor(repoRoot: string, workspaceId: string): string {
  const candidate = join(repoRoot, `${workspaceId}.git`);
  const resolved = resolve(candidate);
  const rootResolved = resolve(repoRoot);
  if (!resolved.startsWith(rootResolved + sep)) {
    throw new Error('repo path escapes repoRoot');
  }
  return resolved;
}
```

**Commit:** `feat(workspace-git-server): repo-path traversal defense`

### Task 7: Bearer auth (port from workspace-git-http)

**Files:** Copy `packages/workspace-git-http/src/server/auth.ts` and its test verbatim into `packages/workspace-git-server/src/server/`. No behavior change. (Eventually we may dedupe via a shared package; for now duplication is fine — under 50 LOC.)

**Commit:** `feat(workspace-git-server): bearer auth (port)`

### Task 8: Paranoid git env constant

**File:** `packages/workspace-git-server/src/server/git-env.ts`

```ts
export const PARANOID_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  PATH: '/usr/bin:/bin',
};
```

Test: assert frozen-ness (no caller mutation), no `GIT_*` keys leaked beyond the explicit list.

**Commit:** `feat(workspace-git-server): paranoid git env`

### Task 9: REST POST /repos handler (failing test)

**File:** `packages/workspace-git-server/src/server/repos.test.ts`

Boots a temp server with a tempdir repoRoot. Assertions:
- POST with valid id + valid token → 201, `path.join(repoRoot, '<id>.git')` exists, `<repo>/HEAD` references `refs/heads/main`.
- POST with valid id + missing token → 401.
- POST with valid id + wrong token → 401, `crypto.timingSafeEqual`-shaped (length mismatch returns same status).
- POST with invalid id → 400, no filesystem side effect.
- POST with same id twice → 409.
- POST with body > 1 MiB → 413.

**Commit:** `test(workspace-git-server): POST /repos spec`

### Task 10: REST POST /repos impl

**Files:** `packages/workspace-git-server/src/server/repos.ts`, `src/server/listener.ts`.

Spawn `git init --bare --initial-branch=main` with paranoid env. Set per-repo config (deny deletes/non-fast-forwards/etc.) via `git -C <repo> config ...`. Body parser with 1 MiB cap. Zod schema validation.

**Commit:** `feat(workspace-git-server): POST /repos handler`

### Task 11: GET /repos/<id> (test + impl)

Two-step (failing test then impl). Returns metadata `{exists, headOid|null}`.

**Commits:**
- `test(workspace-git-server): GET /repos/<id> spec`
- `feat(workspace-git-server): GET /repos/<id> handler`

### Task 12: DELETE /repos/<id> (test + impl)

Two-step. Idempotent 204.

**Commits:**
- `test(workspace-git-server): DELETE /repos/<id> spec`
- `feat(workspace-git-server): DELETE /repos/<id> handler`

### Task 13: GET /healthz

Trivial. No auth. Test + impl in one commit.

**Commit:** `feat(workspace-git-server): /healthz endpoint`

### Task 14: Smart-HTTP discovery `GET /<id>.git/info/refs` (test + impl)

**Files:** `src/server/smart-http.ts`, `src/server/smart-http.test.ts`.

Test creates a tempdir bare repo with one commit, then calls discovery. Asserts pkt-line preamble + flush + non-zero ref advertisement.

**Commits:**
- `test(workspace-git-server): smart-HTTP discovery spec`
- `feat(workspace-git-server): smart-HTTP discovery handler`

### Task 15: Smart-HTTP `POST /<id>.git/git-upload-pack` (test + impl)

End-to-end clone test: tempdir source repo with one commit → POST /repos creates server-side bare → `git push` from source → `git clone` from another tempdir succeeds.

**Commits:**
- `test(workspace-git-server): git-upload-pack spec`
- `feat(workspace-git-server): git-upload-pack handler`

### Task 16: Smart-HTTP `POST /<id>.git/git-receive-pack` (test + impl)

Push test. Asserts deny-deletes and deny-non-fast-forwards both reject.

**Commits:**
- `test(workspace-git-server): git-receive-pack spec`
- `feat(workspace-git-server): git-receive-pack handler`

### Task 17: Argv-injection acceptance test

`__tests__/integration/argv-injection.test.ts` — table of 30+ malicious inputs across REST + smart-HTTP routes. Uses `vi.spyOn(child_process, 'spawn')` to assert no git invocation occurred.

**Commit:** `test(workspace-git-server): argv-injection acceptance`

### Task 18: SIGTERM-aware listener with drain

**File:** `src/server/listener.ts`

- `server.close()` to stop accepting new conns.
- Track in-flight requests; wait up to `terminationGracePeriodSeconds - 5s` for drain.
- Force-kill spawned git children that exceed grace.
- Test: spawn server, simulate long-running upload-pack, send SIGTERM, expect graceful drain.

**Commit:** `feat(workspace-git-server): SIGTERM drain`

### Task 19: CLI entrypoint `main.ts`

**File:** `src/server/main.ts`

Mirror `workspace-git-http/src/server/main.ts` env-driven boot pattern. Required envs: `AX_GIT_SERVER_REPO_ROOT`, `AX_GIT_SERVER_TOKEN`. Optional: `AX_GIT_SERVER_HOST` (default 0.0.0.0), `AX_GIT_SERVER_PORT` (default 7780), `AX_GIT_SERVER_SHARD_INDEX` (informational, logged at boot).

**Commit:** `feat(workspace-git-server): CLI entrypoint`

### Task 20: Container Dockerfile

**Files:**
- Create: `container/git-server/Dockerfile`
- Create: `container/git-server/.dockerignore`

Debian-slim base, `apt-get install -y --no-install-recommends git=<pin>`, non-root, copy compiled `dist/` + production node_modules, expose 7780, ENTRYPOINT direct exec.

Test locally: `docker build` + `docker run` + curl /healthz.

**Commit:** `feat(workspace-git-server): container Dockerfile`

### Task 21: Shard router (test + impl)

`src/shared/shard.ts` + tests for determinism, range, distribution.

**Commits:**
- `test(workspace-git-server): shard router spec`
- `feat(workspace-git-server): shard router`

### Task 22: Test-only client Plugin for runWorkspaceContract

`src/client/plugin-test-only.ts` — minimal Plugin that translates `workspace:apply` to git fetch/commit/push against a shard URL. Maintains a per-workspace tempdir mirror (cleaned at plugin destroy).

**Commit:** `feat(workspace-git-server): test-only client plugin`

### Task 23: runWorkspaceContract reuse

`src/__tests__/contract.test.ts` — mirrors `workspace-git-http/src/__tests__/contract.test.ts` shape. Asserts all contract assertions pass.

**Commit:** `test(workspace-git-server): runWorkspaceContract`

### Task 24: Multi-replica concurrency integration test

`__tests__/integration/multi-replica-concurrency.test.ts` — two host clients hitting one server, concurrent push, exactly one wins, loser retries succeeds.

**Commit:** `test(workspace-git-server): multi-replica concurrency`

### Task 25: Empty-repo materialize integration test

`__tests__/integration/empty-repo-materialize.test.ts` — create repo, ls-remote returns empty, first push creates main.

**Commit:** `test(workspace-git-server): empty-repo materialize`

### Task 26: Helm — values.yaml additions

Add `gitServer.experimental.gitProtocol`, `gitServer.shards`, `gitServerImage`, bumped `terminationGracePeriodSeconds`. Document each with a comment block in the same prose voice as the existing values.yaml.

**Commit:** `feat(chart): gitServer.experimental.gitProtocol values`

### Task 27: Helm — StatefulSet template

`templates/git-server/statefulset.yaml` per the shape above. Gated on `experimental.gitProtocol`. `replicas: {{ .shards }}`.

**Commit:** `feat(chart): gitServer StatefulSet template`

### Task 28: Helm — headless Service template

`templates/git-server/service-headless.yaml`. `clusterIP: None`. Gated on the same toggle.

**Commit:** `feat(chart): gitServer headless service`

### Task 29: Helm — gitServerImage helper

Add `ax-next.gitServerImage` to `_helpers.tpl`. Used by both StatefulSet (Phase 1) and any future per-tier image splits.

**Commit:** `feat(chart): gitServerImage helper`

### Task 30: Helm — render tests

`scripts/test-chart-render.sh` (or whatever the existing chart-render test mechanism is — check `pnpm test` output for the `helm template` invocation already in use):

- Toggle off: legacy Deployment renders, StatefulSet absent, headless Service absent.
- Toggle on (with `gitServer.enabled: true`): StatefulSet, headless Service, per-shard PVCs render. Existing legacy Deployment still renders (shipping in parallel).
- Toggle on with shards: 3: 3 PVCs in volumeClaimTemplates expansion (well, 1 template entry, but the STS will create 3 at runtime — verify the template entry).

**Commit:** `test(chart): gitServer.experimental.gitProtocol render`

### Task 31: NetworkPolicy verification

`templates/networkpolicies/git-server-network.yaml` — verify the existing podSelector matches the new StatefulSet pods (same component label). If labels diverge, add a parallel NetworkPolicy for the new tier; if they match, no change needed but document the verification in the PR.

**Commit:** `chore(chart): verify NetworkPolicy covers new tier` (or `feat(chart): NetworkPolicy for git-server STS`)

### Task 32: Operator runbook

`docs/runbooks/2026-05-01-workspace-git-server-canary.md` — pre-flip checklist + rollback command + common-failure triage.

**Commit:** `docs(runbook): workspace-git-server canary`

### Task 33: PR description with boundary review + security review + half-wired window

Compose against the templates above. Include all open-question resolutions, the migration path, the rollback plan.

**Commit:** None (PR body, not a commit). Open the PR.

---

## What I want from you before I start

Three sign-offs:

1. **Open-question resolutions.** Are recommended answers for Q#1, Q#2, Q#7, Q#4 (image), Q#5 (hash), Q#6 (regex) acceptable? If any need adjustment, tell me which.
2. **Cross-phase reordering (Option D).** Does the test-only Plugin in `src/client/plugin-test-only.ts` satisfy your half-wired-window discipline, or do you want Phase 1 to also wire a real registered host plugin (effectively merging with Phase 2)?
3. **Container shape (Q#4).** Separate `ax-next/git-server` image, or single combined image with git binary added to the host/runner image? My recommendation is split.

After those, I'll start at Task 1.
