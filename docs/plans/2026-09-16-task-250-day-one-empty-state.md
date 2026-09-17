# TASK-250 — the day-one empty state

**Card.** "Day-one empty state for a user with one fresh agent and no history."
**Epic.** `docs/plans/2026-09-12-workspace-as-sole-interface.md`, Tier 4: *"a
brand-new user lands on Today with one agent and nothing done yet. What does that
page say to them?"*
**Copy rules.** CLAUDE.md › Voice & Tone and
`docs/plans/2026-09-11-ux-first-run-copy-spec.md`.

---

## OUTCOME — what actually shipped (re-scoped 2026-09-17)

This doc is the design as it was explored. **Three of its six tasks did not
ship**, and the requester settled which on 2026-09-17. Read this table before
any section below; several of them argue for work that was then dropped.

| tier | disposition |
|---|---|
| **T1** the `Empty` primitive | **SHIPPED** |
| **T4** the zero-turn thread | **SHIPPED** — this became the card |
| **T5** one agent is not a choice | **SHIPPED** |
| T2 `historyIsEmptyFrom` | **DROPPED** |
| T3 the Today day-one panel | **DROPPED** |
| T6 focus the composer | **DROPPED** |

**T3 goes** for the reason set out in "STOP" below: its gate reads the activity
record, and the record has exactly two sources, neither of which is a chat
turn. No Today-route signal can tell "has ever chatted" from "has not", so the
panel would appear right after a first chat and stay forever for anyone who
only chats.

**T2 goes with it, and the section below recommending otherwise is superseded.**
That section argues T2 is independently worth keeping. It is not: the predicate
has exactly one consumer, T3's gate, and CLAUDE.md's Half-Wired Code Policy
forbids merging infrastructure nothing calls. T6 was T3's button, so it goes
too.

**One finding survives the deletion and is NOT fixed here.** `scope` existed
because `useActivityFeed` is one hook instance serving two collections, and the
scope change lands in an effect — so for one render after returning to Today,
every field still describes the agent just left. That is a property of the
hook, not of the predicate, and removing T2 leaves it in place. It has a live
consumer: `doneTodayFrom(feed)` in `WorkspaceShell` counts `done` rows out of
`feed.events`, and `TodayView` prints "N done today" whenever that number is
above zero. So on the render between leaving an agent's tab and the reset
effect running, Today briefly shows **that agent's** done-count as the whole
workspace's. One frame, and an undercount rather than a false claim — which is
why it is a separate card rather than scope creep into this one, not a reason
to think it went away.

---

## What a day-one user actually sees today (read from the code, 2026-09-16)

The first-run path is `App.tsx` → `NewAgentDialog` → `FirstRunAutoCreate` →
`WorkspaceShell`: the person names the agent in the dialog, then
`POST /api/agents/bootstrap` creates it bare, seeds `.ax/BOOTSTRAP.md`, and
drops them on Today.

> **CORRECTION.** This paragraph originally read "No form, no dialog… **a
> workspace user has never seen** `NewAgentDialog`'s 'An agent is your personal
> assistant in ax.'" **That was false**, and several arguments below were built
> on it. `App.tsx` renders `NewAgentDialog` *above* the shell branch and
> non-dismissible on first run, for the workspace as much as for the chat
> shell. See "Fact 3" below.

Today then renders, in order:

| Region | Day-one content |
|---|---|
| header | `Today` · the date · `Needs you` / `Working` (no zero counts — correct) |
| headline | `Nothing is waiting on you.` |
| summary line | absent (positive-only — correct) |
| list card | `When an agent hits something it wants your OK on, it’ll wait for you here.` |
| footer | `Everything they did →` |
| composer | `Ask for something — or just say hi to get started`, picker reads `Auto` |

### The brief's hypothesis, checked

The brief carried one `[INFERRED]` claim: *the gap is likely the wider day-one
surface, not the headline sentence.* **Confirmed, and the two endorsed sentences
stay verbatim.** Both `Nothing is waiting on you.` and `When an agent hits
something it wants your OK on, it’ll wait for you here.` are honest, in voice,
and pinned by tests. Neither is rewritten here.

It also implied the footer link might be a day-one dead end. **Refuted:**
`ActivityFeed.tsx:151-168` already has a good empty state (`Nothing recorded
yet.` + `The record is empty so far. When your agents do something, every run and
every decision shows up here.`). The link lands somewhere sensible. Left alone.

### The three real holes

1. **Today never says what to do first.** Every sentence on the page is about
   the queue — a thing that will matter on day *thirty*. Nothing tells a
   first-timer that they have an agent, what it is called, or that the box at
   the bottom is where you begin. This is the card.

2. **`AgentConversation` renders literally nothing for a zero-turn thread**
   (`AgentConversation.tsx:124-138`). The one workspace surface with no empty
   copy at all — and the surface a day-one user reaches by clicking their only
   agent in the rail.

3. **The first message costs a confirmation step that has one option.**
   `HomeComposer` defaults `pick` to `'auto'`, so a send calls
   `POST /api/workspace/route`, which for a single-agent account returns
   (`routes-workspace.ts:3941-3949`, verbatim) `why: "it's your only agent"`,
   `confident: true`. The person is then shown:

   > ⚡ Auto picked **Quill** — it's your only agent. [Send to Quill] [Someone else] [Cancel]

   A confirmation whose stated reason is that there was nothing to confirm. Two
   clicks and a round-trip to say "hi".

---

## Two hard constraints this design has to respect

**A. No invented suggestions.** `__tests__/no-fixtures.test.ts` is a wall against
plausible-but-false strings on this surface, and `HomeComposer.tsx:188-193`
records the specific lesson: the old placeholder *"try 'find me 30 minutes with
Marcus'"* was deleted because it presumed a scheduler agent, a calendar grant and
a contact. **So: no example prompts, no capability chips, no "try asking it
to…".** Everything the day-one panel says must be derivable from data we read.

**B. An empty state is a claim (H7).** It may render only when the thing is
provably empty, never when the read failed. Three places this bites:

- the queue: `error === null` (already in `TodayView`)
- grants: `grantsError === null` (already in `TodayView`)
- the activity record: a new predicate, below
- the *past-conversation* thread: `AgentView`'s `pastThread` is `[]`
  while `pastError` is set, so an empty-thread empty state that did not check
  `readOnly` would print "nothing here yet" over a failed excerpt read.

---

## Contrast — measured, not eyeballed

**Re-measured 2026-09-17 on the rebased base (`6bd2b280`), for the pairs the
SHIPPED empty state actually produces.** The earlier table here covered T3's
panel too, and its worst row — 4.72:1, the `Say hi to …` button — belonged to
code that no longer exists.

Taken from `src/index.css`'s token values and put through a real browser engine
(`browser_evaluate`: the browser converts each `hsl()` to sRGB, then WCAG 2.x
relative luminance). Both themes. Floor 4.5:1 for normal text. The surface was
read off the enclosing markup, not assumed: `AgentConversation`'s thread pane
sets no background of its own, so it inherits `WorkspaceShell`'s root
`bg-background` / `text-foreground`.

| what | pair | light | dark |
|---|---|---|---|
| `EmptyTitle` | `foreground` on `background` | 17.72:1 | 19.11:1 |
| `EmptyDescription` | `muted-foreground` on `background` | 4.83:1 | 6.14:1 |
| `EmptyMedia variant="icon"` chip | `foreground` on `muted` | 16.12:1 | 16.44:1 |

Worst pair across both themes: **4.83:1** — the description in light mode.
Nothing here is below the floor.

**The one thing to avoid,** for whoever extends this: `muted-foreground` on
`muted` measures **4.40:1 in light mode** — under the floor — because `muted`,
`secondary` and `accent` are all `240 5% 96%` there. The same pairing is 5.28:1
in dark, so a dark-mode-only check clears it and the bug ships. Every new string
above sits on `bg-background` instead. (`AgentConversation`'s pre-existing
find-in-conversation strip already has that pair; out of scope here, noted as a
follow-up.)

---

## STOP — T3's premise does not survive contact with `main` (found 2026-09-16, on the rebase)

Everything above about T3 was written against `main` at the time of the first
build. The branch was then rebased onto `74c5b984`, which merged **PR #553
(TASK-249)**, and three facts read out of the rebased tree contradict the
premise T3 rests on. **Settled 2026-09-17: option (i) below — T3 and T6 are
dropped, and T2 with them, because T3 was its only consumer. T1, T4 and T5
shipped.**

### Fact 1 — the activity record contains no conversations

`GET /api/workspace/activity` merges exactly **two** sources
(`server/routes-workspace.ts`, `firesForAgent` and `receiptsForAgent`): the
`routines:recent-fires-for-agent` service hook and the
`decisions:recent-receipts-for-agent` service hook. **A chat turn is neither.**

So `historyIsEmptyFrom` does not mean what its own doc comment says it means.
It does not answer *"has anything ever happened in this workspace?"* — it
answers *"has no routine fired and no decision been resolved?"* And note the
degenerate case: in a deployment with neither `@ax/routines` nor `@ax/decisions`
loaded, both helpers return `[]` unconditionally, so the predicate is
**permanently true** for every account on every day.

Worth noting that the product already says this out loud, in the copy this doc
praised two sections earlier: `ActivityFeed`'s own empty state reads "The record
is empty so far. When your agents do something, **every run and every decision**
shows up here." Runs and decisions — exactly the two sources, named. The record
was honest about its own scope; T3 borrowed it for a question it does not answer.

The consequence for T3 is not a wording problem. A person who chats with their
agent every day and never uses a routine keeps `historyIsEmpty === true`
forever, and is told *"Say hello to Quill — Quill is new here and hasn't been
asked to do anything yet"* indefinitely. That is the H7 lie this entire branch
exists to prevent, arrived at from the other direction: the gate is sound about
what it reads, and what it reads is not the question T3 asks.

### Fact 2 — first run now auto-greets and leaves Today

`App.tsx` — `FirstRunAutoCreate`'s `onDone` sets `kickoffAgentId` when the
workspace is the surface being rendered, and `WorkspaceShell`'s kickoff effect
POSTs `KICKOFF_TEXT` — `'hi'`, from `lib/bootstrap-kickoff.ts` —
through `startTurn`, which navigates to the agent's chat tab. That is #553.

So the day-one user's first screen is no longer Today with nothing on it. It is
their agent, mid-introduction. A *correctly* gated Today panel would therefore
be close to unreachable, which is the mirror image of Fact 1's problem: as gated
today it shows when it should not, and gated properly it would never show at
all.

### Fact 3 — the workspace first-run path DOES show `NewAgentDialog`

The claim at the top of this doc — "No form, no dialog… **a workspace user has
never seen** `NewAgentDialog`'s 'An agent is your personal assistant in ax.'" —
is **false.** `App.tsx` renders that dialog *above* the shell branch and
non-dismissible on first run, for the workspace as much as for the chat shell,
and its description already reads:

> An agent is your personal assistant in ax. Give it a name to get started —
> it'll introduce itself in a moment.

Which answers most of hole #1 (*"nothing tells a first-timer that they have an
agent, what it is called"*) before Today ever renders — including, in its last
clause, the very thing T3's copy was written to pre-explain.

### The decision this needs

Not a technical unknown — all three facts are read from the code. What is left
is a product call about what the day-one surface *is*, now that first run
explains the noun and auto-greets the agent:

- **(i) Drop T3 and T6**, ship T1/T4/T5. ← **CHOSEN, 2026-09-17.** The card's
  acceptance is arguably better met by **T4** anyway: it is an empty state for
  the one-agent / no-history case *on the surface the user actually lands on*,
  and it needs no claim about history at all. **T2 went too**, against this
  bullet's original advice: with T3 gone the predicate has no consumer, and the
  Half-Wired Code Policy forbids merging that. The one-render scope bug it
  found is real and is now an open follow-up rather than a fixed one — see the
  OUTCOME section at the top.
- **(ii) Keep T3 and give it a signal that can answer its question** — e.g. a
  "has ever been chatted with" field on `GET /api/workspace/state`. Internal to
  `@ax/channel-web`, but a wire change this card did not scope, and it does not
  fix Fact 2: the panel would still be near-unreachable.
- **(iii) Something else** — e.g. move the day-one teaching into the
  post-kickoff chat, where the reader actually is.

**Decided 2026-09-17: (i).** The branch had been left with T3/T6 intact so
whichever way it went was a small edit rather than a rebuild, which is what it
turned out to be.

---

## Tasks

### T1 — install the `Empty` primitive (load-bearing)

`pnpm dlx shadcn@latest add empty -c packages/channel-web`.

Invariant 6 says compose installed primitives, and the shadcn rules say empty
states use `Empty`; the package has **four** bespoke empty-state shapes and no
shared one. `Empty` is pure Tailwind + `cva` + `cn` (no new dependency), and uses
only semantic tokens. Used by T3 and T4 in this same PR — nothing half-wired.
Existing bespoke empty states are **not** migrated (out of scope; the ones that
are a single muted sentence read correctly as they are).

### T2 — a provable "nothing has ever happened" signal — **DROPPED, NOT SHIPPED**

> Kept for the record, and for the `scope` finding inside it, which is a real
> and still-unfixed property of `useActivityFeed`. The predicate itself was
> removed: T3 was its only consumer.

`WorkspaceShell` already holds the workspace-wide feed on the Today route
(`useActivityFeed(undefined)`). Add, **in `lib/workspace-activity.ts` beside the
hook it reads**:

```ts
export function historyIsEmptyFrom(feed: ActivityFeedState): boolean
```

True only when the state is workspace-wide, was read, the read worked, the
window is exhausted, and it holds nothing. Five conditions, each one a way of
being wrong — and one of them was not in the first draft:

| condition | the wrong claim it prevents |
|---|---|
| `scope === undefined` | an *agent's* empty feed read as a brand-new workspace |
| `error === null` | a failed read read as an empty record |
| `!loading` | the unlanded first page read as an empty record |
| `events.length === 0` | — |
| `nextBefore === null` | the newest window read as the whole record |

**`scope` is a real hole, found while building, not a precaution.**
`useActivityFeed` is *one* hook instance serving two collections — `undefined`
on Today, an agent id on an agent tab (design §7: one feed and a filter) — and
the scope change is applied in an effect. On the render between `setRoute`
landing on Today and that effect running, every field still describes the agent
just left. So an agent with nothing to its name, on an account with plenty,
satisfied all four of the original conditions: one frame of "Say hello to Quill"
for someone who has been here for weeks.

The hook therefore reports `scope` — *which collection the rest of this state
describes* — cleared in the same effect as the rows, so it lags the prop exactly
as the data does. `loading` cannot stand in for it: on that one render it is
still the old scope's `false`.

Neither the `scope` nor the `loading` condition can be reached from a **rendered**
assertion — `act` flushes the effect that closes the window before a test can
look — so the predicate is unit-tested directly against a hand-built
`ActivityFeedState`, and it lives next to the hook so that is possible. Each of
the five conditions was verified by dropping it and watching exactly one named
test go red.

Threaded to `TodayView` as `historyIsEmpty?: boolean`, default `false` — "we
cannot prove it" and "there is history" both mean *do not make the claim*, so one
falsy value is honest for both.

### T3 — the day-one panel on Today — **DROPPED, NOT SHIPPED**

> See "STOP" above. The gate cannot be built from any Today-route signal.

Gate (all of them, `filter === 'needs'`):

- `readable` — the queue read worked
- `open.length === 0 && justResolved.length === 0 && grants.length === 0`
- `grantsError === null`
- `!loading`
- `historyIsEmpty`
- `agents.length > 0`

Anything less falls through to today's single line, unchanged.

**Only the conditions the enclosing branch does not already impose belong in
`dayOne`.** Measured: with `readable` and the empty-list checks in the
expression, reducing the whole thing to `historyIsEmpty` made only 2 of 11 tests
fail — the enclosing `{readable && open.length === 0 && justResolved.length ===
0 && grants.length === 0 && …}` already withholds the slot, so those conditions
could never fail a test. `dayOne` is therefore
`!grantsUnknown && !loading && historyIsEmpty && agents.length > 0`, each pinned
by exactly one red test, and the two tests that cannot discriminate are
annotated as such rather than left to imply coverage.

Composition — `Empty` / `EmptyHeader` / `EmptyMedia variant="icon"` /
`EmptyTitle` / `EmptyDescription` / `EmptyContent`, inside the existing list
card. Icon: lucide `MessageSquare`, the same icon `HomeComposer` puts on the box
this panel points at.

Copy (one agent):

> **Say hello to {name}**
> {name} is new here and hasn’t been asked to do anything yet. The first chat is
> where it works out who it is and how you want it to work — a plain “hi” is a
> fine place to start.
>
> [Say hi to {name}]
>
> When an agent hits something it wants your OK on, it’ll wait for you here.

Two or more agents (reachable, e.g. a seeded second agent): the same panel with
`Say hello to your agents` / "Your agents are new here…" and `Start a chat`.

Why this copy is true, not plausible: `BOOTSTRAP_TEMPLATE`
(`packages/agent-identity-templates/src/templates.ts`) *is* the agent's entire
system prompt while `.ax/BOOTSTRAP.md` exists, and it opens "You just woke up.
You don't know who you are yet" and asks the agent to settle its name, what it
is, its vibe and its values *through conversation*. So the first reply really is
an agent working out who it is — and a first-timer who has not been told that
reads it as a malfunction. The panel is also what stops the line from being a
surprise.

The endorsed sentence is kept **verbatim** as the closing line, so it is still
there for the person who reads to the bottom, and its existing test still holds.

### T4 — the zero-turn thread

`AgentConversation`: when `thread.length === 0 && !readOnly`, render an `Empty`
above the composer.

> **Nothing here yet**
> This is where you and {name} talk. Send something below — {name} picks it up
> from there.

`!readOnly` is the H7 gate, not a style choice: a past conversation whose
excerpt read failed renders an empty `thread` (`AgentView`'s `pastThread`), and claiming
"nothing here yet" over that would be the lie the whole surface is built to
avoid. A past conversation with an empty thread keeps rendering nothing.

### T5 — one agent is not a choice

`HomeComposer`:

- `const sole = agents.length === 1 ? agents[0]! : null;` and
  `const picked = sole ?? agents.find((a) => a.id === pick) ?? null;` — derived,
  so it cannot go stale if the roster arrives after mount.
- Render the picker `DropdownMenu` only when `agents.length > 1`. With one agent
  show a static `AgentTile` + name instead: it still says who you are talking
  to, without pretending there is a decision.
- Consequence, not a separate change: `submit()` takes the `picked` branch, so
  there is no `/route` call and no proposal strip for a single-agent account.
  The placeholder already names a picked agent.

Self-evident from the server's own contract rather than a product call:
`RouteResult.confident`'s doc says confidence is claimed "when there is literally
no other agent to choose", and the one-agent branch's reason is *"it's your only
agent"*. Nothing is removed for multi-agent accounts.

### T6 — focus the composer (so the button is not decorative) — **DROPPED, NOT SHIPPED**

> It existed to make T3's button work. With no button, `HomeComposer` takes no
> `inputRef` and `WorkspaceShell` holds no ref.

`HomeComposer` takes `inputRef?: React.Ref<HTMLInputElement>` (shadcn `Input`
forwards refs). `WorkspaceShell` holds the ref and passes
`onStart={() => ref.current?.focus()}` to `TodayView`. A button that does
nothing is the failure `hideClose` exists to prevent — so this ships with the
panel, and a test asserts the click really moves focus.

### YAGNI pass

Answered as of the original design, then re-answered on 2026-09-17:

| task | load-bearing at MVP? | outcome |
|---|---|---|
| T1 `Empty` | yes — the zero-turn empty state composes it | SHIPPED |
| T2 predicate | "yes — without it the panel is a lie or a flash" | DROPPED with its only consumer |
| T3 panel | "yes — the card" | DROPPED — the gate is unbuildable |
| T4 zero-turn | yes — day-one users land there; it is the only surface with *no* copy | SHIPPED — this is the card now |
| T5 one-agent composer | yes — it is the first action a day-one user takes | SHIPPED |
| T6 focus | "yes — otherwise T3's button is dead" | DROPPED with the button |

The pass got T1/T4/T5 right and T2/T3/T6 wrong, and the reason is worth
keeping: it asked whether each task was load-bearing *for the plan*, and three
of them were load-bearing only for each other.

Cut: a shared `EmptyState` migration of the other 20-odd bespoke states; hiding
the `Everything they did` footer link (refuted above); a server-side "is this
user new" field (invariant 1 and H7 both prefer the client-derivable answer, and
`WorkspaceAgent` staying a roster row is a documented decision).

### Boundary review

No hook signature added or changed. No IPC action, no payload field, no route.
Every change is inside `@ax/channel-web`'s own components plus one new shadcn
primitive file. Per CLAUDE.md, a patch that only changes a plugin's internal
implementation needs no boundary review. `security-checklist` does not fire
either: no sandbox boundary, no IPC transport, no plugin loading, no new
dependency, and the only untrusted string rendered is an agent's display name,
which every sibling row already renders through React's escaping.

### Tests (each must fail against the unfixed code)

As shipped — the `TodayView` and `WorkspaceShell` suites this section planned
went with T3 and T6:

- `AgentConversationEmpty.test.tsx` — empty live thread → the copy; empty
  **read-only** thread → nothing; a thread with turns → nothing.
- `HomeComposer.test.tsx` — one agent: no picker, placeholder names them, a send
  dispatches without calling `workspaceApi.route`; two agents: unchanged. The
  Auto suite moved to a two-agent fixture, because it had been testing routing
  on the one roster where routing has no question to answer.
- `WorkspaceShellRouting.test.tsx` — not new coverage: three queries that
  reached for the roster row by bare text now match it by role and exact name,
  because T5's label puts the agent's name on Today a second time.

Dropped with their tiers: `TodayView.test.tsx`'s panel suite,
`WorkspaceShell.test.tsx`'s "a brand-new account" suite, and
`lib/__tests__/workspace-activity.test.ts`.
