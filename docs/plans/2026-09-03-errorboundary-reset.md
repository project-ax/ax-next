# TASK-332 — ErrorBoundary reset on session-switch (plan)

## Problem
A tripped per-surface `ErrorBoundary` never recovers on session-switch:
`error` state persists after the content identity that threw is gone, so the
fallback sticks until the user clicks Try-again or reloads. Verified against
today's `main`: `ErrorBoundary` (`packages/channel-web/src/components/ErrorBoundary.tsx`)
has no reset prop and no `componentDidUpdate`; `App.tsx` passes only `surface`
(+`fallback`). Deferred from PR #496 review (memory: TASK-273 review).

## Decision (divergence from the brief, with evidence)
The brief anticipates a React `key=` reset ("changes Thread unmount semantics").
I am **not** doing that: the deferral note itself flags the cost —
`key={activeSessionId}` remounts `Thread` on **every** identity transition,
including the `null → <minted-id>` transition on the first message POST
(`runtime.tsx handleSetConversationId → setActiveSession`), which would drop
scroll position and risk the in-flight first turn's view state for no reason.

Instead: an opt-in `resetKey?: string | null` prop on `ErrorBoundary`.
`componentDidUpdate` clears `error` **only** when `resetKey` changed since the
previous render. Effect:
- Fallback clears on session-switch (acceptance 1 + 3).
- Zero unmount-semantics change — `Thread` is never remounted by the reset,
  within a session or across one (acceptance 2, strictly stronger than asked).
- A re-render with an unchanged key neither clears nor remounts (no
  incidental churn); if the cause persists, the child re-throws and the
  fallback returns — correct.

## Identity the key uses
`useSessionStore().activeSessionId` in `AppContent`, passed as
`resetKey` on the `chat-thread` boundary only. This is the same identity the
thread uses: `runtime.tsx` mirrors `activeSessionId` into the transport's
`conversationRef` + `setActiveConversationId` on every change, and mints push
back through `setActiveSession` — `conversationId === activeSessionId`
invariant. (Predecessor learning from TASK-275: scope per-thread, not global —
satisfied: sidebar/workspace boundaries untouched; sidebar list identity does
not change on switch, workspace shell owns its own route state.)

Navigation (workspace ↔ chat, admin open/close): those swap `AppContent`
branches, unmounting the boundary outright — nothing to reset. No hook or IPC
change: pure client. No boundary-review payload section needed (confirm in PR).

## Tasks (for implement subagent, TDD)
1. `ErrorBoundary`: add `resetKey` prop + `componentDidUpdate` reset. Unit
   tests in `__tests__/error-boundary.test.tsx`: trip → change key → clears;
   trip → same-key rerender → persists; key change with healthy child →
   child state preserved (no remount); same-key rerender → child state
   preserved. Vacuity: each new test must fail on unpatched code.
2. `App.tsx`: `AppContent` subscribes `useSessionStore`, passes
   `resetKey={activeSessionId}` on the `chat-thread` boundary. Wiring test
   (new `__tests__/error-boundary-reset.test.tsx`, App-level with throwing
   Thread mock like `error-boundary-wiring.test.tsx`): trip → switch session
   via `sessionStoreActions.setActiveSession` → fallback clears and fixed
   child renders; plus same-session rerender keeps fallback.
3. Memory: append decisions to worktree `.claude/memory/decisions.md` only.

## Gate
`pnpm --filter @ax/channel-web test` (then full `pnpm -r --no-bail run test &&
pnpm test:eslint-rules && pnpm test:scripts`), `pnpm build`, lint. Zero dep
changes (`pnpm audit` pre-existing failures documented on PR).
