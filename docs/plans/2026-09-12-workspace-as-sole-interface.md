# The agent workspace as the only interface

**Goal.** Retire the chat UI. The agent workspace becomes the single surface,
and the experience it gives a non-technical person is good enough to stand
alone.

**Status at time of writing.** `channelWeb.agentWorkspace` is `false` by
default. Step 1 below is done (PR: workspace Settings route). Everything else
is unstarted.

**Status 2026-09-16.** Tier 1 is closed: #1 (Settings route), #2 (capability
grants — TASK-350 raise + TASK-373 read-back) and #3 (create-an-agent
entry — TASK-249) are all done. ~~Note #3's postmortem below before sizing
anything in Tier 3 off this document's estimates.~~

**Status 2026-09-18 (TASK-379).** Tier 3 is closed too, and that struck
sentence is why this line exists. TASK-352 (#567), TASK-353 (#558), TASK-354
(#556) and TASK-355 (#559) all merged on 2026-09-16/17 — three of them within
nine hours of the postmortem that was supposed to inform them. So "before
sizing anything in Tier 3" was advice that arrived alongside the work rather
than before it, and TASK-379, which was filed to *re-estimate* Tier 3, found
no Tier 3 left to estimate. What it did instead is a retrospective:
**"Re-measuring the Tier 3 prediction"** at the end of Tier 3 scores #3's
postmortem against the four diffs that actually shipped. Read that before
trusting any sizing sentence in this document, including this one. Open tiers
are 4 (the walk — TASK-356/357/358) and 5 (the cutover — TASK-359).

**How this document was produced.** By reading the code, and — for the first
time — by turning the flag on against the `ax-next-dev` kind cluster and
driving the workspace in a browser. Where a claim below is from the source
rather than from a running app, it says so. That distinction matters here: the
`ux-first-run` audit called the workspace surfaces exemplary from a code read,
and a code read is exactly what let a 2.04:1 footnote and an inert `truncate`
ship on the chat side.

---

## The shape of the problem

The workspace is not a re-skin of chat. It is a different product model, and
most of the difference is deliberate and already decided:

| | chat | workspace |
|---|---|---|
| unit | a conversation you start | an agent that is doing things |
| history | a list of conversations | one continuous thread per agent, compacted; past ones in the rail |
| home | an empty composer | Today — what needs you, what's running |
| routine fires | interleaved in the list | never shown in the thread (`612 unattended runs would bury the two conversations the human actually had`) |

So "port chat's features" is the wrong frame. The question for each thing chat
does is *does the workspace model need this at all*, and only then *how*.

Three things, though, are not model differences. They are holes.

---

## Tier 1 — holes that block the flag

### 1. Settings was unreachable, and the affordance was dead — DONE

`WorkspaceSidebar` rendered `<UserMenu />` bare. The Settings entry renders
unconditionally and calls `onOpenAdminSettings?.()`, which resolved to
`undefined`. `AdminShell` mounts in exactly one place (`App.tsx`) and only in
the chat branch.

So ~11k lines of Settings — AI model keys, Sign-in methods, Connectors, Skills,
Teams, Routines, Branding — had no door, and the door on screen did nothing.
That is the failure `hideClose` exists to prevent (TASK-340 / audit B4): a
control that cannot work reads as a broken product.

Fixed by threading `onOpenAdminSettings` from `App.tsx` through
`WorkspaceShell` → `WorkspaceSidebar` → `UserMenu`, and mounting the *same*
`AdminShell` from the workspace branch (one Settings surface, not one per
shell — invariant 4). The back button's hardcoded `chat` label became a
caller-supplied `backLabel`, because a sign pointing at the retiring surface is
the wrong way out of the replacing one.

### 2. The workspace cannot raise a capability grant

**This is the blocker.** `lib/transport.ts:950` routes `permissionRequest` SSE
frames into `permissionCardStore` → `PermissionCard`. Both are chat-only. The
workspace reads the same stream with its own reader, and
`lib/workspace-api.ts:627` says outright that it ignores `permissionRequest`
"because this surface renders none of them yet".

Concretely: an agent that hits the egress wall — the "Allow access to
example.org?" card — or needs a skill credential mid-turn has no way to ask.
The wall still holds server-side, so this fails *closed*, not open. But the
turn dead-ends with no path forward, and on the workspace that is the only
outcome available.

Needs: a workspace surface for `permissionRequest`. **Decided (2026-09-12) —
presence routes it.** If the human is in a thread with that agent, the grant
renders in the thread, where chat put it. Otherwise it lands in the Today
queue next to decisions. The queue is the default and the thread is the
exception, because most grants will be raised by an agent working unattended
with nobody watching.

One grant, one identity, two render sites — never two live copies
(invariant 4). Answering it in either place resolves it in both, and a human
who walks away mid-grant finds it waiting in the queue rather than orphaned in
a thread nobody is reading.

"In a thread with that agent" is **decided (2026-09-12)**: that agent's
thread is the open route *and* the tab is visible. Everything else — another
agent's thread, Today, Activity, a backgrounded tab, a closed laptop — is the
queue. Cheap to implement, and it matches what a person would say if you asked
them whether they were talking to it. Visibility, not focus: a visible but
unfocused tab still has a human in front of it.

The grant/`Decision` distinction stays. It is deliberate and documented in
`PermissionCard.tsx`: a grant is durable and agent-scoped with no recorded
call; a `Decision` is a one-shot outward action carrying a verbatim call and a
freshness guard. Sharing a queue is not collapsing them — two types, two
cards, one list.

### 3. Create-an-agent is not reachable from the workspace — DONE

Was documented in `WorkspaceSidebar`'s own header: the "New agent" row was
removed because "the shipped create-an-agent flow is driven from `App.tsx`
state this surface cannot reach. A nav row that does nothing when clicked is
worse than one row fewer."

**This section said "same shape as #1, same fix — the callback thread now
exists, so this is small", and that estimate was wrong in a way worth
recording**, because the same reasoning is load-bearing for Tier 3.

The callback thread really was the same one-callback move, and it really was
small. But *routing to the create flow* is not the same as routing to the
**conversational** create flow, and the conversational half — the kickoff `'hi'`
that makes a bare bootstrap agent wake up and introduce itself — was being
dropped on this surface by two independent mechanisms neither this document nor
the card mentioned:

- `bootstrapKickoff` is reachable **only** from the chat runtime. Its one
  registrant is `useChatThreadRuntime`, and assistant-ui invokes a
  `useRemoteThreadListRuntime({ runtimeHook })` hook only from inside
  `_RuntimeBinder`, reached via the runtime core's `RenderComponent` — i.e.
  only under an `AssistantRuntimeProvider`, which the workspace branch
  deliberately mounts none of. `trigger()` there just stranded `_pending`.
  Fixed by branching in `App.tsx`: the workspace is handed the new agent's id
  and greets it through its own `startTurn` / `workspaceApi.sendMessage`.
- `FirstRunAutoCreate` discarded its own `onDone` on the **first-run** arm: the
  `hydrateAgentsOnce` it awaits closes the bootstrap gate and unmounts it, and
  its `cancelled` cleanup then won the race against its own completion
  callback. Measured 0 calls on first run vs 1 on the explicit "+ New agent"
  path. Fixed by not gating a parent callback on an unmount flag.

**The transferable lesson for Tier 2 and Tier 3:** "the callback thread exists"
sizes the *wiring*, not the *flow*. Every remaining Tier 3 item ("chat has it,
the workspace does not") should be sized by asking what the feature's last step
depends on, not by whether a prop can reach the surface — ~~three of the four
(tool steps, attachments, artifacts) have a chat-runtime-shaped dependency of
exactly the kind that bit this one.~~ See
`docs/plans/2026-09-16-workspace-create-agent-entry.md`.

**That struck clause was INFERRED, and it is now measured wrong.** One of the
three named items had a chat-runtime-shaped dependency, not three. The other
two were expensive for reasons this sentence could not have named: Node's ESM
resolver and the sandbox mount protocol. Worse for the sentence, the one item
it left off the list turned out to be the **largest** of the three
non-attachment diffs. Keep the first half of this lesson — "size it by what
the last step depends on" held 4/4, in that no Tier 3 item's last step lived
in the workspace's own component tree — and stop using "chat-runtime-shaped"
as the test for it. See "Re-measuring the Tier 3 prediction" at the end of
Tier 3.

---

## Tier 2 — the decision that sizes everything else

The workspace deliberately does not mount the assistant-ui runtime. It
therefore cannot reuse `lib/transport.ts`, whose parser (`consumeSseAttempt`)
is module-private and inseparable from emitting AI-SDK chunks. So it has a
second, "deliberately dumb" reader that handles text, `done` and `error`, and
ignores `thinking`, `tool-use`, `tool-result`, `phase` and `permissionRequest`.

That is a real architectural choice with a real cost: **a live turn in the
workspace shows text only.** None of the chain-of-thought work, none of the
tool steps, none of the failed/held states measured during the ux-first-run
walk (`text-destructive` 6.17:1, `text-warning` 12.68:1).

**CORRECTED 2026-09-16 (TASK-352, TASK-354).** This paragraph used to claim
there was "already a visible seam" — that re-reading a thread yields a `steps`
variant, so *history shows more than the live stream did*. **That was never
true, and it blocked TASK-352 when a builder tried to build on it.** Measured
twice, independently: `stepsLabel` has ZERO producers repo-wide. Grep the whole
tree and you get two hits — the type declaration (`workspace-types.ts:525`) and
the one renderer that would draw it (`AgentConversation.tsx:348`). The same is
true of the whole `steps` variant and of `fold`. `buildThread`
(`routes-workspace.ts`) emits `user` and `agent` turns of plain text and
nothing else.

So live and reload agree: **both show text only.** The cost named above is
real, but it is a cost the workspace pays uniformly, not an inconsistency
between two paths. Nobody sees more detail by reloading, and any card scoped
around closing that gap is scoped around a gap that does not exist.

**SHIPPED 2026-09-17 (TASK-352).** The cost is now paid off, and paid off
symmetrically. `steps` has a producer on BOTH paths: `lib/workspace-steps.ts`
holds the one shaping function, `server/routes-workspace.ts`'s `buildThread`
feeds it stored `tool_use` / `tool_result` blocks, and `AgentView` feeds it
live `tool-use` / `tool-result` frames. Neither path formats a label of its
own, so no step can read one way live and another way after a reload — it
would take a second formatter to make that happen, and there is not one.
`src/__tests__/workspace-steps-seam.test.tsx` renders one fixture down both
paths and asserts they agree on screen.

**Be precise about what that covers, because the flat claim is wrong.** It
covers the step SENTENCES. It does not cover the GROUPING: the SDK splits a
multi-step reply into one assistant turn per message and
`@ax/agent-claude-sdk-runner-host`'s parser deliberately does not coalesce
across them, while the live wire carries no message boundary at all — so
reload draws one panel per assistant turn where live draws one for the whole
reply. That difference predates TASK-352 (a reply already arrives live as one
accumulating bubble and comes back as several), and closing it means teaching
the live path about turn boundaries, which is its own card. The seam test pins
both halves: sentences equal, panel counts free to differ.

**Thinking did NOT come with it, and must not.** `renderableText` still keeps
`type === 'text'` blocks only. The workspace route calls `conversations:get`
unfiltered — chat gates reasoning behind `?includeThinking=true` and this
surface has no such gate — so that filter is the only thing keeping
chain-of-thought off this wire (invariant J4). Tool steps are additive to it.

(The line number in the original claim had also drifted — it pointed at
`workspace-types.ts:483`, which is now part of `ActivityEvent`. A citation that
no longer resolves is how a claim survives past the code that once supported
it.)

Three ways out, and the one taken:

- **(a) Extract a shared frame parser.** Both readers parse the same wire; each
  renders its own way. Most work; keeps assistant-ui out of the workspace;
  correct long-term; removes the possibility of the two readers drifting.
- **(b) Mount assistant-ui in the workspace.** Cheapest. Reverses a deliberate
  decision and pulls a large runtime into a surface designed without it.
- **(c) Grow renderers off the dumb reader.** Middle. Risks a second divergent
  parser — the exact failure (a) prevents.

**Decided (2026-09-12): (a).** The parser is the shared thing; the rendering
is genuinely different, and should be. Concretely:

- `consumeSseAttempt` comes out of `lib/transport.ts` into a module that owns
  the wire and nothing else — bytes in, typed frames out: `text`, `thinking`,
  `tool-use`, `tool-result`, `phase`, `permissionRequest`, `done`, `error`. No
  AI-SDK chunk emission in there, no rendering.
- `lib/transport.ts` keeps only the adapter from those frames to AI-SDK
  chunks. The workspace reader consumes the same frames and renders its own
  way. The "deliberately dumb" reader's private parsing goes away rather than
  growing.
- **Put it where chat's deletion can't reach it.** Tier 5 #4 deletes
  `lib/transport.ts` and the chat-only tree wholesale. A parser living in
  either is a parser that gets deleted out from under the only surface left.
- One parser is the single source of truth for the wire (invariant 4), and
  that is what closes the history-shows-more-than-live seam: the workspace
  sees the detail live because it sees the frames live.
- Grants (Tier 1 #2) arrive as a parsed `permissionRequest` frame rather than
  a second ad-hoc branch — so the parser lands **before** grants, not after.
- Behaviour-preserving on the chat side. Chat's existing tests are the
  regression net and stay green through the extraction; a frame-level test of
  the new module ships with it.

---

## Tier 3 — fidelity, once the parser question is settled — CLOSED 2026-09-17

Each of these is "chat has it, the workspace does not, and the workspace model
still wants it":

- **Tool steps and thinking in live turns.** ~~Follows directly from Tier
  2.~~ **SHIPPED as tool steps only (TASK-352, #567), and it did not follow
  from Tier 2.** TASK-349's parser handed over the frames; it did not hand
  over a producer. `steps` had a renderer and a type and zero producers, so
  the card had to build one for BOTH paths — `lib/workspace-steps.ts` shapes
  them, `server/routes-workspace.ts`'s `buildThread` feeds it stored blocks
  and `AgentView` feeds it live frames. **Thinking did not ship and must not**
  (invariant J4): the workspace route calls `conversations:get` unfiltered, so
  `renderableText`'s text-only filter is the only thing keeping
  chain-of-thought off this wire. Detail in Tier 2 above.
- **Attachments.** ~~No attach affordance in `HomeComposer` or
  `AgentConversation`; `AttachmentChip`, `AttachmentComposerChip` and
  `ArtifactChip` are chat-only. A user cannot give an agent a file.~~
  **SHIPPED (TASK-353, #558).** The premise was true and it was also the only
  Tier 3 item whose cost actually sat where the Tier 1 #3 postmortem
  predicted: chat's chips are shaped around assistant-ui's `AttachmentAdapter`
  and the workspace mounts no `AssistantRuntimeProvider`, so the chips were
  rebuilt on plain React state. What was shared instead of forked is the
  uploader — `lib/attachment-upload.ts` came out of `AxAttachmentAdapter`, and
  `attachmentRefBlock()` is now the single spelling of the wire block, which
  chat's `lib/transport.ts` builds through too.
- **Search.** ~~`SearchBar` is used only by `Thread.tsx`.~~ **SHIPPED as
  in-conversation find (TASK-354, #556), and it was not a port.** Chat's `SearchBar`
  never filtered anything — `search-store.ts` says so in its own header — so
  porting it would have moved an affordance that lies. The workspace instead
  has a find control over the thread on screen: highlight, count, next/previous,
  Escape to close. Still open, and deliberately NOT started here:
  cross-conversation search, which needs a backend decision (route? index?
  embeddings?) rather than a wider client-side loop.
- **Artifact/download affordances.** Chat has `ArtifactChip`; the workspace has
  `AgentFiles` (a real two-tier file browser), ~~so this may already be covered
  by a better mechanism. Verify before building.~~ **SHIPPED (TASK-355, #559),
  and it was not covered.** `AgentFiles` could show you a file and never hand
  it to you: both read routes answer with TEXT, so a PDF an agent wrote
  rendered as the word "binary" and a long file rendered as its first 128 KiB.
  Two download routes now exist, one per tier. The expensive part was three
  packages away from any UI — the durable tier's read hook bounded a read at
  1 MiB and returned a **silent prefix**, which a preview survives and a
  download does not, so `sandbox-mount-protocol`, `sandbox-k8s` and
  `user-files-read` all had to learn to report `truncated`. This is the one
  Tier 3 item that left `packages/channel-web` at all.

Explicitly NOT a gap — do not port: the conversation list, `NewSessionButton`,
conversation rename, `SessionRow`/`SessionList`. The roster replaces them by
design.

### Re-measuring the Tier 3 prediction (TASK-379, 2026-09-18)

Tier 1 #3's postmortem made one falsifiable forecast about this tier: that
**three of the four** items (tool steps, attachments, artifacts) "have a
chat-runtime-shaped dependency of exactly the kind that bit this one". All
four have now shipped, so it can be scored instead of believed.

**What was measured, and how.** MEASURED-BY-PROBE, from the five merge commits
on `main` (`74c5b984`, `169d9020`, `bf894fbd`, `7ac7bc85`, `4bd9afcb`).
"Production insertions" is `--numstat` over `packages/` with any path matching
`__tests__` or `.test.` excluded; "chat-runtime file" means a file that exists
only to serve the assistant-ui runtime.

| item | card / PR | prod ins. | test ins. | pkgs | chat-runtime file edited | predicted? |
|---|---|---|---|---|---|---|
| create-an-agent *(the baseline)* | TASK-249 / #553 | +224 | +494 | 1 | no | — |
| tool steps | TASK-352 / #567 | +723 | +1297 | 1 | **no** | yes → **wrong** |
| attachments | TASK-353 / #558 | +1011 | +2057 | 1 | **yes** (`transport.ts`, `ax-attachment-adapter.ts`) | yes → **right** |
| find-in-thread | TASK-354 / #556 | +766 | +675 | 1 | **no** | no → **right** |
| artifact download | TASK-355 / #559 | +737 | +1603 | **4** | **no** | yes → **wrong** |

Everything down to and including that table is MEASURED-BY-PROBE. Everything
after it is INFERRED from those numbers — interpretation, not measurement. If
you disagree with a sentence below, the table is the thing to re-derive it
from.

**The forecast scored 2 of 4** — one true positive (attachments), one true
negative (find), two false positives (tool steps, artifacts). Recomputed from
the row above rather than restated: 3 items were predicted positive, 1 of
those 3 was.

**The sharper failure is that it had no discriminating power.** The three
non-attachment items landed at +723, +737 and +766 production insertions —
a spread of under 6% between the largest and the smallest. The item the
forecast singled out as *not* chat-runtime-shaped produced the **largest** of
those three. Whatever separates these items, "does it touch the
chat runtime" did not track even the diff size.

**What the two false positives cost instead**, both named in their own PRs and
neither nameable from the workspace's component tree:

- **TASK-352** — `lib/workspace-steps.ts` was the first `src/lib/` module the
  *server* imports that has relative imports of its own, written extensionless
  the way nearly all of `lib/` is. Vite and Vitest guess; Node does not. Every
  channel-web test, `tsc` and `vite build` all passed, and `@ax/cli`'s
  end-to-end test three packages away reported exit 1 with
  `ERR_MODULE_NOT_FOUND`. Guarded now by
  `src/__tests__/server-import-extensions.test.ts`.
- **TASK-355** — the durable tier's 1 MiB silent-prefix read, above.

**What did hold, 4/4:** not one of these shipped as a change to
`components/workspace/` alone. Every one added or changed `src/lib/` or
`src/server/` code, and one changed three other packages. That is the measured
form of "size it by what the last step depends on, not by whether a prop can
reach the surface" — the heuristic survives; "chat-runtime-shaped" was a bad
proxy for it.

**Three things this section deliberately does NOT claim.**

1. **It is not a cost measurement.** Insertion counts are the size of a diff
   that shipped, not the effort it took, and this repo has already watched a
   "+15 min" estimate get "corrected" to "+4–8 min" and measure at ~+9. Nobody
   timed these four cards, so the honest answer to "how much work was Tier 3"
   is **unmeasured**, and a better-sounding number would not change that.
2. **For three of the four it is barely a forecast at all.** The postmortem
   merged at 10:28 on 2026-09-16; TASK-354, TASK-353 and TASK-355 merged at
   17:56, 18:36 and 18:50 **the same day** — seven and a half to eight and a
   half hours later. Only TASK-352 (2026-09-17) had a full day of forecasting
   distance, and it is one
   of the two the forecast got wrong. Three of these four rows are a
   retrospective wearing a forecast's clothes, and they are scored here as
   one.
3. **Test insertions are not evidence of anything here.** They exceed the
   production diff on every row but TASK-354's — at most 2.2×, on TASK-355
   among the four scored rows (the TASK-249 baseline's 494/224 rounds to the
   same 2.2× and is fractionally higher) —
   and they track this repo's Bug Fix Policy, not the item's difficulty. They
   are in the table so the production column can be checked against the
   published totals, not so the ratio can be read.

**For the tiers still open (4 and 5):** this document contains no size estimate
for either that survived contact with anything. Do not derive one from here.

---

## Tier 4 — the UX quality bar

**The workspace has never been walked.** Not once, by anyone. The ux-first-run
audit covered chat and called the workspace surfaces exemplary from a code
read. The same audit's chat findings were later contradicted by a browser: a
footnote at 2.04:1, an approval card overlapping the transcript by 71px, a
`truncate` that did nothing, two buttons under the AA floor.

Before the workspace can be called a great experience it needs the same
treatment the chat track got:

- Every surface driven in a browser against the cluster, light **and** dark.
- **Contrast measured, not eyeballed** — 4.5:1 for normal text. This is how
  every contrast defect so far was found, and none of them were visible in a
  screenshot.
- Every failure branch exercised: API down, stream lost, decision expired,
  agent errored mid-turn, no agents, empty Today, empty Activity.
- Keyboard paths: focus order, focus restore, Escape, tab traps.
- First-run: a brand-new user lands on Today with one agent and nothing done
  yet. What does that page say to them?

Surfaces with no walk coverage at all: Today, Activity, the agent view, the
rail, `AgentFiles`, `AgentMemory`, `ApprovalCard`, `DecisionRow`,
`HomeComposer`.

**Four more, added 2026-09-18 (TASK-379), because Tier 3 shipped before this
tier rather than after it** — the list above predates them and TASK-356/357/358
would otherwise walk a workspace that has grown since their cards were
written: the live/reload **step panels** (`lib/workspace-steps.ts` rendering in
`AgentConversation` and `AgentView`, including the failed and held rows and the
`sandbox-starting` status line), the **attach chips**
(`WorkspaceAttachmentChip`, plus the held-send states and the Resend path),
the **find control** (`ThreadFind`), and `AgentFiles`' **download** affordance
— which has a fifth failure state that borrows none of the other four, and a
refusal path for a file the durable tier cannot serve whole.

One observation already, from turning it on: Today's empty state reads well —
"Nothing is waiting on you." over "When an agent hits something it wants your
OK on, it'll wait for you here." That is the right voice. It is one screen of
many.

---

## Tier 5 — the cutover

Only after 1–4.

1. **Flip the default.** `channelWeb.agentWorkspace: true` in
   `deploy/charts/ax-next/values.yaml`. Note the chart key is
   `channelWeb.agentWorkspace`, not `features.agentWorkspace` — the env var is
   `AX_AGENT_WORKSPACE_PREVIEW`, and the client-side feature is
   `agentWorkspacePreview`. Three names for one switch; worth collapsing as
   part of this.
2. **The flag survives.** Decided (2026-09-12). "Off" keeps meaning
   `/api/workspace/*` is never registered — still the cheapest capability
   minimization we know how to buy. What changes is what it *implies*: it
   stops meaning "you get chat instead" and starts meaning "this deployment
   has no web interface", which is a real shape to be able to ship once an
   agent is reachable from somewhere other than a chat window. Restate the
   chart comment to say exactly that, so the next reader doesn't read `off` as
   a broken install. The three-names-for-one-switch collapse
   (`channelWeb.agentWorkspace`, `AX_AGENT_WORKSPACE_PREVIEW`,
   `agentWorkspacePreview`) still stands, and `Preview` should fall out of
   both names once the workspace *is* the product.
3. **`/chat` goes in one release.** Decided (2026-09-12) — no deprecation
   window, no dated notice. `pathRendersWorkspace()` is `/`, `/workspace`,
   `/workspace/*`; chat keeps `/chat` until the cutover, and then `/chat`
   redirects to `/` in the same release that deletes it. A redirect is not a
   deprecation window — it is just the difference between a bookmark that
   lands somewhere and a bookmark that 404s.
4. **Delete chat.** ~5,150 lines of chat-only components, plus the assistant-ui
   runtime, `lib/transport.ts`, and a large share of the 76 top-level test
   files. Do this *last*, as its own PR, when nothing references it — not
   opportunistically along the way.

---

## Suggested order

1. ~~Workspace Settings route~~ — done.
2. ~~Create-an-agent from the workspace. Small, same mechanism, removes a
   second dead end.~~ — done (TASK-249, #553). It was not small; see the
   postmortem above.
3. ~~**Extract the shared frame parser** (Tier 2, option (a)).
   Behaviour-preserving on the chat side; unblocks 4 and 6.~~ — done
   (TASK-349, #548).
4. ~~Capability grants in the workspace. Functional hole,
   security-relevant.~~ — done (TASK-350 raise, TASK-351 presence routing,
   TASK-373 read-back).
5. Walk the workspace (Tier 4). Fix what it finds, each with a regression
   test. **Still open** — TASK-356/357/358.
6. ~~Fidelity (Tier 3).~~ — done (TASK-352/353/354/355), **and it ran before
   step 5, not after**. Worth knowing rather than quietly re-ordering: the
   walk cards now face four surfaces that did not exist when this order was
   written (live step panels, attach chips, the find control, the download
   affordance), so their coverage lists are wider than Tier 4 below describes.
7. Cutover (Tier 5), deletion last. **Still open** — TASK-359.

Steps 2–4 are prerequisites for flipping the default for anyone. Step 5 is the
prerequisite for calling it good.

---

## Ground rules carried forward

- Every bug fixed in the loop gets a regression test in the same change
  (CLAUDE.md Bug Fix Policy), and the test is confirmed to **fail** against the
  unfixed code — not merely pass against the fixed one.
- Full gate before any PR: `pnpm build`, then
  `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`,
  then `pnpm lint`.
- Measure contrast in `browser_evaluate` against a 4.5:1 floor. Do not eyeball.
- Copy follows CLAUDE.md's Voice & Tone and
  `docs/plans/2026-09-11-ux-first-run-copy-spec.md`.
- One UI design language (invariant 6): shadcn primitives and semantic tokens.
  Fix shared primitives in the primitive, not at 22 call sites.
- Before fixing anything found on a surface, check which shell owns it. A fix
  to a chat-only component is wasted work now.

## Decisions (2026-09-12)

Every open question this document raised is answered. The rationale is kept
because it is short, and because the next reader will otherwise re-litigate
it.

1. **Capability grants: presence routes them.** The Today queue by default;
   the thread when the human is actually there talking to that agent — that
   agent's thread is the open route *and* the tab is visible. One grant, two
   render sites, never two live copies. Shapes Tier 1 #2.
2. **The `agentWorkspace` flag survives** the cutover as a capability
   boundary. `off` no longer means "chat instead" — it means this deployment
   has no web interface, which is worth being able to ship. Shapes Tier 5 #2.
3. **`/chat` goes in one release.** No deprecation window; it redirects to `/`
   in the release that deletes it. Shapes Tier 5 #3.
4. **Tier 2 is (a): one shared frame parser.** It owns the wire; chat and the
   workspace each render their own way. It lands before grants, and it lands
   outside the tree Tier 5 #4 deletes. Shapes Tier 2, Tier 3, and the
   suggested order.

No open questions remain in this document. What it asks for next is work.
