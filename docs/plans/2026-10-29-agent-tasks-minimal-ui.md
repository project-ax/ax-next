# Agent Tasks: minimal UI (2026-10-29)

Agent Tasks shipped through PR 5 and works, but its pages were text-heavy, showed
everything at once, and were hard for non-technical people to read. This redesign
keeps every capability and changes only how the pages present them.

- **Evidence:**
  - an impeccable critique scoring 21/40, archived in
    `packages/channel-web/.impeccable/critique/`;
  - a ux-designer review of PR 5 on kind.
- **Design:** the Figma page "Tasks — redesign v2 (minimal)" in the Goals mock file
  (`QMFOa9v5Z5b67XWJdC51jJ`, node `26:1875`).
- **Reference PNGs:** the worktree's `.playwright-mcp/design-v2/` (gitignored).
  - `task-stay-on-top-needs-you.png`, `task-get-done-claimed.png`, `task-repeat.png`,
    `task-done.png` and `task-mobile.png` are the task page.
  - `tasks-list.png` and `tasks-list-mobile.png` are the list.
  - `new-task-dialog.png` is the New/Edit dialog.
  - `more-menu-and-delete.png` is the ⋯ menu and the delete confirm.

## The rule

Only what can't be said another way stays as words:

- the task name;
- the agent's own words, one sentence per card, clamped;
- the status pill;
- the one action the page wants from you;
- the reply box.

Everything else becomes an icon or a position, or moves one click down.

**Accessibility comes with that rule, and it isn't optional.** Every icon-only
control and every icon chip uses `IconAction` or `MetaChip` from
`components/workspace/task-bits.tsx`. Both put the full sentence in a Tooltip and in
the accessible name. A `StateDot` that stands alone keeps a visually hidden word.

## Shared pieces (`components/workspace/task-bits.tsx`)

- `TaskKindIcon`, `TASK_KIND_ICONS`, `TASK_KIND_SHORT`
- `MetaChip({ icon, label?, description, emphasis? })`
- `IconAction({ icon, label, variant?, busy?, ref?, ...ButtonProps })`
- `TaskStatusPill({ group, label? })`

Use `AgentTile` from `bits.tsx` for the agent avatar. Don't hand-roll one.

## Task page (`TaskPage.tsx` and its children)

### Header

The header leaves `WorkspaceHeader`'s 15px title row. The page draws its own
header inside the scroll column.

- A small back link: `‹ Tasks`, using the existing `routeLinkProps({ kind: 'tasks' })`
  link and its `tasksLinkRef`.
- The **H1** title at 24px semibold, with a `TaskStatusPill` for the task's group.
  - Use `taskGroup(...)`, the same group the list uses.
  - A Done task gets `done`.
  - A paused task gets `paused`.
  - A repeat task gets a pill labelled "Scheduled" (`on-track` style) when enabled,
    or "Paused".
- **Meta chips** (`MetaChip`), in one row:
  - `AgentTile` plus the agent's name (the only text chip);
  - the kind icon with its short word;
  - a clock with the short interval ("20 min"). Its description is the full
    existing schedule sentence (`detail.schedule`) plus "next check {when}".
  - **get-done only:** a calendar chip "Nov 3 · 5 days", emphasised. Its
    description is the full finish-date sentence, and it is the trigger that opens
    the existing `TaskFinishDate` editor (Popover or in place). With no date, use
    an icon-only calendar `IconAction` "Add a finish date".
- **Actions**, right-aligned, in the same order and with the same refs and
  focus-return rules as today:
  - `IconAction` RefreshCw "Check now" (Play "Run now" for repeat);
  - `IconAction` Pause "Pause" / Play "Resume";
  - ⋯ `DropdownMenu`.
  - **Primary-action rule:** when the page's one primary action is Resume, it is a
    **text** `Button` "Resume" (default variant), not an icon. A Done task shows a
    text "Reopen" (outline) plus `IconAction` Copy "Duplicate".
  - The "why disabled" note (`actionNote`) moves into the disabled button's tooltip
    **and** stays as `aria-describedby` text (visually hidden is fine). The paused
    line ("Paused. It won't check in until you resume it.") becomes the pill; keep
    its words for screen readers.
- **⋯ menu:** Edit task, Duplicate (not for repeat), Pause/Resume when it isn't a
  header button anyway, a separator, then "Delete task…" in destructive text.
  - "Delete task…" opens a `Dialog` confirm: title `Delete “{name}”?`, body
    "It leaves Tasks and no new check-ins will start. A check-in that's already
    running may finish.", and buttons Cancel, "Pause instead" (when running) and a
    destructive "Delete task".
  - This **replaces `TaskOptions`' collapsible** and keeps its request-id/revision
    retry logic.

### Banner (at most one, under the header)

- **Ask** (`task.ask` present): a `bg-warning-soft` card containing:
  - the agent tile;
  - the ask text (agent words, 15px);
  - **the reply box inline** (`TaskReplyBox`, compact: one-line input with a send
    `IconAction`; it grows as you type).
  - Keep the reply box's sent/paused/queued live lines. The paused helper line stays
    because it's honest state.
  - The page's separate bottom reply box then doesn't render. With no ask, the
    compact reply box sits at the bottom of the check-ins card.
- **Claim** (`isClaimed`): a `bg-primary-soft` card with the agent tile, then
  "{agent} thinks this is done." and Not yet / Mark done (primary). It keeps the
  in-place Not yet box and `MarkDoneConfirmation` exactly.
- **Missed check-ins** (`noRecentUpdate`): a muted card with the group's dot, the
  one-line `missSummary`, and the fix as a link-styled button. Keep `words.fix`
  copy, and keep Edit/Check now behaviour.
- **Done:** a `bg-primary-soft` card: "You marked this done {when}." Reopen and
  Duplicate live in the header.
- **Paused copy** (`copyLine`): keep the existing line, as a small Alert.

### Columns

`lg:grid-cols-[1fr_290px]`, single column below `lg`. On mobile, the side
column's Steps come right after the latest update.

**Main column:**

1. **Latest card**, with no title:
   - the update in quotes (clamp 3 lines, full text in `title`);
   - right-aligned, a muted relative time (`checkInWhen` short form) plus an
     ArrowUpRight `IconAction` (ghost, link) "See what it did";
   - when a reading exists, one row under it with the number (20px semibold), its
     label (muted), and the existing trend from `TaskReadingBlock` (restyle the
     same data, don't invent data).
2. **Check-ins card**, with no title:
   - the newest **3** entries, excluding the one already shown as latest;
   - each row is dot (+ hidden word), one clamped line of text, and a short time.
     The full text is in `title`, and "See what it did" is an ArrowUpRight icon
     link per row (hidden on rows that share a conversation, as today).
   - Replies render as `AgentTile`-style "You" with the text.
   - Then a History icon button "N earlier" that expands the rest, keeping
     `foldTimeline`'s quiet fold.
   - Error rows show the mapped reason (see Copy) in muted text on the same line.

**Side column:**

1. **Steps** (get-done):
   - a header row with the ListChecks icon, "2/5" and a Plus `IconAction`
     "Add a step";
   - rows of checkbox and text. "added by {agent}" moves into a tooltip on the row
     (screen-reader text kept).
   - Mark done (outline, footer) stays when there is no claim.
   - Everything else in `TaskSteps` stays: reword, delete, the ⋯ per step,
     read-only when Done.
2. **About list**: a Card of rows, each an icon, one clamped line and a chevron.
   Each row opens its content **in place** (Collapsible):
   - Target: the "Going well when" text itself as the row label. If missing,
     "Add how we'll know it's going well" opens Edit.
   - FileText "Instructions": opens the full brief (`detail.brief.promptBody`),
     `whitespace-pre-wrap`.
   - NotebookPen "{agent}'s notes" with a count. Opens `TaskNotes`, Clear kept.
   - Plug "App updates" with "On"/"Off". Opens `TaskAppUpdates`, which keeps the
     address, signing secret (`CredentialSlotRow`) and connection test; the HMAC
     secret row moves here from `TaskOptions`. With no webhook it says "Off. Turn
     it on in Edit task." with an Edit link.
   - Repeat only: History "Memory between runs" with "Fresh"/"One thread". This is
     read-only; it is changed in Edit.
3. The **agent-wide routine consent** (`RoutineConsentSection`) leaves the task page.
   It already lives in the agent's Settings (`RoutinesTab`). Add one muted link row
   in the About list, "What {agent} can do without asking", that navigates to that
   settings tab. Verify the route exists; if it doesn't, keep the section inside an
   About row instead.

### Repeat a job (`RepeatTaskBody`)

Same header and columns.

- **Main column:** one "Runs" card. Each row is a dot (done/off-track/no-update for
  ok/error/silenced), one line of text, a short date and an ArrowUpRight link.
  Newest 4, then "N earlier".
  - The text comes from the existing status words. Errors use the mapped plain
    reason.
  - `RepeatRunSummary`'s live states (Working… / N runs active / N app updates
    waiting / warning) show as a single muted status line above the list. They are
    honest async state; keep them.
- **Side column:** the About list, with Instructions and Memory between runs.

### Done

- The header has the Done pill, Reopen (text), Duplicate (icon) and ⋯.
- The banner is the done line.
- The main column has the final update card and a History "N check-ins" toggle
  that opens the full timeline, collapsed by default.
- The side column has Steps (read-only) and the About list.

## Tasks list (`TasksPage.tsx`)

- **Header:**
  - The "Tasks" H1 is 24px, with no subtitle.
  - On the right: an agent filter `IconAction` (Bot, "Filter by agent"). Render it
    **only when there is more than one agent**, as a `DropdownMenu` of agents;
    filtering is client-side over the loaded rows.
  - Then "New task" (primary, Plus).
- **No summary strip.**
- **Groups** in `groupTasks` order. The heading is a dot, the muted group word and
  a muted count. Repeat jobs use the Repeat icon in their heading.
- **Rows** are single-line on desktop and are real links (keep `routeLinkProps`):
  - `AgentTile` 22px;
  - the name (14px medium, truncate);
  - the latest line as muted one-line text that fills the space. For a needs-you
    row it is the ask, in foreground and in quotes.
  - `TaskKindIcon`;
  - one short right-hand fact:
    - get-done: "3/4 · Nov 3";
    - otherwise the short "checked … ago";
    - repeat: the last run day.
  - Needs-you rows add a MessageSquare `IconAction` "Reply". It navigates to the
    task page and focuses its reply box; it must not nest a button inside the row
    link, so the row link and the button are siblings.
  - On mobile a row is two lines: name, then latest.
  - Existing extra lines become this compact form: the miss summary, the auto-paused
    line, "{agent} thinks this is done", and the reading. The status lives in the
    group, so drop those lines and keep at most one latest line. Choose it in this
    order: claim → "Thinks it's done", miss summary, update.
- **Bottom toggles:** the paused toggle stays as "N paused" with the dash dot. The
  Current/Done segmented control is replaced by an "N done" toggle that expands the
  Done list in place, newest first. The "Done this week" section is dropped; it
  becomes the top of that toggle's list.
- **Calm state:** with no active groups and nothing done this week, show one quiet
  line: "Nothing is running right now." When tasks are paused, add a link-button
  "Show N paused". Keep the empty-state `Empty` for zero tasks.

## New / Edit task dialog (`TaskDialog.tsx`; `RoutineEditor` `taskMode` only)

**Don't change non-task routine editing** (`RoutinesList`, `DefaultRoutineEditor`).
Extract a task-only form if that's cleaner. It must save the same definition shape
through the same API calls.

- **Title** "New task" / "Edit task", with no description.
- **Kind** is a three-option `ToggleGroup` (icon + short word: Stay on top /
  Get done / Repeat), with one muted line under it describing the selected kind:
  - stay-on-top: "Keeps checking and fixing. Never finishes."
  - get-done: "Works through steps until you say it's done."
  - repeat: "Does the same job on a schedule."
  - Keep the existing kind-change warning on edit, in plain words: "Switching kinds
    starts this task over. Its steps, latest update, notes and finish date will be
    cleared."
- **Fields:** placeholders in place of visible labels, plus visually hidden
  `FieldLabel`s:
  - Name;
  - "What should {agent} do?" (Textarea);
  - a Target-icon input, "Going well when…" (task kinds only).
- **Setting chips:** a wrapping row of pill buttons, each opening a small `Popover`:
  - the agent (`AgentTile` + name; only when more than one agent, create only);
  - Clock + interval preset: a `Select` of 15 min, 30 min, 1 hour, 2 hours,
    1 day and 1 week. Repeat also offers 1 min and 5 min, keeping its 60s minimum.
    Custom/cron lives under ⋯.
  - Calendar + "Any time" / "Weekdays 9–6": the active-hours switch, days and
    times (the existing `ActiveHoursDaySelector` and time inputs);
  - Plug "App updates", off/on: the "When another app sends an update" toggle plus
    a "React within" preset `Select` (1, 5, 15 or 60 min). Its one line says
    "You'll connect the app after you start the task."
- **⋯ "More options"** (`IconAction` Ellipsis, opening a Collapsible below the
  chips) holds everything else:
  - time zone;
  - custom schedule/cron;
  - webhook address name ("Address name") and event filter ("Only these kinds of
    updates");
  - the signature fields;
  - repeat's conversation ("Memory between runs: Start fresh each time / Keep one
    running conversation") and quiet-reply settings;
  - "Note for you (optional)" (the Description field);
  - create only, "Start right away" (default on; the old Enabled switch). On edit,
    Enabled isn't shown, because Pause/Resume live in the task header.
- **Footer:** ⋯ on the left; Cancel (ghost) and Start task / Save (primary) on the
  right. It's sticky when the body scrolls.
- **Validation:** Start task is always enabled. On submit, map schema issues to the
  field: "Give it a name.", "Tell {agent} what to do.", and for anything else a
  plain sentence under the related control. Then focus the first invalid field.
  Never show a raw zod message.

## Copy changes (these apply everywhere)

- Map the run failure reasons from the routines store to plain sentences in one
  client helper:
  - `interrupted` → "Stopped early because we restarted. It tries again next time."
  - `failed` → "Something went wrong, so this check-in didn't finish."
  - Keep the others' existing plain text.
  - Find where `lib/task-updates.ts` renders `update.error`, and key on the code if
    the wire has one; otherwise match the known store strings. **Do not invent wire
    fields.**
- `TaskDialog`'s "Your changes save directly." is gone.
- `TaskOptions`' "Task options" is gone.

## Must not change

- The wire, routes and hooks are untouched. This is a channel-web-only change.
- The live-region rules in `TaskPage`'s header comment (PollLine, one polite region
  mounted with the task), the focus-after-press rules, the Mark done focus to the
  done line, the request-id replay on unconfirmed presses, and agent text rendered
  only as React text children. Update those comments where layout moved, but keep
  the behaviours, and keep their tests passing with updated queries.
- Invariant #6: shadcn primitives and semantic tokens only, with no raw colours.
  Text sizes stay on the existing ramp (12, 13, 14, 15, 24px); **no 11.5px.**

## Tests

Update the existing tests to the new structure, and change queries from visible text
to role/name where text became an icon. Keep every behaviour assertion. Add tests
for:

- tooltips and accessible names on the icon actions;
- the ⋯ Delete confirm (including Pause instead);
- the inline reply in the ask banner;
- the "N earlier" expansion;
- the About rows opening in place;
- the list's agent filter;
- the N done toggle;
- the calm line;
- the dialog's field-level errors and the absence of raw zod text.

Run `pnpm --filter @ax/channel-web test` and
`pnpm --filter @ax/channel-web exec tsc --noEmit -p .` (channel-web's tsc includes
test files), and lint the changed files.
