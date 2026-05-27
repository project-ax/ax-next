# TASK-51 — Lock broker tools into multi-tenant `allowedTools` (default+locked) — JIT Part II P4

**Branch:** `auto-ship/TASK-51-broker-allowedtools-lock` · **Base:** `main`

## Problem

The two always-on broker host-tools — `search_catalog` and `request_capability` (shipped
in `@ax/skill-broker`, TASK-34, wired into `presets/k8s`) — are only *reachable* where an
agent's `allowedTools` admits them. The tool-dispatcher scope filter
(`packages/mcp-client/src/scope.ts`) admits the whole catalog ONLY for the **empty-empty
wildcard** (`allowedTools: [] && mcpConfigIds: []`, the dev/single-tenant loop). A real
**non-wildcard** multi-tenant agent (any explicit tool or MCP config) does NOT see the
broker tools — so just-in-time capability acquisition isn't a real default.

**Goal (the standalone functional half — TASK-46 was CLOSED, so NO skill-list-row dep):**
lock both broker tools into every multi-tenant agent's effective `allowedTools` as
**default+locked**. "default+locked" = the agent's `allowedTools` admits the tools and a
tenant can't remove them; it does NOT imply any UI list entry.

## Approach

Inject the two broker tool names into `agentConfig.allowedTools` at the **orchestrator
session-open** — `packages/chat-orchestrator/src/orchestrator.ts`, the `const agentConfig`
build (~L844), the single chokepoint every multi-tenant chat turn passes after
`agents:resolve`, and already the home of capability unioning (skills/hosts/creds).

- **default:** every fresh-spawn session-open unions the names in, regardless of the
  stored row.
- **locked:** it's a session-open union, not a stored value — a later
  `PATCH /admin/agents` removing the tools is overridden at the next open.
- **wildcard preserved:** inject ONLY when the scope is already non-wildcard
  (`allowedTools.length > 0 || mcpConfigIds.length > 0`). An empty-empty agent already
  sees the whole catalog (incl. broker) via the wildcard sentinel; injecting would shrink
  it to a broker-only list (regression). Dedup so an agent that already lists a broker
  tool isn't double-appended.
- **I2 (no cross-plugin imports):** orchestrator deps are only `@ax/core` +
  `@ax/sandbox-protocol`; the two names are a LOCAL `const` (mirror-the-shape, like
  TASK-34), not an import from `@ax/skill-broker`.
- **Exclude** `install_authored_skill` (the broker's open-mode 3rd tool) — only the two
  always-on tools.

This propagates everywhere automatically: the frozen `agentConfig` flows into
`sandbox:open-session.owner.agentConfig` (~L1528) → persisted by `session:create` →
returned by `session:get-config` → the tool-dispatcher `tool:list` scope filter admits the
broker tools; and the runner's own defensive `allowedTools` filter
(`agent-claude-sdk-runner/src/main.ts:374`) admits them too.

## Boundary review

Internal-implementation-only change to `@ax/chat-orchestrator`. **No hook-surface change**
(no new/changed service hook, no payload field rename, no new IPC action). Per CLAUDE.md,
internal-only patches don't need boundary review. (Card confirms: "No new tool/hook surface.")

## Tasks (independent, testable)

### Task 1 — Inject broker tools at orchestrator session-open (TDD)
- Add a local module constant in `orchestrator.ts`:
  `const ALWAYS_ON_BROKER_TOOLS = ['search_catalog', 'request_capability'] as const;`
  with a comment explaining the I2 local-mirror + the source of truth
  (`@ax/skill-broker`'s `SEARCH_CATALOG_DESCRIPTOR` / `REQUEST_CAPABILITY_DESCRIPTOR`).
- A small pure helper `withBrokerDefaults(allowedTools, mcpConfigIds)`:
  - if `allowedTools.length === 0 && mcpConfigIds.length === 0` → return `allowedTools`
    unchanged (wildcard preserved);
  - else return `allowedTools` plus any broker tool not already present (dedup,
    append-only, order-stable).
- Use it in the `const agentConfig` build: `allowedTools: withBrokerDefaults(agent.allowedTools, agent.mcpConfigIds)`.
- **Tests** (in `orchestrator.test.ts`, the `lastSandboxInput.owner.agentConfig` seam):
  1. non-wildcard agent → frozen `allowedTools` includes both broker tools appended after
     the agent's own (and `mcpConfigIds` unchanged);
  2. wildcard agent (`allowedTools: [] && mcpConfigIds: []`) → frozen `allowedTools` stays
     `[]` (NOT broker-only);
  3. non-wildcard via `mcpConfigIds` only (`allowedTools: []`, `mcpConfigIds: ['mcp-1']`)
     → frozen `allowedTools` becomes exactly the two broker tools;
  4. dedup — agent already lists `search_catalog` → not duplicated.

### Task 2 — Update the existing change-detector
- `orchestrator.test.ts` ~L1054 asserts `last.owner.agentConfig.toEqual({... allowedTools:
  ['file.read', 'bash.exec'] ...})`. After injection this becomes
  `['file.read', 'bash.exec', 'search_catalog', 'request_capability']`. Update the exact
  expected array (the assertion is a change-detector canary; updating it IS the contract —
  same posture as TASK-34's preset.test.ts).
- Sweep for any OTHER orchestrator test that exact-asserts a non-wildcard
  `agentConfig.allowedTools` flowing to `sandbox:open-session` and update consistently.

### Task 3 — Gate: build + test + lint (whole workspace)
- `pnpm build && pnpm test --filter @ax/chat-orchestrator` then full `pnpm test` + lint.
- Whole-branch: confirm no preset/canary that exact-asserts a non-wildcard agentConfig
  broke (the k8s preset canaries drop the broker and use wildcard-ish stubs — verify).

## Security note (invariant #5)
Locking the broker tools widens what every non-wildcard multi-tenant agent can call. The
two tools are: a read-only catalog search (`search_catalog`) and a shape-validated
capability *request* (`request_capability`, `skillId` validated, drives the human-in-the-
loop approval card — TASK-34/35). No escalation beyond that; full `security-checklist`
walk in Phase 3.
