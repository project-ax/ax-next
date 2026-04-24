# Security — `@ax/sandbox-subprocess`

This package registers the `sandbox:spawn` service hook. It's a trust boundary — every `tool:execute` call that wants process isolation goes through it. This note captures the walk performed under the `security-checklist` skill for the initial Week 4–6 landing.

## Security review

- **Sandbox:** `child_process.spawn` with `shell:false` and a fixed argv array. `argv[0]` validated against `/^[A-Za-z0-9_./-]+$/` as defense-in-depth (even though `shell:false` already blocks metachar interpretation). `env` strictly built from an allowlist (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `NODE_OPTIONS=''`); caller-supplied env is filtered to the allowlist key set BEFORE merging, and the allowlist merges LAST so parent values always win on collisions. `ANTHROPIC_API_KEY` explicitly verified absent from the child's env via unit test. `cwd` is validated absolute by the Zod schema. `stdio` is `['pipe','pipe','pipe']` — no inherited IPC channel or extra file descriptors. Timeout fires `SIGKILL` (default 30s, cap 300s). `stdout` and `stderr` accumulators cap at 1 MiB each by default with a truncation flag surfaced to the caller. `child.stdin.on('error', ...)` is attached before the first write to absorb EPIPE / ECONNRESET when the child closes stdin early.

- **Injection:** The child's `stdout` and `stderr` are returned as strings. The host layer never interpolates them into another shell, prompt, or SQL query. Content flows into the chat messages array as tool-result content — the model is the expected downstream sink, and `llm:post-call` / `tool:post-call` subscribers are the designed veto / rewrite lever for anything that shouldn't reach the model.

- **Supply chain:** No new runtime dependencies. The package depends on `@ax/core` only; `child_process`, `fs/promises`, and `os` are Node built-ins. `zod` is re-exported through `@ax/core` and not a direct dep.

## Known scope limits (not enforced by this plugin)

These require OS-level primitives beyond `child_process.spawn` and are deferred to Week 7–9 (`@ax/sandbox-k8s`, where pod specs provide the primitives natively) or later hardening of this package:

- **No uid/gid drop.** The child runs as the host user.
- **No `ulimit` / cgroup / namespaces.** No CPU, memory, or fd limits beyond what Node inherits from the host shell.
- **No network isolation.** The child inherits the host's network stack.
- **No filesystem namespace.** The child sees the host's filesystem (subject to the workspace-relative `cwd`).

These limits are acceptable for the subprocess sandbox's stated purpose — preventing casual shell-injection escape and capping resource usage with timeouts and output size caps — but they are NOT sufficient for executing untrusted code. A chat where an external party controls the model's tool-call arguments should run on the k8s sandbox, not this one.

## Boundary review

- **Alternate impl this hook could have:** `@ax/sandbox-k8s` (Week 7–9) — spawns a pod per call. Input and output shapes identical; only the backend differs.
- **Payload field names that might leak:** `argv`, `cwd`, `env`, `stdin`, `timeoutMs`, `maxStdout/StderrBytes`, `exitCode`, `signal`, `truncated`, `timedOut`. All OS-process vocabulary that maps 1:1 to pod-spec equivalents. No git / sqlite / HTTP vocabulary.
- **Subscriber risk:** None — `sandbox:spawn` is a service hook (one producer), not a subscriber hook.
- **Wire surface:** NOT exposed as an IPC action this week. Tool plugins are in-process consumers only. Week 7–9 may wire it through to agent-side tool-local execution — that's a future decision.

## Security review — sandbox:open-session extension (2026-04-24)

- **Sandbox:** Spawns the runner binary via the same hardened `spawn()` shape we already ship for `sandbox:spawn` — `shell: false`, fixed argv (`node <runnerBinary>`), `runnerBinary` validated to be absolute and to exist + be readable before spawn. Env injected: ONLY `AX_IPC_SOCKET`, `AX_SESSION_ID`, `AX_AUTH_TOKEN`, `AX_WORKSPACE_ROOT`, plus the existing parent-merged allowlist (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `NODE_OPTIONS=''`). Caller env is filtered to the allowlist — same rule as `sandbox:spawn` (I5). Auth token never echoed in error messages, never logged at `info` (I9). Unix socket and its parent dir created via `fs.mkdtemp` (mode 0700, I10) so only the host user can connect — the child inherits access because it runs as the same uid, not because the socket is world-readable. On child close / kill, `session:terminate` fires before the handle resolves so a post-exit IPC attempt from a stale token returns 401, not a leaked session. `ipc:stop` + tempdir `rm -r` also run on close — best-effort; failures log at warn and don't block the close.
- **Injection:** Runner gets user input via `session:claim-work` — which is in-process, not a shell interpolation. The auth token is crypto-random; runner never originates it. No caller-provided string reaches `spawn()`'s argv beyond the `runnerBinary` path, which is fixed by config at boot, not per-call.
- **Supply chain:** No new runtime deps. `@ax/ipc-protocol` is a sibling workspace package with its own review (Task 1). No postinstall scripts added.
