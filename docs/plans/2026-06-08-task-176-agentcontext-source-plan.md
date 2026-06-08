# TASK-176 — AgentContext.source + memory guard (skill-crystallization PR-A)

**Branch:** `auto-ship/TASK-176-agentcontext-source`
**Epic:** skill-crystallization (`docs/plans/2026-06-08-skill-crystallization-design.md`)
**Role:** PR-A, the root primitive that TASK-178 (skill-reflection routine) builds on.

## Problem

`@ax/memory-strata` is the memory-extraction subscriber on `chat:end` (observer +
consolidator). A `@ax/routines` scheduled fire runs a hidden, non-user conversation
through the same `agent:invoke` path, so its `chat:end` currently feeds the memory
extractor — polluting the agent's episodic memory with routine-internal turns (the
existing heartbeat routine already does this). The skill-crystallization design also
needs a `skill-reflection` routine that must NOT reflect on its own reflection turns.

Both need the same primitive: a way to mark a context as originating from a routine
fire, and a guard in the memory observer/consolidator that skips routine-sourced
`chat:end`.

## Design decision

Add an optional `source?: 'routine' | 'user'` field to the `AgentContext` primitive
in `@ax/core`. Abstract origin labels (no backend/transport vocabulary), mirroring the
existing optional `conversationId` field exactly (conditional spread under
`exactOptionalPropertyTypes`). Routines stamps `source: 'routine'` on its fire context;
memory-strata's two `chat:end` subscribers early-return when `ctx.source === 'routine'`.

**Boundary review (field on a core primitive, NOT a hook):**
- *Alternate impl this could have:* none needed — this isn't a hook. It's a field on the
  universal `AgentContext` value object that already carries `reqId`/`sessionId`/
  `conversationId`. No service-hook signature changes; no subscriber payload changes.
- *Field names that might leak:* none. `'routine' | 'user'` are origin labels, not
  storage/transport vocabulary.
- *Subscriber risk:* none new — no hook payload changes shape. memory-strata reads
  `ctx.source` (already part of the ctx every subscriber receives).
- *Wire surface:* none. `source` is a host-side context field; it is NOT serialized
  across the IPC boundary (see the propagation note below).

## Tasks (independent, testable)

1. **@ax/core — add `source` to AgentContext + thread through makeAgentContext.**
   - Add `readonly source?: 'routine' | 'user'` to `AgentContext` with a doc comment.
   - Add `source?: 'routine' | 'user'` to `MakeAgentContextOptions`.
   - Thread it through `makeAgentContext` with the same conditional-spread pattern as
     `conversationId` (only set when defined; never a literal `undefined`).
   - Test: `makeAgentContext` round-trips `source`; defaults to `undefined` when omitted.

2. **@ax/routines — stamp `source: 'routine'` on the fire context.**
   - In `fire.ts`, add `source: 'routine'` to the `makeAgentContext` call that builds
     `fireCtx` (the ctx passed to `agent:invoke`, ~line 101).
   - Test: the fire ctx carries `source: 'routine'`.

3. **@ax/memory-strata — guard both `chat:end` subscribers on `ctx.source`.**
   - In `plugin.ts`, early-return at the top of BOTH `chat:end` subscribers (observer
     ~246, consolidator ~288) when `ctx.source === 'routine'`.
   - Test: a routine-source `chat:end` skips the observer (extraction LLM uncalled) AND
     the consolidator; a user-source (or unset) `chat:end` runs the observer.

## YAGNI pass

- Task 1–3 are all load-bearing at MVP: the field is the primitive, the stamp is what
  marks routine fires, the guard is what stops the pollution. None is dead code.
- NOT in scope (deferred): end-to-end propagation of `source` across the IPC boundary on
  the happy path (see below). TASK-178 + a propagation follow-up own that.

## Known gap to surface (NOT a PR-A blocker)

`source` is a host-side `AgentContext` field. On a **successful** runner turn the
happy-path `chat:end` is fired by the IPC server (`packages/ipc-server/src/listener.ts`)
with a ctx reconstructed from the session auth result — which carries
`sessionId`/`agentId`/`userId`/`workspaceRoot`/`conversationId` but NOT `source`. So the
guard fires correctly on (a) orchestrator-fired error/terminated `chat:end` and (b) any
in-process unit test, but NOT on the happy-path runner-completed `chat:end` until
`source` is plumbed through session auth → IPC reconstruction. PR-A delivers the
primitive + guard (all card acceptance is unit-level and satisfied); the propagation is
a distinct follow-up TASK-178 depends on. Logged in decisions.md + handoff.

## Gate

`pnpm build && pnpm -r run test` (canonical; not bare vitest) + `eslint .` green.
Affected packages run in isolation: `@ax/core`, `@ax/routines`, `@ax/memory-strata`.
