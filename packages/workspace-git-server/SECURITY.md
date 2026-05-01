# Security — `@ax/workspace-git-server`

This package replaces the storage tier of `@ax/workspace-git-http` with a sharded, container-shipped, native-`git`-binary backend. The shape is structurally similar to the sibling — one HTTP listener per pod, bearer auth via `crypto.timingSafeEqual`, a NetworkPolicy perimeter, single-writer per shard — but the threat model is meaningfully different in three places, and they're the three places this note spends most of its time on:

1. We **spawn the `git` binary**. The sibling uses pure-JS `isomorphic-git` and never touches `child_process`. This is the biggest new capability.
2. We deploy as a **`StatefulSet` with `replicas: <gitServer.shards>`** (per-shard PVC, headless `Service` for stable DNS), not a single `Deployment`. Within a shard, single-writer; across shards, no contention. Blast radius is now per-shard.
3. We expose a small **lifecycle REST API** (`POST /repos`, `GET /repos/<id>`, `DELETE /repos/<id>`) on top of standard git smart-HTTP. The sibling has only the four `workspace:*` actions.

Everything else (Zod, the bearer-token wall, the SecurityContext story, `MAX_FRAME` body caps, fixed-string auth errors) is the same posture as the sibling. We didn't reinvent the parts that were already paranoid enough.

This note is the `security-checklist` walk for this slice. The implementation lands across subsequent tasks per `docs/plans/2026-05-01-workspace-redesign-phase-1-plan.md`; the SECURITY.md is forward-looking by design — invariants we're committing to before code is written are easier to enforce than ones we discover after.

## Security review

- **Sandbox:** New process-spawn capability scoped to the literal command `'git'` with a fixed argv shape `[ '-c', flags..., subcommand, ...const_args, repoPath ]`. Caller never controls argv0 or flags; the only caller-derived element is `repoPath`, built from a regex-validated `workspaceId` via `path.join(repoRoot, ...)` with a defense-in-depth `path.resolve` startsWith check. Locked-down env via `PARANOID_GIT_ENV` (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `HOME=/nonexistent`, `PATH=/usr/bin:/bin`) — full replacement, never `{ ...process.env, ... }`. NetworkPolicy permits only inbound from host pods on the configured port; egress: `[]`. Filesystem access bound to `<repoRoot>/`. SecurityContext: non-root UID 1000, all caps dropped, `readOnlyRootFilesystem: true`, the per-shard PVC is the only writable mount.
- **Injection:** Storage tier handles only opaque pack bytes (piped through `git`'s stdin/stdout), regex-validated `workspaceId`s, bearer tokens compared via `crypto.timingSafeEqual`, and a tiny JSON request body schema-validated by Zod under a 1 MiB cap. Bearer token never appears in any error message (shape carried over from `workspace-git-http/server/auth.ts`). Logged `workspaceId`s are regex-restricted (no newlines, control chars, ANSI), preventing log injection. The model-output / tool-output / commit-message attack surface lives in **Phase 3** (sandbox-side commit construction) — Phase 1's storage tier never sees agent-originated strings.
- **Supply chain:** No new npm runtime dependencies. The HTTP transport is `node:http`, hashing is `node:crypto`, and Zod is already in the workspace. New runtime dependency: **the `git` binary itself**, pinned via the new `container/git-server/Dockerfile` (Task 17) to a specific apt version on `debian-slim`. Base-image rebase cadence: monthly + on critical CVE. Recent CVEs to keep in mind: CVE-2024-32002 (RCE via crafted submodule symlink — mitigated by `protocol.allow=never` in our paranoid env), CVE-2024-32004 (clone-from-untrusted — N/A, the server only *serves* repos, it never *clones from* an untrusted source).

## Sandbox / capability

This is the first plugin we ship that spawns a process. That alone earns the long walk; the sharded StatefulSet shape and the lifecycle REST surface earn the rest.

### Pod-side server: inbound TCP listener

The pod-side server is a Node `http` listener on `0.0.0.0:7780` by default, run as the entrypoint of a dedicated `ax-next/git-server` image inside a `StatefulSet`. The `StatefulSet` is fronted by a **headless `Service`** (`clusterIP: None`) so each replica gets a stable DNS name (`<sts-name>-<ord>.<headless-svc>.<ns>.svc.cluster.local`); host pods route to a specific shard by ordinal. There's no load-balanced VIP — there can't be, because each ordinal owns a different slice of workspaces.

#### What capability we grant

Two things, in order of how-much-this-keeps-us-up-at-night:

1. **`server.listen(port, host)`** on the git-server process. Default `0.0.0.0:7780`, configurable via `AX_GIT_SERVER_HOST` / `AX_GIT_SERVER_PORT`. Anyone who can route a TCP connection to that address and ordinal can attempt requests; inside the cluster, "anyone who can route" is whoever NetworkPolicy lets through.
2. **`child_process.spawn('git', argv, { env: PARANOID_GIT_ENV })`** for `git init --bare`, `git -C <repo> config ...`, `git -C <repo> rev-parse refs/heads/main`, `git -c ... upload-pack --stateless-rpc`, and `git -c ... receive-pack --stateless-rpc`. That's the entire list. Every invocation:
   - Uses **argv-array form only**. The shell-form variants of `child_process` (`exec`, `execSync`, the string-command form of `spawn`) are forbidden across the package; lint enforces.
   - Uses a **fully replaced env** — `PARANOID_GIT_ENV` is the *only* thing in the child's environment. Never `{ ...process.env, ... }`. The constant lands in `src/server/git-env.ts` (Task 6) and lists exactly:
     - `GIT_CONFIG_NOSYSTEM=1` — no `/etc/gitconfig`.
     - `GIT_CONFIG_GLOBAL=/dev/null` — no `~/.gitconfig`.
     - `GIT_TERMINAL_PROMPT=0` — never block waiting for a TTY.
     - `HOME=/nonexistent` — the binary won't find anything if it tries.
     - `PATH=/usr/bin:/bin` — explicit, no inheritance.
   - Per-repo, the bare repo's own `config` file pins additional defenses set at `POST /repos` time: `core.hooksPath=/dev/null` (no server-side hooks), `protocol.allow=never` (no remote helpers, kills the CVE-2024-32002 class), `receive.denyDeletes=true`, `receive.denyNonFastForwards=true`, `uploadpack.allowAnySHA1InWant=false`.

#### What bounds it

Four layers, in order:

1. **NetworkPolicy** (`deploy/charts/ax-next/templates/networkpolicies/git-server-network.yaml`, modified in Task 31). Ingress is allowed only from host-pod labels in the same namespace. Runner pods MUST NOT be permitted, ever — runners don't speak the storage-tier wire and there's no legitimate reason for one to reach the git-server. Egress: `[]`. This is the perimeter.
2. **Bearer auth via `crypto.timingSafeEqual`** against an env-loaded token (`AX_GIT_SERVER_TOKEN`, sourced from a Helm-managed Secret). Missing, malformed, or wrong token returns 401 with a fixed message — the offending value is never echoed (invariant I9, carried over from `@ax/ipc-http` and `@ax/workspace-git-http`). This is the wall behind the perimeter.
3. **`workspaceId` regex chokepoint, server-side at every route.** Lives in `src/shared/workspace-id.ts` (Task 3). The regex is `^[a-z0-9][a-z0-9_-]{0,62}$` — lowercase only (filesystem-safe on case-insensitive volumes), no dots (we don't have to think about `..` traversal because `.` literally can't appear), 63-char cap (DNS label cap; gives us room to repurpose IDs as DNS components later). The regex runs **before any filesystem touch and before any `git` spawn**. Failure → 400 with a sanitized error that does not echo the input (no log injection through workspace IDs).
4. **`path.resolve` startsWith defense-in-depth.** `repoPathFor(repoRoot, id)` (Task 4) does `path.join(repoRoot, '${id}.git')`, then asserts the resolved path starts with `path.resolve(repoRoot) + path.sep`. Even if a future bug regresses the regex (someone adds `.` to the character class, say), this catches escape. Belt and suspenders. We're a nervous crab.
5. **Pod SecurityContext.** Non-root UID 1000, all caps dropped, `readOnlyRootFilesystem: true`. The per-shard PVC is the only writable mount and it's the bare repos' own gitdir. `tmp` is a 256 MiB `emptyDir` for pack staging. Even if an attacker pops the process, they're a non-root user with no shell, no writable rootfs, and the PVC for one shard's workspaces under their feet.

(Yes, that's five layers in a list called "four layers." Counting is hard when you're paranoid.)

#### Blast radius if this pod is compromised

This is the place sharding meaningfully helps over the sibling. The sibling's git-server pod, if compromised, leaks **every workspace's content** — every session, every user, all the bytes ever committed. That's because the sibling is a single Deployment with one PVC.

This package is a `StatefulSet` with `replicas: <gitServer.shards>`. Each ordinal owns a slice of workspaces by SHA-256-mod-N hash. **A compromise of one pod leaks one shard's workspaces** — `1/N` of the total — not all of them. That's a meaningfully tighter property at higher shard counts, and it's free; we paid for sharding for the scaling property and got the blast-radius narrowing as a bonus.

Caveats we want to be honest about:

- The bearer token is **the same value across all shards** by default (one Secret, mounted into every replica's env). If the token leaks, the attacker can talk to every shard. Per-shard tokens would narrow this further but make rotation operationally painful in a different way. Documented as a known limit.
- **Lateral movement between shards** isn't impossible — a compromised shard pod could in principle reach the others over cluster networking — but Egress: `[]` on the StatefulSet's NetworkPolicy means no, it can't. The compromised pod can't open outbound connections. Unless the NetworkPolicy itself is bypassed.
- **Shard-membership leak via observability.** We log workspace IDs at info level. An attacker with stdout access on a compromised shard sees only the IDs that map to that shard — not the rest of the keyspace. Same property as the data-plane reach.

The mitigation is depth: NetworkPolicy keeps the listener unreachable from non-host pods; bearer auth keeps it unreachable without credentials; the regex chokepoint + `path.resolve` defense keep a credentialed-but-malicious caller from escaping `repoRoot`; the SecurityContext keeps a compromised process from doing much locally; sharding narrows the blast radius if all of the above fail. The paranoia adds up.

#### Cross-session escalation: not applicable here (per shard now)

A subtle but important difference from `@ax/ipc-http`. The IPC HTTP listener uses `session:resolve-token` because a token belongs to exactly one session and the resolved `sessionId` becomes the session this request operates as.

There's no session boundary at the workspace layer. A workspace is owned by the cluster (sharded across the storage tier), not by a session — multiple sessions share a workspace, and the host process decides which session is asking. Static service token gates everything. **If the token leaks, every shard leaks** (see the caveat above). One secret to rotate, one wall to defend per cluster, no per-session token plumbing across the storage-tier wire.

(If you skim the auth code looking for the cross-session check that lives in the unix listener — there isn't one. The token resolution would normally be it, but there's no second value to compare against here, same as the sibling.)

#### Process spawn — yes, scoped to `git`

This is the section that's a sharp departure from the sibling, which has no spawn at all. Here, we spawn the `git` binary; everywhere we do, the discipline is the same.

- **Argv0 is always the literal string `'git'`.** Never caller-influenced. No `git/git`, no resolved-from-PATH-at-call-time tricks; the `PATH=/usr/bin:/bin` env constraint pins where the binary comes from, but the argv0 is a constant in our source.
- **Subcommand and flags are constants** from the route handler. The handler decides whether this is `init --bare --initial-branch=main`, `config <key> <value>`, `rev-parse --quiet --verify refs/heads/main`, `upload-pack --stateless-rpc`, or `receive-pack --stateless-rpc`. The caller (the HTTP request) doesn't pick the subcommand — the route does.
- **The only caller-derived element of argv is the resolved repo path**, and it's not really caller-derived: it's `repoPathFor(repoRoot, id)` where `id` has already been validated against the regex and the result has been checked with `path.resolve` startsWith. By the time it reaches `spawn`, the path is provably under `repoRoot`. We don't need a `--` argv terminator because no argv element after the path is caller-influenced.
- **`PARANOID_GIT_ENV` is the full env**, not a merge over `process.env`. The constant is the entire environment the child sees. (We're not using `Object.freeze` on the constant for runtime mutation defense; the test in Task 6 verifies no caller mutation occurs, and the constant is `as const` to keep TypeScript honest about it.)
- **No shell.** Node's `child_process.spawn` with an argv array doesn't go through `/bin/sh` unless `shell: true`, which we never pass. Lint bans `shell: true` and bans the string-form spawn API.
- **stdio is wired carefully.** `git upload-pack --stateless-rpc` reads its capability list / haves / wants from stdin and writes pack bytes to stdout; we pipe the request body to stdin and stream stdout to the response. We never `pipe` git's stdout into another process or shell. The bytes are opaque to us — pack format from a trusted git on the wire.
- **Spawn lifetime is request-scoped.** Every spawn is awaited or attached to the request's lifecycle; on request abort or pod SIGTERM, the spawned `git` is killed. The Task 18 SIGTERM handler force-kills any spawned children that exceed the grace deadline.

#### Path validation chokepoint

Different from the sibling's `validatePath` (which validates filepath strings with traversal blacklists) because the input to this package is a **`workspaceId`** — a DNS-label-shaped opaque ID, not a filepath. Validation is much simpler, and that's the point: the strict regex is the chokepoint, applied server-side at every route, and `repoPathFor` is the only function that turns a `workspaceId` into a filesystem path.

- `validateWorkspaceId(id)` (Task 3) runs first on every route handler, including URL-path extraction. The URL regex for smart-HTTP routes is `^/([a-z0-9][a-z0-9_-]{0,62})\.git/...`, so the URL parser itself rejects malformed IDs before the handler runs.
- `repoPathFor(repoRoot, id)` (Task 4) is the only path-construction function. It runs `path.resolve` startsWith on the result. There is no other place in the codebase that turns a `workspaceId` into a filesystem path; lint and code review enforce.
- Acceptance test (Task 17, `__tests__/integration/argv-injection.test.ts`) walks 30+ malicious inputs across REST and smart-HTTP routes — `../`, `..\\`, `;rm`, `$(echo)`, backticks, semicolons, NUL, leading whitespace, very long strings, non-ASCII, empty, null, undefined, numbers, objects — and asserts every one returns 400 with no filesystem side effect and **no `git` spawn occurred** (verified via `vi.spyOn(child_process, 'spawn')`).

## Prompt injection / untrusted content

Phase 1's storage tier sees a small, well-bounded set of untrusted strings. The model-output / tool-output attack surface — agent-authored commit messages, agent-authored file contents — is **Phase 3's** problem (sandbox-side commit construction). Phase 1's storage tier never sees agent-originated strings directly.

### Untrusted strings entering the slice

- **Wire request bodies** for the lifecycle REST routes. JSON, body-cap 1 MiB (matching the sibling). Zod-validated via the schemas in `src/server/repos.ts` before any handler logic runs. Fail-fast on `Content-Length > cap` (413 before any body bytes are buffered).
- **Wire request `workspaceId`s**, in URL paths and JSON bodies. Regex-validated by `validateWorkspaceId` before any filesystem touch or `git` spawn.
- **`Authorization` header** value. Compared via `crypto.timingSafeEqual` after a length check; the token never appears in any log or error message.
- **Smart-HTTP request bodies** — opaque pack bytes from a host's `git push`. We pipe them straight to `git receive-pack --stateless-rpc` over stdin. We never decode them. They're bytes the host's `git` produced, validated by the receiver's `git` on the other end. The bare repo's `receive.denyDeletes=true` + `receive.denyNonFastForwards=true` + `uploadpack.allowAnySHA1InWant=false` config keeps the receiver paranoid even about malicious pack content.
- **`POST /git-upload-pack` request bodies** — opaque haves/wants pkt-line bytes. Same treatment: piped to `git upload-pack --stateless-rpc` stdin, never interpreted by us.

### Bad destinations — gated by the regex and `path.resolve`

The Zod schemas accept the action's specific shape and reject everything else with 400. After Zod, the regex chokepoint runs on every `workspaceId`. After the regex, `repoPathFor` runs the `path.resolve` startsWith check. By the time a `workspaceId` becomes part of an argv, three layers have looked at it.

The wire schema doesn't accept shell strings, command-line flags, or anything we'd want to interpolate downstream. The handlers themselves don't shell out (argv-array only) and don't build SQL — they call `spawn('git', [...])`. The smart-HTTP handlers pipe opaque bytes; nothing about a request body becomes part of an argv.

### Errors never echo body content

The error envelope is fixed: `{ error, message }` per `ErrorResponseSchema`. The `message` field is whatever the handler chose; it's bounded to a sanitized cause and never includes a body excerpt or the offending input bytes. Auth errors emit short generic strings — never the offending token value. Workspace-id errors emit `invalid workspaceId` without the input — never echo the input, never log the input verbatim. This kills both log injection (newlines, ANSI escapes, control chars in IDs) and an attacker reading an error message to confirm what they sent.

### Worst case

A malicious authenticated host pod (one that already holds the static service token) sends:

- An oversized REST body → 413, socket destroyed before memory fills.
- A body that `JSON.parse` rejects → 400 `invalid_json`. The parser's message is bounded.
- A well-formed JSON body with the wrong shape → Zod rejects → 400 `validation_error` with the path-of-error and the issue message (no body excerpt).
- A well-formed JSON body that passes Zod but encodes injection-flavored content (e.g., a `workspaceId` of `../../etc/passwd` or `$(rm -rf /)`) → `validateWorkspaceId` rejects with 400 `invalid_workspace_id`; no path is constructed, no git is spawned.
- A smart-HTTP request with a malformed pack → `git receive-pack` rejects with a non-zero exit; we surface that as a 500 with a sanitized message; no ref update occurs because git's atomic ref-update guarantees it.
- A smart-HTTP push that races another replica's push → standard `non-fast-forward` rejection from `receive-pack`; this is expected behavior, not an exploit.

## Supply chain

Two supply chains: **npm** (zero new entries) and **the OS image** (one new dependency, the `git` binary, pinned via apt).

### Runtime npm deps

- `@ax/core` — workspace, `workspace:*`. `MAX_FRAME`, `PluginError`, hook bus types.
- `@ax/ipc-core` — workspace, `workspace:*`. Planned for the server side (`readJsonBody`, `writeJsonOk`, `TooLargeError`, `BadJsonError`); added when Task 9 lands the body-reader.
- `zod` — already in the workspace at `^3.x`. No new entry.
- `node:http`, `node:crypto`, `node:child_process`, `node:path`, `node:fs/promises`, `node:os` — Node built-ins.

That's it. No Express, no Koa, no Fastify, no `simple-git`, no `nodegit`, no `body-parser`, no `helmet`. Each of those is a new attack surface (transitive deps, install hooks, parser edge cases) for capability we already have. The listener and handlers are short enough to audit in one sitting; we want to keep that property.

### DevDeps (workspace standard)

`@ax/test-harness`, `@types/node`, `typescript`, `vitest`. Same set every other workspace plugin uses.

### The `git` binary itself

This is genuinely new. The image is built by `container/git-server/Dockerfile` (Task 17), which:

- Bases on `debian-slim:bookworm`. Recommended over Alpine for `git` CVE patch cadence — Alpine's `git` package historically lags upstream more often than Debian-stable's security backports.
- Installs `git` via apt with an explicit version pin (to be filled in at Task 17 when the package is selected; phrasing here is "to-be-pinned" because the version isn't picked yet).
- Runs as non-root UID 1000.
- Direct-execs `node /opt/ax-next/git-server/main.js` — no shell wrapper, so `SIGTERM` reaches Node cleanly.

#### Base-image rebase cadence

**Monthly + on critical CVE.** That's the explicit policy. We rebase the image at the start of each calendar month on the latest `debian-slim:bookworm` digest, and additionally whenever a critical CVE lands against `git` itself or a Debian package we depend on. The CI image-build job records the source digest in the image labels so an operator can pin to "git-server image as of <date>" via tag.

#### Recent CVEs we care about

- **CVE-2024-32002** — RCE via crafted submodule symlink. Mitigated by `protocol.allow=never` in `PARANOID_GIT_ENV`; we never fetch from external sources, and we reject sub-protocols outright.
- **CVE-2024-32004** — clone-from-untrusted RCE. Not applicable; the server only *serves* repos, it never *clones from* an untrusted source. The only inbound is host-driven `git push` of opaque pack bytes, which goes through `receive-pack`, not `clone`.

We're not naming CVEs that don't exist. If a future CVE applies, we'll add it here.

### Pinning

Workspace deps are `workspace:*` (lockfile pins resolved versions). External deps: zero new, so there's nothing new to pin in npm. The base image is pinned by digest in the chart's `gitServerImage.tag`; the `git` package is pinned by apt version in the Dockerfile.

## Known limits

The honest list of what this slice doesn't do, and why.

### Single replica per shard for MVP

Each StatefulSet ordinal is a single pod with a `ReadWriteOnce` PVC. Pod restart drops sessions on that shard until recovery (seconds — the same property today's single-replica `gitServer` Deployment has, applied per-shard). No active/standby HA in this slice; design doc Q#1 leaves this as deferred. Adding `replicas > 1` per shard would require a fundamentally different storage architecture (consensus-backed bare repo, e.g., dragonfly-on-git or external-coordination via a real database).

For MVP this is acceptable; recovery time is "kubelet detects pod gone, schedules new pod, attaches PVC, opens listener" — bounded by your storage class's reattach latency plus a few seconds for Node startup.

### No automated re-sharding

The operator picks `gitServer.shards` at install time. Changing it requires manual workspace migration: drain the canary, rsync the affected bare repos to the new shard layout, flip the host plugin's shard config, restore traffic. This is operational follow-up, not architectural — the architecture *allows* re-sharding, it just doesn't *automate* it. Phase 1 ships with `shards: 1` default; multi-shard works but no automated rebalancing.

### First-time materialize: empty repos are a deliberate contract

`POST /repos` creates an **empty bare repo** — no initial commit, no `refs/heads/main`. The host's first `git ls-remote` sees no `main` and treats this as the empty-baseline case (skip the clone, start the sandbox with empty `/permanent`). The first push from the host creates `main` atomically.

This is the resolution to design doc Q#7. We picked it over the "synthesize an initial commit" alternative because:

- `POST /repos` is purely repo-creation, no implicit history. The sibling's `bootstrap-via-temp-clone-and-push` dance from v1 is gone.
- The host's clone-or-empty case is a 5-line check.
- The contract is documented, tested (Task 25 acceptance test), and surfaces no edge cases we're aware of.

If you read this and think "but what about a host that doesn't handle the empty case correctly?" — that's why Task 25 exists, and why the empty case is exercised end-to-end in CI.

### Token rotation is operationally painful

Inherited from the sibling, with the same shape and the same trade-off. The token lives in a Helm-managed Secret, generated at install time via the lookup-or-generate pattern. Operators rotate by writing a new value into the Secret and rolling-restarting **every** pod that holds it:

1. The git-server **StatefulSet** (rolling, in ordinal order — host pods may briefly fail to reach the rolling shard during the restart of that ordinal).
2. Every **host Deployment** so each host plugin reads the new token at boot.

During rotation there's a window where some pods have the old token and some have the new one. Token mismatch → 401 → host plugin retries exhaust → workspace operations fail loudly until rollouts converge. Real operational pain, flagged so the next person rotating doesn't think they're missing a step.

Future improvement: dual-token acceptance (server accepts `tokenOld OR tokenNew` for the rotation window). Not in this slice.

### No DR (per-shard now, instead of cluster-wide)

Each shard's PVC is the durable source of truth for that shard's workspaces. If one shard's PVC dies, that shard's workspaces are lost. This slice ships zero DR primitives — no backup, no cross-shard replication, no `git bundle` cron, no snapshot lifecycle.

The improvement over the sibling: the **blast radius of "lose a PVC" is now `1/N` of total workspaces** instead of "everything." Same backup recommendations apply per-shard:

- Volume snapshots via the cluster's CSI driver (e.g., AWS EBS snapshots, Longhorn snapshots).
- Cross-zone or cross-region replication if the storage class supports it.
- A `git bundle` cron that ships each shard's bare repos to off-cluster object storage on a schedule.

Pick at least one. Per shard. We're being upfront because "the durable database is on N PVCs and there's no backup" is the kind of detail that's easy to miss until the day it matters.

### Plain HTTP within the cluster, no mTLS

We use plain HTTP between the host pods and the git-server StatefulSet pods. NetworkPolicy is the perimeter; bearer auth is the wall behind it. Same posture as the sibling, same trade-off, same future work.

The threat we're explicit about: if NetworkPolicy is disabled or unsupported (some kind clusters' default CNI doesn't enforce policies), an attacker reachable on the cluster network could attempt requests against the listener. Bearer auth still blocks the call without a stolen token. But "NetworkPolicy is the perimeter" is a real prerequisite — operators running this without policy enforcement should know it.

### Git binary CVE timeline matters

The biggest difference from the sibling's supply chain. The sibling depends on `isomorphic-git` (npm); we depend on the Debian `git` package. CVE-patch latency is now **a function of the Debian security team and our rebase cadence**, not of npm. That's mostly fine — Debian-stable's security backport story is mature — but it means the **monthly + on-critical-CVE rebase cadence is a real operational requirement**, not aspirational. The CI image-build job is the enforcement mechanism.

### No GC for failed applies — better than the sibling, configurable

The sibling carried a "no GC for dangling objects" known limit from `@ax/workspace-git-core` (failed applies leave dangling blobs and trees in `objects/`, disk grows monotonically with churn). The new package can run **native `git gc --auto`** periodically, which is enabled by setting `gc.auto` in the per-repo config at create time. The threshold is configurable via chart values and conservative by default; tuning is operational, not architectural. This is a strictly-better posture than the sibling.

## Boundary review

- **Alternate impl this hook could have:** Yes — Gitea, GitHub Enterprise, GitLab self-hosted. Each gets a small REST CRUD adapter (~50–200 LOC); the data plane is standard git smart-HTTP, which all of them speak natively. Two concrete second/third impls already named in the design doc.
- **Payload field names that might leak:** Two appear on the storage-tier wire: `headOid` (in `GET /repos/<id>` responses) and `default_branch: "main"` (an implicit assumption baked into the bare-repo init). Both are git-shaped vocabulary. **They're exposed only on the storage-tier wire**, never on the bus-level `workspace:*` hooks (which still use opaque `WorkspaceVersion`). The leak stops at the storage-tier wire — Phase 2's host plugin is responsible for translating `headOid` → `WorkspaceVersion` internally and never letting an oid escape into a subscriber-visible payload. Phase 2's plan will include a test that asserts this.
- **Subscriber risk:** N/A in Phase 1. No new subscribers — no plugin registers anything for this server in this PR; that's Phase 2's job (the half-wired window stays open until Phase 2 closes it).
- **Wire surface (REST + smart-HTTP):** REST schemas live in `packages/workspace-git-server/src/server/repos.ts` (Zod, co-located with handlers). Smart-HTTP routes live in `packages/workspace-git-server/src/server/smart-http.ts`. **Not in `@ax/workspace-protocol`** — that package is the legacy JSON-over-HTTP wire and shouldn't carry this slice's schemas. Avoiding the coupling now keeps the two protocols independently auditable and lets us delete the legacy package cleanly in Phase 5.

## What we don't know yet

- Whether the **SIGTERM grace period** (60 s in this slice, bumped from the sibling's 30 s) is enough for in-flight `git receive-pack` draining on large repos. The host plugin's pushes are bounded by network and pack-decode time; for typical workspace sizes 60 s is generous, but a pathological "rebase a huge tree" turn could exceed it. If so, we may need `server.closeAllConnections()` after a deadline. The Task 18 SIGTERM handler is the place this gets adjusted if we find it short.
- Whether **SHA-256-mod-N shard distribution is uniform enough at our scale**. The Task 21 distribution test asserts 10 000 random workspace IDs across 4 shards land within ±5% of uniform, which is plenty for the math. Real-world workspace IDs may be biased (e.g., heavily prefix-clustered if we adopt a `<userId>-<n>` naming convention later), and biased inputs to a hash modulo can defeat the uniformity. We'll watch shard load in production once Phase 2 lands real traffic.
- Whether the **empty-repo first-time-materialize contract** surfaces edge cases when the host pod and the runner sandbox are both fresh on the same workspace at the same time. Task 25's integration test exercises the contract, but it doesn't exercise the *concurrent-first-time* race. Phase 2 may need to revisit if the host plugin sees this case in the wild.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
