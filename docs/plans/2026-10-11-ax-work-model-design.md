# AX Work Model (umbrella design)

**Status:** design approved in conversation on 2026-10-11; each work item gets its own spec and plan before it's built.
**Owner:** Vinay · **Started:** 2026-10-11 · **Last updated:** 2026-10-12
**Mocks:** [Projects, simplified flow](https://www.figma.com/design/yDka46zOpwgipUxTBWiXuo/?node-id=120-291) ·
[Goals, tasks and the morning summary](https://www.figma.com/design/yDka46zOpwgipUxTBWiXuo/?node-id=136-879)
(both need access to the AX Figma team)
**Shareable snapshot:** https://claude.ai/artifact/VKVaYGHsUujqm4ZAE7xmSe (private; v7 as of 2026-10-12).
**This file is the source of truth.** The snapshot is refreshed only when we want to show someone.
**Code cited at:** `a730c4c6e`.

How AX helps a company reach its goals, at the company level and at each
person's level, using goals, agents, projects and knowledge, each with one
clear home.

---

## Resume here

- **Now:** the W1 spec is drafted and waiting for review:
  [`2026-10-12-w1-prompt-contributions-design.md`](2026-10-12-w1-prompt-contributions-design.md).
- **Next, in order:**
  1. Approve the W1 spec, write its plan, and put its cards on the board.
  2. Write the W2 (shared folders) spec. W1 and W2 can be built in parallel.
  3. Turn the goals design into a final spec, lined up with W1 and W13.
  4. Write the W13 (agent tasks) spec.
- **2026-10-12:** this file, the W1 spec and the goals-design rewrite landed
  together in one docs PR (branch `docs/ax-work-model`).

## Status

One row per work item. Statuses go: no spec → spec draft → spec approved → plan → cards → shipped.

| W | Work item | Phase | Needs | Spec | Status | Cards |
|---|---|---|---|---|---|---|
| W1 | Prompt contributions from several plugins | Foundation | nothing | [W1 spec](2026-10-12-w1-prompt-contributions-design.md) | spec draft | — |
| W2 | Shared folders | Foundation | nothing | — | no spec | — |
| W3 | Projects | Projects | W1, W2 | — | no spec | — |
| W4 | Sharing across owners | Projects | W3 | — | no spec | — |
| W5 | Connector sources, plus the host-side connector call | Projects | W3 | — | no spec | — |
| W13 | Agent tasks | Goals and delegation | W1 (the project view also needs W3) | — | no spec | — |
| W6 | Goals v1 | Goals and delegation | W1, W13 (connector counts need W5) | [goals design](2026-10-09-agent-goals-design.md) | design reviewed; final spec next | — |
| W7 | Worker delegation | Goals and delegation | W3 | — | no spec | — |
| W8 | Primary agent as the default | Goals and delegation | nothing (lands best with W3) | — | no spec | — |
| W11 | Daily plan and morning summary | Autonomy | W6, W7, W13 | — | no spec | — |
| W12 | Several agents per project | Autonomy | W4, W13 | — | no spec | — |
| W9 | Company and team goals | Company layer | W6 | — | no spec | — |
| W10 | Publish to company knowledge | Company layer | W3 | — | no spec | — |

W13 was added last, when tasks moved to belong to agents, so it's numbered out of order.

## How we track this across sessions

1. **Design and status live here.** Each work item gets its own spec in
   `docs/plans/`, linked from the Status table.
2. **Implementation lives on the GitHub "TO DO" board** (see the Task Board
   Policy in `CLAUDE.md`). Once a work item's spec and plan are approved, it's
   broken into cards titled `[TASK-n] W3: …`, with "Depends on" pointing at the
   cards they need. Design work stays off the board, because it needs a person
   and auto-ship can't do it.
3. **Decisions agents must know** also go into `.claude/memory/decisions/`
   shards, which are committed and read by every session and yolo-ship agent.
4. **Every session** starts at "Resume here". It ends by updating Resume here,
   Status, and the decisions table (§14), then committing. A doc that a card
   cites must be on `origin/main` before auto-ship picks the card up.

---

## 1. Where we are: everything is keyed by agent

Every kind of context hangs off `agentId`. That works when one agent does one
job. It breaks when an agent juggles several projects, or when two agents (or
two people) need to share context.

| Surface | Scoped by | Where it lives |
|---|---|---|
| Memory facts | Agent only, with no namespace or tag column | `memory-facts-postgres/src/agent-scope-key.ts` |
| Memory injected into the prompt | Agent, once per fresh session (rules, profile, recent, digest) | `memory/src/augment.ts` |
| `/files` | Agent (NFS `subPath: agentId`) | `workspace-filestore/src/plugin.ts` |
| `/agent` workspace | One git repo per agent | `workspace-git-core` |
| Conversations | Agent and user, with no folder or project | `conversations/src/types.ts` |
| Search over files | Doesn't exist; embeddings are used only by the sqlite memory backend | — |
| Company brain | Company-wide, filtered only by source id | `canopy-knowledge` MCP |

Two constraints shape the design:

- **Only one plugin can add to the prompt.** `system-prompt:augment` allows a
  single provider, and `@ax/memory` owns it. Projects, goals and tasks all need
  to add prompt context, so this changes first (W1).
- **New tables need cleanup.** Every table keyed by agent must clean up on
  `agents:deleted`, and a test enforces it. New tables (projects, shares,
  goals, tasks) follow the same rule.

## 2. The model: four concerns, one home each

Stop keying everything by agent. Split the system into four concerns that can
change independently, each with exactly one source of truth.

| Concern | Question it answers | Entity | Shape |
|---|---|---|---|
| Why | What are we trying to achieve? | Goals | Hierarchical: company → team → individual |
| Who | Who does the work? | Agents | A primary agent per person, digital employees, temporary workers |
| Where | Where does the work's context live? | Projects | Flat shared folders at `/files/projects/<id>`, linked from goals |
| Know | What have we learned? | Knowledge | Three tiers: agent memory (private) → project memory (members) → company brain (everyone) |

## 3. Agent or project? The rule people need to know

**An agent is who is acting. A project is what it's working on.**

- **An agent is an identity:** the accounts it signs in as, its persona, its
  memory of the person it works for, its budget, and who answers for it.
- **A project is a body of work:** instructions, memory, playbooks, sources,
  work files and collaborators.

**Agents own capabilities. Projects own context.**

| You want… | Make |
|---|---|
| It to act as a different account (its own email or Slack user) | Agent |
| A team to direct it, with the agent itself shared | Agent owned by the team |
| A lasting role with its own persona ("Sam from Support") | Agent |
| A different topic, set of files or collaborators | Project |
| Different instructions or tone for one body of work | Project |
| Sensitive material kept away from your other work | Project |
| Fewer connectors in use for certain work | A project that narrows them |
| Separate memory about you | Neither. You're one person, so you get one memory about you. |

| Thing | Owned by | A project can |
|---|---|---|
| Connectors, tools | Agent | Narrow them |
| Skills | Agent | Narrow them |
| Routines | Agent | Be the target: the routine runs in the project's scope |
| Tasks | Agent: one agent keeps track of each task, in the database | Show its members' tasks that are linked to it |
| Instructions, memory, playbooks, sources, work files | Project | Own them |

- **Projects narrow, never widen.** A project can turn off some of an agent's
  connectors, tools and skills while the agent works in it. It can never grant
  anything the agent doesn't already have. A "Finance" project keeps the bank
  connector on. An "Inbox triage" project reads untrusted mail, so it turns the
  bank connector off.
- **Routines need someone to run as.** A routine runs as an agent's identity and
  sign-ins and spends its budget, so it belongs to an agent. It can carry an
  optional `projectId`. The project page lists every routine that targets the
  project.
- **Playbooks, not project skills.** Procedures for a project ("how we write the
  weekly report") are markdown files in `playbooks/`, read like any other
  project file. A skill supplied by a shared project would carry another
  person's instructions, and possibly scripts, past the skill validator. A
  procedure that needs a script becomes a normal skill attached to the agent.
- **A second agent that acts as you is allowed, but not encouraged.** By the
  rule, it's the same identity, so it should be the same agent. A second one
  splits memory ("why doesn't my other agent know I like short emails?"), means
  signing in twice, and leaves two assistants claiming to speak for you. When
  someone adds an agent and signs it in as themselves, the UI suggests a project
  instead. A scratch agent for experiments, kept apart from your primary agent's
  memory, still works.

## 4. Agents: one primary per person, digital employees, temporary workers

- **Primary agent.** The default, and most people never make a second agent.
  It's each person's chief of staff: it holds their goals, works in their
  projects, and delegates.
- **Digital employee.** A lasting role with its own identity, accounts and
  accountability: Support, Release Manager, Sales Ops. It can be owned by a team
  or by a person. This is where agent-owned sign-ins (shipped 2026-10-08) pay off.
- **Worker.** Temporary. An agent starts one for a task, scoped to a single
  project with the narrowest permissions. A worker keeps no memory; its
  continuity is the project's memory folder.

**Delegation has to be built natively.** The Claude SDK's built-in `Task` tool
is disabled on purpose, because it "would spawn a sub-agent outside our hook bus"
(`agent-claude-sdk-runner/src/tool-names.ts`; deny rule `builtins.task` in
`tool-policy/src/rules.ts`). Workers need a new AX tool, `delegate`. It starts a
worker session through the hook bus, so every tool call a worker makes goes
through the same policy, approvals, credential proxy and audit as the primary
agent's. Built this way, delegation gives each agent less standing access than
today's long-lived agents, which keep all their permissions all the time:

- Each worker gets only its project's mount, only that project's connectors, and
  only the tools the task needs.
- The primary agent plans, and workers handle untrusted content. The primary
  doesn't read raw Drive docs or transcripts itself, so an injection planted in
  one project can only reach that worker's narrow permissions.
- What a worker returns is untrusted input to the primary agent.
- Work that spans days runs as a durable background run (routines, the daily
  plan). A worker's approval requests go to the person's Today queue.

**Not in v1:** direct messaging between agents with different owners. Agents
coordinate through shared projects and goals: a request note in a shared folder,
or an item in someone's "Waiting on you". Every direct agent-to-agent channel
across owners is another prompt-injection path, and each one would need securing.

## 5. Projects are shared folders

We follow the Claude approach. A project's context is plain files on disk, and
agents find what they need with `ls`, `grep`, `find` and `read`. There are no
embeddings and no index. Agents add to the project by writing files into it.

### 5.1 The building block: folder sharing between agents

Folder sharing is generic infrastructure, and projects are its first user. Most
of the mount plumbing exists already: `sandbox:resolve-mounts` returns a list of
mounts, each with its own `readOnly` flag. A shared folder is one more entry in
that list.

- **Neutral storage.** A shared folder lives at `shared/<folderId>` in the
  filestore, not inside the owner's agent folder. It survives if the owner is
  deleted: ownership passes to the next editor, and if there are no other
  members the folder is deleted.
- **Same path for everyone.** Every member sees it at `/files/projects/<id>`, so a
  path cited in a note works for all of them.
- **Grants** are `(folderId, agentId, role)`, where role is owner, editor or
  viewer. A viewer gets a read-only mount.
- **Revoking access** unmounts the folder at the next session and retires live
  sessions. As with Drive, nothing un-reads what an agent already saw.

### 5.2 A project is a convention on top

```
/files/projects/<id>/
  instructions.md      # what it's for, member roles; read first
  memory/              # what agents learned, shared by all
    status.md          # where things stand; any member edits it
    log.md             # history, append-only
    customers/beta/    # topic folders, two levels at most
  playbooks/           # how this project does things
  sources/             # connector copies, read-only
  work/                # everything people and agents make
```

- A conversation can belong to a project through a nullable `projectId` on the
  conversation.
- **Only the active project is mounted.** A conversation in project X mounts X
  and nothing else.
- The top level is always these five entries. That's exactly what people see on
  the project page, and each one opens the file browser.
- The project's prompt block shows `instructions.md`, a shortened file tree and
  highlights from `memory/`.
- Agents change shared files with small targeted edits, never whole-file
  rewrites, so two agents working on different parts don't collide. The host
  keeps every file's history (who changed what) with one-click undo.

### 5.3 Flat, not nested

Nested projects bring in Drive's hardest problems:
- permissions inherited from the parent, then overridden on a child
- what happens to permissions when something moves
- how a parent's and a child's instructions merge
- which levels get mounted

Each of those becomes a security question, and none of them buys much.
Subfolders inside a project are free and carry no permission meaning.
**Hierarchy belongs to goals.**

### 5.4 Project memory is files, not facts

What agents learn about a project lives in `memory/` as files, not as rows in
`@ax/memory`. So `@ax/memory` doesn't change, and sharing comes free: agent B
reads what agent A wrote with `cat`, and people read and edit it in the same file
browser as everything else.

Memory is one shared folder, with no per-agent folders and no single-writer
rule. Agents can add topic files and up to two levels of folders. Anything only
one agent cares about goes in that agent's own private memory instead. Nothing
captures project knowledge automatically. Agents write memory on purpose, guided
by the prompt and by an "update project memory" step at the end of a
conversation.

### 5.5 Connector sources: keep a reference, sync a copy on the host

A project can include Google Drive docs, Fellow transcripts and other sources
that only a connector can reach.
- The project stores a **reference**: which connector, the external id, who
  attached it, and when.
- A **host-side sync job** writes a text copy into `sources/` with provenance on
  it: source URL, fetch time, and which account fetched it.
- Connector tokens never enter the sandbox.

People add a source from one + menu, then search the connector or paste a link,
the way Claude Projects does it. Neither works today: the host can list a
connector's tools but can't call one. W5 adds a host-side tool call, plus a small
per-connector table of link formats and search tools.

| Kind of source | Behavior |
|---|---|
| Doesn't change (Fellow transcripts, PDFs, meeting notes) | Copied once when attached. |
| Living docs (Google Docs, Sheets, Drive folders) | Re-synced on a schedule, with freshness shown. The agent can fetch the live version through the connector when it needs the authoritative copy. |
| Removed at the source, or detached | The copy is deleted, so the project can't keep content its source has removed. |

**Attaching a source shares it.** Each agent reads a source as its own account.
If agent A's Drive account can open a doc and agent B's can't, copying the doc
into a shared project gives B access that Drive never granted. That's acceptable
only as an explicit act: attaching a source to a project means "I'm sharing this
with everyone in the project." A person does it, and the audit log records it.

The sync runs as the sign-in of the agent that attached the source, labeled
"Synced via Bob's agent". People don't pick that agent. AX uses their agent in
the project that has the connector, primary agent first. If that agent leaves
the project or loses access:
- sync pauses
- the last copy stays
- the Sources row says what to fix

## 6. Knowledge: three tiers, one home for each fact

| Tier | What it holds | Where it lives | Who sees it |
|---|---|---|---|
| **Company** | What the company knows | canopy-knowledge (Slack, Outline, …), read through a connector | Everyone |
| **Project** | What we know about this work | `memory/`, `sources/`, `instructions.md` | Project members |
| **Agent** | Its person's preferences, its own experience | `@ax/memory` facts, per agent, unchanged | That agent and its owner |

**How individual work becomes company knowledge:**
1. A preference or lesson starts in agent memory.
2. The agent writes what matters to the project into `memory/`.
3. A person reviews a summary or decision record, and the agent publishes it to
   Outline, where the brain's existing Outline sync indexes it.

This needs **no new write path into the brain**. The brain stays read-only and
company-visible, as designed.

**Outside AX.** Because project context is plain files, sharing it outside AX is
a file-access problem: a read-only MCP with list, read and grep, or a mirror to a
Drive folder. That's far cheaper than solving retrieval and access control, so
it's left out of v1.

## 7. Goals hold the hierarchy

"Launch Cedar Creek" is a company goal. The engineering, sales and support work
under it are team goals, and each links to its own flat project. Rollups, the
"why does this matter?" chain and company views all come from the goal tree, not
from folder nesting.

- **For the company.** Leadership sets company goals. Teams attach team goals
  under them, and agents take individual goals. Goal check-ins roll up the tree,
  so the company view is a rollup, not a separate system. A "leadership chief of
  staff" is a digital employee owned by the leadership team, not a special
  entity.
- **For each person.** Each person's primary agent sees their goals and the
  chain up to the company goal ("this matters because…"). It works in their
  projects and puts whatever needs a human into "Waiting on you".

A goal links to the projects that hold its context. A **responsibility** goal
("keep support response time healthy") may have no project at all, which is why
goals and projects stay separate concepts. The goal details (data model, judge,
autonomy settings) are in the [goals design](2026-10-09-agent-goals-design.md).

## 8. Daily work: how an agent works on its projects on its own

Each piece of project work runs as its own fresh session, with that project's
prompt, mount and narrowed tools. The agent doesn't loop over every project. It
picks first, then runs the chosen work in parallel.

1. **Trigger: a schedule or an event.** A schedule means one daily plan per
   agent, plus any routines that target a project. An event is a source
   finishing a sync, a webhook, a person's message, or a new task. Events go
   straight to work and skip the plan.
2. **Plan: one cheap pass per agent, with a small context.** It reads signals,
   not content: goal health, deadlines, and what changed in each project since
   the last run. It picks the few projects or tasks that need work today, which
   on most days is zero to three. It replaces the goal pulse (goals design §6.2).
3. **Work: one fresh session for each project and task, in parallel.**
   - Prompt: identity + `instructions.md` + the goal + the memory index + the task
   - Tools: the agent's own, narrowed by the project
   - Mount: `/files/projects/<id>` only
4. **Write back:** memory, task status, a goal check-in, and approvals.
   Approvals go to the Today queue. The next session starts from memory, so no
   long chat history builds up and nothing has to be compacted.
5. **Morning summary: one per person,** not one per project. The primary agent
   writes it at the top of Today (7:00 local by default, with an email option)
   and skips days with nothing new.

Why it's shaped this way:
- **Picking first controls cost.** With ten projects and a routine for each, the
  agent would pay for ten sessions a day just to report "nothing new". OpenClaw
  reported $380/day in idle heartbeat cost. One cheap plan that usually picks one
  or two projects keeps cost from growing with the number of projects.
- **The planner stays clean.** The plan reads counts, timestamps and goal health.
  Raw documents and project memory go only to work sessions, which have narrow
  permissions.
- **Built on routines.** Routines already have schedule and webhook triggers,
  active hours, a silence token and per-run conversations. The new part is an
  optional `projectId`, so a run mounts the project and applies its narrowing.

## 9. Several agents, one project

Agents coordinate through the project, not by messaging each other.

- **Roles.** Each member agent has a role in the project ("Bob's agent: sales
  follow-ups", "Support agent: customer issues"), listed in `instructions.md`.
  Each agent's project prompt shows its own role and everyone else's, and its
  daily plan only considers work in its role. That prevents most duplicate work.
- **Tasks belong to agents.** Every task has one agent that keeps track of it,
  and it lives in the database so it survives across chats. It can link to a
  project, a goal and the chat it came from. Either the agent does it, or the
  agent's person does and the agent reminds them. A project's task list is a
  view of its members' tasks, so there's no shared pool and nothing to claim.
  Shared lists, like a launch checklist, are one file in project memory.
- **No lead agent.** Every member agent keeps the project's status current, and
  file history shows who changed what, so no single agent owns `status.md`. Each
  person's morning summary reads the project's status, so nobody gets the same
  update from several agents.
- **Suggest, then accept.** Nobody can assign a task to an agent with a
  different owner. A person or agent suggests it instead, and that agent's owner
  accepts or declines. A direct assignment would amount to one person's agent
  giving orders to another person's agent.

## 10. Security rules: sharing crosses a trust boundary

Once projects are shared between agents, and between people, these rules carry
real weight.

- **An agent's reach is at most its owner's reach.** A worker's reach is at most
  its parent agent's reach.
- **An agent can't share by itself.** If agents get a share tool, a
  prompt-injected agent can share a project with an outsider's agent, and that's
  data exfiltration with an approval trail. Sharing is a human action, or an
  agent proposal that a human approves (the `connector_propose` pattern).
- **A share between agents with different owners needs the recipient's owner to
  accept.** Shares between agents with the same owner are accepted automatically.
- **Shared content is untrusted input.** Another agent's memory edits, synced
  sources and `instructions.md` are framed as context, ranked below the agent's
  own `.ax/AGENTS.md` and Rules, never as instructions that override them.
- **Only the active project is mounted.** Otherwise an injected note in project
  X could read or write project Y.
- **Attaching a connector source shares its content with everyone in the
  project.** The add flow says so, and the audit log records it. Synced files
  are a prompt-injection path into every member agent, so they get the same
  untrusted framing.
- **Projects narrow, never widen.** A project can turn off an agent's
  connectors, tools and skills. It can't add any. A goal's autonomy setting
  follows the same rule.
- **No feedback loops.** An agent's own writes never trigger it, and other
  agents' memory edits don't trigger immediate work; the next daily plan picks
  them up. Otherwise agent A writes, agent B reacts, agent A reacts, and so on
  until the budget runs out.
- **Approvals go to the acting agent's owner.** Bob's agent asks Bob, even when
  Alice's agent suggested the task.
- **Tasks move between owners only by suggestion.** A person or agent suggests a
  task, and the other agent's owner accepts it. No direct assignment.

## 11. What happens to personal agents

**Correction to the first version of this proposal.** "Stop building for
personal extra agents" drew the line in the wrong place. The line isn't who owns
the agent; it's what the agent is for. The sign-ins design that shipped on
2026-10-08 was motivated by one person owning two digital employees: agent 1
reads and sends mail as bob@canopyworks.com and agent 2 as alice@canopyworks.com,
even when one person owns both
(`2026-10-07-agent-owned-connector-sign-ins-design.md:9`). That's a real use
case, and it stays.

- **What we keep building for:** one primary agent per person (the personal
  chief of staff), and digital employees owned by a person or a team, for any
  agent that needs its own identity, accounts or accountability.
- **What projects replace:** a second or third personal assistant made only to
  keep contexts apart ("my Cedar Creek agent", "my hiring agent"). That job moves
  to projects inside one primary agent.

**What it touches in the codebase:** very little breaks.
- There's no cap on agents per person (`agents/src/store.ts`).
- Onboarding already creates exactly one agent, at first run and in the admin
  wizard.
- The home composer already skips its agent picker when someone has a single
  agent (TASK-250).
- The Today queue already aggregates across agents.

Most of the impact is in how things are framed.

| Area | Today | Change |
|---|---|---|
| Data model | Nothing marks a primary agent. "Default Agent" is only the onboarding display name. | Add a marker, such as `agents.role: primary \| employee`, with exactly one primary per person. |
| Sidebar | An "Agents" list with a count and a permanent "New agent" button (`WorkspaceSidebar.tsx`) | The primary agent is pinned, digital employees are listed under it, and the button becomes "Add a digital employee". Projects get their own section. |
| Create flow | One flow with `first-run` and `add` modes (`FirstRunAutoCreate.tsx`) | First run creates the primary agent. Add mode is reframed around a role and its own sign-ins. |
| Identity template | One bootstrap template that assumes several people share the agent | Add a primary-agent template: one person's chief of staff. The shared template remains for digital employees. |
| Default routines | Created for every personal agent (`routines/src/plugin.ts`) | Created for the primary agent only. Otherwise a person-owned digital employee also gets the personal ones. |
| Sign-ins (shipped) | Each agent signs in as itself | No change. The same-owner, two-accounts test case stays valid. |
| Goals design | Targeted the manager of 5 to 50 digital employees first, and defined digital employees as team-owned | The single-agent view is a first-class v1 audience, and digital employees can be owned by a person, matching the sign-ins design. |
| Team UI | `TeamList` is a read-only placeholder; creating teams, inviting and managing members hasn't shipped | Needed for team-owned digital employees. Folder sharing (W2 to W4) covers cross-person projects without it. |

- **Existing users with several personal agents:** no data moves. One agent is
  marked primary: the onboarding agent, or the most recently used one. The rest
  become person-owned digital employees and keep their memory, files and
  sign-ins.
- **Deferred: turning an agent into a project.** An action that copies an
  agent's `/files` into a new project folder would help people who used separate
  agents to keep contexts apart. It isn't in v1. Nothing is lost without it,
  since every existing agent keeps working. We'll build it if people ask.

## 12. What people see: simple first

Most people using AX aren't technical, so the screens start from patterns they
already know and keep the plumbing out of sight. The mocks are linked at the top
of this doc.

- **Projects in the sidebar.** A top-level Projects section next to Agents. Today
  stays home, and the primary agent is pinned first and is the default in every
  composer.
- **A project page like Claude's.** Chats on the left. On the right, the five
  top-level entries (Instructions, Memory, Playbooks, Sources, Work), then
  Scheduled and Members. No tabs; settings sit behind ⋯.
- **One browser for files and memory.** Every entry opens a full-page file
  browser: a tree on the left, a preview on the right, with Edit and History.
  Memory is just another folder.
- **Adding things.** One + menu: upload, add text, or pick a connector and search
  or paste a link. A problem shows only on the row that has it, such as
  "Sources · 1 needs sign-in".
- **Sharing like Google Docs.** Add people or teams and choose Can edit or Can
  view. Each person joins with their own agent, answering one question.
- **Settings stay out of the way.** Name, description, one list of switches for
  what your agents can use in this project, and Delete.
- **A morning summary on Today.** Your primary agent writes one card each
  morning: done yesterday, planned for today, and goals that need you. Reply to
  change the plan.
- **Tasks in the agent panel.** Each agent has a Tasks tab: suggested, for you,
  doing, to do. A project shows its members' tasks with a Chats / Tasks toggle.
- **Goals when you want them.** A full page grouped by what needs you. It joins
  the sidebar after your first goal, which the agent offers in chat: "Make this a
  goal?"

**Rules every screen follows:**
- Start from a pattern people know.
- Pick a sensible default instead of asking.
- Talk about people, not plumbing.
- Show status only when something is wrong, on the thing that's wrong, with the
  fix one tap away.
- Keep advanced controls behind ⋯.

## 13. Work items

Each step is useful once it ships, so nothing sits half-wired waiting for a later
step. Steps that share no dependencies can run in parallel. Status and spec links
are in the Status table at the top.

| Phase | Work items |
|---|---|
| Foundation | W1 prompt contributions, W2 shared folders |
| Projects | W3 projects, W4 sharing across owners, W5 connector sources |
| Goals and delegation | W13 tasks, W6 goals, W7 workers, W8 primary agent as the default |
| Autonomy | W11 daily plan, W12 several agents per project |
| Company layer | W9 company and team goals, W10 publish to company knowledge |

**W1. Prompt contributions from several plugins.** Turn `system-prompt:augment`
from a single provider into contributions from several plugins, so projects,
goals, tasks and memory each add their own block without importing one another.
*Needs:* nothing. *Unblocks:* W3, W6, W13.
*Packages:* `@ax/core`, `@ax/chat-orchestrator`, `@ax/memory`.

**W2. Shared folders.**
- Neutral storage at `shared/<id>` and a grants table with owner, editor and
  viewer roles.
- Members see the folder at `/files/projects/<id>` through
  `sandbox:resolve-mounts`, and viewers get a read-only mount.
- Cleanup on `agents:deleted`, ownership transfer, and revocation that retires
  live sessions.
- Agents with the same owner only, at first.

*Needs:* nothing. *Unblocks:* W3.
*Packages:* `@ax/workspace-filestore`, `@ax/workspace-localdir`,
`@ax/sandbox-k8s`, new `shared-folders`.

**W3. Projects.**
- Create and list projects, with the fixed `instructions.md` / `memory/` /
  `playbooks/` / `sources/` / `work/` layout.
- A nullable `projectId` on conversations; only the active project is mounted.
- The project prompt block.
- Projects can narrow connectors, tools and skills, and routines can target a
  project through an optional `projectId`.
- Memory guidance (shared files, up to two folder levels, targeted edits), an
  "update project memory" step at the end of a conversation, and per-file
  history with undo.
- UI in channel-web, built with shadcn: the project page, the full-page file
  browser with preview and Edit, and moving a chat into a project.
- Which project a session is for comes from the host, never from the model (see
  the W1 spec, §3.6).

*Needs:* W1, W2. *Unblocks:* W4, W5, W7, W10.
*Packages:* new `@ax/projects`, `@ax/conversations`, `@ax/routines`,
`@ax/tool-policy`, `@ax/channel-web`.

**W4. Sharing across owners.**
- A people-first share dialog (add people or teams, Can edit or Can view) where
  a person shares, or approves an agent's proposal to share. Each person joins
  with their own agent.
- The recipient's owner accepts. Shares between agents with the same owner are
  accepted automatically.
- Everything is audited, and shared content is framed as untrusted context in
  the prompt.

*Needs:* W3. *Packages:* `shared-folders`, `@ax/audit-log`, `@ax/channel-web`.

**W5. Connector sources.**
- Attach Drive, Fellow and other connector items from one + menu, by searching
  the connector or pasting a link.
- Needs a host-side connector tool call (`connectors:call-tool`; today the host
  can only list tools) and a per-connector table of link formats and search
  tools.
- A host-side sync writes text copies with provenance into `sources/`, re-syncs
  living docs about hourly, and deletes copies on detach or when the source is
  removed.
- Needs a security review: synced files are untrusted content that every member
  agent reads.

*Needs:* W3. *Syncs as:* the person's agent in the project that has the
connector, primary agent first; sync pauses if that agent leaves.
*Packages:* `@ax/projects`, `@ax/connectors`, `@ax/mcp-client`,
`@ax/routines`, `@ax/credential-proxy`.

**W13. Agent tasks.**
- Each task has one agent that keeps track of it, and is done by that agent or
  its person.
- Optional links to a project, a goal and the chat it came from.
- Includes the Tasks tab in the agent panel, a project's Chats / Tasks view, and
  suggested tasks across owners that the owner accepts.
- In a chat, the agent's step checklist stays unsaved; only commitments become
  tasks.
- Done tasks leave the list after 7 days but are kept.

*Needs:* W1 (the project view also needs W3). *Unblocks:* W6, W11, W12.
*Packages:* new `@ax/tasks`, `@ax/channel-web`.

**W6. Goals v1.** The details are in the
[goals design](2026-10-09-agent-goals-design.md), whose agent side was reviewed
on 2026-10-11.
- Each goal links to its projects and tasks.
- A full page that joins the sidebar after the first goal, which the agent
  offers in chat.
- Only an agent's owner sets its goals (a team's admins for a team's agent);
  anyone else suggests one.
- Two autonomy settings (Ask me first, Use its judgment), enforced in the host's
  existing tool gate. A goal can only narrow the agent's tool rules.
- One measure per goal, counted from linked tasks in v1 or estimated by the
  agent.
- A judge checks each update against project files and tool calls the host
  already holds.

*Needs:* W1, W13. *Counting from a connector needs:* W5. *Unblocks:* W9, W11.
*Packages:* new `@ax/goals`, `@ax/decisions`, `@ax/channel-web`.

**W7. Worker delegation.** A native `delegate` tool that starts a temporary
worker session through the hook bus.
- The worker gets the project's mount and narrowed tools and connectors.
- Its result is treated as untrusted.
- Long work runs as a durable background run, and approvals go to the Today
  queue.

*Needs:* W3. *Packages:* `@ax/chat-orchestrator`,
`@ax/agent-runner-core`, `@ax/tool-policy`, `@ax/agent-activity`.

**W8. Primary agent as the default.**
- Add an `agents.role` marker with one primary agent per person, and mark
  existing users' primaries.
- The sidebar pins the primary agent and lists digital employees under it.
- The create flow becomes "Add a digital employee".
- Add a primary-agent identity template, and create default routines for the
  primary agent only.
- An action that turns an agent into a project is deferred until people ask for
  it.

*Needs:* nothing technically; it lands best alongside W3.
*Packages:* `@ax/agents`, `@ax/onboarding`, `@ax/agent-identity-templates`,
`@ax/routines`, `@ax/channel-web`.

**W9. Company and team goals.** Use the reserved `parentId` to build the
company → team → individual tree, rollups, a company view, and the "why this
matters" chain in each agent's prompt.
*Needs:* W6. *Packages:* `@ax/goals`, `@ax/teams`, `@ax/channel-web`.

**W10. Publish to company knowledge.** An agent drafts a project summary or
decision record. A person reviews it, and the agent publishes it to Outline,
where the brain's existing sync picks it up. canopy-knowledge doesn't change.
*Needs:* W3. *Packages:* `@ax/projects`, the Outline connector.

**W11. Daily plan and morning summary.**
- One cheap pass per agent with a small context. It reads goal health, deadlines
  and what changed in each project, picks the work for the day, and starts
  worker sessions in parallel.
- Events skip the plan.
- It ends with one morning summary per person, written by the primary agent at
  7:00 local by default and skipped when nothing changed.
- It replaces the goal pulse, keeping its silence token, active hours and
  backoff when nothing changes.

*Needs:* W6, W7, W13.
*Packages:* `@ax/goals`, `@ax/tasks`, `@ax/routines`, `@ax/projects`.

**W12. Several agents per project.**
- Member roles in `instructions.md`, shown in each agent's prompt.
- Tasks move between owners by suggestion only, and the project's task view
  comes from W13, so there's no board and nothing to claim.
- An agent's own writes never trigger it, and other agents' memory edits wait
  for the next plan.

*Needs:* W4, W13.
*Packages:* `@ax/projects`, `@ax/tasks`, `@ax/decisions`, `@ax/channel-web`.

## 14. Decisions

Add a row whenever something is decided, with the date. Decisions that agents
building cards must know also go into a `.claude/memory/decisions/` shard.

| Date | Status | Decision |
|---|---|---|
| 2026-10-11 | Decided | Project context is files on disk, searched with bash tools. No RAG and no index. |
| 2026-10-11 | Decided | Project memory is one shared folder of files, `memory/`, with no per-agent folders and topic folders at most two levels deep. `@ax/memory` stays per agent and unchanged. |
| 2026-10-11 | Decided | Every project's top level is fixed: `instructions.md`, `memory/`, `playbooks/`, `sources/`, `work/`. The project page lists exactly these, and each opens the full-page file browser. The names stay as they are; "Documents" would be confused with Sources. |
| 2026-10-11 | Decided | Simple UX is the top priority. Screens start from familiar patterns (Claude Projects, Google Docs sharing), pick defaults instead of asking, and show status only when something is wrong. |
| 2026-10-11 | Decided | Projects can be shared between agents, like folders. The building block is folder sharing. |
| 2026-10-11 | Decided | canopy-knowledge stays company-visible and read-only. Project content isn't indexed there. |
| 2026-10-11 | Decided | An agent is who is acting and a project is what it's working on. Agents own capabilities; projects own context. |
| 2026-10-11 | Decided | Projects can narrow an agent's connectors, tools and skills, but never widen them. |
| 2026-10-11 | Decided | Routines belong to an agent and can target a project. Project procedures are playbooks (context), not project-owned skills. |
| 2026-10-11 | Decided | Daily work: a cheap daily plan picks the projects that need work, then runs fresh, parallel sessions scoped to each project. |
| 2026-10-11 | Decided | Tasks move between agents with different owners only by suggestion, never by direct assignment. |
| 2026-10-11 | Decided | Project instructions live in `instructions.md` rather than a database row, so everything about a project travels with the shared folder. |
| 2026-10-11 | Decided | Connector sources sync as the sign-in of the agent that attached them, labeled "Synced via Bob's agent". If that agent leaves the project or loses access, sync pauses and the project asks for a new sync account. There is no project-owned sign-in. |
| 2026-10-11 | Decided | Agents edit shared project files with targeted edits, and the host keeps per-file history with undo. There is no single-writer rule, `status.md` included. |
| 2026-10-11 | Decided | No access to project files from outside AX in v1. |
| 2026-10-11 | Decided | A digital employee can be owned by a person or a team, using the existing `ownerType`. |
| 2026-10-11 | Decided | No "turn this agent into a project" action in v1. Existing extra agents keep working as digital employees, and nothing in production is measured yet. |
| 2026-10-11 | Decided | Tasks belong to agents. One agent keeps track of each task, and the agent or its person does it. A project's task list is a view of its members' tasks, with no board and no claims. Suggestions across owners wait for that agent's owner to accept. Shared lists are memory files. Done tasks leave the list after 7 days and are kept. |
| 2026-10-11 | Decided | Only an agent's owner sets its goals (a team's admins for a team's agent); anyone else suggests one. Goals joins the sidebar after the first goal. Two autonomy settings, Ask me first and Use its judgment, because "Just do it" would widen the owner's tool rules. One measure per goal in v1. The morning summary is a routine on the primary agent, at 7:00 local by default, shown on Today with an email option, and skipped on days with nothing new. |
| 2026-10-11 | Decided | No lead agent per project. Any member agent updates the project's status, and each person's morning summary reads it. |
| 2026-10-11 | Decided | The goals design's agent side (§6) as reviewed: goals reach the prompt at session start through W1; three agent tools; the daily plan replaces the goal pulse; the judge runs on the host; suggestions are decisions until accepted; connector counts wait for W5. |
| 2026-10-11 | Proposed | One primary agent per person is the default. Digital employees cover separate identities. Workers handle delegation. |
| 2026-10-11 | Proposed | Projects are flat, and goals hold the hierarchy. |
| 2026-10-11 | Proposed | Defaults: a Fellow series copies the last three months, then each new meeting. Switching off a connector that keeps a source in sync leaves the last copy and shows "Can't refresh". No project-wide rules from the owner in v1. |

## 15. Open questions

- **Use outside work, for example a family.** Goals, projects and tasks carry
  over, but accounts need their own pass: whether kids get their own agents,
  what parents can see, and whether a kid's agent can send email or spend money.
  Signup is limited to canopyworks.com today.
- **The three Proposed rows in §14** still need an explicit yes or no.
- **Goals design §8 Q2:** add a green `success` token for "on track", or keep
  the blue `ring`?
