# TASK-142 — Drop `system_prompt` + file-based admin editor + memory-strata seed-from-identity

**Phase 4 of conversational-agent-identity.** Closes the half-wired string-fallback window (Invariant #3). One PR.

## Problem

The `agents_v1_agents.system_prompt` column + its Zod types/validators + the
`agents:create` field + the runner's `buildFallbackPrompt` string-fallback path
are the last remnants of the pre-file identity model. Every agent now has `.ax/`
files (Phases 1–3 + backfill #304); the `.ax/` files are the only source of
truth (Invariant #4). This PR removes the column and the fallback, ships the
file-based admin editor, and reseeds memory-strata from the composed `.ax/`
identity.

## Key design decisions

1. **`AgentConfig` field rename + augment split.** The frozen session-snapshot
   `AgentConfig.systemPrompt` carried two things: (a) the legacy fallback base,
   (b) the `system-prompt:augment` prepend (memory injection). After the drop,
   (a) becomes `displayName` (the runner's fallback identity); (b) stays alive
   on a NEW dedicated field `systemPromptAugment`. Two honest values, not one
   conflated string. Ripples through every `AgentConfig` shape: ipc-protocol,
   session-inmemory, session-postgres, sandbox-protocol, sandbox-k8s,
   sandbox-subprocess, mcp-client, chat-orchestrator, agent-claude-sdk-runner.

2. **Runner fallback removal.** `buildFallbackPrompt` deleted.
   `buildSystemPrompt(displayName, augment, workspaceRoot, ephemeralRoot, venv)`:
   - BOOTSTRAP mode: unchanged (BOOTSTRAP.md verbatim).
   - NORMAL mode: `[augment prepend] + floor + AGENTS.md? + ## Identity
     (IDENTITY.md OR `You are <displayName>, a helpful personal assistant.` when
     no IDENTITY.md) + ## Soul (SOUL.md?) + evolution + notes`. No preset path.
   - The "no `.ax/` files at all" case now ALWAYS produces normal mode with the
     displayName fallback identity (not the legacy preset).

3. **`agents:create` loses `systemPrompt`** (boundary review: a field lost, not
   a hook gained). `AgentInput.systemPrompt`, `validateSystemPrompt`,
   admin-routes `systemPromptSchema` + body fields, store column write/select,
   `Agent.systemPrompt`, `AgentSchema` field all removed.

4. **Column drop migration.** `ALTER TABLE agents_v1_agents DROP COLUMN IF
   EXISTS system_prompt` + remove from CREATE TABLE + `AgentsRow`.

5. **Admin file editor.** `AgentForm.tsx` replaces the "System prompt" textarea
   with Identity / Soul / Operating instructions (advanced → `.ax/AGENTS.md`).
   Read via `GET /admin/agents/:id/identity` (host workspace:read ×3 under owner
   ctx); save via `PUT /admin/agents/:id/identity` (host workspace:apply →
   pre-apply → validator-identity). AGENTS.md created only when advanced field
   non-empty. Existing shadcn primitives only.

6. **memory-strata seed.** `bootstrapMemoryTree` input `agentSystemPrompt` →
   `composedIdentity`. `handleChatStart` reads `.ax/IDENTITY.md` + `.ax/SOUL.md`
   from `ctx.workspace.rootPath` (direct readFile, same as inject.ts) and
   composes `## Identity… ## Soul…`; seeds `system/agent.md` with that.

## Tasks

- **T1 Runner** — delete `buildFallbackPrompt`; `buildSystemPrompt` takes
  `(displayName, augment, …)`; normal-mode displayName fallback; trust-note
  (~L274) updated (validator IS wired). Tests: prompt-engine, system-prompt, main.
- **T2 Orchestrator** — AgentConfig `{displayName, systemPromptAugment}`; augment
  step writes `systemPromptAugment`; drop AgentRecord.systemPrompt. Tests: augment,
  orchestrator, keepalive, route-by-conversation, apply-*-grant.
- **T3 Session snapshot** — rename in ipc-protocol/actions, session-inmemory
  types+plugin, session-postgres store+plugin. Tests: schemas, return-schemas,
  store, plugin.
- **T4 Sandbox protocols** — sandbox-protocol schemas, sandbox-k8s, subprocess,
  mcp-client local shape. Tests for each.
- **T5 agents package** — drop column+field+types+validators+admin schemas;
  remove dead backfill (column gone → nothing to backfill from; #304 already ran;
  remove runIdentityBackfill + test + plugin wiring; check backfillIdentityFile
  callers). Tests: store, admin-routes, migrations, return-schemas, plugin.
- **T6 memory-strata** — bootstrap composedIdentity; handleChatStart reads .ax/
  + composes; resolveAgent drops systemPrompt. Tests: bootstrap, plugin, isolation.
- **T7 channel-web** — new routes-agent-identity (GET/PUT), register +
  workspace:read in calls; AgentForm file editor; lib/admin drop systemPrompt +
  add identity client fns; hydrate-agents drop system_prompt; mocks. Tests:
  identity-route, AgentForm round-trip, admin-agents mock.
- **T8 stubs/onboarding** — dev-agents-stub, onboarding completion-tx,
  admin-reset-bootstrap test.

## Verification
`pnpm build && pnpm test` (full — shared-table drop ripples) + `pnpm lint`
(changed files). Watch acceptance/preset.

## Security (admin editor writes untrusted content)
PUT identity accepts untrusted browser bytes → workspace:apply → pre-apply →
validator-identity (injection scan + bootstrap-window + non-canonical-BOOTSTRAP
veto). Route forbids writing `.ax/BOOTSTRAP.md` (only IDENTITY/SOUL/AGENTS).
CSRF via http-server. Owner-ctx routing.
