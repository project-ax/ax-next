# TASK-147 — Decouple admin identity save from tools-required check (wildcard/bare agents)

## Problem statement

The admin **AgentForm** Save handler (`packages/channel-web/src/components/admin/AgentForm.tsx`,
`submit`) unconditionally rejects an empty Allowed-tools field:

```js
if (allowedTools.length === 0) {
  setBusy(false);
  setError('agent must list at least one tool');
  return;
}
```

That `return` aborts the WHOLE submit — including the `putAgentIdentity` call that
saves the Identity / Soul / Operating-instructions files. So for a **wildcard/bare
agent** (an agent whose persisted `allowedTools` is empty — a legitimate, store-allowed
state), the combined form can't save an **identity-only** edit. The standalone
`PUT /admin/agents/:id/identity` route has no tools gating and works correctly; only
the combined AgentForm Save is over-gated (TASK-143 walk GLITCH).

## Root cause (confirmed by reading the server)

`packages/agents/src/admin-routes.ts`:
- `rejectsWildcardScope` (line 341) rejects an agent **only** when BOTH `allowedTools`
  and `mcpConfigIds` are *present and empty* — the dev-mode-bypass wildcard sentinel.
- It runs on BOTH `create` (line 481) and `update` (line 559).
- The `update` body schema makes every field **optional** (line 175). A PATCH that
  **omits** `allowedTools`/`mcpConfigIds` is accepted and leaves the agent bare.

So:
- A **new** bare agent IS correctly rejected by the server → the form's create-time
  gate legitimately mirrors that. Keep it.
- An **existing** bare agent is a valid persisted state. The form bug is twofold:
  1. The gate blocks the submit before `putAgentIdentity` runs.
  2. Even without the gate, the form's PATCH always sends `allowedTools: []` +
     `mcpConfigIds: []`, which the server's `rejectsWildcardScope` would reject on
     update — so the fix must ALSO stop sending the empty wildcard pair on a
     bare-stays-bare edit.

## Chosen approach

Narrow the gate + fix the PATCH shape, both scoped to the bare-agent edit case. Do
NOT weaken validation for explicit-tool-list agents or for new agents.

1. Detect whether the form is editing an **existing wildcard/bare agent** — the
   persisted `editing` agent has `allowedTools.length === 0` AND
   `mcpConfigIds.length === 0`. (The form already sends `mcpConfigIds: []` itself, so
   "bare" really means "persisted allowedTools empty".)
2. **Gate:** the `allowedTools.length === 0` error fires only when the save would
   create a NEW wildcard agent — i.e. `editing === 'new'`, OR an edit that is NOT a
   bare-stays-bare edit (the user cleared a previously-populated tool list). For a
   bare-stays-bare edit, skip the gate so the identity write proceeds.
3. **PATCH shape:** on a bare-stays-bare edit, OMIT `allowedTools` and `mcpConfigIds`
   from the PATCH body (leave them as-is server-side) so `rejectsWildcardScope` is not
   triggered. The identity files still save via `putAgentIdentity`.
   - Tightest rule: if the resulting `allowedTools` is empty AND the agent was already
     bare, drop both tool fields from the patch. Otherwise send them (covers
     populated→populated, populated→cleared-with-error, bare→populated).

## Tasks

- **Task 1 (test-first):** Add regression tests to `AgentForm.test.tsx`:
  - (a) Editing a wildcard/bare agent (`allowedTools: []`) and changing only the
    identity → `putAgentIdentity` is called, NO 'must list at least one tool' error,
    and `patchAgent` is called WITHOUT empty `allowedTools`/`mcpConfigIds` (omitted).
  - (b) The gate STILL fires for a NEW agent with no tools (existing behavior preserved).
  - (c) The gate STILL fires when editing an agent that HAD tools and the user clears
    them to empty (don't silently let an explicit-tool agent become wildcard via the
    form) — error shown, no save.
  Then implement the fix in `AgentForm.tsx` to make them pass.

## Invariants / boundary review

- Pure channel-web client change. No hook surface added/changed → no boundary review.
- No sandbox / IPC / plugin-loading / untrusted-content / new-dep change →
  security-checklist not required. (Identity contents still flow through the
  unchanged `putAgentIdentity` → validator-identity path.)
- Invariant #6 (UI): no new markup primitives; uses existing error path. The Save
  button + error Alert already exist; we only change submit logic.

## YAGNI

All three tasks are load-bearing: the fix (gate + PATCH shape) and the three
regression cases directly back the acceptance criteria. Nothing dead.
