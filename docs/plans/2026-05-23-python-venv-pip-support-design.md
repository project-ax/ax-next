# Session-scoped Python venv: weak-LLM-friendly `pip install`

**Date:** 2026-05-23
**Status:** Design (approved, pre-plan)
**Scope:** `@ax/agent-claude-sdk-runner` (+ a kind-acceptance walk). No image change, no host-side change, no node change.

## Problem

Inside the runner sandbox today, Python dependency installation does not work for the path a model instinctively reaches for:

- There is no `pip` in the agent image (`container/agent/Dockerfile` installs `python3` + `uv`, **not** `python3-pip`).
- `uvx <tool>` covers the *run-a-CLI* case (fetch-and-run, cache redirected to the ephemeral tier), but it does **not** cover the far more common Python need: *"install a library so my own script can `import` it."*
- The uv-idiomatic answer to that need — `uv run --with <pkg> script.py` — is newer and under-represented in training data. A weaker model will almost certainly type `pip install requests`, hit "command not found", get confused, and burn turns.

So the failure mode we're fixing is specifically: **a weak model wants to use a Python library in a script, types the thing it knows (`pip install X` / `import X`), and it doesn't work.**

Node is explicitly **out of scope**: `npx` already covers the dominant fetch-and-run case, its cache is already redirected to the ephemeral tier, and `npm install -g` would only add a bare-name binary on PATH — a niche need not worth the plumbing, and one that does not even buy cross-session persistence given ephemeral sessions. Revisit only if a concrete tool requires a bare bin on PATH.

## Goal

An agent — *especially a weak model, with zero knowledge of uv idioms* — can type:

```sh
pip install requests
python script.py     # import requests works
```

and it Just Works, with installs subject to the existing egress allowlist.

## Non-goals

- Node `npm install -g` support.
- Adding `python3-pip` to the agent image (uv seeds pip into the venv instead).
- Cross-session persistence of installed packages (the venv is ephemeral by design).
- Teaching the agent uv idioms as the primary mechanism (we make the *familiar* path work; a one-line system-prompt note is a secondary aid for strong models).

## Approach: a pre-seeded, session-scoped virtualenv active by default

At session start, the runner creates a virtualenv in the ephemeral tier and makes it the default Python environment for the SDK subprocess by putting it on `PATH`. Then `python`, `python3`, and `pip` all resolve into that venv — `pip install` writes into it and `python script.py` runs with it, so install-then-import works with no special knowledge.

All three pieces are gated on `env.ephemeralRoot` being present (both real sandbox providers set it: k8s `/ephemeral` emptyDir; subprocess per-session tempdir). When absent (ad-hoc/test callers), the feature is a no-op — Python deps simply won't work, exactly as today.

### Why a venv (not a `pip` shim, not a prompt note)

- A **pre-seeded venv on PATH** matches the universal mental model: there's a `python`, there's a `pip`, `pip install` works, `import` works. Zero special knowledge. Chosen.
- A **lazy `pip` shim → `uv pip`** avoids the always-on venv-create cost but adds a shim script + lazy-create race for marginal benefit (uv venv creation is ~100–300ms). Rejected.
- A **system-prompt note only** (teach `uvx`/`uv run --with`) is the fragile bet we're explicitly avoiding — weak models won't follow it reliably. Rejected as the primary mechanism; kept as a one-line secondary aid for strong models.

### Trigger: eager, every session (decided)

The venv is created at every session start when an ephemeral root exists — not gated on `capabilities.packages.pypi`. Rationale: a weak model on an agent that did **not** declare pypi packages would still type `pip install` and, under a gated approach, hit the exact broken path we're removing. The cost (~100–300ms `uv venv --seed`, uv is fast) is paid once per session even when Python is unused — an acceptable price for "`pip install` always works the instant an agent reaches for it."

## Components

All in `@ax/agent-claude-sdk-runner`, in a new focused module `src/python-venv.ts` (the scaffold spawns a process; the env builder is pure — kept together as one feature, separate from the npx/uvx cache concern in `tool-cache-env.ts`).

### 1. `scaffoldPythonVenv(ephemeralRoot, opts?)` — process spawn

- Runs `uv venv --seed <ephemeralRoot>/py`.
  - `--seed` installs `pip` (and `setuptools`/`wheel`) into the venv, so we do **not** add `python3-pip` to the image.
  - Venv creation is **offline** — uv ships the seed wheels, so this does not touch the proxy/network.
- `uv` binary path: `/usr/local/bin/uv` (image location); allow override via `opts.uvBin` for tests.
- **Idempotent:** if `<ephemeralRoot>/py` already looks like a venv (e.g. `pyvenv.cfg` present), skip — handles warm-runner re-entry.
- **Best-effort:** if `uv` fails (non-zero exit, missing binary), log loudly (not silently — surfaces in runner stderr) and return a failure signal. The caller then skips the env wiring (Component 2), so a Python-venv failure never kills a session that doesn't need Python. This is best-effort *with a loud log*, not a silent swallow.
- Called from `main.ts` at session start, alongside the existing `scaffold*` calls, **after** materialize (consistent ordering with `scaffoldWorkspaceGitignore` / `scaffoldSdkProjectsSymlink`).

### 2. `buildPythonVenvEnv({ ephemeralRoot, currentPath, caCertFile })` — pure env builder

Returns the env overrides spread into the `query()` env literal in `main.ts`, **after** `proxyStartup.anthropicEnv` so they win on `PATH`:

- `PATH` = `<ephemeralRoot>/py/bin:<currentPath>` — venv `python`/`python3`/`pip` resolve first.
- `VIRTUAL_ENV` = `<ephemeralRoot>/py` — tools (and `uv run`) detect the active venv.
- `PIP_CERT` = `caCertFile` — **load-bearing.** pip uses its vendored certifi bundle and ignores both Node's store and `SSL_CERT_FILE`, so without this an HTTPS install through the MITM proxy fails TLS verification.
- `REQUESTS_CA_BUNDLE` = `caCertFile` — belt-and-suspenders for packages whose build steps make their own `requests` calls during install.

Returns `{}` when `ephemeralRoot` is undefined/empty. Omits `PIP_CERT`/`REQUESTS_CA_BUNDLE` when `caCertFile` is undefined (no proxy CA forwarded — e.g. a test/ad-hoc path).

`caCertFile` is sourced in `main.ts` from `proxyStartup.anthropicEnv.SSL_CERT_FILE ?? proxyStartup.anthropicEnv.NODE_EXTRA_CA_CERTS` — the same proxy CA PEM the Node/uv tools already trust.

### 3. `pythonVenvNote(ephemeralRoot)` — system-prompt aid

Appended in `buildSystemPrompt` next to the existing ephemeral-scratch note (same `ephemeralRoot` gate). One line, e.g.:

> *Python: a session-scoped virtualenv is active — use `pip install <pkg>` to add dependencies and `python <script>.py` to run them. Both are discarded when the session ends, and installs are limited to the package registries your agent is permitted to reach.*

Secondary aid for strong models; the venv-on-PATH does the real work for weak ones.

## Data flow (a `pip install`)

```
agent Bash: pip install requests
  → venv pip (PATH resolves to <ephemeralRoot>/py/bin/pip)
  → HTTPS via forwarded HTTPS_PROXY → credential-proxy
       · MITM TLS terminate (leaf cert chained to "AX MITM Proxy CA")
       · CA trusted by pip via PIP_CERT → handshake succeeds
       · egress allowlist gate: pypi host must be allowlisted
            (capabilities.packages.pypi auto-allowlists the registry — sub-project D)
  → installs into <ephemeralRoot>/py/.../site-packages
agent Bash: python script.py  →  import requests  →  works (same venv python)
```

## CA-trust asymmetry (why only pip needs an explicit var)

The proxy MITMs HTTPS by default (`credential-proxy/src/listener.ts`). Every TLS client through it must trust the proxy CA:

| Tool | TLS stack | Trusts proxy CA via | Extra var? |
|---|---|---|---|
| `npm`/`npx` | Node TLS | `NODE_EXTRA_CA_CERTS` (already forwarded) | none |
| `uv`/`uvx` | Rust | `SSL_CERT_FILE` (already forwarded) | none |
| `pip` | vendored certifi | nothing by default | **`PIP_CERT`** (+ `REQUESTS_CA_BUNDLE`) |

This is why the existing npx/uvx paths already work, and why pip is the single genuinely-needed addition.

## Lifecycle & isolation

- The venv lives in the `/ephemeral` tier — dies at session end, never round-trips to the host, never on the git tree (so no bundle bloat, no `.gitignore` entry needed).
- Persists across turns within a pod (same as the npx/uvx caches).
- **Security item — verify, don't assume:** confirm warm-runner keepalive reuse (PR #124) is scoped to the same session/tenant. If a warm pod could be reused for a *different* tenant, the venv (with its installed packages) would be a cross-tenant leak surface — but so would `/ephemeral` and `/permanent` already, so same-session reuse is the expectation. This gets an explicit check in the security note, not a hand-wave.

## Security checklist (invariant #5)

This change spawns a process at session start (`uv venv`), adds env vars into the SDK subprocess, and manipulates `PATH` — it touches the sandbox boundary, so the `security-checklist` skill is run during implementation and a security note is produced. Key points to cover:

- New env vars (`VIRTUAL_ENV`, `PIP_CERT`, `REQUESTS_CA_BUNDLE`, modified `PATH`) carry no secrets — `caCertFile` is a public CA cert path, already present in the subprocess env. No `AX_*`/bearer exposure.
- `pip`/`python` egress remains gated by the same proxy + allowlist as everything else; the venv grants no new network reach.
- The venv directory is inside the already-granted `additionalDirectories: [ephemeralRoot]` — no new filesystem capability.
- Warm-reuse tenant-isolation check (above).

## Testing (TDD + bug-fix policy)

- **`buildPythonVenvEnv` (pure):** returns `{}` without `ephemeralRoot`; `PATH` prepends venv bin (ordering: venv first); `VIRTUAL_ENV` set; `PIP_CERT`+`REQUESTS_CA_BUNDLE` set when `caCertFile` present and omitted when absent.
- **`scaffoldPythonVenv`:** invokes `uv venv --seed <root>/py` with correct argv; idempotent (skips when `pyvenv.cfg` present); best-effort failure path returns the failure signal + logs (no throw that kills the session).
- **`main.test.ts`:** the `query()` env literal carries the python overrides when `ephemeralRoot` is set, and none when unset; scaffold is called after materialize.
- **Manual kind-acceptance walk (the real proof):** in `ax-next-dev`, an agent runs `pip install <allowlisted pkg>` then imports it — synthetic tests can't exercise the live MITM-CA TLS path, so this is the ground truth. Document in `deploy/MANUAL-ACCEPTANCE.md`.

## Files touched (anticipated)

- `packages/agent-claude-sdk-runner/src/python-venv.ts` (new) — `scaffoldPythonVenv` + `buildPythonVenvEnv` + `pythonVenvNote`.
- `packages/agent-claude-sdk-runner/src/main.ts` — call scaffold after materialize; spread `buildPythonVenvEnv(...)` into the `query()` env; pass note through `buildSystemPrompt`.
- `packages/agent-claude-sdk-runner/src/system-prompt.ts` — wire `pythonVenvNote` (or accept it as an arg).
- `packages/agent-claude-sdk-runner/src/__tests__/*` — unit tests above.
- `deploy/MANUAL-ACCEPTANCE.md` — walk step.
- A security note under `docs/plans/2026-05-23-python-venv-pip-support-security-note.md`.

(Final placement of `pythonVenvNote` — its own export vs. folded into `buildSystemPrompt`'s signature — is an implementation detail for the plan.)
