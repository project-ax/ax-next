# Agent Goals & Tasks — design (in progress)

> **Paused 2026-10-20.** Superseded by the [Agent Tasks design](2026-10-20-agent-tasks-design.md).
> Don't turn this into a spec; the resume checklist in §9 no longer applies.

**Status:** Brainstorming, all sections reviewed. The data model and UX were
approved on 2026-10-09; the agent side (§6) was reviewed on 2026-10-11 under the
AX Work Model framing, where goals are work item W6 and tasks moved to their own
plugin (W13). Next: turn this into a final spec.
**Resume at:** [§9 Resume checklist](#9-resume-checklist).
**Started:** 2026-10-07 · **Owner:** Vinay
**Mocks:** current: https://www.figma.com/design/yDka46zOpwgipUxTBWiXuo/?node-id=136-879
(round 3, frames R1–R9); first mock: https://www.figma.com/design/QMFOa9v5Z5b67XWJdC51jJ
**Framing:** AX Work Model, https://claude.ai/artifact/VKVaYGHsUujqm4ZAE7xmSe

---

## 1. Why

ax agents run all the time: routines fire on schedules and approvals wait for
people. Today nothing says *what an agent is trying to achieve*, how far along
it is, or how a person steers it when it drifts.

In a company there will be many ax agents, and most will be **digital
employees** (agents owned by a team). They should line up with company goals,
and eventually with OKRs. Employees' personal agents can be given goals and
tasks too.

We want an experience that is **delightful, simple and powerful** for:

- **defining** goals and the tasks under them,
- **seeing** progress and health,
- **course-correcting** when an agent drifts.

## 2. Decisions so far

| # | Decision | Why |
|---|---|---|
| D1 | **Primary user for v1: the manager of digital employees.** An ops or team lead with 5–50 agents. The exec OKR view and the employee's single-agent view come later, as other views of the same data. | "Simple" means picking one person to delight first. |
| D2 | **Two kinds of goal.** A *responsibility* is standing and never finishes; it is measured as **health**. An *objective* is time-boxed with a target; it is measured as **progress**. | A digital employee has a job description plus quarterly objectives, just like a human employee. |
| D3 | **A goal's number is either *counted* or *estimated*.** The UI says "Counted from …" or "Caveman's estimate". *Counted* means the host computes it: in v1 from the goal's linked tasks; from a connected system (a sheet, a CRM) once W5's host-side connector call exists. *Estimated* means the agent supplies a number with evidence and a judge checks it. The **agent suggests how to count** and a human accepts it with one click. (Revised 2026-10-11; was *measured* / *reported*.) | Research shows people distrust an agent's self-reported progress. |
| D4 | **Autonomy setting per goal: *Ask me first* / *Use its judgment*** (default). Two settings, not three: "Just do it" would have overridden the owner's own tool rules, which a goal must never widen (revised 2026-10-11). Trust grows the existing way, with "Always allow" on a held call. The steering verbs are **Redirect** ("Tell Caveman what to change"), **Reprioritize** (drag to reorder) and **Pause**. | The manager loosens control as trust builds. |
| D5 | **No company-goal layer in v1.** Each goal has a plain-text **"Why this matters"**. The data model reserves a nullable `parentId` for company goals or OKRs later. When that layer arrives, the "why" text is used to *suggest* a parent for each goal. | The user explicitly chose to ship alignment second. |
| D6 | **A new `@ax/goals` plugin, database only.** No `.ax/GOALS.md`, no rendered file, no validator. Humans edit in the UI. The agent reads its goals through the host and changes them **only by proposal**. | See §3. |
| D7 | **Goals is a full page: one list grouped Waiting on you / Needs attention / On track / Done recently.** A goal opens as a full page too. The Goals sidebar item has no badge (Today already counts what needs you) and appears only once the first goal exists; the agent offers "Make this a goal?" in chat. No "team roster" cards. (Revised 2026-10-11; the agent rail gets a Tasks tab, not a Goals tab.) | It scales to about 100 goals, and the sidebar already serves as the roster. Approvals that aren't health states still surface. |
| D8 | **Visual language: inherit channel-web** (shadcn and semantic tokens, IBM Plex Sans, light background with navy text). Health uses **existing tokens only**: on track = `ring` (blue), at risk = `warning`, off track = `destructive`, no recent update = hollow `state-quiet`. | Invariant #6. Adding a `success` token is an open question (§8). |
| D9 | **Only an agent's owner sets its goals.** For a team-owned agent that means the team's admins. Anyone else suggests a goal, and the owner accepts it (2026-10-11). | The same suggest-and-accept rule as tasks. A goal sends the agent off to work on its own, so a shared agent shouldn't take goals from everyone. |
| D10 | **Tasks belong to agents and live in `@ax/tasks` (work item W13), not in this plugin.** A goal lists the tasks linked to it (2026-10-11). | One task concept across chats, projects and goals. |
| D11 | **One measure per goal in v1**, down from up to three (2026-10-11). | R3 shows one progress bar; several "key results" per goal is the OKR shape most people won't need. |

## 3. Rejected alternatives (and why)

- **Goals as agent-editable files** (`.ax/goals/*.md`, the routines pattern).
  `.ax/**` writes go through `workspace:pre-apply` (`packages/core/src/workspace-apply-facade.ts`).
  That checkpoint only lets automated validators veto a write. There is **no
  human review step**, so the agent could rewrite its own target or loosen its
  own dial.
- **The file approach with "veto the agent, allow humans".** The checkpoint
  can't tell who is writing. `packages/validator-identity/src/plugin.ts:170`
  says so: *"pre-apply carries no trusted origin… `reason` is
  agent-influenceable."* It would need a new trusted-origin stamp, plus files
  for tasks and progress. The user judged this too complicated and chose
  database only.
- **A goal as a routine with a success condition.** This conflates *when to
  wake up* with *what to achieve*. It also can't represent responsibilities,
  measures or roll-up.
- **A "Team roster" home (one card per agent).** It doesn't scale past about
  10 agents and duplicates the sidebar's agent list.

## 4. Data model (approved; revised 2026-10-11)

Every record below is owned by `@ax/goals`. Storage-specific names stay inside
the plugin; hook payloads use the vocabulary below (invariant #1).

**Goal**
- `id`, `agentId`, `kind: 'responsibility' | 'objective'`, `title`, `why` (text).
  The UI says "ongoing" for a responsibility and shows the due date for an objective.
- `autonomy: 'ask' | 'judgment'` (default `judgment`; see D4)
- `status: 'active' | 'paused' | 'achieved' | 'dropped'`
- `priority` (order within the agent), `dueAt` (objectives only)
- `projectId` (nullable): the project that holds the goal's context
- `version` (bumped on every human edit; suggestions carry the version they were made against)
- `parentId` (nullable, **unused in v1**), `createdBy`, timestamps

**Measure** (zero or one per goal in v1, see D11)
- `goalId`, `label`, a target for objectives or a threshold for responsibilities, a direction
- `source: 'counted' | 'estimated'`
- counted, in v1: the number of the goal's linked tasks that are done (the host already has them)
- counted, after W5: a saved connector query that the host runs with the agent's grants (the agent suggested it and a human accepted it)
- estimated: the number comes from the agent's updates, with evidence, and the judge checks it
- A goal with no measure (for example "keep bills paid on time") is tracked by health alone.

**Tasks** moved to `@ax/tasks` (W13, see D10). A task can link to a goal; the
goal's task list is the tasks linked to it. A task the agent wants to add under
*Ask me first* is a suggestion (a decision, §6.4) until the owner accepts it.

**Check-in** (an entry in the timeline; the UI calls it an update)
- `goalId`, timestamp, `health: on_track | at_risk | off_track`, a one-line summary, the measure value at that moment, evidence
- Evidence is a list of references to things the host holds: a project file path, or a tool call in the session's transcript
- **Judge verdict**: checked / couldn't check, plus a short reason (§6.3)
- A goal with no check-in within its expected window is shown as **"No recent update"** (gray): a week for any goal, a day during a dated goal's final week.

**Redirect** (a person's "Tell Caveman what to change" note; was *Steer*)
- `goalId`, author, text, `createdAt`, `removedAt`
- Stays part of the goal, and is shown to the agent in every session, until a person removes it. The doc used to drop a steer once the agent acknowledged it, which made the agent forget it a week later.
- Sending one runs a short agent turn; the agent's reply is posted on the timeline under the redirect.

**Who can write what**

| | Goal and measure | Redirects | Check-ins |
|---|---|---|---|
| Agent owner (team admins for a team's agent) | edit freely | add, remove | — |
| Anyone else who can use the agent | suggest only (a decision) | — | — |
| The agent | suggest only (a decision) | — | write |

Only a human, or a counted value reaching its target, marks an objective
**achieved**. The agent never marks its own goal achieved.

## 5. UX (mocked, approved structure)

**Current mocks (round 3, 2026-10-11):** page "Goals, tasks and digest" in
https://www.figma.com/design/yDka46zOpwgipUxTBWiXuo/?node-id=136-879, in the
simplified style of the workspace redesign. R1 Today with the morning summary ·
R2 Goals · R3 A goal (two autonomy settings, linked tasks, Redirect) · R4 an
agent's Tasks tab · R5 a project's tasks · R6 suggesting a task to someone
else's agent · R7–R8 mobile · R9 the first goal offered from chat, before Goals
is in the sidebar. Where round 3 and the first mock below disagree, round 3 wins.

The first mock, kept for history: **ax — Goals (mock)**, https://www.figma.com/design/QMFOa9v5Z5b67XWJdC51jJ.
It is light theme only, at 1440 wide, and uses sample data.

| Frame | Node | Shows |
|---|---|---|
| 01 Goals home (needs attention) | `6:6` | "Waiting on you" (a plan to approve, a proposed target change), then Off track → At risk → No recent update → On track (collapsed) |
| 02 Goals home (all calm) | `7:283` | "Nothing needs you right now", the on-track list, "Achieved recently" |
| 03 Goal detail, objective | `8:558` | Proposal banner; progress with an "expected by today" tick; weekly bars; measured vs reported; check-in timeline (with judge lines and a steer plus the agent's reply); autonomy dial; tasks (proposed ones have Approve and Skip) |
| 04 Goal detail, responsibility (redirecting) | `8:880` | Inline **Redirect** composer (not a modal); daily chart with a dashed threshold line and over-threshold bars in red |
| 05 Goal detail as a side sheet | `9:723` | The same steering in a 520px sheet over the list, plus "Open full page" |
| 06 Agent view, Goals tab | `9:1312` | A target tab in the agent rail; the agent cites its goal inline in chat; its idea links to the approval |
| Components | `4:2` | `Goal row`, `Sidebar`, `Source badge` (Measured / Reported). Colors are the `ax tokens` variable collection. |

**UX rules captured in the mock:**
- *Counted* numbers ("Counted from …") look solid; *estimated* ones ("Caveman's estimate") look lighter, with a dashed outline. Estimates never look as authoritative as counted numbers.
- Every check-in shows the judge's line: "✓ Checked: …" or "Couldn't check one claim…".
- Each row shows the agent's latest check-in **in the agent's own words**.
- Redirect is an inline composer. Its helper text reads "…you'll see its reply, and what changed, in the timeline."
- Reprioritize is drag-to-reorder via grip handles; no separate control.
- The Goals sidebar entry has no badge; Today already counts everything that needs you. It appears once the first goal exists. (Revised 2026-10-11; the first mock showed a count.)
- Anti-goals: no gamification, no scores, no fake precision.

**Decided (2026-10-11):** a goal opens as a **full page** (round 3 R3). The side
sheet (05) is dropped.

## 6. Agent side and wiring (reviewed 2026-10-11)

Reviewed under the AX Work Model framing: one cheap daily plan per agent picks
the day's work (W11), work runs in fresh sessions scoped to a project or goal,
and tasks live in `@ax/tasks` (W13).

**6.1 How the agent sees its goals.**
- **At session start, not turn start.** `system-prompt:augment` runs only on a
  fresh spawn (`packages/chat-orchestrator/src/orchestrator.ts:665`) and has a
  single provider today (`@ax/memory`), so goals need W1 (ordered contributions
  from several plugins). When a person edits a goal or adds or removes a
  redirect, `@ax/goals` fires `system-prompt:augment-changed`, which already
  retires the agent's live sessions at their next turn (TASK-612). The agent
  sees the change on its next turn with nothing new to build.
- **What goes in depends on the session.** A work session started for a goal
  gets that goal in full: target, progress, open redirects, the autonomy
  setting and its linked tasks. A chat gets a short list: the top five active
  goals by priority, title and health only. The daily plan reads health and
  deadlines, not content.
- The goals block is agent- and human-authored content, so it never sets
  `bootstrapSafe`.
- **Three tools:**
  - `goal_get`: one goal's details and recent timeline.
  - `goal_checkin`: post an update (health, one line, the measure value for an
    estimated measure, evidence references).
  - `goal_suggest`: suggest any change (target, date, measure, how to count,
    title) or a new goal. It becomes a decision (§6.4). It also drives the
    "Make this a goal?" card in chat (R9).
- Gone from the first draft: `goal_list` (the list is in the prompt),
  `task_upsert` (tasks moved to `@ax/tasks`), `propose_measure` (folded into
  `goal_suggest`) and `steer_ack` (the agent replies to a redirect in a normal
  turn).

**6.2 Periodic check: the daily plan replaces the goal pulse.**
- No routine per goal. The daily plan (W11), one cheap pass per agent, reads
  goal health, deadlines and what changed, and picks the day's work. Work
  sessions post the check-ins. Events skip the plan: a counted value moving, a
  linked task finishing, or a new redirect.
- "No recent update" shows after a week without a check-in, or a day during a
  dated goal's final week.
- Cost: once a day plus events, with no goal-specific ceiling. Goal work runs
  as the agent's owner and counts toward the existing usage limits
  (`usage:check` in `@ax/usage-limits`).
- Counted values need no model call. In v1 the host counts done linked tasks.
  Counting from a connector needs the host to call a connector tool, which it
  can't today (it can only list them with `connectors:describe-tools`). That is
  the same `connectors:call-tool` hook W5 adds for sources, with the same
  security review, so connector counts arrive with W5. Until then such goals
  use the agent's estimate.

**6.3 Judge.**
- Runs inside `@ax/goals` on the host, right after a check-in is written, with a
  cheap model through `llm:call:<provider>`, the way conversation titles and
  memory extraction already call a model. It is not a hook subscriber: the
  verdict is stored on the check-in, which `@ax/goals` owns (invariant 4).
- It judges every check-in the agent writes and skips counted values, which the
  host fetched itself.
- Evidence must reference something the host already holds: a project file, or
  a tool call in that session's transcript. The judge reads those records, not
  the agent's description of them. Any other reference gets "Couldn't check".
  The judge never fetches the web.
- The judge reads untrusted text (the agent's summary, files, tool output). It
  gets no tools, returns a fixed shape (checked / couldn't check, plus a reason
  capped at about 200 characters), and the reason renders as plain text. A
  prompt-injected agent may still talk the judge into "✓ Checked", so the line
  is a hint, not proof: only a person or a counted value marks a goal achieved
  (§4).

**6.4 Approvals.**
- `@ax/decisions` owns "something is waiting for a person"; `@ax/goals` and
  `@ax/tasks` own the thing it is about. That's the same split held tool calls
  already use.
- A suggested goal change, new goal or task is a decision until someone accepts
  it, not a goal or task row with a "proposed" status. One record holds the
  wait, and Today, the goal page banner (R3) and an agent's Suggested group
  (R4) all read it. Accepting applies the change through `@ax/goals` or creates
  the task through `@ax/tasks`.
- New decision kinds are needed: today `DecisionKind` is `'action' | 'grant'`
  (`packages/decisions/src/types.ts:55`, hand-copied in
  `packages/channel-web/src/lib/workspace-types.ts:50`).
- A suggestion made against an older goal `version` goes **stale** rather than
  overwriting a human's edit.
- Plans need no approval. Under *Ask me first* the tasks a plan would add wait
  as suggestions instead.

**6.5 Enforcing the autonomy setting.**
- Enforced on the host, never by prompt alone, in the existing `tool:pre-call`
  gate (`packages/decisions/src/pre-call.ts`). Tool rules already classify calls
  as `outward` (sends something to someone) or `spends` (money)
  (`packages/tool-policy/src/types.ts:94`).
- *Ask me first*: in a session working on this goal, every `outward` or
  `spends` call is held, even if the agent's rules would allow it, and new
  tasks wait as suggestions.
- *Use its judgment*: the agent's normal tool rules apply unchanged, and it
  adds tasks freely.
- A goal can only narrow what the agent may do, never widen it, the same rule
  as projects. That is why there is no "Just do it" (D4).
- The host attaches the goal to a work session when it starts it, the way it
  attaches a project. The model never names its own goal context.
- Changing the goal itself (target, date, how it's counted) is always a
  suggestion, whatever the setting.

**6.6 Pause.** A paused goal leaves the prompt and the daily plan skips it. Its
linked tasks stay in the agent's list. Pausing a whole agent is out of scope.

**6.7 Testing.**
- Plugin unit tests: goal status, redirect lifecycle, staleness against
  `version`, judge output parsing (fixed shape, capped reason, unknown evidence
  → "couldn't check").
- Host enforcement: under *Ask me first*, an `outward` call in a goal work
  session is held; under *Use its judgment* the agent's own rules decide.
- Contract tests for the `goals:*` hooks.
- Canary acceptance: make a goal from chat (R9) → the daily plan posts a
  check-in with a judge line → accept a suggested new date → send a redirect and
  see the reply on the timeline.
- A Playwright walk on kind for round-3 frames R1–R9.
- Run `security-checklist` on the judge and on the injected goals block.

## 7. Boundary review notes (for the PR)

- **New hooks.** `goals:list`, `goals:get`, `goals:checkin`, `goals:suggest`
  and `goals:redirect`, plus new decision kinds in `@ax/decisions`. Final names
  will be settled in the spec.
- **Alternate implementation.** An external OKR tool (Linear initiatives,
  Lattice) as the source of truth behind the same hooks.
- **Leak check.** No `sql`, `row` or `sheet` vocabulary. A counted source is
  described as "linked tasks" or "connector + query", never named after a
  specific vendor's API. Evidence references say "project file" or "tool call",
  not storage paths or transcript row ids.
- **Security** (invariant 5, run `security-checklist`):
  - The agent can't edit its targets, autonomy setting or "achieved" status;
    it can only suggest.
  - The autonomy setting only narrows the agent's tool rules (§6.5). The goal
    context of a session is set by the host, never by the model.
  - Check-in, evidence and judge text is untrusted model output: render it as
    text and never interpolate it.
  - The judge has no tools and reads only records the host already holds.
  - Connector counts (after W5) run with the agent's existing connector grants,
    never wider ones.

## 8. Open questions

Still open:

2. Add a `success` (green) token for "on track", or keep the existing blue `ring`?

Answered on 2026-10-11:

1. Goal detail: a **full page** (§5).
3. Goals for a team-owned agent: the **team's admins** set them; other members suggest (D9).
4. The judge runs on the host for **every check-in the agent writes**, and skips counted values (§6.3).
5. Cadence: the **daily plan plus events**, no pulse routine. No goal-specific cost ceiling; the existing usage limits apply (§6.2).
6. Another person's agent: you **suggest** a goal and its owner accepts it (D9).

## 9. Resume checklist

1. ~~Answer §8 Q1~~ (done 2026-10-11: full page).
2. ~~Walk §6.1 → §6.7~~ (done 2026-10-11).
3. Turn this doc into a final spec: settle hook names, and line it up with the
   W1 (prompt contributions from several plugins) and W13 (`@ax/tasks`) specs.
4. Run `superpowers:writing-plans` to write the implementation plan.
5. If the work goes through auto-ship, land this doc on `origin/main` first
   (cards citing a design must find it there), then decompose into cards.

## 10. Research references (2026-10-07)

- **OpenClaw:** `HEARTBEAT.md` (silent when there's nothing to report),
  standing orders (Authority / Trigger / Approval gate / Escalation), and
  idle-heartbeat cost blowups.
  https://docs.openclaw.ai/automation/standing-orders
- **Hermes `/goal`:** a judge returns `done | blocked | continue | wait` with a
  reason; the goal pauses when its budget runs out.
  https://hermes-agent.nousresearch.com/docs/user-guide/features/goals
- **Codex `/goal`:** a structured goal (objective, verification, constraints,
  budget); the agent can only mark it complete with evidence.
  https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex
- **Claude Code `/goal`:** a fast model judges each turn and shows its reason
  as the goal's live status. https://code.claude.com/docs/en/goal
- **Linear and Perdoo:** a health flag plus a gray "no update" state;
  progress computed rather than typed in.
  https://linear.app/docs/initiative-and-project-updates
- **Relevance AI / Gemini Enterprise inbox:** humans see only exceptions
  ("needs input / error / done").
  https://relevanceai.com/docs/build/workforces/workforce-features/approvals-and-escalations
- **Lindy / Artisan:** trust settings that people loosen per action as
  confidence grows.
