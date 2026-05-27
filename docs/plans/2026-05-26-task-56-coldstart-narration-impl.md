# TASK-56 — JIT cold-start user-facing narration ("asked your admin", not an error)

**Follow-up from TASK-53 (#198).** TASK-53 wired the cold-start *trigger* (broker fires
`catalog:submit` on `request_capability` not-found / `search_catalog` empty) and explicitly
deferred the *narration* as a system-prompt/agent-messaging concern (its plan's "NOT doing"
section). This card closes that.

Design §13: *"broker finds no catalog hit → files an admit-request (deduped) → 'I've asked
your admin to add Linear; I'll be able to do this once it's approved.' Not an error."*

## Confirmed: NOT already covered

- `request_capability`'s descriptor + `capabilityHandoffNote` (runner system-prompt) only
  steer the *successful connect/approve* path ("the user will be asked to approve", "continue
  automatically", "do not narrate the mechanics"). Neither tells the agent what to **say** when
  the capability **isn't in the catalog** (the `not-found` / empty-`skills` result).

## Scope

Pure host-authored prose. No new hook / IPC action / wire schema / store / migration / UI /
dependency. No untrusted model text is interpolated into the narration (the notes are fixed
strings; the model fills in the specific capability noun from the `skillId`/intent already in
the tool result). No boundary review needed (no hook-surface change). security-checklist NOT
triggered (no sandbox/IPC/plugin-loading/untrusted-input/dependency change).

## Tasks (independent, testable)

### Task 1 — extend `capabilityHandoffNote` with the cold-start "asked your admin" guidance
File: `packages/agent-claude-sdk-runner/src/system-prompt.ts`.
Add a sentence to `capabilityHandoffNote()` (the always-present JIT agent-messaging note):
when a capability you need isn't available yet, tell the user you've asked their admin to add
it and that you'll be able to help once it's approved — frame it as in-progress, not an error.
Keep it generic (no hardcoded "Linear"); the model names the specific capability from the tool
result.

Tests (`src/__tests__/system-prompt.test.ts`, extend the "JIT capability-handoff note" block):
- the note contains "asked your admin" (or equivalent admin-narration phrasing) and frames it
  as not-an-error / approval-pending.
- the note is still present on both the empty-prompt preset `append` and a custom-string prompt
  (the existing `toEqual(append: ...)` assertions already pin presence — update them if the
  string changed, which it does, since `capabilityHandoffNote()` is interpolated into those
  expected strings — they reference the function, so they stay correct automatically).

### Task 2 — add cold-start narration guidance to the broker tool descriptions
File: `packages/skill-broker/src/tools/request-capability.ts` (`REQUEST_CAPABILITY_DESCRIPTOR`)
and `packages/skill-broker/src/tools/search-catalog.ts` (`SEARCH_CATALOG_DESCRIPTOR`).
Append to each `description` a line telling the model that on a not-found / empty result the
request has been filed for the admin and it should tell the user it's been asked for (not an
error).

Tests (`packages/skill-broker/src/__tests__/plugin.test.ts`):
- `REQUEST_CAPABILITY_DESCRIPTOR.description` contains the admin-narration phrasing.
- `SEARCH_CATALOG_DESCRIPTOR.description` contains the admin-narration phrasing.

## Gate
`pnpm install` (worktree has no node_modules), then `pnpm build` (tsc refs) +
`pnpm -F @ax/skill-broker test` + `pnpm -F @ax/agent-claude-sdk-runner test` (the two touched
packages) + `pnpm lint`.
