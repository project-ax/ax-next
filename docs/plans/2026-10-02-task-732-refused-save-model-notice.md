# TASK-732 — tell the model next turn when a refused save removed its files

## Problem

An end-of-turn save the host refuses (pre-apply veto, or too large to carry)
rolls the turn's file changes back. The person learns of it from
`saveRefused` on `event.turn-end` (TASK-720). The model never does: the turn is
over, so it starts the next turn believing its files exist.

## Approach

Runner-internal, no hook or wire change.

1. `packages/agent-runner-core/src/save-refused-notice.ts`
   - `saveRefusedNotice(result)` — model-facing prose for a TERMINAL refusal
     (same predicate as `saveRefusedFrom`), labelled with the fixed
     `System message (not from the user):` prefix the decision turn uses, and
     the host's reason sanitized by `sanitizeDecisionNote`. `undefined` when the
     save was not refused.
   - `prependNotice(content, notice)` — prepend to a string, or as a leading
     `{type:'text'}` block to a content-block array.
2. `run-runner.ts`
   - `closeTurn` stores the notice in a shell-scoped pending slot.
   - `nextMessage` consumes it on the next turn it starts (user message or
     decision-resolved), then clears it. `chatEndHistory` stays person-only.
   - Fix the stale "the model cannot be told" comment (contract rule 5).

## Out of scope (follow-ups)

- The FINAL/idle commit runs after the loop drains; no later turn exists in
  this runner process. Telling the model then needs host-persisted state
  (and is the same gap TASK-731 closes for the person).
- A per-turn refusal on a runner that then exits before the next message
  loses the notice for the same reason.

## Tests

- unit: notice composition, sanitization, predicate parity with
  `saveRefusedFrom`, prepend for string/array.
- run-runner: refused turn → next `nextMessage()` content starts with notice;
  the turn after that does not; accepted/kept/race → no notice;
  decision-resolved turn also carries it.
