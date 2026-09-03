# TASK-275 — Approval-card interaction: composer hold + focus semantics

## Problem
When a tool call is held for approval, the composer stays live: a send during
the hold either races the parked turn or vanishes silently. And focus behavior
on approval arrival is unruled. Human ruling (2026-08-22, card body) settles both:
no focus move (keep polite live announcement); composer DISABLED with reason copy.

## Verified current state (vs main @ f167cfe4)
- Part 1 (focus) ~DONE: `InThreadApprovals.tsx:195` already has a separate
  `sr-only role=status aria-live=polite` node with one stable sentence
  ("Your agent is waiting for your approval."), no counter inside, no `.focus()`
  call anywhere on the approval path. `Composer.tsx:177` keeps `autoFocus` on
  the input (mount only — not a hold-time steal; keep).
- Part 2 (composer) NOT DONE: neither `Composer.tsx` nor
  `AgentConversation.tsx` reads open-approval state; no "Waiting on your
  approval" copy anywhere. Confirmed by grep.
- `/workspace` has NO live region at all (`AgentConversation`); `/` has one.
- Open-state predicate: `isOpenDecision()` (`lib/workspace-types.ts:77`);
  `useConversationDecisions()` already splits `open`/`settled` with it.
  Both surfaces must key off the same predicate — one decision.

## Tasks
1. `/` composer hold. `Composer.tsx`: read `useConversationDecisions()`,
   `held = open.length > 0`. When held: disable Input + Send (+ attach),
   block `onSubmit`, render visible reason copy above the field.
   Tests: send impossible while held (click + Enter paths); reason copy
   visible (dimming-alone absent); no silent-drop path (submit handler
   short-circuits, doesn't clear).
2. `/workspace` parity. `AgentConversation.tsx`: `held = decisions.some(isOpenDecision)`
   (import from `lib/workspace-types`). Same disabled + copy treatment on its
   Input/Send; add the same separate polite announcer node (stable sentence,
   no counter). `busy` (streaming) and `held` compose independently.
3. Lock-in tests + gate. Live-region test: announcer node contains no digit/
   counter text with a settled receipt inside its undo window (tick
   `useDecisionClock`). Focus test: approval arrival moves no focus
   (`document.activeElement` unchanged). Full gate:
   `pnpm build` + `pnpm -r --no-bail run test && pnpm test:eslint-rules &&
   pnpm test:scripts` + lint.

## Copy (ux-design applied, advisory)
- Composer hold line: "We're waiting on your approval above — send is paused
  until you choose." ("we", plain language, names the reason + next action.
  Short; sits above the disabled field, not placeholder-only.)
- Live sentence unchanged: "Your agent is waiting for your approval."
- No jump-to-approval affordance: card sits directly above the composer on `/`
  and inline in `/workspace` — already in view; affordance buys nothing. Logged.

## YAGNI / non-goals
- No message queueing (explicitly rejected in ruling). No focus move, no AT pass.
- No hook/IPC change → no boundary review beyond noting "no surface change"
  in the PR body (PR #497 precedent).
- No per-row composer states; one boolean per surface.

## Decisions log targets
- `decisions.md`: held predicate choice, copy choice, jump-affordance skip,
  assistant-ui disable mechanism (subagent reports back).
