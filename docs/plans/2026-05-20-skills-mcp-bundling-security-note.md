# Security review — Phase B (capabilities.mcpServers)

> Companion to `docs/plans/2026-05-20-skills-capability-lifecycle-impl.md`, Phase B (step
> B-design.1). Walks the three threat models that the CLAUDE.md invariant #5 / `security-checklist`
> skill demands. The Phase B PR must paste the **Output contract** block (bottom of this file)
> into its body, and reference this doc for the long form.

## What Phase B changes (capability surface)

1. SKILL.md manifest grammar gains `capabilities.mcpServers: McpServerSpec[]`. The parser
   recognises a new shape and persists it through `manifest_yaml` (opaque text) and the
   typed `SkillCapabilities` projection.
2. The orchestrator unions every attached skill's `mcpServers` into a new per-skill field
   on the sandbox open-session payload (`InstalledSkillForSandbox.mcpServers`).
3. Both sandbox impls (`@ax/sandbox-k8s`, `@ax/sandbox-subprocess`) widen their zod schema to
   accept the new field and pass it through to the runner unchanged.
4. The SDK runner (`@ax/agent-claude-sdk-runner`) writes `${skillDir}/.mcp.json` alongside
   the existing `SKILL.md`, in the Anthropic-SDK-canonical MCP config shape, when the skill
   declares at least one server. The SDK auto-discovers that file and spawns the server in
   the sandbox.

The net effect: an admin-uploaded skill can now declare bundled MCP servers; when an agent
attaches the skill and opens a session, those servers spawn inside that agent's sandbox and
their tools become available to the model.

---

## 1. Sandbox escape / capability leakage

**New reachable capabilities granted to the running agent**, all conditional on an admin
having uploaded a skill that declares them:

- **Process spawn (stdio transport).** The Claude SDK invokes `command + args + env` from
  `.mcp.json`. We mitigate:
  - `command` is whitelisted at parse time. Allowlist: `npx`, `node`, `bun`, `uvx`,
    `python`, `python3`. Anything else → `invalid-mcp-command` at manifest parse.
    Rationale: blocks `/bin/sh`, `curl`, `bash -c …` etc. as command entries.
  - `args` is a string array, capped at 32 entries, each ≤ 256 chars. Passed to the SDK
    in array form, never concatenated into a shell command (the SDK itself uses
    `child_process.spawn` with array args — no shell interpolation). No argv0 control:
    the admin only chooses the trailing args, the SDK fills argv0 from `command`.
  - `env` is a `Record<string, string>` of **non-secret literal values**. The existing
    inline-secret rule from `manifest.ts:33` (`findSecretKey`) recursively walks the
    parsed manifest and rejects any node containing a key in `SECRET_KEYS`
    (`apiKey`, `token`, `password`, `secret`). It already traverses arrays and nested
    objects, so any `env: { apiKey: … }` etc. fails parsing with `inline-secret-forbidden`.
    Real secrets continue to flow through `capabilities.credentials` slots, populated
    via the existing credentials plugin — the slot's `kind: api-key` already routes
    through the credential-proxy.

- **Network reach (http transport).** A skill can declare `url: https://…` for an HTTP MCP
  server. The host is parsed through `URL`, validated against `HOSTNAME_RE` (already used
  for `allowedHosts`), and **implicitly unioned into the skill's `allowedHosts`** by the
  parser. This means the credential-proxy (which gates host reach per agent) sees the host
  in the unioned allowlist and lets requests through — no separate egress decision.
  IPv4 literals, `*` wildcards, `http://`, paths, and schemes other than `https:` are
  rejected at parse time, same as `allowedHosts`.

- **Filesystem paths.** `.mcp.json` is written into `${skillDir}/.mcp.json`, where
  `skillDir = <runner-owned root>/skills/<id>` and `<id>` was validated by `NAME_RE`
  (`/^[a-z][a-z0-9-]{0,63}$/`) at manifest parse. No caller-controlled component reaches
  `path.join`. The file is written with mode `0o444` (read-only after creation) so a
  compromised agent process can't rewrite it to swap `command` mid-session.

- **Array length DoS bound.** `mcpServers.max = 8` per skill, enforced by both the manifest
  parser and the sandbox zod schema (defense in depth — if a future bypass lets a skill row
  carry more than 8, the sandbox still refuses to open the session).

- **Capability hand-off across boundaries.** The orchestrator passes `mcpServers` as
  plain structured data (`{ name, transport, command?, args?, env?, url?, allowedHosts,
  credentials }`) over the hook bus. No opaque handles, no fds, no sockets. The sandbox
  re-validates with zod before materialising — no implicit trust that the orchestrator
  hasn't been compromised in some hypothetical future bug.

**Path-as-token confusion check.** `command` and `args` are command-line fields, named
the way every MCP-config dialect names them; they're not paths being repurposed.
`name` is the MCP server's logical name (used as the `.mcp.json` key), not a filesystem
identifier. `url` is a URL, not a connection-string.

**N/A statement.** Not applicable — this PR adds reachable capability (process spawn +
new network reach + new filesystem write). The mitigations above are all enforced at
parse time and at sandbox-schema validation, so each new capability is bounded.

---

## 2. Prompt injection / untrusted content

**Untrusted strings on this code path:**

- **Manifest text** is admin-uploaded. Admins are the trust anchor for the skills surface
  (they already control `bodyMd` verbatim, which is folded into the model's system prompt).
  Adding `capabilities.mcpServers` does not move the trust boundary — it widens what an
  admin can do, not who can do it.
- **MCP tool outputs.** Once the server is running, its tool-call return values flow back
  through the SDK's standard tool-output channel — the same channel every other MCP tool
  already uses. The SDK presents them to the model as tool results; we don't post-process
  them, render them as HTML, or interpolate them into prompts or commands.
- **`bodyMd` is NOT re-expanded.** We parse the manifest once at upload time. The stored
  `manifest_yaml` is opaque text; on resolve, we re-parse it through the same
  `parseSkillManifest` (no template syntax, no `${…}` interpolation).

**Worst-case walk.** A malicious admin uploads a skill whose `bodyMd` contains adversarial
text aimed at the model AND whose `mcpServers` declares a server that exfiltrates
context. Effect: the agent attached to that skill calls the bad server's tools and
leaks. This is not a new injection path — admins already control `bodyMd` and
`allowedHosts`/`credentials`. The skill review process (admin UI + the upcoming Phase C
`sourceUrl` provenance) is the mitigation, not parser-level rejection.

**No new untrusted destinations.** The new strings we accept (`command`, `args`, `env`
keys/values, `url`) end up in:
- A `.mcp.json` file written by the runner (JSON-encoded — `JSON.stringify` handles
  escaping; no shell or HTML interpolation).
- Passed as zod-validated structured data over the hook bus.

Neither path is a known prompt-injection sink.

**N/A statement.** Not applicable — but the only untrusted-content surface we add is the
manifest itself, and the existing inline-secret recursion + the new command allowlist /
host regex / array-length cap bound the damage a malicious manifest can do.

---

## 3. Supply chain

**Build-time dependencies.** Phase B adds no new entries to any `package.json`. The parser
uses `js-yaml` (already a dep of `@ax/skills`). The zod schema in the sandbox uses `zod`
(already a dep of both sandbox packages). The SDK runner uses `node:fs` (built-in).

**Runtime-fetched MCP server binaries.** A skill declaring
`command: npx, args: ['-y', '@modelcontextprotocol/server-github']` causes the SDK to
shell out to `npx` at session start, which fetches the package from the npm registry into
the sandbox. **This is a real supply-chain surface, but it is the admin's risk — not the
ax-next build's risk.**

- The admin who uploads the skill is implicitly accepting the package they reference.
- The package runs inside the agent's sandbox, with the network reach scoped to the
  skill's `allowedHosts` and the credentials in its declared slots.
- It cannot reach other agents (each sandbox is isolated) or the host process.
- Future hardening (out of scope for Phase B): require `args` to pin a version
  (`@modelcontextprotocol/server-github@1.2.3`) and surface unpinned-server warnings in
  the admin UI. Tracked in Plan 2 ("distribution + infra").

**Supply-chain note for the PR body**: this PR does not touch any `package.json`. Future
unverified-source warnings live in Plan 2, not here.

**N/A statement.** Not applicable as a categorical N/A — we did consider the runtime-fetch
surface above. For *build-time* deps, however: N/A — no `package.json` change in this PR.

---

## Output contract (paste this into the PR body)

```md
## Security review
- Sandbox: Adds MCP-server spawn inside the agent sandbox. Command is parse-time
  whitelisted (npx/node/bun/uvx/python/python3); args/env capped (32 × 256 chars, ≤8
  servers/skill); env values reject SECRET_KEYS via existing inline-secret recursion;
  http url host validated by HOSTNAME_RE and unioned into allowedHosts; .mcp.json written
  to NAME_RE-validated skill dir with 0o444. Sandbox schema re-validates with zod.
- Injection: Manifest text is admin-uploaded (existing trust anchor — admins already
  control bodyMd + allowedHosts). New strings (command, args, env, url) flow into a
  JSON-encoded .mcp.json file and zod-validated hook payloads only — no shell, HTML, or
  prompt-string interpolation. bodyMd is parsed once at upload, never re-expanded.
- Supply chain: N/A for build-time — no package.json changes. Runtime-fetched MCP server
  binaries (e.g. `npx -y @modelcontextprotocol/server-x`) are an admin-accepted risk
  scoped to that agent's sandbox; future unpinned-source warnings tracked in Plan 2.
```
