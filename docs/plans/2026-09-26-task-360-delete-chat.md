# TASK-360 — delete chat, retire the `agentWorkspace` flag

Final step of `2026-09-12-workspace-as-sole-interface.md` (Tier 5 #3 + #4), widened
by a human ruling on 2026-09-26: the `agentWorkspace` flag goes too. The workspace
is always on; there is no off state. That supersedes that doc's Decision 2 ("the
flag survives").

## Tasks

1. **SPA shell** — `App.tsx` renders the workspace for every signed-in path. `/chat`
   and `/chat/*` are REPLACED with `/` (`lib/retired-chat-path.ts`), keeping no
   segment, query or hash. No `/api/features` fetch.
2. **Delete the chat tree** — every client module that nothing reaches from
   `main.tsx` or `server/index.ts` once (1) lands (import-graph fixed point, not the
   card's list), plus its tests. Keep `lib/sse-frames.ts` and every module the
   workspace still imports (`AttachmentChip`, `Markdown`, `UserMenu`, ...).
3. **Client tests** — rewrite the tests that exercised the flag or App's chat branch
   for an always-on workspace; delete tests of deleted modules.
4. **Server + preset + CLI + chart** — drop `agentWorkspace` from the channel-web
   plugin config and `registerWorkspaceRoutes` (routes always mount); delete
   `GET /api/features`; delete `/api/chat/title-events` (its only consumer was
   chat); drop the k8s/memory preset parse; `ax serve` warns once for each retired
   name (`AX_AGENT_WORKSPACE`, `AX_AGENT_WORKSPACE_PREVIEW`) and never fails boot on
   them; the chart drops the value, the stamping and the schema entry, and NOTES.txt
   warns when a values file still sets it.
5. **Prose, deps, guards** — remove the `@assistant-ui/*`, `ai`, `@ai-sdk/react` and
   `assistant-stream` dev deps plus the lockfile entries; drop the workspace→chat-tree
   eslint guard (its targets no longer exist); fix comments that name deleted modules;
   update the k8s-acceptance-loop skill probe, MANUAL-ACCEPTANCE, the design doc, and
   `StepDone`'s `/chat` link.

## YAGNI pass

- A server-side `/chat` 302: cut. Chat never had URL state, so there are no deep
  links worth a second mechanism, and a client replace covers the dev server too.
- A "this deployment has no web interface" page: cut by the ruling. There is no off
  state to render.
- Pruning `/api/chat/conversations*`: deferred. The k8s e2e helpers still call it,
  so it is not dead, only unused by the SPA.
