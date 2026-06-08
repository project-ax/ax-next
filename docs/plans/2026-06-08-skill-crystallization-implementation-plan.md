# Skill Crystallization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execute in an isolated worktree/branch off `origin/main`** — NOT the shared main checkout. This work was planned in `.worktrees/skill-crystallization` (branch `feat/skill-crystallization`). The shared checkout has switched branches mid-session before; keep this work isolated.
>
> **ax conventions:** invoke `ax-conventions` before touching plugins/hooks; invoke `shadcn` (with `-c packages/channel-web`) for any UI; invoke `security-checklist` for the propose/scan path. Pre-PR check is `pnpm build && pnpm test && pnpm lint` (scope lint to changed files to avoid stale-worktree noise).

**Goal:** Agents autonomously graduate *recurring, proven* procedures out of episodic memory into durable, auto-active instruction-only skills, via a scheduled per-agent reflection routine — borrowing Hermes' skill-authoring loop, fenced by ax's capability invariant. Per-agent on/off, **default enabled**.

**Architecture:** A system **default routine** (`skill-reflection`) fires per agent on a 24h interval and runs the agent in a hidden per-fire reflection turn. The turn reviews its consolidated memory (`@ax/memory-strata`'s `permanent/memory/system/recent.md` + `docs/`), confirms a procedure recurred across ≥2 conversations, and proposes an instruction-only draft via the existing `skill_propose` tool → `skills:propose`. Because the draft is `origin='authored'` + scan-clean, it lands `status='active'` and the session re-spawns so the same agent sees it next turn (already-shipped projection, PRs #218/#219). Two enabling pieces are net-new — and they are **orthogonal to skills**: (1) a routine-origin signal so reflection (and all routine) turns don't pollute memory; (2) a **generic per-agent override for default routines** (default enabled) that lets a user turn any default routine — skill-reflection being the first consumer — off for a specific agent. The override lives in `@ax/routines`, not skills.

**Enablement model (two levels):**
- **Global master switch** — the existing per-default `enabled` flag (flipped via the existing `routines:upsert-default`). Seed `skill-reflection` `enabled: false`; validate on kind; flip it on once. This is the one-time rollout gate / kill-switch. No new code.
- **Per-agent override** — default **enabled**. Absence of an override row = on. A user may disable skill-reflection for a specific agent. Net-new, generic, in `@ax/routines`.

> Because the per-agent override is **default-enabled** ("absence = on"), it carries **no compatibility risk for the existing `heartbeat` default** — current behavior is unchanged, and the table only ever stores explicit *disables*. (A default-OFF/opt-in design would have needed a backfill; this one doesn't.)

**Tech Stack:** TypeScript, pnpm monorepo, hook-bus plugins, Kysely (Postgres/SQLite), `croner`, vitest, `@ax/test-harness`, shadcn (channel-web).

**Spec:** `docs/plans/2026-06-08-skill-crystallization-design.md` (on `main`). This plan deviates from the spec's open sub-decision #2 ("default OFF, opt-in") — per a later decision the per-agent default is **ENABLED**, and the gating mechanism is a generic routines override rather than a skills-owned toggle.

---

## File Structure (decomposition lock-in)

Four PRs, ordered so nothing is half-wired (invariant #3). Dependency graph: **A** and **B** are independent; **C** depends on **A**; **D** depends on **B** + **C**.

- **PR-A — routine-origin signal + memory guard.** Adds `source?: 'routine' | 'user'` to `AgentContext`; `@ax/routines` stamps `source: 'routine'` on fire contexts; `@ax/memory-strata` skips its observer + consolidator for routine-origin turns. *Independently valuable:* it stops the existing `heartbeat` routine (and any future fire) from polluting agent memory — a latent bug today (verified: `@ax/memory-strata` is the **sole** `chat:end` subscriber, so the guard's entire blast radius is "memory stops ingesting automated turns"). Fully testable alone.
- **PR-B — generic per-agent default-routine override (default enabled).** Adds `agent_default_routine_overrides_v1` (stores disables) + a materialize gate + a de/re-materialize path + `routines:set-agent-default-enabled` + a read hook. Generic routines infra; reachable/testable against the existing `heartbeat` default, so it's wired on its own (not half-wired waiting for skill-reflection).
- **PR-C — the `skill-reflection` routine (the feature).** Seeds the `skill-reflection` system default routine (`enabled: false`) carrying the reflection meta-prompt, plus the wiring canary + capability-fence + no-self-reflection tests. Depends on PR-A (the guard the no-self-reflection test asserts).
- **PR-D — admin UI toggle.** A shadcn `Switch` in agent settings (channel-web) wired to `routines:set-agent-default-enabled`, defaulting to the per-agent enabled state.

| File | PR | Responsibility |
|------|----|----|
| `packages/core/src/context.ts` | A | Add `source?: 'routine' \| 'user'` to `AgentContext` |
| `packages/routines/src/fire.ts` | A | Stamp `source: 'routine'` on the fire context |
| `packages/memory-strata/src/plugin.ts` | A | Guard observer + consolidator: skip `ctx.source === 'routine'` |
| `packages/memory-strata/src/__tests__/observer-guard.test.ts` | A | Routine turn → no observer; user turn → observer runs |
| `packages/routines/src/__tests__/fire.test.ts` | A | Fire ctx carries `source: 'routine'` |
| `packages/routines/src/migrations.ts` | B | `agent_default_routine_overrides_v1` table |
| `packages/routines/src/store.ts` | B | `setAgentDefaultEnabled`, `disabledDefaultIdsForAgent`, materialize gate, de/re-materialize |
| `packages/routines/src/types.ts` | B | `routines:set-agent-default-enabled` / `routines:list-agent-defaults` schemas |
| `packages/routines/src/plugin.ts` | B | Register the two hooks |
| `packages/routines/src/__tests__/agent-default-override.test.ts` | B | default on; disable → de-materialize; re-enable → re-materialize |
| `packages/routines/src/reflection-prompt.ts` | C | The reflection meta-prompt constant (the IP) |
| `packages/routines/src/migrations.ts` | C | Seed `skill-reflection` default (enabled:false) |
| `packages/skills/src/__tests__/crystallization-canary.test.ts` | C | fire → invoke → propose → active; capability-fence; no-self-reflection |
| `packages/channel-web/src/...agent settings...` | D | shadcn `Switch` → `routines:set-agent-default-enabled` |

---

## PR-A — Routine-origin signal + memory guard

**Why first:** `@ax/memory-strata`'s observer + consolidator subscribe to `chat:end` for *every* turn, including routine fires. There is no signal to distinguish a routine fire from a real user chat (verified: the `chat:end` payload carries only `{ outcome }`; `ctx` carries `reqId/sessionId/agentId/userId/conversationId` but no origin). That means the existing `heartbeat` routine's fires already feed memory — a latent pollution bug — and our reflection turns would reflect on themselves. `@ax/memory-strata` is the **only** `chat:end` subscriber (`plugin.ts:246`, `:288`), so fixing the signal here is self-contained. (The routines plugin keys off `chat:turn-end`, a different event — untouched.)

### Task A1: Add `source` to `AgentContext`

**Files:**
- Modify: `packages/core/src/context.ts` (the `AgentContext` interface, ~lines 87–103)
- Test: `packages/core/src/__tests__/context.test.ts` (or the existing context test file)

- [ ] **Step 1: Write the failing test** — assert `makeAgentContext` carries `source` through and defaults to `undefined`.

```typescript
// packages/core/src/__tests__/context.test.ts
import { describe, it, expect } from 'vitest';
import { makeAgentContext } from '../context.js';

describe('AgentContext.source', () => {
  it('defaults to undefined and round-trips when set', () => {
    const plain = makeAgentContext({ reqId: 'r1', sessionId: 's1', agentId: 'a1', userId: 'u1' });
    expect(plain.source).toBeUndefined();

    const routine = makeAgentContext({ reqId: 'r2', sessionId: 's2', agentId: 'a1', userId: 'u1', source: 'routine' });
    expect(routine.source).toBe('routine');
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `pnpm test --filter @ax/core -- context` → FAIL (`source` not on type / not carried).

- [ ] **Step 3: Implement** — add the optional field to `AgentContext` and ensure `makeAgentContext` copies it. Transport-agnostic (it's about *who initiated the turn*, not a backend — invariant #1 holds).

```typescript
// packages/core/src/context.ts — inside the AgentContext interface
  /**
   * Who initiated this turn. 'routine' = a scheduled/automated fire (@ax/routines);
   * 'user' or undefined = a human-driven turn. Subscribers that should only react to
   * human turns (e.g. the memory observer) key off this. Transport/storage-agnostic.
   */
  source?: 'routine' | 'user';
```

(Then thread `source` through `makeAgentContext`'s param object and the returned object, matching how `conversationId` is already threaded.)

- [ ] **Step 4: Run it, verify it passes** — `pnpm test --filter @ax/core -- context` → PASS.

- [ ] **Step 5: Commit** — `feat(core): add AgentContext.source to distinguish routine-initiated turns`

### Task A2: Stamp `source: 'routine'` on fire contexts

**Files:**
- Modify: `packages/routines/src/fire.ts` (the `makeAgentContext({...})` call building `fireCtx`, ~line 101)
- Test: `packages/routines/src/__tests__/fire.test.ts` (extend the existing `fireRoutine` describe)

- [ ] **Step 1: Failing test** — assert the ctx passed to `agent:invoke` has `source === 'routine'`.

```typescript
// in fire.test.ts, alongside the existing per-fire test
it('stamps source=routine on the agent:invoke context', async () => {
  let invokeCtx: any;
  const bus = await makeBus({
    create: async () => ({ conversationId: 'cnv_x', userId: 'u1', agentId: 'agt_a' }),
    invoke: async (ctx) => { invokeCtx = ctx; return { kind: 'complete', messages: [] }; },
  });
  const fire = createFireRoutine({ bus, pending: new Map() } as FireDeps);
  await fire(row(), 'tick');
  expect(invokeCtx.source).toBe('routine');
});
```

- [ ] **Step 2: Run, verify it fails** — `pnpm test --filter @ax/routines -- fire` → FAIL (`source` undefined).

- [ ] **Step 3: Implement** — add `source: 'routine'` to the `makeAgentContext({...})` building `fireCtx`.

```typescript
// packages/routines/src/fire.ts (~line 101)
const fireCtx = makeAgentContext({
  reqId,
  sessionId,
  agentId: row.agentId,
  userId: row.authorUserId,
  conversationId,
  source: 'routine',   // NEW
});
```

- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Commit** — `feat(routines): mark fire contexts as source=routine`

### Task A3: Guard the memory observer + consolidator

**Files:**
- Modify: `packages/memory-strata/src/plugin.ts` (the `chat:end` observer subscriber ~line 246, and the consolidator subscriber ~line 288)
- Test: `packages/memory-strata/src/__tests__/observer-guard.test.ts` (new)

- [ ] **Step 1: Failing test** — a routine-origin `chat:end` does NOT kick off the observer; a user-origin one does. Use the plugin's existing `onObserverSettleReady` test seam (plugin.ts:74) to await/detect the detached chain rather than racing a sleep.

```typescript
// packages/memory-strata/src/__tests__/observer-guard.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { makeAgentContext } from '@ax/core';
import { createMemoryStrataPlugin } from '../plugin.js';
// + the index plugin + a stubbed llm:call:anthropic (observer makes an LLM call)

describe('memory observer routine guard', () => {
  it('skips the observer for source=routine turns', async () => {
    const llmCalls = vi.fn(async () => ({ content: '[]' }));  // observer's extraction LLM
    const h = await createTestHarness({
      plugins: [/* db + memory-strata + its index plugin */],
      services: { 'llm:call:anthropic': llmCalls /*, other stubs */ },
    });
    const ctx = makeAgentContext({ reqId: 'r', sessionId: 's', agentId: 'a1', userId: 'u1', source: 'routine' });
    await h.bus.fire('chat:end', ctx, { outcome: { kind: 'complete', messages: [{ role: 'user', content: 'x' }] } });
    await h.flushMemoryWork?.();   // or the onObserverSettleReady seam
    expect(llmCalls).not.toHaveBeenCalled();
    await h.close();
  });

  it('runs the observer for user-origin turns', async () => {
    // same setup, ctx without source (or source: 'user') → expect llmCalls TO have been called
  });
});
```

- [ ] **Step 2: Run, verify it fails** — observer fires for routine turn → `llmCalls` called → assertion fails.

- [ ] **Step 3: Implement** — early-return in both subscribers.

```typescript
// packages/memory-strata/src/plugin.ts — top of the chat:end observer handler (~line 246)
bus.subscribe<ChatEndPayload>('chat:end', PLUGIN_NAME, async (ctx, payload) => {
  if (ctx.source === 'routine') return undefined;   // NEW: don't reflect on routine/automated turns
  // ... existing kickOffObserver(...) ...
});

// and the consolidator subscriber (~line 288), same early-return at the top.
```

- [ ] **Step 4: Run, verify it passes** (both tests).
- [ ] **Step 5: `pnpm build && pnpm test --filter @ax/memory-strata && pnpm lint` (changed files).**
- [ ] **Step 6: Commit** — `fix(memory-strata): skip observer + consolidator for routine-origin turns`

> **PR-A boundary note:** No new hook surface — `source` is a field on the existing `AgentContext` primitive. Alternate impl: any subscriber that should ignore automated turns reads the same field. No leaked backend vocabulary. Subscriber risk: none — additive optional field; absence preserves today's behavior for human turns.

---

## PR-B — Generic per-agent default-routine override (default enabled)

**Scope note:** this is a *routines* capability, not a skills one. It lets a user turn any default routine off for a specific agent. `skill-reflection` is its first consumer (PR-C), but it also immediately gives users per-agent control of `heartbeat`. Default behavior is **enabled** ("absence of an override row = on"), so nothing about today's `heartbeat` behavior changes.

### Task B1: `agent_default_routine_overrides_v1` table + store reads

**Files:**
- Modify: `packages/routines/src/migrations.ts` (additive table)
- Modify: `packages/routines/src/store.ts` (`setAgentDefaultEnabled`, `disabledDefaultIdsForAgent`, `isAgentDefaultEnabled`)
- Test: `packages/routines/src/__tests__/store.test.ts` (extend)

- [ ] **Step 1: Failing test** — absence reads as enabled; an explicit disable persists; re-enable clears it.

```typescript
it('agent default override: absent = enabled, disable persists, re-enable flips back', async () => {
  expect(await store.isAgentDefaultEnabled({ agentId: 'a1', defaultRoutineId: 'skill-reflection' })).toBe(true); // default on
  await store.setAgentDefaultEnabled({ agentId: 'a1', defaultRoutineId: 'skill-reflection', ownerUserId: 'u1', enabled: false });
  expect(await store.isAgentDefaultEnabled({ agentId: 'a1', defaultRoutineId: 'skill-reflection' })).toBe(false);
  expect([...await store.disabledDefaultIdsForAgent('a1')]).toContain('skill-reflection');
  await store.setAgentDefaultEnabled({ agentId: 'a1', defaultRoutineId: 'skill-reflection', ownerUserId: 'u1', enabled: true });
  expect(await store.isAgentDefaultEnabled({ agentId: 'a1', defaultRoutineId: 'skill-reflection' })).toBe(true);
});
```

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement migration** — additive, prefixed table per convention.

```typescript
// packages/routines/src/migrations.ts — inside runRoutinesMigration, additive
await db.schema
  .createTable('agent_default_routine_overrides_v1')
  .ifNotExists()
  .addColumn('agent_id', 'text', (c) => c.notNull())
  .addColumn('default_routine_id', 'text', (c) => c.notNull())
  .addColumn('owner_user_id', 'text', (c) => c.notNull())
  .addColumn('enabled', 'boolean', (c) => c.notNull())
  .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
  .addPrimaryKeyConstraint('agent_default_routine_overrides_v1_pk', ['agent_id', 'default_routine_id'])
  .execute();
```

- [ ] **Step 4: Implement store methods** — `setAgentDefaultEnabled` (upsert; `ON CONFLICT (agent_id, default_routine_id) DO UPDATE SET enabled, updated_at`), `disabledDefaultIdsForAgent(agentId)` (`SELECT default_routine_id WHERE agent_id = ? AND enabled = false` → `Set`), `isAgentDefaultEnabled` (true unless an `enabled=false` row exists). Match the Kysely style in `store.ts`.

- [ ] **Step 5: Run, verify it passes.**
- [ ] **Step 6: Commit** — `feat(routines): add per-agent default-routine override table (default enabled)`

### Task B2: Gate materialization on the override (default on)

**Files:**
- Modify: `packages/routines/src/store.ts` (`materializeMissing`, ~lines 102–105 + body)
- Test: `packages/routines/src/__tests__/agent-default-override.test.ts` (new)

- [ ] **Step 1: Failing test** — a globally-enabled default materializes for an agent with no override (default on); after disable it does NOT (and an already-materialized instance is removed); after re-enable it materializes again.

```typescript
it('default-on materialization; disable de-materializes; re-enable re-materializes', async () => {
  // seed an enabled default 'heartbeat' (existing) or a fixture default
  await store.materializeMissing({ agents: [{ agentId: 'a1', ownerUserId: 'u1' }], now });
  expect(await store.listForAgent({ agentId: 'a1', userId: 'u1' })).toHaveLength(1); // default ON

  await store.setAgentDefaultEnabled({ agentId: 'a1', defaultRoutineId: 'heartbeat', ownerUserId: 'u1', enabled: false });
  await store.removeMaterializedDefault({ agentId: 'a1', defaultRoutineId: 'heartbeat' }); // de-materialize on disable
  await store.materializeMissing({ agents: [{ agentId: 'a1', ownerUserId: 'u1' }], now });
  expect(await store.listForAgent({ agentId: 'a1', userId: 'u1' })).toHaveLength(0); // gated off, stays off

  await store.setAgentDefaultEnabled({ agentId: 'a1', defaultRoutineId: 'heartbeat', ownerUserId: 'u1', enabled: true });
  await store.materializeMissing({ agents: [{ agentId: 'a1', ownerUserId: 'u1' }], now });
  expect(await store.listForAgent({ agentId: 'a1', userId: 'u1' })).toHaveLength(1); // back on
});
```

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement the materialize gate** — skip materializing a default for an agent if it's in `disabledDefaultIdsForAgent(agentId)`. Keep the existing per-agent `author_user_id` stamping intact (the owner-resolution path `fire.ts` relies on — see the no-synthetic-actor lesson).

```typescript
// inside materializeMissing, per agent:
const disabled = await this.disabledDefaultIdsForAgent(agent.agentId);
for (const def of enabledDefaults) {
  if (disabled.has(def.defaultRoutineId)) continue;   // NEW: per-agent override gate (default on)
  // ... existing upsert one row per (agent, default), author_user_id = agent.ownerUserId ...
}
```

- [ ] **Step 4: Implement `removeMaterializedDefault({ agentId, defaultRoutineId })`** — first check the materialized-routine row schema in `store.ts`: **if a routine row has an `enabled`/`active`/`disabled` flag, flip it off** (preserves fire history); only if no such flag exists, `DELETE` the `(agent, default)` materialized row. The plan deliberately leaves this conditional because it depends on the real routines-row schema — the implementer reads `store.ts` and picks the non-destructive option if available.

- [ ] **Step 5: Run, verify it passes.**
- [ ] **Step 6: Commit** — `feat(routines): gate default-routine materialization on per-agent override`

### Task B3: `routines:set-agent-default-enabled` + `routines:list-agent-defaults`

**Files:**
- Modify: `packages/routines/src/types.ts` (schemas), `packages/routines/src/plugin.ts` (register)
- Test: `packages/routines/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Failing test** — the set hook flips the override + de/re-materializes for the agent (auth-scoped to the caller's ownership); the list hook returns `{ defaultRoutineId, name, enabled }[]` for an agent.

```typescript
it('routines:set-agent-default-enabled disables for one agent; list reflects it', async () => {
  await h.bus.call('routines:set-agent-default-enabled', ctxFor('u1'),
    { agentId: 'a1', defaultRoutineId: 'skill-reflection', enabled: false });
  const list = await h.bus.call('routines:list-agent-defaults', ctxFor('u1'), { agentId: 'a1' });
  expect(list.defaults.find((d: any) => d.defaultRoutineId === 'skill-reflection').enabled).toBe(false);
});
```

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement** — register both services. `set` resolves+authorizes that `ctx.userId` owns `agentId` (existing owner path), calls `setAgentDefaultEnabled`, then `materializeMissing` (enable) or `removeMaterializedDefault` (disable) for that agent. `list` joins the globally-enabled defaults with the per-agent override to compute `enabled`. Schemas live in this plugin's directory.

```typescript
// packages/routines/src/plugin.ts
bus.registerService<SetAgentDefaultEnabledInput, SetAgentDefaultEnabledOutput>(
  'routines:set-agent-default-enabled', PLUGIN_NAME,
  async (ctx, input) => {
    await assertOwnsAgent(bus, ctx, input.agentId);   // existing owner-resolution path
    await store.setAgentDefaultEnabled({ agentId: input.agentId, defaultRoutineId: input.defaultRoutineId, ownerUserId: ctx.userId, enabled: input.enabled });
    if (input.enabled) await store.materializeMissing({ agents: [{ agentId: input.agentId, ownerUserId: ctx.userId }], now: nowFn() });
    else await store.removeMaterializedDefault({ agentId: input.agentId, defaultRoutineId: input.defaultRoutineId });
    return { ok: true };
  },
  { returns: SetAgentDefaultEnabledOutputSchema },
);
// + routines:list-agent-defaults returning { defaults: { defaultRoutineId, name, enabled }[] }
```

- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: `pnpm build && pnpm test --filter @ax/routines && pnpm lint` (changed files).**
- [ ] **Step 6: Commit** — `feat(routines): routines:set-agent-default-enabled + list-agent-defaults hooks`

> **PR-B boundary note:** both hooks — alternate impl: any per-agent routine-pref store. Payload fields `agentId`, `defaultRoutineId`, `enabled` — no backend vocabulary. Subscriber risk: none (commands/reads, not events). Not IPC actions (admin/host-side via existing routes); schemas live in `packages/routines/src/`.

---

## PR-C — The `skill-reflection` routine (the feature)

**Cadence (refines spec open-decision #1):** trigger `kind: 'interval', every: '24h'` (not cron) — matches the `heartbeat` precedent and staggers fires by each agent's materialization time, avoiding a 3am herd.

### Task C1: The reflection meta-prompt

**Files:**
- Create: `packages/routines/src/reflection-prompt.ts`

- [ ] **Step 1: Write the prompt constant** (exercised by the canary; no unit test for a constant).

```typescript
// packages/routines/src/reflection-prompt.ts
export const SKILL_REFLECTION_PROMPT = `You are running an autonomous self-improvement reflection on your own past work. Nobody is waiting on this; it is a background pass.

Your job: graduate procedures you have PROVEN repeatedly into durable skills, and fix skills you've found wrong. A pass that changes nothing is the correct, common outcome — do NOT invent work.

## Step 1 — Short-circuit
Read \`.ax/skill-reflection/last-run.json\` if it exists. If your consolidated memory (\`memory/system/recent.md\`) has not changed since the commit/timestamp recorded there, you are done: reply with exactly REFLECTION_DONE and stop. Otherwise continue, and at the end write the current memory state back to that marker.

## Step 2 — Find recurring procedures
Your consolidated memory (\`memory/system/recent.md\` and \`memory/docs/\`) already represents reinforced, surviving learnings — start there. For any procedure it implies, CONFIRM it actually recurred: it must appear in at least 2 DISTINCT past conversations. You may grep your own transcripts at \`.claude/projects/*/*.jsonl\` to verify and cite the occurrences. If you cannot cite ≥2 distinct conversations, it is NOT ready to be a skill — leave it.

## Step 3 — Crystallize (prefer patch over create)
In order of preference:
1. If an existing skill of yours covers this procedure but is wrong/incomplete, PATCH it.
2. If an existing skill is close, add to it.
3. Only if nothing covers it, CREATE a new skill.
Author/patch the skill, then call the \`skill_propose\` tool to propose it. Keep skills INSTRUCTION-ONLY: do not declare connectors/capabilities. If a procedure genuinely cannot work without a connector, you may declare it — it will go to the user for approval rather than activating — but prefer instruction-only.

## Hard limits
- At most 3 author/patch operations this pass. Pick the highest-value ones.
- Do NOT crystallize: environment-dependent failures, one-off/transient errors, negative claims about a tool ("X doesn't work"), or specifics of a single session. These are memory's job, not a skill's.

## Step 4 — Finish
Update \`.ax/skill-reflection/last-run.json\`, then reply with exactly REFLECTION_DONE.`;
```

- [ ] **Step 2: Commit** — `feat(routines): add skill-reflection meta-prompt`

### Task C2: Seed the `skill-reflection` system default routine

**Files:**
- Modify: `packages/routines/src/migrations.ts` (seed, imitating the `default-heartbeat` seed pattern in `store.test.ts:30–44`)

- [ ] **Step 1: Implement the seed** — `ON CONFLICT (name) DO NOTHING`, `enabled = false` (the global master switch stays off until you flip it via `routines:upsert-default` after the kind walk), `conversation = 'per-fire'` (each fire gets its own hidden conversation), `silence_token = 'REFLECTION_DONE'`, `prompt_body = SKILL_REFLECTION_PROMPT`, interval 24h.

```typescript
// packages/routines/src/migrations.ts — after table creation, seed built-in defaults
await sql`
  INSERT INTO default_routines_v1
    (default_routine_id, name, description, spec_hash, trigger_kind, trigger_spec,
     interval_seconds, silence_token, silence_max, conversation, prompt_body, source_md, enabled)
  VALUES
    ('skill-reflection', 'skill-reflection',
     'Autonomously graduate recurring procedures from memory into durable skills.',
     'seed-2026-06-08',
     'interval', ${'{"kind":"interval","every":"24h"}'}::jsonb, 86400,
     'REFLECTION_DONE', 4000, 'per-fire',
     ${SKILL_REFLECTION_PROMPT}, 'seed', false)
  ON CONFLICT (name) DO NOTHING
`.execute(db);
```

- [ ] **Step 2: Verify idempotency** — run the migration twice in a test; assert one row.
- [ ] **Step 3: Commit** — `feat(routines): seed skill-reflection system default routine (master switch off)`

### Task C3: Crystallization canary + capability-fence + no-self-reflection

**Files:**
- Create: `packages/skills/src/__tests__/crystallization-canary.test.ts`

**Honest scope:** a unit test can't exercise the model's *judgment* (no real LLM). It exercises the **wiring**: a reflection routine whose agent (a stubbed `agent:invoke` that calls the REAL `skills:propose` to simulate authoring) lands an active skill + a re-spawn signal, and whose `chat:end` doesn't pollute memory. The model-judgment half (does it crystallize the *right* things / respect recurrence) is the MANUAL-ACCEPTANCE walk below. **Do not over-mock:** drive the real `skills:propose` with a real owner (no synthetic actor through `agents:resolve` — see that lesson), so an owner/auth regression surfaces here.

- [ ] **Step 1: Canary — wiring lands an active skill.** Stub `agent:invoke` to call the real `skills:propose` with `origin='authored'`, instruction-only manifest; assert returned `status === 'active'` and that `skills:proposed` fired.

```typescript
it('reflection fire → authored instruction-only skill → active + proposed event', async () => {
  let proposedEvent: any;
  h.bus.subscribe('skills:proposed', '@test', async (_c, e) => { proposedEvent = e; return undefined; });
  const invoke = async (ctx: any) => {
    const out = await h.bus.call('skills:propose', ctx, {
      ownerUserId: ctx.userId, agentId: ctx.agentId,
      manifestYaml: 'name: commit-style\ndescription: how we format commits\n',
      bodyMd: '# Commit style\nUse conventional commits.', files: [], origin: 'authored',
    });
    expect(out.status).toBe('active');
    return { kind: 'complete', messages: [] };
  };
  // fire skill-reflection through the real fire path with the stub invoke; assert proposedEvent set
});
```

- [ ] **Step 2: Capability-fence** — same, but the manifest declares a connector → assert `status === 'pending'` (not active). Mirrors `propose.test.ts`.

- [ ] **Step 3: No-self-reflection** — fire skill-reflection; assert the memory observer was NOT invoked (relies on PR-A's `source: 'routine'` guard; assert the extraction LLM stub uncalled).

- [ ] **Step 4: Recurrence-guard (prompt-level).** Assert `SKILL_REFLECTION_PROMPT` contains the "≥2 distinct conversations" and anti-pattern clauses (guards the prompt against regressing). `log()` that behavioral recurrence-gating is covered by the manual walk, not this unit test — don't pretend otherwise.

- [ ] **Step 5: Run, verify, commit** — `test(skills): crystallization wiring canary + capability fence + no-self-reflection`

- [ ] **Step 6: Full gate** — `pnpm build && pnpm test && pnpm lint` (lint scoped to changed files). Invoke `security-checklist` for the propose/scan path before opening the PR.

> **PR-C half-wired window:** the `skill-reflection` routine is reachable from the canary the same PR; its master switch is seeded off intentionally (rollout gate), not half-wiring. Window CLOSED on merge.

---

## PR-D — Admin UI toggle

**Files:**
- Modify: the agent settings surface in `packages/channel-web` (invoke the `shadcn` skill with `-c packages/channel-web`; invoke `ux-design` for label/help copy).

- [ ] **Step 1: Add a shadcn `Switch`** labeled "Skill self-improvement" in agent settings; initial state from `routines:list-agent-defaults` (the `skill-reflection` entry's `enabled`). Default reflects on (per-agent default-enabled).
- [ ] **Step 2: Wire** the switch to `routines:set-agent-default-enabled` ({ agentId, defaultRoutineId: 'skill-reflection', enabled }) via the existing admin-routes pattern (e.g. `@ax/admin-settings-routes`).
- [ ] **Step 3: Copy** (per `ux-design`): "When on, this agent reviews what it's learned and writes its own skills from procedures it's repeated. On by default; turn off to stop it."
- [ ] **Step 4: `pnpm build && pnpm test && pnpm lint`; optional Playwright check via `k8s-acceptance-loop`.**
- [ ] **Step 5: Commit + PR.**

---

## MANUAL-ACCEPTANCE walk (after PR-C; flip the global master switch on first)

Use `k8s-acceptance-loop` against `ax-next-dev`:
0. Flip the `skill-reflection` default's global `enabled` to true (via `routines:upsert-default`).
1. Hold ≥2 short conversations with a test agent that repeat a clear procedure (e.g. "always summarize as 3 bullets").
2. Let memory consolidate, then `routines:fire-now` the `skill-reflection` routine.
3. Assert: a new instruction-only skill appears `active` for that agent (admin UI / `skills:list-authored`), the reflection conversation is hidden, and the next real turn reflects the new skill.
4. Negative: a one-off procedure from a single conversation is NOT crystallized.
5. Per-agent toggle (PR-D): turn the switch off → confirm the routine stops materializing/firing for that agent; turn on → it returns.

---

## Self-Review

**Spec coverage:**
- Trust posture (auto-active, instruction-only, scanned, connectors→approval) → C3 capability-fence + existing `classifyProposal`. ✅
- Two-stage (memory feeds skills) → prompt reads `memory/` (C1); memory loop untouched. ✅
- Scheduled reflection turn via routines → C2 seed + existing fire path. ✅
- Recurrence signal (consolidated-memory + cited ≥2) → C1 prompt + C3 prompt-guard test + manual walk. ✅
- Guard: reflection-eats-itself → PR-A. ✅
- Guard: runaway authoring → C1 "≤3 ops". ✅
- Guard: one-off hardening → C1 recurrence clause. ✅
- No-op short-circuit / last-run marker → C1 Step 1. ✅
- Per-agent enable/disable, **default enabled** → PR-B (generic override) + PR-D (UI). ✅
- Canary (invariant #3) → C3. ✅

**Placeholder scan:** the only non-code task is PR-D (UI), routed through `shadcn`/`ux-design` per repo policy. The one deliberately conditional step is B2 Step 4 (flag-flip vs delete) — left conditional because it depends on the real routines-row schema; the implementer reads `store.ts` and picks the non-destructive option. No `TBD`/"handle errors"/"similar to" placeholders.

**Type/name consistency:** `source: 'routine' | 'user'` (A) used identically in A2/A3/C3. Override hooks `routines:set-agent-default-enabled` `{ agentId, defaultRoutineId, enabled }` + `routines:list-agent-defaults` consistent across B3/PR-D. `skill-reflection` is the `default_routine_id`/`name` everywhere. `REFLECTION_DONE` token consistent (C1/C2). `skill_propose` tool / `skills:propose` hook names match the grounding. Store methods `setAgentDefaultEnabled` / `disabledDefaultIdsForAgent` / `removeMaterializedDefault` consistent across B1/B2/B3.

**Deviations from spec (documented):** (1) per-agent default is **ENABLED**, gated by a generic routines override — supersedes spec open-decision #2's "default OFF, opt-in" (which conflated a generic routines capability into the skills feature). (2) cadence is interval-24h not cron. (3) the "auto-active draft" path is the shipped `skills:propose` DB-row path, not a `.ax/draft-skills/` git file, so the prompt tells the agent to use the `skill_propose` tool rather than hardcoding a draft path.
