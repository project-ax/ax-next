# TASK-152 — subprocess backend parity (docker compose)

Epic: dev-services-in-sandbox. Subprocess half of "bring declared `services` up alongside the sandbox."
Predecessor TASK-150 (merged): `services` field is on `OpenSessionInputSchema`; `ServiceDescriptorSchema`
(canonical in `@ax/skills-parser`, re-validated at the wire in `@ax/sandbox-protocol`). `@ax/validator-service`
registers `services:validate`.

## Problem statement

When `input.services` is non-empty, the subprocess backend (`packages/sandbox-subprocess/src/open-session.ts`)
must bring the declared services up via `docker compose` on a per-session project keyed by `sessionId`, publish
ports only on `127.0.0.1`, wait for health, and tear them down (`docker compose down -v`) in the existing
`child.once('close')` cleanup. Same locked posture as k8s: no host mounts, no `privileged`, no host networking.
Fail loud if Docker is unavailable and services were requested (don't half-open the session). Nothing populates
`input.services` yet (orchestrator fold + k8s sidecars are separate cards) — **half-wired window stays OPEN**.

## Invariants (from card)

- **I2** — neutral descriptor; no k8s/docker vocab crosses the hook boundary. (Our compose object is internal; the
  descriptor in/out is unchanged.)
- **I3** — both backends in one half-wired window; load in both presets where applicable. (Subprocess already
  loaded in the CLI preset via `packages/cli/src/main.ts:250`; the `services` field is additive on the existing
  `sandbox:open-session` hook, so no new preset wiring is needed. k8s sidecar half is a sibling card.)
- **I4** — publish ports only on `127.0.0.1`.
- **I7** — gVisor/broker-agnostic; canary uses JVM Kafka + Mongo. (Our translation is image-agnostic.)
- **I8** — digest-pinned images. (Re-validated by `ServiceDescriptorSchema` at the wire; we pass `image` through.)
- **I10** — no host mounts / privileged / host networking; curated posture. `writablePaths` → `tmpfs:` (ephemeral),
  never a host bind mount.

## Tasks (each independent + testable)

### Task 1 — `compose.ts`: pure descriptor → compose-project translation (TDD)
New module `packages/sandbox-subprocess/src/compose.ts`:
- `composeProjectName(sessionId)` → `ax-svc-<sanitized>` (sanitize to `[a-z0-9_-]`, lowercase, bounded length).
- `descriptorsToComposeProject(services)` → a plain JS object matching a compose file:
  - `services[name] = { image, environment, ports, healthcheck?, tmpfs?, restart: 'no' }`
  - `ports`: each declared port → `"127.0.0.1:<p>:<p>"` (loopback publish, I4).
  - `environment`: descriptor `env` verbatim (record of string→string).
  - `healthcheck`: tcp → `{ test: ['CMD-SHELL', "<tcp probe>"], interval, timeout, retries, start_period }`;
    exec → `{ test: ['CMD', ...command], ... }`. (tcp probe uses a shell test that doesn't need extra binaries
    in the service image — use bash `/dev/tcp`? No: not all images have bash. Use `CMD-SHELL` with a portable
    check is unreliable across images. Decision: for `tcp`, emit a compose healthcheck only when the descriptor
    gave one; map tcp→`CMD-SHELL` `"true"` is wrong. Instead, for tcp we DON'T rely on an in-container binary —
    we wait for health host-side via a TCP connect to the published loopback port (see Task 3). The compose
    `healthcheck` block is emitted ONLY for `exec` (the image author supplied the command); for `tcp` the
    readiness gate is host-side loopback connect.)
  - `tmpfs`: each `writablePaths` entry → a tmpfs mount string (ephemeral, no host bind). **No** `volumes` with
    host paths, **no** `privileged`, **no** `network_mode: host`, **no** `pid`/`ipc` host sharing.
- Asserts (defense-in-depth, even though the wire already validated): name shape, digest-pin present, port range.
- **Tests** (no Docker): image/env/ports/healthcheck(exec)/tmpfs mapped; loopback prefix on every published port;
  NO host bind mount, NO `privileged`, NO host networking key anywhere in the output; project name sanitization;
  empty services → empty `services` map.

### Task 2 — `compose.ts`: injectable command-runner + up/down/probe (TDD)
- `type ComposeRunner = (args: string[], opts: { stdin?: string }) => Promise<{ code: number; stdout: string; stderr: string }>`.
- `composeAvailable(run)` → `docker compose version`; true iff exit 0.
- `composeUp(run, { projectName, composeFile })` → `docker compose -p <project> -f - up -d --wait` with the YAML on
  stdin. (`--wait` blocks until healthy/started for services WITH a healthcheck; host-side tcp wait covers the rest.)
- `composeDown(run, { projectName })` → `docker compose -p <project> -f - down -v` (stdin: the same YAML so compose
  knows the services; or `down` by project name alone — verify which works; prefer `-f -` parity).
- `waitForTcpPorts(host, ports, deadlineMs)` → connect to each `127.0.0.1:<port>` until open or deadline; used for
  `tcp`-healthcheck services (and as a belt for `--wait`).
- **Tests** (no Docker): a fake runner asserts the exact argv + that the YAML is on stdin for up/down/version;
  a down call issues `down -v`; available=false when the runner returns nonzero.

### Task 3 — wire into `open-session.ts` (TDD against a fake compose runner)
- Add a default real `ComposeRunner` (spawn `docker`, pipe stdin, collect stdout/stderr) — injectable via an
  optional last param on `openSessionImpl` so tests pass a fake (mirrors how the file already takes `bus`).
- **Gate first (fail loud):** if `input.services?.length`, call `composeAvailable(run)`; on false throw
  `PluginError({ code: 'services-unavailable', ... })` BEFORE minting session/listener/spawn — no half-open.
- After the runner spawns successfully (services should be alive while the runner runs), bring services up:
  translate → `composeUp` → host-side `waitForTcpPorts` for tcp-health services. On `composeUp` failure, tear down
  (`composeDown`), then unwind session+listener+spawn+tempdir and throw `PluginError({ code: 'services-up-failed' })`.
  (Bring-up happens after env build but the Docker availability probe is the earliest gate.)
- **Teardown:** in the existing `child.once('close')` cleanup, after the session/ipc/tempdir steps, call
  `composeDown(run, { projectName })` — best-effort, warn on failure, never throw. Project name captured in closure.
- **Tests** (fake runner, no Docker): (a) services + Docker-unavailable → `PluginError` 'services-unavailable' and
  session NOT created (assert `session:create` spy not called / no tempdir leak); (b) close path issues
  `compose ... down -v` (fake runner records the down call); (c) services empty / undefined → runner NEVER invoked
  (zero Docker calls — back-compat for the no-services path).

### Task 4 — security-checklist note + PR body
- Invoke `security-checklist` skill; paste the structured note in the PR.
- PR body documents the OPEN half-wired window (consumer shipped; producer = orchestrator fold + k8s sidecars in
  sibling cards) and the boundary review (no new hook surface — `services` field already existed; this is internal
  implementation of `sandbox:open-session`).

## YAGNI pass
- Task 1 translation — load-bearing (the card's core deliverable + primary test target). KEEP.
- Task 2 up/down/probe — load-bearing (bring-up + teardown). KEEP.
- Task 3 wiring — load-bearing (the consume point). KEEP.
- Host-side `waitForTcpPorts` — load-bearing for tcp-health services ("wait for health before returning"); a
  pure-`--wait` approach can't cover tcp descriptors (no in-image probe binary guaranteed). KEEP.
- A compose-file-on-disk path — CUT (STDIN `-f -` avoids it).
- An orchestrator fold / k8s sidecar — OUT OF SCOPE (sibling cards; would break the deliberate half-wired window).

## Security posture (pre-write summary; full note via security-checklist)
- Process spawn: `docker compose` argv is fixed; the only caller-influenced values are the already-wire-validated
  descriptor fields (name `[a-z][a-z0-9-]{0,63}`, digest-pinned image, int ports, capped env, absolute
  writablePaths). No shell — spawn `docker` with an argv array, YAML on stdin. Project name sanitized to compose's
  charset.
- Untrusted input: the descriptor originates from a connector's parsed capabilities (model/admin-authored,
  untrusted). It's zod-validated at the wire (TASK-150) AND we re-assert digest-pin/charset in `compose.ts`
  (defense in depth). env values are passed verbatim into the service container's env only — never into our argv
  or a shell.
- Capability minimization: services get loopback-only published ports (I4), tmpfs scratch (no host fs reach, I10),
  default bridge network (no host networking, I10), no `privileged` (I10). The runner reaches services over
  `127.0.0.1:<port>` exactly as the orchestrator/k8s parity intends.
- Fail-closed: Docker-unavailable-with-services → loud `PluginError`, session never opened.

## Security review (security-checklist output — paste into PR)

- Sandbox: New capability = bring up dev services via `docker compose`, gated behind a
  non-empty `services` array and fail-closed when Docker is absent. `docker` is spawned with a
  FIXED argv array (`shell:false`); the only caller-influenced argv value is the compose project
  name, sanitized to `[a-z0-9_-]` (no flag injection — it's positional after `-p`, leading dashes
  stripped). All descriptor content (image/env/ports/tmpfs/healthcheck) rides on STDIN (`-f -`),
  never argv. Published ports bind ONLY to `127.0.0.1` (I4 — verified via real `docker compose
  config`: `host_ip: 127.0.0.1`). `writablePaths` → `tmpfs` (ephemeral), never a host bind mount;
  no `privileged`, no `network_mode: host`, no host pid/ipc (a unit test asserts the serialized
  project contains none of these). No compose file is written to disk.
- Injection: The `ServiceDescriptor` is untrusted (connector capabilities, model/admin-authored).
  Zod-validated at the wire (`@ax/sandbox-protocol`, TASK-150: name charset, digest-pinned image,
  int ports, capped env, absolute writablePaths) AND re-asserted in `compose.ts` (name regex,
  digest-pin, port range, absolute path). Descriptor strings flow ONLY into the compose JSON on
  stdin → the service container's own config/env; never into our argv or a shell. The exec
  healthcheck becomes a compose `test: ['CMD', ...]` array (no shell). Worst-case env value
  `"; rm -rf / #` is a verbatim container env value, never host-shell-evaluated.
- Supply chain: N/A — no `package.json` / `pnpm-lock.yaml` changes. `compose.ts` imports only
  `node:child_process`, `node:net`, and the existing `@ax/sandbox-protocol` workspace dep.
