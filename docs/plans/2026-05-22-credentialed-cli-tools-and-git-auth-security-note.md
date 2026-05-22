# Security-checklist note — credentialed CLI tools & git Basic-auth egress

**Date:** 2026-05-22
**Scope:** Sub-project **B** (git Basic-auth substitution in the credential-proxy MITM path) + sub-project **D** (skill-declared `capabilities.packages` → registry auto-allowlist + `uv`/`uvx`/`python3` in the agent image).
**Invariants:** I1–I7 (design doc §3). I7 mandates this walk.

This is the structured note backing invariant #5 (capabilities explicit and minimized). All three threat models walked; "N/A" lines give a reason.

---

## 1. Sandbox escape / capability leakage

### B — credential-proxy Basic-auth transform
- **Filesystem:** no new paths. N/A.
- **Network:** **no widening.** B changes only *how* the `Authorization`/`Proxy-Authorization: Basic` header is rewritten on the wire for hosts that are **already** session-allowlisted and already MITM'd. No new host, port, or scheme becomes reachable.
- **Process spawn:** none.
- **Env vars:** none new. (`GIT_TERMINAL_PROMPT=0` was already stamped in both sandbox providers; Task B4 only locks it in with a regression test — no new env surface.)
- **Handles:** none cross a hook boundary. `RequestFramer` operates on in-memory `Buffer`s inside one MITM connection; no fd/socket/token is passed in any payload.
- **New surface = a bounded in-memory buffer.** The framer buffers each request **head** up to `maxHeadBytes` (64 KiB) before forwarding; bodies are **never** fully buffered (streamed with the existing per-chunk verbatim substitution). An oversized head falls back to verbatim passthrough (logged) — so a malicious client cannot force unbounded memory growth.
- **Header injection (CRLF):** the transform re-`base64`-encodes the substituted `user:pass`; base64 output cannot contain CR or LF, so a decoded value containing `\r\n` cannot inject a new header. Covered by a unit test (`request-framer.test.ts` "cannot inject CRLF").
- **Path traversal / argv injection / env exfiltration / handle leak / path-as-token:** all N/A — B has no paths, no spawn, no caller-named env reads, no handles, no path-shaped payload fields.

**Verdict (B):** adds a bounded transient buffer + a header-only transform; widens **no** reachable capability. Bodies are never rewritten beyond the pre-existing verbatim substitution (I1).

### D — CLI provisioning
- **Network — this is the one real widening.** When an **admin-installed** skill declares `capabilities.packages.npm`, the orchestrator unions `registry.npmjs.org` into the **session** allowlist; for `packages.pypi` it unions `pypi.org` + `files.pythonhosted.org`. Bounded by: (a) **specific hosts only**, never blanket internet (I5); (b) **only** when the skill declares that ecosystem; (c) the skill is **admin-installed** — the trust boundary for granting a credentialed/egress capability is skill installation, not in-session approval ([[project_credential_egress_via_skills]]).
- **Process spawn:** the agent runs `npx <name>` / `uvx <name>` via Bash — but the agent **already has arbitrary Bash**. D adds no new spawn path; it makes the interpreters present in the image and the registry host reachable. The package **name is never interpolated into a shell by us** (I4) — there is no host-side or orchestrator-side command construction from the name. The canonical command is run by the agent itself, guided by the admin-authored SKILL.md.
- **Image toolset:** `python3` (Debian) + `uv`/`uvx` (static binaries) are added to the runtime image — the intended capability. Land root-owned in `/usr/local/bin`, world-executable, runnable by the non-root `axagent` (UID 1000); verified by the docker smoke (`uv 0.11.16`, `uvx 0.11.16`, `Python 3.11.2`, all as UID 1000).
- **Filesystem / env / handles / path-as-token:** N/A — D adds no caller-provided path, no caller-named env read, no handle in any payload, no path-shaped field.

**Verdict (D):** widens the **session** allowlist to specific public package registries, gated on an admin-installed skill's ecosystem declaration (I5); adds two distro/vendor interpreters to the image. No blanket egress; no new arbitrary-execution path beyond the Bash the agent already has.

---

## 2. Prompt injection / untrusted content

### B
- **Untrusted string:** the decrypted client→upstream bytes are produced by the agent (model-driven — e.g. a `git clone` the model chose to run). The `Authorization: Basic <b64>` value is agent-controlled.
- **Where it ends up:** decoded → **canary-scanned** → placeholder-substituted (verbatim `replaceAll` on the decoded `user:pass`) → re-`base64`-encoded → forwarded **on the wire** to an already-allowlisted upstream. It is **not** interpolated into a shell/SQL/path, **not** rendered as HTML/markdown, **not** concatenated into any prompt.
- **Key new mitigation (canary parity, §4.5):** because the new code *decodes* the Basic blob, a canary token that an attacker base64-wraps to dodge the existing raw-byte `chunk.includes` scan is now caught — the framer scans the **decoded** value and blocks (the same 403/destroy/`event.http-egress` path as the raw-byte hit). Tested in both the unit suite and the MITM integration suite.
- **Worst case:** a prompt-injected agent embeds a canary in a Basic blob to exfiltrate it to an allowlisted host → blocked by the decoded-value canary scan. Replaying a *placeholder* to another allowlisted host is unchanged from today and bounded by the session allowlist + canary. CRLF smuggling is impossible (base64 re-encode).

### D
- **Untrusted string:** the `capabilities.packages` entries are skill-authored manifest content (admin-installed, but treated as untrusted input at the trust boundary).
- **Where it ends up:** parsed + **validated** in `@ax/skills-parser` (ecosystem key checked against a fixed `{npm, pypi}` set → `unsupported-package-ecosystem`; each name checked against `NPM_NAME_RE`/`PYPI_NAME_RE` + length/count caps → `invalid-package`). The validated value is consumed by the orchestrator **only** to decide which fixed registry **host string** to add to the allowlist — the package **name is never used to build a host, a URL, a path, or a command** on the host/orchestrator side.
- **Worst case:** a malicious name like `"; rm -rf / #"` → rejected by `NPM_NAME_RE`/`PYPI_NAME_RE` (whitespace + shell metacharacters excluded by construction); even if validation were bypassed, we never place the name in a shell (I4). An unknown ecosystem (`go`, `cargo`, …) → rejected loudly (`unsupported-package-ecosystem`), never silently accepted.

---

## 3. Supply chain

- **package.json / pnpm-lock:** **N/A — no changes.** Verified: `git diff --name-only origin/main...HEAD | grep -E 'package\.json|pnpm-lock'` → none. B uses only Node built-ins (`Buffer`); D's parser/orchestrator changes are hand-rolled (no new npm dep).
- **New *image* deps (not package.json, but a real supply-chain surface — documented, not hidden):**
  - **`uv`/`uvx` — `ghcr.io/astral-sh/uv:0.11.16`.** Pinned by **version tag** (not digest — digest-pin is a tracked TODO, alongside the existing `tini`/`ca-certificates` pinning follow-up). Maintainer: **Astral** (authors of `uv`/`ruff`) — established, high-trust. Distributed as static Rust binaries `COPY`-ed into `/usr/local/bin`; **no install-time scripts** (it is not an npm package — nothing runs at `COPY`).
  - **`python3` — Debian bookworm (`apt-get`, `--no-install-recommends`).** Distro-maintained; no custom install scripts; resolves to the system interpreter `uvx` reuses (so `uv` never downloads a separate Python build → no extra egress host).
- **Transitive deps:** none added (no npm graph change).

---

## Output contract (paste into PR description)

```
## Security review
- Sandbox: B adds a bounded (64 KiB) in-memory request-head buffer + a header-only Basic-auth transform on already-allowlisted MITM'd hosts (no new host/port/scheme; bodies untouched beyond existing verbatim sub; base64 re-encode prevents CRLF injection). D widens the SESSION allowlist to specific public registries (registry.npmjs.org / pypi.org+files.pythonhosted.org) only when an admin-installed skill declares that ecosystem (I5 — no blanket egress); adds python3 + uv/uvx to the image (agent already had arbitrary Bash, so no new exec path).
- Injection: B decodes agent-controlled Basic blobs only to canary-scan + verbatim-substitute + re-base64-encode onto the wire (never into shell/SQL/path/prompt); the new decode CLOSES a base64-wrapped-canary exfil gap. D validates skill-authored package names (NPM/PYPI name regex + caps; unknown ecosystem rejected) and uses them ONLY to pick a fixed registry host — names are never interpolated into a shell (I4).
- Supply chain: N/A for npm — no package.json / pnpm-lock changes. Image deps: uv/uvx pinned to ghcr.io/astral-sh/uv:0.11.16 (version tag; digest-pin = tracked TODO; Astral, static binary, no install scripts) + python3 from Debian bookworm.
```
