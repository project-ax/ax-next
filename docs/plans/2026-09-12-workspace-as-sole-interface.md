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

Needs: a workspace surface for `permissionRequest`, and a decision about
whether it renders in the thread (as chat does) or lands in the Today queue
next to decisions. Note the existing distinction is deliberate and documented
in `PermissionCard.tsx`: a grant is durable and agent-scoped with no recorded
call; a `Decision` is a one-shot outward action carrying a verbatim call and a
freshness guard. Collapsing them was considered and rejected. Do not undo that
casually — but *do* revisit whether the workspace's Today queue is the right
home for a grant, because the workspace has a queue and chat did not.

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

Three ways out. Pick one before doing any Tier 3 work:

- **(a) Extract a shared frame parser.** Both readers parse the same wire; each
  renders its own way. Most work; keeps assistant-ui out of the workspace;
  correct long-term; removes the possibility of the two readers drifting.
- **(b) Mount assistant-ui in the workspace.** Cheapest. Reverses a deliberate
  decision and pulls a large runtime into a surface designed without it.
- **(c) Grow renderers off the dumb reader.** Middle. Risks a second divergent
  parser — the exact failure (a) prevents.

Recommendation: **(a)**. The parser is the shared thing; the rendering is
genuinely different, and should be.

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
2. **Decide whether the flag survives.** Today "off" means `/api/workspace/*`
   is never registered — a genuine capability boundary, and the chart comment
   defends it as "the cheapest capability minimization we know how to buy". If
   the workspace is the only interface, "off" means a product with no UI. Either
   retire the flag or restate what off now means.
3. **`/chat` handling.** `pathRendersWorkspace()` is `/`, `/workspace`,
   `/workspace/*`; chat keeps `/chat`. Decide: redirect, or a dated notice
   before removal. People have bookmarks.
4. **Delete chat.** ~5,150 lines of chat-only components, plus the assistant-ui
   runtime, `lib/transport.ts`, and a large share of the 76 top-level test
   files. Do this *last*, as its own PR, when nothing references it — not
   opportunistically along the way.

---

## Suggested order

1. ~~Workspace Settings route~~ — done.
2. Create-an-agent from the workspace. Small, same mechanism, removes a second
   dead end.
3. **Decide Tier 2.** Blocks the rest.
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

## Open questions for a human

1. Does a capability grant belong in the workspace's Today queue, or in the
   thread as it is in chat? This is a product call, and it is the one that
   shapes Tier 1 #2.
2. Does the `agentWorkspace` flag survive the cutover as a capability boundary,
   or retire with chat?
3. Is there a deprecation window for `/chat`, or does it go in one release?
