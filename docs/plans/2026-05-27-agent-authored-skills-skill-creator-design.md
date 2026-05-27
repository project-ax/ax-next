# Agent-authored skills: default-on open mode + `ax-skill-creator` built-in

**Date:** 2026-05-27
**Status:** Design — pending implementation plan
**Author:** Vinay (with Claude)

## Motivation

A user asked an agent to "create a Linear skill," then to use it. The agent
wrote a `linear.md` file, then — on the next request — searched the capability
catalog, found nothing, and filed a cold-start request to the admin. It never
used the file.

That is the *designed* behavior in **curated mode**: ax agents do not discover
skills from arbitrary files. Skills are materialized into the sandbox by the
orchestrator from the `@ax/skills` system; the agent's only self-service paths
are `search_catalog` / `request_capability`.

But the capability the user actually wanted — **agents authoring their own
skills** — already exists, gated behind an "open mode" that is OFF by default:

- `install_authored_skill` (`packages/skill-broker/src/tools/install-authored-skill.ts`):
  the agent writes a bundle to `.ax/skills/<id>/SKILL.md`, then calls the tool
  with the hosts + credential slots the skill needs. The host promotes the draft
  to a user-scoped skill carrying those capabilities and fires **one approval
  card** (`chat:permission-request`, `kind:'skill'`, `authored:true`). The user
  approves the hosts and enters the keys before anything runs.
- The tool is registered only when `allowUserInstalledSkills` is true
  (`packages/skill-broker/src/plugin.ts:59`), default `false`, plumbed from the
  chart's `skills.allowUserInstalled` → `AX_ALLOW_USER_INSTALLED_SKILLS` →
  `presets/k8s/src/index.ts:1230` → `createSkillBrokerPlugin(...)`.

Two gaps remain:

1. **Open mode is off by default**, so most agents never get the tool.
2. **There is no authoring guide.** Even with the tool present, the agent gets
   only the tool's one-paragraph description. There is no skill teaching it the
   ax conventions (where to write the bundle, that frontmatter must not declare
   capabilities, how credentials/egress work, the approval-card UX).

This design closes both: flip open mode on by default, and ship an ax-adapted
`skill-creator` skill as a built-in that materializes whenever open mode is on.

## Confirmed mechanics (the constraints the design must respect)

- **Frontmatter must NOT declare capabilities.** A `capabilities:` block in an
  agent-authored `SKILL.md` is stripped on `workspace:pre-apply`
  (`packages/validator-skill/src/frontmatter.ts` +
  `packages/validator-skill/src/plugin.ts`) and independently flagged
  `hasForbiddenCapabilities` by the promote scanner
  (`packages/agents/src/authored-skills.ts:86-92`). Capabilities are granted
  **only** via the arguments to `install_authored_skill` (today `hosts`/`slots`;
  Part E adds `packages`). This is the sandbox-escape backstop: an agent cannot
  self-grant external reach.
- **Materialization union** (`packages/chat-orchestrator/src/orchestrator.ts`):
  `unionedSkills` = explicit attachments (`skills:resolve`) + default-attached
  (`skills:list-defaults`, deduped by id, explicit wins). Each unioned skill is
  mapped to `installedSkillsForSandbox` (`:1448`) as a `SKILL.md` file tree +
  optional helper files, allowed hosts, and credential slots. A skill with empty
  capabilities materializes as pure instructions — no egress/credential effect.
- **Skill discovery in the sandbox** is via the SDK `settingSources:['user','project']`
  pointed at the isolated `$CLAUDE_CONFIG_DIR/skills/` (k8s tmpfs) — never the
  host's `~/.claude`. The host's `~/.claude/skills/linear.md` was unreachable by
  construction.
- **Bundle file rules** (`packages/agent-claude-sdk-runner/src/installed-skills.ts:35-56`):
  `SKILL.md` is the only allowed uppercase filename; helper paths match
  `^[a-z0-9._-]+(\/[a-z0-9._-]+)*$`; `.mcp.json`, `.claude`, `.git` are reserved;
  max path 256 chars, max segment 64.
- **Grammars** (`install-authored-skill.ts:10-16`): skill id
  `^[a-z0-9][a-z0-9._-]{0,127}$`; credential slot `^[A-Z][A-Z0-9_]{0,63}$`
  (SCREAMING_SNAKE); host RFC-1123-ish. The only credential `kind` the manifest
  grammar permits is `api-key`.

## Goals

1. Agents can author a skill end-to-end and have a human approve its capabilities
   — working by default, on every deployment.
2. A discoverable `ax-skill-creator` skill teaches the ax authoring conventions,
   present exactly when the flow it teaches (`install_authored_skill`) is.
3. No weakening of the sandbox-escape backstop: capabilities still require the
   human approval card.

## Non-goals

- No eval/benchmark/description-optimization harness (the Anthropic skill-creator's
  `eval-viewer`, `aggregate_benchmark`, `run_loop`, `.skill` packaging). None of
  that substrate exists in the ax sandbox; porting it is out of scope.
- **No agent-authored MCP servers.** `mcpServers` is the highest-risk capability
  (an arbitrary server process with its own egress/credentials). It stays
  hardcoded-empty in the authored promote; MCP-bundling skills remain admin-only
  via the catalog. The skill-creator documents this limit.
- No new hook surface (see Boundary review).

## A correctness gap this design must close (packages)

The authoring grant path currently carries only **two** of the four capability
kinds. `install_authored_skill` accepts `hosts` + `slots`; the promote
(`packages/agents/src/plugin.ts:399-404`) rebuilds the manifest from those args
and **hardcodes `mcpServers: []` and `packages: { npm: [], pypi: [] }`**. So an
agent-authored skill that needs npm/python has no way to declare it, and
`capabilities.packages` is exactly what drives the orchestrator's registry
auto-allowlist (`orchestrator.ts:1404-1414`: `registry.npmjs.org` for npm;
`pypi.org` + `files.pythonhosted.org` for pypi). With it forced empty,
`npx`/`uvx`/`pip` hit the egress wall.

The fix (Part E) extends the grant path for `packages` while keeping the security
rule intact: capabilities are never self-asserted in frontmatter (still stripped
whole) — they are declared as **install arguments** and surfaced on the human
approval card. Public package registries, so the card line is informational
(auto-included), not a per-host toggle.

## Design

### Part A — the `ax-skill-creator` skill (built-in asset)

A trimmed, ax-adapted fork of
`https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md`,
shipped as a repo asset (no DB row).

**Frontmatter** (name + description only — never a capabilities block):

```yaml
---
name: ax-skill-creator
description: >-
  Use when the user wants to create, author, build, or modify a skill,
  capability, or integration for this assistant — e.g. "make a skill for
  Linear", "add a Jira integration", "turn this workflow into a reusable
  skill", or "update the X skill". Walks authoring a SKILL.md bundle under
  .ax/skills/ and installing it with install_authored_skill so the user can
  approve the hosts and credentials it needs. Use this whenever a new
  capability or integration is requested, even if the user does not say the
  word "skill".
---
```

The description is deliberately "pushy" (combats undertriggering) but scoped to
authoring/integration intent — it is default-attached to **every** agent in open
mode, so it must not hijack unrelated requests.

**Body sections** (target < 500 lines):

1. **The ax authoring loop** — overview: interview → write bundle in
   `.ax/skills/<id>/` → call `install_authored_skill(hosts, slots)` → user
   approves one card → skill installed + usable. Emphasize the human-approval
   backstop up front.
2. **Capture intent / interview** (ported, trimmed) — what it does, when it
   triggers, output, and *which hosts + credentials it needs*.
3. **Write the SKILL.md** (ported, trimmed) — anatomy, progressive disclosure,
   writing patterns + style, the description-writing/"pushy" guidance.
4. **AX-specific rules** (the part that differs from vanilla Claude Code):
   - Write to `.ax/skills/<id>/SKILL.md`; helper files under that dir.
   - id grammar; helper-file naming + reserved names + size limits.
   - **Frontmatter is `name` + `description` only — never a `capabilities:`
     block** (it is stripped/flagged). Everything the skill needs to reach the
     outside world (hosts, credential slots, package ecosystems) is declared as
     an **argument to `install_authored_skill`**, not in the file. One rule, no
     exceptions — that is how the human approves what the skill can do.
   - Credentials: reference the slot as an env var in the body (e.g.
     `$LINEAR_API_KEY`); slot names SCREAMING_SNAKE. Allowed hosts are reachable
     only through the egress proxy, and only the hosts passed at install time.
   - Packages: if the skill runs `npx`/`uvx`/`pip`, declare the ecosystems
     (`packages: { npm?: [...], pypi?: [...] }`) at install time so the public
     registries are allowlisted — without it, package fetches hit the egress wall.
   - **MCP servers are not self-authorable.** A skill that needs to bundle an MCP
     server must be authored by an admin via the catalog; say so rather than
     attempting it.
5. **Install it** — call `install_authored_skill({ skillId, hosts, slots, packages })`.
   The user sees one approval card listing exactly those hosts/keys (and a line
   noting any package registries) and enters the keys; the assistant must **not**
   narrate the step, restate keys, or re-ask the original request — after approval
   the conversation continues automatically. On approval the draft is promoted +
   materialized; available next turn.
6. **Test & iterate** — run a realistic prompt that exercises the skill; to
   change it, edit the bundle and call `install_authored_skill` again. Lightweight,
   human-in-the-loop; no eval harness.
7. **Worked examples** — (a) a Linear skill end-to-end (frontmatter; body using
   `$LINEAR_API_KEY` against `api.linear.app` GraphQL for "issues in the current
   cycle"; install with `hosts:['api.linear.app'], slots:['LINEAR_API_KEY']`); and
   (b) a short package-using example showing the `packages` arg (e.g. a skill that
   runs a `uvx`/`npx` tool, installed with `packages:{ pypi:[...] }`) so the
   ecosystem-declaration path is concrete.
8. **Principle of lack of surprise** (ported) — no malware/exfil skills; intent
   must match the description.

**Explicitly cut:** eval-viewer, `aggregate_benchmark`/`run_loop`, description-
optimization loop, `.skill` packaging/`present_files`, Cowork/Claude.ai sections,
parallel subagent eval orchestration.

Asset home: `presets/k8s/assets/ax-skill-creator/SKILL.md` (read by the preset at
construction). Final location confirmed during implementation.

### Part B — orchestrator built-in injection

- Add `builtinSkills?: ResolvedSkillForOrch[]` to `ChatOrchestratorConfig`
  (`orchestrator.ts:68`). Default `[]`.
- In the union assembly (after the defaults union, `orchestrator.ts:~1390`),
  union builtins at **lowest precedence**: filter out any id already present in
  `unionedSkills` (so an explicit or default-attached skill of the same id wins,
  letting an admin override the built-in). Builtins carry empty capabilities, so
  they have no effect on the package-registry auto-allowlist or egress allowlist.
- No new hook. The field is plain construction config, set once by the preset.

### Part C — preset wiring (the gate)

- In `presets/k8s/src/index.ts`, after resolving `config.allowUserInstalledSkills`
  (`:1230`), load the asset and pass it to the orchestrator:
  `createChatOrchestratorPlugin({ ..., builtinSkills: config.allowUserInstalledSkills ? [axSkillCreator] : [] })`.
- `axSkillCreator` is built once from the asset: split via `@ax/skills-parser`
  (`splitSkillMd` + `parseSkillManifest`) into
  `{ id, manifestYaml, bodyMd, files:[], capabilities:<empty> }`. Fail loud at
  boot if it's malformed (it's our own file — a parse failure is a build bug, not
  a runtime condition).
- The asset must travel **inside the host image**, not be read from a runtime fs
  path that may not exist in the container. Embed it (e.g. a generated string
  constant or a bundler text-import) so it's part of the compiled preset, not a
  loose file the deploy has to mount. (Implementation chooses the mechanism.)
- This couples the built-in's presence to open mode: off → `builtinSkills:[]` →
  not materialized; the `install_authored_skill` tool is also absent, so there's
  no skill teaching an unavailable flow.

### Part D — flip the default

- `deploy/charts/ax-next/values.yaml`: `skills.allowUserInstalled: true`.
- The existing chain lights up: env stamp → `loadK8sConfigFromEnv` →
  `createSkillBrokerPlugin({ allowUserInstalledSkills:true })` (tool registered)
  + the Part C built-in injection (skill materialized).
- Update the `env-shape` chart test and any preset/broker tests that assert the
  default-off posture.

### Part E — packages in the authoring grant path

Close the gap so authored skills can use npm/python, without weakening the
"frontmatter never grants" rule.

- **Tool** (`packages/skill-broker/src/tools/install-authored-skill.ts`): add an
  optional `packages: { npm?: string[]; pypi?: string[] }` input, re-validated at
  the trust boundary like `hosts`/`slots` (package-name grammar; mirror
  `parseSkillManifest`'s authority). Update the tool description so the agent
  knows to declare ecosystems here, not in frontmatter.
- **Promote** (`packages/agents/src/plugin.ts:399-404`): stop hardcoding
  `packages: { npm: [], pypi: [] }`; pass the requested packages through into the
  built manifest. `mcpServers: []` stays hardcoded (non-goal).
- **Card** (`chat:permission-request`, `kind:'skill'` payload + `PermissionCard.tsx`
  + the channel-web server/client re-decls): add an informational packages line
  ("installs npm packages → reaches registry.npmjs.org" / "pypi → pypi.org,
  files.pythonhosted.org"). Public registries, so it is shown, not a per-host
  toggle. Keep the canary + card tests in sync (the payload is re-declared across
  the boundary).
- **Effect:** the promoted user-scoped skill carries `capabilities.packages`, so
  the orchestrator's existing registry auto-allowlist (`orchestrator.ts:1404-1414`)
  lights up `registry.npmjs.org` / `pypi.org` + `files.pythonhosted.org` for that
  session. Names are advisory (the allowlist is registry-level, matching current
  behavior); the plan confirms any runner-side effects (e.g. pip/uv venv seeding)
  are carried.

## Security checklist note

This widens the **default** capability surface (agents can author + propose
capabilities by default), so a full three-threat-model pass goes in the PR. Key
points:

- **Sandbox escape:** unchanged. Agents still cannot self-grant any capability.
  Frontmatter capabilities are stripped/flagged; the only grant path is
  `install_authored_skill`'s args (hosts, slots, **and now packages**), which
  produce a **mandatory** human approval card. `mcpServers` stays unreachable from
  authoring. The `ax-skill-creator` built-in itself has empty capabilities.
- **Prompt injection:** a malicious instruction could coax the agent into
  authoring a skill that requests egress to an attacker host and exfiltrates a
  credential. This is bounded by the same approval card — the human sees the exact
  hosts/slots/registries and must approve. The "authored" banner ("⚠ This is a new
  skill your assistant just wrote") flags the provenance. Worth confirming the card
  renders all grant lines truthfully and is not suppressible.
- **Supply chain:** no new dependencies. The built-in asset is a repo-tracked
  markdown file reviewed like any code. The packages path adds egress to **public**
  registries only (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`);
  the agent already runs arbitrary code in its sandbox, so the incremental reach is
  registry fetch, surfaced on the card.

## Invariants (must hold at merge)

- **I1** — Frontmatter capabilities are never honored from agent-authored skills;
  grants flow only through `install_authored_skill` args → approval card.
- **I2** — The `ax-skill-creator` built-in materializes **iff** `allowUserInstalledSkills`
  is true (gated in the preset). Off-mode deployments see neither the tool nor the
  skill.
- **I3** — Built-ins lose to explicit + default-attached skills on id collision
  (lowest precedence), so a deployment can override the built-in.
- **I4** — The built-in has empty capabilities and must not alter any egress or
  package-registry allowlist.
- **I5** — No new hook surface; `builtinSkills` is construction config only.
- **I6** — No half-wired window: asset + orchestrator field + preset wiring +
  chart flip ship in one PR; the orchestrator field is consumed by the preset in
  the same change.
- **I7** — Packages reach the promoted manifest only via the
  `install_authored_skill` `packages` arg (surfaced on the card), never read from
  the authored frontmatter; an authored skill declaring packages gets the
  registry auto-allowlist, one declaring none does not.
- **I8** — `mcpServers` stays hardcoded-empty in the authored promote; no agent
  authoring path grants an MCP server.

## Boundary review

- **New hook?** No. `builtinSkills` is plain construction config on the
  orchestrator plugin factory, not a hook signature. No transport/storage
  vocabulary crosses a hook boundary.
- **Payload field names that might leak:** none (no new payload).
- **Subscriber risk:** none (no new event).

## Testing

- **Unit (orchestrator):** builtins union into `installedSkillsForSandbox`;
  deduped by id (explicit/default wins); empty-capability builtin adds no host to
  the egress allowlist.
- **Unit (preset):** open mode on → `builtinSkills` non-empty + broker registers
  `install_authored_skill`; open mode off → both absent.
- **Unit (asset):** the shipped `ax-skill-creator` SKILL.md parses via
  `@ax/skills-parser` and declares no capabilities.
- **Unit (broker tool):** `install_authored_skill` accepts `packages`, re-validates
  names at the trust boundary (invalid names filtered), and a missing/empty
  `packages` is a no-op (back-compat).
- **Unit (promote):** the `packages` arg flows into the built manifest
  (`packages/agents/src/plugin.ts`) instead of the hardcoded empty; `mcpServers`
  stays empty (I8).
- **Unit (card payload):** the `kind:'skill'` permission payload carries the
  packages line and the channel-web re-declarations stay in sync (canary + card
  tests).
- **Chart:** `env-shape` test reflects the new default.
- **kind walk (manual acceptance):**
  1. Author the **Linear** skill (hosts + credential, no packages), approve the
     card + enter a key, then "list all Linear issues in the current cycle" →
     live result.
  2. Author a **package-using** skill (declares an npm or pypi ecosystem),
     approve the card, and confirm the skill's `npx`/`uvx`/`pip` step reaches the
     registry instead of hitting the egress wall — exercises the Part E path.

## Open questions / deferred

- Should the built-in appear in the admin skills list (read-only)? Deferred — it
  is intentionally not a store row; the agent discovers it via materialization.
- Subprocess preset: only `presets/k8s` exists today; if a subprocess preset is
  added later it must mirror Parts C + D.
