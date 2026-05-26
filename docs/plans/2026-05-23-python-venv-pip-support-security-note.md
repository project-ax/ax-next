# Security note — session-scoped Python venv (`pip install` support)

**Date:** 2026-05-23
**Change:** `@ax/agent-claude-sdk-runner` — `python-venv.ts` (`scaffoldPythonVenv` + `buildPythonVenvEnv`), `system-prompt.ts` (`pythonVenvNote`), `main.ts` wiring.

Walked all three threat models (the change spawns a process + adds env vars to the SDK subprocess → sandbox boundary).

## 1. Sandbox escape / capability leakage

- **Process spawn (`scaffoldPythonVenv`):** argv is **fixed** — `uv venv --seed <venvDir>`. argv0 is the literal `'uv'` (resolved via the image PATH; `opts.uvBin` override exists only for tests). `venvDir = path.join(ephemeralRoot, 'py')` where `ephemeralRoot` is `AX_EPHEMERAL_ROOT`, **host-set by the sandbox provider** (k8s pod-spec / subprocess), never model/user/caller-supplied. Spawn uses the **arg array, not a shell**, so even shell metacharacters in the path could not be interpreted. No argv injection.
- **Filesystem:** writes only under `<ephemeralRoot>/py`, inside the ephemeral tier **already granted** to the SDK as an `additionalDirectory`. No new FS reach.
- **Env into SDK subprocess:** fixed names — `PATH` (prepends the venv bin to the already-forwarded PATH), `VIRTUAL_ENV` (host-derived venv path), `PIP_CERT`/`REQUESTS_CA_BUNDLE` (= the **public** proxy CA path already in the subprocess env via `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`). No secrets added; no caller-supplied env *keys* (we write fixed names, we don't read `process.env[userInput]`).
- **Network:** this code opens none. `uv venv --seed` is offline (bundled seed wheels). The agent's later `pip install` egress flows through the **existing** credential-proxy + per-session allowlist — unchanged; `PIP_CERT` only makes pip trust the already-existing MITM CA. The allowlist remains the gate.
- **Cross-tenant leak (verified):** warm-runner keepalive (PR #124) keys `warmSessions` by `sessionId` (orchestrator.ts:535), so a warm pod is reused only for later turns of the **same session**. The venv (and its installed packages) is session-scoped, exactly like `/ephemeral` itself — no cross-tenant exposure.

## 2. Prompt injection / untrusted content

- `pythonVenvNote()` is **fixed runner-authored prose** — it interpolates nothing (not even the venv path). Zero untrusted input.
- `ephemeralRoot` is host-set (not model/user/tool output); it reaches a spawn **arg array** and **env values**, never an interpolated shell/SQL/URL string.
- No model output, tool output, user uploads, or external-API responses touch this code path. The agent's own `pip install <pkg>` is an ordinary agent Bash invocation, gated by the same proxy/allowlist as any command — this PR does not synthesize tool calls from untrusted content.

## 3. Supply chain

- **N/A — no `package.json` change, no new dependency.** `uv` was already added to the agent image (PR #126); `node:child_process`/`fs`/`path` are stdlib.

## PR-body block

```
## Security review
- Sandbox: Spawns `uv venv --seed <ephemeralRoot>/py` — fixed argv, host-set path (AX_EPHEMERAL_ROOT, not caller), arg-array (no shell). New SDK-subprocess env vars (PATH/VIRTUAL_ENV/PIP_CERT/REQUESTS_CA_BUNDLE) carry no secrets (CA path is public, already present); venv lives in the already-granted ephemeral additionalDirectory; egress unchanged (same proxy+allowlist). Warm-reuse is sessionId-keyed → venv is session-scoped, no cross-tenant leak.
- Injection: N/A — pythonVenvNote() is fixed prose; ephemeralRoot is host-set and only reaches a spawn arg-array + env values, never an interpolated command. No model/tool/user/external content in this path.
- Supply chain: N/A — no package.json change, no new dep (uv already in the image, rest is Node stdlib).
```
