# Credentialed CLI tools & git Basic-auth egress — design

**Date:** 2026-05-22
**Status:** Design (approved for plan-writing)
**Scope:** Two sub-projects, **B** (git / Basic-auth) and **D** (CLI tool provisioning), drawn from the larger "non-technical-user seamlessness" gap analysis (2026-05-22 session).

---

## 1. Context & goal

A recurring ax-next goal: a non-technical user installs a skill, and the agent can do something useful that needs a third-party CLI and/or credentialed egress — without the user knowing what a token, registry, or proxy is.

Two pressure-test examples drove this design:

1. **"Check out `https://gitlab.com/smplabs/staff-duress.git` and show me the last 2 commits."** — agent runs `git clone` over HTTPS to an allowlisted host; the clone needs HTTP Basic auth.
2. **"Show me all Linear issues for the Product team in the current cycle."** — agent runs an `npx`-based Linear CLI that reads an API key from the env and calls `api.linear.app` with a Bearer header through the MITM proxy.

### What already works (verified — do not rebuild)

A prior gap analysis (and two exploration sub-agents) wrongly concluded that "MCP credential injection is absent." Direct verification overturned that. The following are **live and correct** today:

- **Bearer / api-key egress for CLIs and the SDK.** A skill's credential slot resolves to a placeholder (`ax-cred:<hex>`), which is injected into the runner env (`proxy:open-session` → sandbox env), forwarded to the SDK subprocess by value-shape (`agent-claude-sdk-runner/src/proxy-startup.ts:209`), inherited by Bash-spawned CLIs, emitted as `Authorization: Bearer <placeholder>`, and substituted verbatim on the wire by the proxy (`credential-proxy/src/registry.ts:62`). **The Linear example's credential path already works** — its only real gap is getting the CLI installed (sub-project D).
- **Remote-MCP credential injection (host-side).** `@ax/mcp-client` stores MCP server configs with `credentialRefs` (stdio env) / `headerCredentialRefs` (http headers), resolves them via `credentials:get`, and injects the **real** secret into the connection from the host (`mcp-client/src/transports.ts:92-199`). It connects host-side (direct egress, no proxy), scopes tools per agent by `mcpConfigIds` (`scope.ts`), and is composed into the live host (`cli/src/main.ts:275,288`). This is the original "sub-project A" — **already implemented**, so it is explicitly out of scope here.

### The actual gaps these examples expose

| Example | Credential path | Real gap (this doc) |
|---|---|---|
| **git clone** (gitlab.com) | ❌ broken — HTTP Basic base64-encodes `user:token`, which corrupts verbatim placeholder substitution | **B** — Basic-auth-aware substitution in the proxy |
| **Linear CLI** (npx + API key) | ✅ already works (env placeholder → Bearer → substitute) | **D** — get the `npx`/`uvx` CLI installed + registry reachable |

---

## 2. Non-goals

- **A — remote-MCP credential injection.** Already implemented (host-side `@ax/mcp-client`). Not touched here.
- **C — OAuth auth-shape** (hosted MCP, GitHub App, Linear's own OAuth MCP). Deferred; its own design.
- **E — JIT onboarding UX** (intent→capability resolution, skill discovery/marketplace, just-in-time credential prompting, in-session host approval). The "seamless for non-technical users" layer; depends on B/D as primitives. Deferred; large, its own brainstorm.
- **Skill-bundled-vs-host-MCP unification.** A skill can declare `capabilities.mcpServers` (transport `http`) that materializes a *credential-less* sandbox-side `.mcp.json`, bypassing the credentialed host-side `@ax/mcp-client`. This is a real invariant #3/#4 item but serves neither example; tracked separately.
- **Go toolchain.** Deferred (≈300 MB+ image weight). Grammar is shaped to extend to it.
- **Private package registries** (private npm/PyPI needing auth). Public registries only for MVP. (B's Basic-auth substitution will help here when we get to it.)
- **Cross-session tool caching.** MVP is per-session ephemeral fetch; caching is a later optimization.

---

## 3. Design invariants

These are the constraints every part of B and D must satisfy. Numbered so the implementation plan and review can reference them.

- **I1 — The proxy stays a substitution + policy engine, not an HTTP-rewriting middlebox.** B adds exactly one bounded transform: decode → reuse-existing-substitution → re-encode, for the `Authorization`/`Proxy-Authorization: Basic` header only. No general request rewriting, no per-host credential *construction* from a host rule.
- **I2 — No real secret enters the sandbox.** Only opaque placeholders (`ax-cred:<hex>`) reach the runner/agent. Substitution of the real value happens on the wire, in the proxy, exactly as today. (B introduces no new credential kind and no new sandbox-visible material.)
- **I3 — Reuse before build.** B reuses the placeholder pipeline and `registry.replaceAll`; D reuses the env-var placeholder path for credentials and `npx`/`uvx` on-demand execution. New surface is minimized to: one proxy transform (B), one manifest field + auto-allowlist + two image additions (D).
- **I4 — No arbitrary skill-supplied commands.** D's `packages` declaration is **name-only**; the runner/agent runs a *canonical* `npx <name>` / `uvx <name>`, never a skill-provided shell string (mirrors the existing `MCP_COMMAND_ALLOW` posture in `skills-parser`).
- **I5 — Egress stays default-deny + allowlist-gated.** D auto-unions only the specific public registry hosts for ecosystems the skill actually declares. No blanket internet access.
- **I6 — Hook surface stays transport/storage-agnostic.** No new leaky field names; the credential and egress models don't gain git/npm/k8s vocabulary in shared payloads.
- **I7 — Security-checklist is mandatory for both.** B touches the MITM/sandbox boundary; D touches sandbox egress, new image dependencies, and untrusted skill-declared content. The `security-checklist` skill runs during implementation of each.

---

## 4. Sub-project B — git / Basic-auth via Basic-aware substitution

### 4.1 The problem

HTTP Basic auth puts `base64("<username>:<password>")` on the wire. The placeholder lives in the password position, which is almost never a 3-byte boundary, so `base64("ax-cred:<hex>")` is **not** a substring of `base64("oauth2:ax-cred:<hex>")` — the boundary base64 chars mix bits from the `oauth2:` prefix with the start of the placeholder. Verbatim substitution (`registry.replaceAll`) therefore silently misses it, and a corrupted placeholder reaches the upstream → auth fails.

### 4.2 Mechanism (α1: Basic-auth-aware decode/sub/re-encode)

In the credential-proxy MITM request path (`credential-proxy/src/listener.ts`):

1. **Buffer the request head.** Accumulate decrypted client→upstream bytes until end-of-headers (`\r\n\r\n`), bounded to a max head size (e.g. 64 KiB). If exceeded, stop buffering and pass through with the existing per-chunk substitution + log. This also fixes a **latent bug**: a plaintext placeholder split across TCP segments is currently never substituted by the per-chunk path.
2. **Transform the auth header.** In the buffered head, find `Authorization:` / `Proxy-Authorization:` whose scheme is `Basic` (case-insensitive). Base64-**decode** the value, run the existing `registry.replaceAll` on the decoded `user:pass` string, and if it changed, re-base64-encode and splice the new value back into the head.
   - Position-agnostic: works whether the placeholder is the password (`https://oauth2:TOKEN@host`) or the username (`https://TOKEN@host`).
3. **Forward + stream body.** Emit the (possibly modified) head upstream, then stream the body with the existing per-chunk verbatim substitution untouched (Bearer/api-key placeholders in bodies/URLs keep working).

### 4.3 Credential & agent UX

- **No new credential kind.** The PAT is stored as a plain `api-key`. The username is not a secret and is supplied by the agent in the clone URL.
- **Skill declaration (existing grammar):** `allowedHosts: ['gitlab.com']` + a credential slot, e.g. `GITLAB_TOKEN` (kind `api-key`).
- **SKILL.md instruction:** tells the agent to clone with `https://oauth2:$GITLAB_TOKEN@gitlab.com/<path>.git`. `$GITLAB_TOKEN` is the placeholder env var (existing path). git base64-encodes `oauth2:ax-cred:<hex>`; the proxy decodes → substitutes → re-encodes.
- **`GIT_TERMINAL_PROMPT=0`** is stamped into the runner env (a `GIT_`-prefixed var already forwarded by `proxy-startup.ts`) so a missing/invalid credential fails fast instead of hanging on an interactive prompt.

Example skill manifest fragment:

```yaml
name: gitlab-readonly
capabilities:
  allowedHosts: [gitlab.com]
  credentials:
    - slot: GITLAB_TOKEN
      kind: api-key
      description: GitLab personal access token (read_repository scope)
```

### 4.4 Edge cases

- Token-in-password and token-in-username both handled (substitution runs on the decoded `user:pass`).
- Placeholder split across TCP segments — handled by head buffering.
- Oversized head — pass through, logged.
- Non-`Basic` schemes (`Bearer`, `Digest`) — left to existing verbatim substitution (Bearer already works; Digest unsupported).
- Multiple/duplicate auth headers — transform each occurrence found in the head.

### 4.5 Security (checklist required — MITM boundary)

- **No header-splitting risk:** re-encoding to base64 cannot emit CR/LF, so a malicious decoded value can't inject new headers.
- **No secret logging:** the decoded `user:pass` is never logged; errors name the header, not the value.
- **Canary parity:** run the existing canary scan on the **decoded** Basic value too, so a base64-wrapped exfiltration attempt isn't blinded by the new decode step.
- **Bounded memory:** head buffer is capped; bodies are never fully buffered.
- Residual model risk (prompt-injected agent replaying a placeholder to another allowlisted host) is unchanged from today and bounded by the session allowlist + canary.

### 4.6 Files touched (B)

- `packages/credential-proxy/src/listener.ts` — request-head buffering + Basic-auth transform in the MITM path.
- `packages/credential-proxy/src/registry.ts` — small helper to substitute within a decoded string (reuses `replaceAll`); possibly expose canary-scan-on-string.
- `packages/credential-proxy/src/__tests__/` — new tests (§4.7).
- Sandbox env: stamp `GIT_TERMINAL_PROMPT=0` (`sandbox-k8s` pod-spec / `sandbox-subprocess` open-session, alongside existing `GIT_*`).

### 4.7 Tests (B)

- Token-in-password and token-in-username Basic blobs are substituted correctly.
- Placeholder split across two chunks is substituted (regression for the latent gap).
- Oversized head passes through and logs.
- `Bearer`/non-Basic schemes are untouched.
- A canary token inside a Basic blob is detected and blocked.
- End-to-end: a stubbed upstream sees the real credential after a `git clone`-shaped request.

### 4.8 Boundary review (B)

- **Alternate impl:** none new — this is internal to `@ax/credential-proxy`; no hook-surface change. (Internal-only patch per CLAUDE.md boundary-review exemption.)
- **Leaky field names:** none — no payload shape changes.

---

## 5. Sub-project D — CLI tool provisioning (managed)

### 5.1 The problem

A skill needs a third-party CLI (npm or python package) that the agent runs via Bash, which then makes credentialed HTTP requests through the proxy. Today the image has `node`/`npm`/`npx` + `git`/`git-lfs` but **no** python/uvx/go, and package registries aren't reachable unless a host is on the session allowlist. A non-technical user shouldn't have to know about interpreters or registry hostnames.

### 5.2 Grammar

Extend `capabilities` (in `@ax/skills-parser`) with a **name-only** package declaration:

```yaml
capabilities:
  packages:
    npm:  ['@linear/cli']        # run via `npx <name>`
    pypi: ['some-tool']          # run via `uvx <name>`
```

- Name-only (no versions-with-shell, no arbitrary commands) — I4. Validation mirrors the existing array/length caps and the inline-secret scan.
- `ResolvedSkill.capabilities` gains `packages`; `skills:resolve` re-parses it from the stored manifest like the rest of `capabilities`.

### 5.3 Registry egress (auto-allowlist)

In `chat-orchestrator` (where `unionedAllowlist` is built, `orchestrator.ts:971-1006`): when any attached skill declares `packages.npm`, union `registry.npmjs.org`; when any declares `packages.pypi`, union `pypi.org` + `files.pythonhosted.org`. The user/author never hand-allowlists a registry (I5).

### 5.4 Runtime

- **node:** no install step — the agent runs `npx <name>`, which fetches-and-runs on demand using the npx cache (works as non-root). npm support is therefore *just the registry allowlist*.
- **python:** the agent runs `uvx <name>`, which fetches-and-runs the tool in an ephemeral environment using the system `python3`. No `pip`, no venv management by us.
- **credentials:** reach the CLI via the existing env-var placeholder path (already verified). Bearer/api-key CLIs work as-is; a Basic-auth CLI benefits from B.
- **No runner pre-install step** for MVP (on-demand matches npx/uvx design). Pre-warming is an optional later optimization.

### 5.5 Image changes (`container/agent/Dockerfile`)

- `COPY --from=ghcr.io/astral-sh/uv:<pinned-version> /uv /uvx /usr/local/bin/` — single, pinnable, lightweight (Rust static binaries).
- `apt-get install -y --no-install-recommends python3` — system interpreter for `uvx` to use, so uv never needs to download a Python build (no extra egress host). If a tool requires a Python version incompatible with bookworm's `python3`, it fails with a clear error; allowlisting the python-build-standalone host is a follow-up.

### 5.6 Decisions (defaulted)

- **Persistence:** per-session ephemeral fetch. No caching infra for MVP (YAGNI). Cost: npx/uvx re-fetch latency per session. Caching deferred.
- **Ecosystems:** node (works now) + python (via uvx). **Go deferred.** A `packages.go` declaration is rejected with a clear "not yet supported" error; grammar is shaped to add it later.

### 5.7 Security (checklist required — egress + new deps + untrusted content)

- **Supply chain:** auto-allowlisting `registry.npmjs.org` / PyPI lets the sandbox reach the *whole* public registry, so a prompt-injected agent could `npx`/`uvx` an arbitrary package. Bounded by: admin-installed skill declares the ecosystem (trust boundary), the session allowlist, the canary scanner, and the fact that the agent already has arbitrary Bash. Acceptable for MVP; documented, not hidden. Per-package allowlisting is a possible later tightening.
- **New image deps:** `uv`/`uvx` pinned by version (digest-pin as a follow-up alongside the existing ca-certificates/tini pinning TODO); `python3` from Debian.
- **Untrusted manifest content:** `packages` entries are validated (name shape, length caps) and never interpolated into a shell.

### 5.8 Files touched (D)

- `packages/skills-parser/src/manifest.ts`, `capabilities.ts` — `packages` grammar + validation + types.
- `packages/skills/src/_row-mappers.ts` (+ resolve path) — carry `packages` through `skills:resolve`.
- `packages/chat-orchestrator/src/orchestrator.ts` — auto-union registry hosts by declared ecosystem.
- `container/agent/Dockerfile` — `uv`/`uvx` + `python3`.
- Tests across the above.

### 5.9 Tests (D)

- Manifest parses `packages.npm` / `packages.pypi`; rejects `packages.go` with a clear message; rejects malformed names.
- Orchestrator auto-unions `registry.npmjs.org` for npm and `pypi.org`+`files.pythonhosted.org` for pypi; unions nothing when no packages declared.
- Image smoke test: `uv`, `uvx`, `python3` are present and executable as the non-root user.
- End-to-end (or harness-level): a skill declaring an npm CLI runs `npx <name>` through the proxy and authenticates against a stubbed upstream.

### 5.10 Boundary review (D)

- **Alternate impl:** the `packages` capability is parsed/owned by `@ax/skills-parser` and consumed by the orchestrator's allowlist union — no new service hook. (`skills:resolve` shape gains an additive field; existing subscribers unaffected.)
- **Leaky field names:** `packages.npm` / `packages.pypi` are ecosystem names, not backend/storage vocabulary — acceptable.

---

## 6. Half-wired window

B and D each land their producer + consumer in the same PR:

- **B:** the proxy transform is exercised by the new tests and reachable from the credential-proxy's own acceptance path; no plugin is left half-wired.
- **D:** the `packages` grammar, the orchestrator auto-allowlist, and the image additions ship together. A skill declaring `packages` must be runnable end-to-end (registry reachable + tool present) within the same PR, or D doesn't merge.

---

## 7. Roadmap context

This doc is B + D of a five-part decomposition from the 2026-05-22 gap analysis:

- **A** — remote-MCP credential injection — *already shipped* (host-side `@ax/mcp-client`).
- **B** — git / Basic-auth — *this doc*.
- **C** — OAuth auth-shape — deferred.
- **D** — CLI tool provisioning — *this doc*.
- **E** — JIT onboarding UX (discovery, intent→capability, JIT credential prompting, in-session approval) — deferred; the layer that makes A–D actually *seamless* for non-technical users.
