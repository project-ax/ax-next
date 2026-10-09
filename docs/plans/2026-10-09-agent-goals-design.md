# Agent Goals & Tasks — design (in progress)

**Status:** Brainstorming, partly approved. Data model and the home-screen
structure are approved. Screens are mocked in Figma. The agent-side behaviour,
the approvals wiring and the testing sections are **not yet reviewed**.
**Resume at:** [§9 Resume checklist](#9-resume-checklist).
**Started:** 2026-10-07 · **Owner:** Vinay · **Mock:** https://www.figma.com/design/QMFOa9v5Z5b67XWJdC51jJ

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
| D3 | **Each measure is either *measured* or *reported*.** *Measured* means a live query against a connected system. *Reported* means the agent supplies a number with evidence and a judge checks it. The UI always shows which. The **agent proposes the measurement** and a human accepts it with one click. | Research shows people distrust an agent's self-reported progress. |
| D4 | **Autonomy dial per goal:** *Check with me* / *Use judgment* / *Just do it*. New objectives default to *Check with me*; responsibilities default to *Use judgment*. The steering verbs are **Redirect** (a plain-language note), **Reprioritize** (drag to reorder) and **Pause**. | The manager loosens control as trust builds. |
| D5 | **No company-goal layer in v1.** Each goal has a plain-text **"Why this matters"**. The data model reserves a nullable `parentId` for company goals or OKRs later. When that layer arrives, the "why" text is used to *suggest* a parent for each goal. | The user explicitly chose to ship alignment second. |
| D6 | **A new `@ax/goals` plugin, database only.** No `.ax/GOALS.md`, no rendered file, no validator. Humans edit in the UI. The agent reads its goals through the host and changes them **only by proposal**. | See §3. |
| D7 | **Goals home is one list grouped by health,** with a **"Waiting on you"** group at the top. Each agent's view gets a **Goals tab** in its rail. No "team roster" cards on the home screen. | It scales to about 100 goals, and the sidebar already serves as the roster. Approvals that aren't health states still surface. |
| D8 | **Visual language: inherit channel-web** (shadcn and semantic tokens, IBM Plex Sans, light background with navy text). Health uses **existing tokens only**: on track = `ring` (blue), at risk = `warning`, off track = `destructive`, no recent update = hollow `state-quiet`. | Invariant #6. Adding a `success` token is an open question (§8). |

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

## 4. Data model (approved)

Every record below is owned by `@ax/goals`. Storage-specific names stay inside
the plugin; hook payloads use the vocabulary below (invariant #1).

**Goal**
- `id`, `agentId`, `kind: 'responsibility' | 'objective'`, `title`, `why` (text)
- `autonomy: 'check' | 'judgment' | 'auto'`
- `status: 'active' | 'paused' | 'achieved' | 'dropped'`
- `priority` (order within the agent), `dueAt` (objectives only)
- `parentId` (nullable, **unused in v1**), `createdBy`, timestamps

**Measure** (one to three per goal; the "key results")
- `goalId`, `label`, a target for objectives or a threshold for responsibilities, a direction
- `source: 'measured' | 'reported'`
- measured: a saved connector query (the agent proposed it and a human accepted it)
- reported: the number comes from check-ins, with evidence links

**Task** (the agent's to-do list under a goal)
- `goalId`, `title`, `status: 'proposed' | 'todo' | 'doing' | 'blocked' | 'done' | 'dropped'`
- `createdBy: agent | human`, note, evidence links
- Under *check with me*, new agent tasks start as `proposed`.

**Check-in** (an entry in the timeline)
- `goalId`, timestamp, `health: on_track | at_risk | off_track`, a one-line summary, measure values at that moment, evidence
- **Judge verdict**: verified / can't verify, plus a reason
- A goal with no check-in within its expected window is shown as **"No recent update"** (gray).

**Steer** (a manager's redirect note)
- `goalId`, author, text
- State: open until the agent acknowledges it with a reply, then **absorbed**
- Shown to the agent until absorbed; appears in the timeline with the agent's reply.

**Who can write what**

| | Goals and measures | Tasks | Check-ins |
|---|---|---|---|
| Human (agent owner or team admin) | edit freely | add, approve, skip | — |
| Agent | **propose only** (becomes an approval) | create and update within its dial | write |

Only a human, or a measured value reaching its target, marks an objective
**achieved**. The agent never marks its own goal achieved.

## 5. UX (mocked, approved structure)

Figma file: **ax — Goals (mock)**, https://www.figma.com/design/QMFOa9v5Z5b67XWJdC51jJ.
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
- *Measured* badge: a solid soft chip with a gauge icon. *Reported* badge: a dashed outline. Reported numbers never look as authoritative as measured ones.
- Every check-in shows the judge's line: "Evidence checks out…" or "Couldn't verify one claim…".
- Each row shows the agent's latest check-in **in the agent's own words**.
- Redirect is an inline composer. Its helper text reads "…you'll see its reply, and what changed, in the timeline."
- Reprioritize is drag-to-reorder via grip handles; no separate control.
- The Goals sidebar entry carries a count of items waiting on you, hidden when zero.
- Anti-goals: no gamification, no scores, no fake precision.

**Open UX choice:** goal detail as a **full page** (03/04), a **side sheet** (05),
or **both** (the sheet from the list, the full page from links and the
"Open full page" button). It hasn't been decided yet; the recommendation is both.

## 6. Proposed, NOT yet reviewed: agent side and wiring

This is a starting point for the next session. Present it section by section for approval.

**6.1 How the agent sees its goals.** At turn start the host injects a compact
"Your goals" block: active goals, measures and latest values, open steers, the
dial, and its open tasks. It is read through a `goals:*` service hook. The
agent's tools are narrow:
- `goal_list` / `goal_get` (read)
- `task_upsert` (respects the dial: under *check with me*, tasks are created as `proposed`)
- `checkin_report` (health, summary, values, evidence)
- `steer_ack` (reply to a steer)
- `propose_goal_change` (a target, measure, title or new goal; becomes an approval)
- `propose_measure` (a connector query; becomes an approval)

**6.2 Periodic goal check ("goal pulse").** A default routine per agent with
active goals, reusing `@ax/routines`. It is an interval routine, silent when
there's nothing to report (`silenceToken`), runs within `activeHours`, and
uses the **cheap or helper model with a slim context**. That's a guard against
OpenClaw's reported $380/day idle-heartbeat cost.

Check-in frequency backs off when nothing changes. "No recent update" is
computed from the expected cadence.

**6.3 Judge.** After each `checkin_report`, a small model checks that the
evidence supports the reported values and the stated health. Its verdict is
stored on the check-in. Measured values are fetched by the host via
connectors, never by the agent. Open question: does the judge run on the host
or as a hook subscriber?

**6.4 Approvals.** Plans, proposed tasks, goal changes and measure proposals
all reuse `@ax/decisions` (approve, dismiss, freshness/stale, and replay when
nobody is watching). They appear in Today **and** in Goals → "Waiting on you".
A proposal made against an older goal version goes **stale** rather than
overwriting a human's edit.

**6.5 Enforcing the dial.** It is enforced on the **host** side when tools
execute, never by prompt alone:
- *check with me*: any new task or plan is held as a decision.
- *use judgment*: things the agent does routinely run freely. Anything new
  (a new plan, a recipient not seen before, spending money) is held.
- *just do it*: nothing is held; everything is logged.

**6.6 Pause.** A paused goal is dropped from the injected context, and its
pulse skips it. Per-agent pause doesn't exist yet: `AgentView` notes this, and
`PauseAgentsDialog` covers usage limits only.

**6.7 Testing (sketch).**
- Plugin unit tests: the state machines (goal status, task status, steer
  absorbed, staleness), and that the dial is enforced by the host.
- Contract tests for the `goals:*` hooks.
- Canary acceptance: create a goal, get a pulse check-in, approve a proposal,
  send a redirect and see it absorbed.
- A Playwright walk on kind for screens 01–06.

## 7. Boundary review notes (for the PR)

- **New hooks.** `goals:list`, `goals:get`, `goals:propose-change` and
  `goals:checkin`, among others. Final names will be settled in the
  implementation plan.
- **Alternate implementation.** An external OKR tool (Linear initiatives,
  Lattice) as the source of truth behind the same hooks.
- **Leak check.** No `sql`, `row` or `sheet` vocabulary. A measured source is
  described as "connector + query", never named after a specific vendor's API.
- **Security** (invariant 5, run `security-checklist`):
  - The agent can't edit its targets, dial or "achieved" status.
  - Check-in and evidence text is untrusted model output: render it as text
    and never interpolate it.
  - Measure queries run with the agent's existing connector grants, never
    wider ones.

## 8. Open questions

1. Goal detail: full page, side sheet, or both? (Recommendation: both.)
2. Add a `success` (green) token for "on track", or keep the existing blue `ring`?
3. Who may create goals for a team-owned agent: any team member, or team admins only?
4. Should the judge run on the host (an extra model call per check-in) or only on reported measures?
5. What's the default pulse cadence (every 2h?), and what is the cost ceiling per agent per day?
6. Can an employee give a goal to *another* person's personal agent? (Probably not in v1.)

## 9. Resume checklist

1. Answer §8 Q1 (full page, side sheet or both).
2. Walk §6.1 → §6.7 one section at a time and get each approved.
3. Turn this doc into a final spec (remove "proposed" markers; settle hook names).
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
