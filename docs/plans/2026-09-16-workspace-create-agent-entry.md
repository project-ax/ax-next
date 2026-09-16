# TASK-249 — a create-agent door in the workspace, and a kickoff that survives it

Tier 1 #3 of `docs/plans/2026-09-12-workspace-as-sole-interface.md`.

## What the card assumed, and what the code says

The card (and the epic doc, §Tier 1 #3) says:

> Same shape as #1, same fix — the callback thread now exists, so this is small.

**Half of that is right.** Threading `onCreateAgent` from `App.tsx` →
`WorkspaceShell` → `WorkspaceSidebar` is genuinely the same one-callback move
Settings got, and it is genuinely small.

**The other half is wrong, and it is the part that matters.** Routing to the
create flow is not the same as routing to the *conversational* create flow. The
flow's last step — the one that makes it conversational — is dead on the
workspace path, and it is dead **today**, before this card adds any door:

- `FirstRunAutoCreate` creates a bare agent (`.ax/BOOTSTRAP.md` seeded
  server-side) and calls `onDone()`.
- `App.tsx` answers `onDone` with `bootstrapKickoff.trigger()`, which sends the
  first message (`'hi'`) so the agent wakes up in bootstrap mode and introduces
  itself.
- `bootstrapKickoff`'s only registrant is `useChatThreadRuntime`
  (`lib/runtime.tsx`). That hook is passed to assistant-ui as
  `useRemoteThreadListRuntime({ runtimeHook })`, and **assistant-ui only ever
  calls `runtimeHook` from inside `_RuntimeBinder`**, which is rendered through
  the runtime core's `RenderComponent` — i.e. only under an
  `AssistantRuntimeProvider`.
- The workspace branch of `App.tsx` deliberately mounts no
  `AssistantRuntimeProvider` (its own comment says so).

So on the workspace path `register()` is never called, `trigger()` sets
`_pending = true`, and the kickoff is **silently dropped**. The user gets a
created agent that never says anything, sitting in a roster on Today.

Verified by reading
`node_modules/@assistant-ui/core/dist/react/runtimes/{useRemoteThreadListRuntime,RemoteThreadListHookInstanceManager}.js`:
`runtimeHook` is invoked in `_RuntimeBinder`, reached only via
`__internal_RenderThreadRuntimes` → `RenderComponent`.

Shipping only the door would therefore produce exactly the failure TASK-230's
author was avoiding when they removed the row: an affordance that goes
somewhere and then quietly does nothing. Both halves ship here.

The workspace does not need assistant-ui to send the kickoff — it already has
its own send (`workspaceApi.sendMessage` → the same shipped
`POST /api/chat/messages`) and its own reader (`pendingReply` → `AgentView`
streams it). The kickoff rides that.

## A second hole, found while wiring the first — and measured

Wiring the door turned up a bug one layer down, in code neither the card nor the
epic doc mentions. **`FirstRunAutoCreate` swallows its own completion callback
on first run.**

```
const agent = await autoCreateBareAgent(agentName);
agentStoreActions.setSelectedAgent(agent.agentId);
await hydrateAgentsOnce();
if (cancelled) return;     // ← this
onDone(agent.agentId);
```

`hydrateAgentsOnce` writes `agent-store`, which App reads through
`useSyncExternalStore`. The list is now non-empty, so
`shouldShowAgentBootstrap`'s `noAgents` arm flips false — and on **first run**
that arm is the only thing holding the gate open, because `createAgentOpen` is
false. App unmounts the component, the effect cleanup sets `cancelled = true`,
and the guard above discards the completion of work that fully succeeded.

Measured with a throwaway probe (deleted; its assertion now lives in
`FirstRunAutoCreate.test.tsx`):

| path | agent created? | `onDone` calls |
|---|---|---|
| explicit "+ New agent" (`createAgentOpen === true`) | yes | **1** |
| first run (`createAgentOpen === false`) | yes | **0** |

The explicit path is immune because `createAgentOpen` keeps the gate open until
`onDone` itself closes it. That is why this survived: every walk of the create
flow that went in through the agent menu worked.

Fixed by not gating `onDone` on `cancelled`. That flag is there to stop
setState-after-unmount, and `onDone` is not this component's state — it is a
callback on `AppContent`, which is still mounted, being the thing that unmounted
us. The two `cancelled` guards that do protect local state stay.

**The honest limit of the measurement.** RTL sets `IS_REACT_ACT_ENVIRONMENT`,
which changes which lane React takes for that store write, so this does **not**
establish that a production browser lost the kickoff too. What it establishes is
that success-versus-silence was resting on an unrelated store write's scheduling
lane. That is not a property to rest on, whichever way it happens to fall today.

In scope because first run on `/workspace` is a route *into* the flow this card
is about: a created-but-never-greeted agent is this card's own acceptance
failing, just on the other arm.

## The stale line that generated this card

`WorkspaceSidebar`'s header paragraph ("Also not here: a 'New agent' entry …
the shipped create-an-agent flow is driven from `App.tsx` state this surface
cannot reach") is the line the card was filed off. It is corrected in this
branch, not left for the next session to re-file from (contract rule 5).

`bootstrap-kickoff.ts`'s header is *accurate* but reads as surface-neutral;
it gains an explicit note that it serves the chat runtime only, and why.

## Tasks

### Task 1 — the kickoff carries the agent it is for, and the workspace can send it

Files: `lib/bootstrap-kickoff.ts`, `components/onboard/FirstRunAutoCreate.tsx`,
`components/__tests__/FirstRunAutoCreate.test.tsx`.

- Export `KICKOFF_TEXT` (one source of truth for the first message — invariant
  4; the workspace must not spell `'hi'` a second time).
- Header note: this bridge is the **chat runtime's** kickoff path. Say why the
  workspace cannot use it (no `AssistantRuntimeProvider` → `runtimeHook` never
  runs → `register` never called → `trigger` strands `_pending`).
- `FirstRunAutoCreate`'s `onDone` becomes `onDone(agentId: string)`. It already
  holds `agent.agentId`; the workspace needs it because its send is explicit
  about the agent where the chat transport resolves one from the agent store.

Load-bearing at MVP: yes — without the id the workspace has nothing to send to.

### Task 2 — `WorkspaceShell`: one turn-start, two callers, and the kickoff

Files: `components/workspace/WorkspaceShell.tsx`, new
`components/workspace/__tests__/WorkspaceCreateAgentRoute.test.tsx`.

- Extract `startTurn(agentId, text)` from `HomeComposer`'s inline `onSend`:
  POST via `workspaceApi.sendMessage`, `setPendingReply`, navigate to that
  agent's `chat` tab. `HomeComposer` keeps calling it — one turn-start on this
  surface, not two.
- New props: `onCreateAgent?: () => void`,
  `kickoffAgentId?: string | null`, `onKickoffConsumed?: () => void`.
- Consume `kickoffAgentId` exactly once, ref-guarded on the id, mirroring the
  `pendingReply` / `onPendingReplyConsumed` pattern `AgentView` already uses.
- **Failure is surfaced, never swallowed.** If the kickoff send rejects, raise a
  toast (`toastActions.error`) *and* still navigate to the agent — it exists, it
  just has not been greeted, and the composer's own placeholder invites the hi.

### Task 3 — `WorkspaceSidebar`: the door

Files: `components/workspace/WorkspaceSidebar.tsx`.

- `onCreateAgent?: () => void`. The row renders **only when supplied** — the
  `AgentMenu` / `AgentChip` pattern, and the direct lesson of the Settings row
  that rendered unconditionally onto `undefined`.
- Copy `New agent…`, matching `AgentMenu`'s shipped string (the ellipsis is the
  app's existing "opens a dialog" signal). `Plus` from lucide, the existing
  `row()` helper, semantic tokens only (invariant 6).
- Placed as the last child of `<nav>`, **not** gated on `rosterOpen`: a
  collapsed roster must still have a create door, since reachability is the
  whole card.
- Replace the stale header paragraph.

### Task 4 — `App.tsx`: supply both ends

Files: `App.tsx`, `__tests__/workspace-gate.test.tsx` (its harness already
renders `<App />` with the flag on and a stubbed `WorkspaceShell`).

- Hoist `const rendersWorkspace = pathRendersWorkspace() && features.agentWorkspacePreview;`
  above the bootstrap gate so `onDone` can branch on it.
- `onDone={(agentId) => { … rendersWorkspace ? setKickoffAgentId(agentId) : bootstrapKickoff.trigger(); }}`
  — one kickoff, two surfaces, each through its own send path. The `if` is the
  honest shape; a shared singleton whose chat registrant ignores the agent id
  would be a second mechanism wearing one name.
- Pass `onCreateAgent`, `kickoffAgentId`, `onKickoffConsumed` to
  `WorkspaceShell`. `onCreateAgent` is byte-identical to the chat branch's
  `SessionHeader onCreateAgent`.

### Task 5 — tests

- **Shell** (`WorkspaceCreateAgentRoute.test.tsx`):
  1. clicking `New agent…` reaches the app's handler *through the sidebar*.
  2. vacuity guard — with no `onCreateAgent` the row is absent, so (1) is about
     the wiring and not about a row that renders either way.
  3. `kickoffAgentId` → `workspaceApi.sendMessage` posts `KICKOFF_TEXT` to that
     agent, the URL lands on that agent's chat tab, and `onKickoffConsumed`
     fires once. *Against unfixed code `sendMessage` is never called — red.*
  4. a rejecting `sendMessage` still lands on the agent and raises a toast.
- **App** (`workspace-gate.test.tsx`): with the flag on and zero agents, run the
  first-run dialog and assert the stubbed `WorkspaceShell` receives the new
  agent's `kickoffAgentId` — i.e. the kickoff is handed to the surface that can
  send it rather than stranded in `bootstrapKickoff`. *Against unfixed code the
  prop does not exist — red.*
- **App**: `WorkspaceShell` receives a callable `onCreateAgent`, and invoking it
  opens the `NewAgentDialog`.

## Boundary review

No hook signature changed, no IPC action added, no payload crosses a plugin
boundary. This is entirely inside `@ax/channel-web`'s SPA. No boundary review
required; no `security-checklist` trigger (no sandbox boundary, no IPC, no
plugin loading, no new dependency, no new untrusted-content path — the kickoff
text is an authored constant).
