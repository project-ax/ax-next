# TASK-959 — task-page and Today completion polish

Base inspected: `1a6055fa9ad446be601735ab54db4667537af520` (TASK-940 merged). Scope is channel-web, existing shadcn primitives and semantic tokens. No dependency, service-hook, wire, backend or polling-design change.

## Findings and choices

All four walk findings remain true. `TaskPage` reads only its detail after Mark done / Not yet / Reopen / reply; the shell already owns the shared `useTasks.reload` that forces a new request and rejects stale responses. Done metadata always includes a saved schedule. In-place forms deliberately persist open after success. Tasks rows show the update without the claim.

The Not yet helper already promises an immediate check-in with `canStart=true`. Today always passes false. For a claimed row, existing `canMarkDone` is the services' `permissions.edit`; for the task owner this has the same management permission as `fire`. Reuse that fact for Not yet, retain conservative `canStart=false` for ordinary Today replies, and retain paused / permission-loss helper branches. Do not broadly promise immediate starts to every owner.

UX review (ux-design, advisory): misleading asynchronous state is the main defect. Keep one form visible after Reopen, close special forms only on successful send, retain drafts/error/retry identity on failure, and return focus to a stable visible control only if the person has not moved on. Keep the current disclosure and design language. The Done line already dates completion, so metadata should keep agent/kind and omit the schedule. Claimed rows add “{agent} thinks this is done.” while retaining the update and existing miss precedence.

## Task 1 [tier: sensitive] — complete the four fixes with regressions

Concurrency in the shared-read integration earns sensitive; this is one cohesive write/read/form path, with no security boundary or new untrusted-content handling. `security-checklist` is not required.

1. Read TaskPage, TaskMarkDone, TaskReplyBox, TodayTaskGroup, TasksPage, WorkspaceShell, workspace-tasks and their existing component tests. Read Impeccable craft floor immediately before UI changes. Dependencies must be installed and the fresh worktree built before tests.
2. Add failing component regressions before source fixes (update existing expectations that deliberately assert the old open-box behavior):
   - TaskPage calls a small required `onTaskWriteSucceeded: () => void` prop on landed Mark done, normal reply, Not yet and Reopen. No call for failed/refused writes. Test a detail refresh failure/held read after a success still announces the write. Test pending write resolved after page unmount still announces shared list refresh.
   - Real WorkspaceShell integration: load a claimed row/badge, open its task, Mark done; before opening Today the sidebar badge clears from the fresh list. Opening Today then shows no stale block. Hold a pre-write list read in flight, land Mark done, require a second list request (reload, not retry), resolve its new answer first and the old claimed answer last, and assert stale response cannot restore badge/block. Keep detail refresh independently failing in one real integration regression.
   - Done metadata omits “checks in …” both on initial Done load and after Mark done; ordinary running task retains schedule and the existing Done date remains.
   - Today Not yet and task-page Not yet/Reopen close immediately on success, including slow/failed detail read; failures retain visible form, draft and error, and ordinary reply behavior stays. Reopen leaves one visible ordinary reply after detail becomes running. Verify the special composer DOM node stays mounted while hidden (receipt reset and retry identity are not remount tricks), and keyboard focus remains on a visible recovery/action target when a send closes its box.
   - Today claimed Not yet with `canMarkDone=true` names the immediate check-in; false and paused cases retain honest fallback. Unit-test helper as needed without rewriting already correct branches.
   - TasksPage claimed row adds “{agent} thinks this is done.” while retaining update; ordinary Needs you and Done rows do not claim completion. Existing miss/auto-pause priority stays.
3. Run focused tests, save red output in `/private/tmp/ax-next-polish-20261026/TASK-959/`, confirm each new assertion fails for the intended defect (not missing build/import).
4. Wire `WorkspaceShell`'s `taskRead.reload` directly to the page's callback. Announce each write as soon as its endpoint succeeds, before detail refresh/poll/form work; failed writes never announce. Avoid coupling announcements to refresh success, route presence, or poll completion. Pass callback through TaskBody to Mark done and use it in reply onSent. Keep detail refresh and task-page `useTaskPoll` separate.
5. Close only the in-place box on successful special sends; keep its mounted TaskReplyBox when hidden. Preserve normal reply drafts/receipts and TASK-940's mounted completion-reset behavior. Close Today's special Not yet only after success, retaining ordinary reply behavior. Follow existing focus helpers and avoid stealing focus after navigation or moving elsewhere.
6. Omit schedule metadata when Done; add claim sentence on the Tasks row without hiding the update or superseding missed-check-in notices. Use `canMarkDone` only for claimed Not yet's existing helper capability. Update comments that describe old open-on-success behavior and the workspace-tasks header's now-expanded refresh triggers. Add a short current implementation note to task design §3.3/§3.5 or §15 if needed; historical walk findings remain a historical record.
7. Run focused tests green, review diff against scope, and commit code/tests. No new refresh mechanism or polling changes: `useTaskRowPoll` remains removed; TodayView owns `useTaskReplyPoll` for the full 10-second / five-minute window, independent of report receipts. `useTasks.retry` remains the tick path and reload the landed-write path.

## Verification and ship gates

Run `pnpm build`, full `pnpm --filter @ax/channel-web test`, `pnpm test:eslint-rules`, `pnpm test:scripts`, and `pnpm lint`. No unrelated recursive suites; unchanged routines' predecessor gate remains evidence only for its unchanged source. If any other package changes, run its full suite. Run the Impeccable mechanical detector once over final changed UI sources; classify findings against pre-existing code and fix actual introduced defects.

Browser and Node REPL tools are unavailable. The TASK-954 captures establish the historical finding; they are not fresh rendered QA. Report that limit instead of claiming new screenshots. Component/DOM and source checks cover the flow; no production or cluster actions.

Before independent review, commit every tracked change and capture full HEAD and branch range against current origin/main. Reviewer is read-only and runs every command in this worktree. Address findings, regress meaningful bugs red-before-green, re-review exact final code head, then push/open PR base main and drive exact-head CI green. Do not merge or delete worktree. Every temp/log/PR body is task-scoped. Record durable learnings in TASK-959 shards only.

## YAGNI / stale-prose check

No new wire permission, event bus, cache, global poll, receipt state owner, API endpoint, dependency or component. No broad redesign, unrelated focus rescue, or backend change. The card originated in the rendered TASK-954 walk, not stale prose. Source comments describing the old behavior must change with their implementations; frozen memory archives and historical findings are not rewritten.
