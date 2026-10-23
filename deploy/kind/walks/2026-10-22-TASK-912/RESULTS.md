# TASK-912 walk: Agent Tasks PR 1 on kind

**When:** 2026-10-22, 22:40–23:40 EDT.

**Where:** the local kind cluster `ax-next-dev` (`--context kind-ax-next-dev`).
- Image built from `main` at `6b1234d96`, which includes TASK-906–911 (#1009, #1011, #1014, #1015, #1016, #1019).
- Helm revision 11.

**How:** Playwright drove the real web app through a port-forward on `localhost:19090`.

**Setup:** kind had been wiped on 2026-10-20 and nobody had set it up again, so this walk also went through the real first-time setup:
- step 1: bootstrap token;
- step 2: the admin account, "Walk Admin";
- step 3: the Anthropic key.

Setup created "Default Agent". All the screenshots in this folder come from that account.

## Results

| # | Step | Result | Evidence |
|---|---|---|---|
| 1 | **Start from chat.** "Keep an eye on my inbox… Check every 15 minutes." | Pass, after a nudge. The card says "Wants to start a task" and shows the name, what it will do, "Going well when" and "Runs every 15 minutes". On the first message the agent didn't propose a task (finding 1). | `01-approval-card.png` |
| 2 | **Always Allow carve-out.** | Pass. Approved with Always Allow. A second task proposal (a status-page watch) was still held for a yes, and declining it reported "Nothing ran". A schedule-only change (15 to 20 minutes) went straight through `routine_update` with no card. | `03-…`, `04-…` |
| 3 | **Approve once**, then it's on Tasks. | Pass. "No update yet · 1". Tasks sits right under Today. | `02-…` |
| 4 | **Tick** (Check now). | Pass. The task page shows "Needs you", the agent's update, its ask, and "Checked at 11:09 PM · Next check at 11:12 PM". Tasks moved it to "Needs you · 1", "checked just now". | `06-…`, `07-…`, `08-…` |
| 5 | **Report is bound.** `routine_report` called from ordinary chat. | Pass. The tool returned "This works only during a task check-in." | `05-…` |
| 6 | **Updates thread.** | Pass. A scheduled check-in (`tick`) added a second entry, and each entry links to its own check-in. On a second task, four on-track check-ins in a row show the newest plus "3 earlier check-ins, all on track". A fold needs at least two hidden entries (`FOLD_MIN_HIDDEN`), so two in a row stay separate. That's by design. | `12-…`, `15-…` |
| 7 | **See what it did.** | Pass. Read-only: no composer, no Send, Stop, Continue or Retry. The 5 tool steps are visible. The header says "Started outside its schedule · read-only" and shows the report. | `09-…` |
| 8 | **Notes.** | Pass. Show revealed the agent's notes. Clear notes asked to confirm ("You can't undo this"), then the page said "Notes cleared." The next scheduled check-in's message said "You have no saved notes yet." (checked in its stored conversation). | `10-…`, `11-…` |
| 9 | **Pause / Resume.** | Pass. Pause says "Paused. It won't check in until you resume it.", Check now is disabled, and Tasks folds it into "Show 1 paused task". Paused at 23:14. Its 23:32 slot passed with no check-in: still 2 fires at 23:34. Meanwhile the unpaused date task ran on schedule at 23:29:50, so the scheduler was running. Resume brought back Pause and an enabled Check now, set "Next check at 11:54 PM", and put it back under "Needs you · 1". After the walk, both walk tasks were left paused on kind. | `13-…`, `14-…`, `17-resumed.png`, `18-tasks-two-groups.png` |
| 10 | **No brief, no check-in.** | Not forced on kind: there's no flag to make the routines provider fail. Covered by unit tests: `briefLandedVeto refuses a task run whose brief isn't listed…` (`packages/routines/src/__tests__/brief.test.ts`). The turn error `system-prompt:brief-missing` maps to "This task's instructions didn't load, so the check-in didn't run." (`packages/channel-web/src/lib/turn-error-labels.ts`). | — |
| 11 | **Console and phone width.** | Pass. No console errors on the Tasks page, both task pages or the check-in page. No horizontal scroll at 1280 px or 390 px. | `16-phone-*.png` |

## Findings

None of these block PR 1. Each is a follow-up card.

1. **The agent puts off starting a task it can't do yet.** With no inbox connector, its first reply filed a connector request with the admin and asked two questions ("Which inbox? How do you identify a customer?"). It said it would set up the check once it could read mail. It proposed the task only after being told "start it now anyway". That's defensible, but the design's canary expects a proposal.
2. **The agent says updates come "through this chat".** After the task was created it said "You'll get notified through this chat at each check-in". Updates show on Tasks and the task page, so what `routine_create` returns, or the tool description, should say where they go.
3. **The agent gives times in UTC.** "It will next run at 03:12 UTC." The model sees UTC instants and doesn't know the person's timezone.
4. **One check-in shows two times.** An Updates entry is stamped when the run started (11:08 PM), while the latest-update card's "Checked at" is when it reported (11:09 PM).
5. **What an agent reported comes back after a notes clear.** After the clear, the next check-in wrote new notes saying "Each check-in has returned the same result". It got that from the last three reports in its check-in message. This is the path TASK-921 closes.
6. **Small UI notes:**
   - `non-@canopyworks.com` in the agent's text was turned into an email link.
   - Tool steps show raw names ("ToolSearch: select:mcp__ax-host-tools__…"). That comes from the shared thread renderer, not PR 1.

## Environment notes

- **OrbStack stalled twice mid-walk.** The kind API and port-forward timed out for about 10 minutes, and a later check showed host load around 17. It recovered without a restart. The port-forward then needed restarting ("error creating error stream").
- **The Playwright tool echoes a script loaded with `filename` back into its output.** So a secret typed that way reaches the transcript. Use a different route for secrets.
- **First-time setup refuses once any admin exists.** So making an admin with the local kind-login helper before `/setup` makes setup fail ("admin already exists; bootstrap refused"). Run setup first, then use kind-login for extra users.
