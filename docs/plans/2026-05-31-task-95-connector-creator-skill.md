# TASK-95 — ax-connector-creator builtin + connector_propose tool + narrow ax-skill-creator

**Status:** Plan
**Branch:** auto-ship/TASK-95-connector-creator-skill
**Epic:** connectors-first-class (design 2026-05-31-connectors-first-class-design.md, Phase 2)

## Problem & scope resolution

The design (line 180) defines the connector-authoring loop as: capture intent →
write a connector draft → call `install_authored_connector(...)` → ONE approval
card → test. TASK-94 shipped the **host-side data plane**: the
`connectors:install-authored` hook (persists a PENDING draft, zero reach) + the
orchestrator firing ONE approval card per pending draft at session-open. But
TASK-94 **deliberately deferred the model-facing caller to TASK-95** (see TASK-94
plan §Scope + §Out-of-scope: "TASK-95: the `ax-connector-creator` builtin SKILL.md
that *drives* the hook + the runner-side install_authored_connector ... tool").

So today the host hook has **no model-facing caller** — an `ax-connector-creator`
SKILL.md telling the agent to "call install_authored_connector" would reference a
tool that doesn't exist (a half-wired skill, invariant #3). TASK-95 must therefore
supply the tool too, even though the card's literal Acceptance lists only the
SKILL.md. (Decision logged in `.claude/memory/decisions.md`.)

**Architecture decision:** the tool is `connector_propose`, a **host-executed**
tool (`executesIn: 'host'`) in a new package `@ax/tool-connector-propose` —
mirroring `@ax/skill-broker`'s `request_capability`, NOT the sandbox-executor+IPC
pattern of `@ax/tool-skill-propose`. Connector args are pure structured JSON the
model produces inline (no `/ephemeral/...` draft dir to read), so the sandbox
executor + IPC action TASK-94's note sketched is unnecessary. The tool reads
`(userId, agentId)` from the host-trusted tool ctx (same as `request_capability`)
and calls `connectors:install-authored` on the bus. The hook is the authoritative
validator (I5 boundary); the tool is a thin scope-stamping adapter with a light
shape check + clean error map.

**Also found:** the current `ax-skill-creator` SKILL.md is STALE — it teaches a
deleted tool (`install_authored_skill`, removed in 4d3d0bc8) + the wrong draft
dir. The live authoring tool is `skill_propose` writing to
`/ephemeral/skill-draft/<id>/` with a `capabilities:` block in frontmatter
(TASK-74). Narrowing ax-skill-creator must also bring it in line with that reality.

## Tasks (independent, testable)

### T1 — `@ax/tool-connector-propose` package: descriptor + host executor
New package mirroring `@ax/tool-skill-propose` scaffolding (package.json, tsconfig,
index.ts) BUT host-executed like `request_capability`.
- `descriptor.ts`: `CONNECTOR_PROPOSE_TOOL_NAME = 'connector_propose'` +
  `CONNECTOR_PROPOSE_DESCRIPTOR` (`executesIn: 'host'`, inputSchema for
  `{connectorId, name, hosts, slots, packages?, mcpServers?, usageNote?, keyMode}`).
  Description carries the spawn-time-discovery guidance (a proposed connector is
  approved/available NEXT turn) + the keyMode meaning.
- `plugin.ts`: `createToolConnectorProposePlugin()` registers `tool:register`
  (descriptor) + `tool:execute:connector_propose` (the host service). The executor
  reads `(ctx.userId, ctx.agentId)`, light-validates the input shape, calls
  `connectors:install-authored`, returns `{ connectorId, status: 'pending' }`.
  Structural rejects from the hook → a model-actionable tool error (mirror
  request_capability / skill.propose error mapping; no plugin-message echo, I9).
- **Tests:** descriptor shape (host-executed, name); executor happy path (forwards
  to hook, returns pending); executor rejects missing/blank connectorId before the
  hook; executor maps a hook validation PluginError to a clean error.

### T2 — `ax-connector-creator` builtin SKILL.md
Under `presets/k8s/src/builtin-skills/ax-connector-creator/SKILL.md`. Frontmatter
`name` + `description` only. Body drives capture→draft→`connector_propose`→approve
→test. Covers: the 4 mechanisms (MCP http/stdio, CLI package, direct API);
keyMode personal vs workspace; the one-card approval + next-turn availability; the
grammars (connectorId, slot names, host names); usageNote; that secrets are env
vars, never literals. No `.ax/draft-skills` / `install_authored_skill` language.

### T3 — Narrow `ax-skill-creator` SKILL.md to know-how
Rewrite so it: (a) no longer authors capability blocks as install-tool args;
(b) uses the LIVE `skill_propose` reality (write to `/ephemeral/skill-draft/<id>/`,
`capabilities:` block in frontmatter, call `skill_propose`); (c) for a skill that
needs reach, instructs ensuring the connector exists — spin one up via
`ax-connector-creator` if absent (composition via the model, not imports, I2) — and
writing the manifest's top-level `connectors: [<id>]` reference list (TASK-92).
Keep the principle-of-lack-of-surprise section.

### T4 — Register both builtins + wire the new tool
- `presets/k8s/src/builtin-skills/index.ts`: `loadBuiltinSkills()` returns
  `[ax-skill-creator, ax-connector-creator]`.
- `presets/k8s/src/index.ts`: register `createToolConnectorProposePlugin()` under
  the same `config.allowUserInstalledSkills` gate as `tool-skill-propose`; add deps
  to `presets/k8s/package.json` + project refs to root `tsconfig.json` AND
  `presets/k8s/tsconfig.json` (TASK-91 gotcha — verify with a filtered build).
- `packages/chat-orchestrator/src/orchestrator.ts`: add `connector_propose` to
  `ALWAYS_ON_BROKER_TOOLS` so a non-wildcard tenant agent sees it (mirror TASK-76's
  skill_propose addition).

### T5 — Tests / preset assertions
- Extend `builtin-skills.test.ts`: asserts both builtins load with empty caps + no
  files + non-empty body; assert ids.
- Update `orchestrator.test.ts` `withBrokerDefaults` + always-on expectations to
  include `connector_propose`.
- Add a preset-level gate test for `createToolConnectorProposePlugin` if symmetric
  to the skill_propose gate (only if there's an existing assertion to mirror).

## Boundary review
- **New hook surface?** No new *service* hook. New host TOOL
  `tool:execute:connector_propose` (the dynamic tool-dispatch exception, same class
  as `request_capability`). It only *calls* the existing `connectors:install-authored`.
- **Alternate impl:** a different connectors backend registering
  `connectors:install-authored` — the tool keys off the hook name + the
  mechanism-agnostic flat args, never a backend field. Fine.
- **Leaking fields:** the descriptor inputSchema names `mcpServers` (with
  transport/command/url INSIDE the spec object) — these stay inside the spec, not
  first-class tool params; `keyMode`/`usageNote`/`hosts`/`slots`/`packages` are
  storage-agnostic. OK.
- **Untrusted input:** the tool forwards model-authored caps to the hook, which
  re-validates authoritatively (I5). The tool does a light shape check + scope
  stamping from ctx (a runner can't author into a foreign agent — ctx is
  host-derived). Run `security-checklist` (plugin loading + untrusted capability
  declaration + builtin-skill loading).

## YAGNI pass
- No connector.install-authored IPC action / sandbox executor (not needed —
  host-executed tool; would be dead code, I3). CUT.
- No new connectors hook (the host data plane is complete from TASK-94). CUT.
