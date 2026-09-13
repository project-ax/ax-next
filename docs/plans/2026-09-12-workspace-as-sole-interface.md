# The agent workspace as the only interface

**Goal.** Retire the chat UI. The agent workspace becomes the single surface,
and the experience it gives a non-technical person is good enough to stand
alone.

**Status at time of writing.** `channelWeb.agentWorkspace` is `false` by
default. Step 1 below is done (PR: workspace Settings route). Everything else
is unstarted.

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

### 3. Create-an-agent is not reachable from the workspace

Already documented in `WorkspaceSidebar`'s own header: the "New agent" row was
removed because "the shipped create-an-agent flow is driven from `App.tsx`
state this surface cannot reach. A nav row that does nothing when clicked is
worse than one row fewer."

Same shape as #1, same fix — the callback thread now exists, so this is small.
Today a workspace-only user can never create a second agent.

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

There is already a visible seam: re-reading a thread yields a `steps` variant
(`workspace-types.ts:483` — `stepsLabel` plus `string[]`), so **history shows
more than the live stream did**. A user who watches a turn happen and then
reloads sees more detail than they did live. That is the kind of inconsistency
people notice and cannot explain.

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

## Tier 3 — fidelity, once the parser question is settled

Each of these is "chat has it, the workspace does not, and the workspace model
still wants it":

- **Tool steps and thinking in live turns.** Follows directly from Tier 2.
- **Attachments.** No attach affordance in `HomeComposer` or
  `AgentConversation`; `AttachmentChip`, `AttachmentComposerChip` and
  `ArtifactChip` are chat-only. A user cannot give an agent a file.
- **Search.** `SearchBar` is used only by `Thread.tsx`. With conversations
  living inside agents and compaction folding them, *finding* something said
  three weeks ago matters more here than it did in chat, not less.
- **Artifact/download affordances.** Chat has `ArtifactChip`; the workspace has
  `AgentFiles` (a real two-tier file browser), so this may already be covered
  by a better mechanism. Verify before building.

Explicitly NOT a gap — do not port: the conversation list, `NewSessionButton`,
conversation rename, `SessionRow`/`SessionList`. The roster replaces them by
design.

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
2. Create-an-agent from the workspace. Small, same mechanism, removes a second
   dead end.
3. **Extract the shared frame parser** (Tier 2, option (a)).
   Behaviour-preserving on the chat side; unblocks 4 and 6.
4. Capability grants in the workspace. Functional hole, security-relevant.
5. Walk the workspace (Tier 4). Fix what it finds, each with a regression test.
6. Fidelity (Tier 3).
7. Cutover (Tier 5), deletion last.

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
