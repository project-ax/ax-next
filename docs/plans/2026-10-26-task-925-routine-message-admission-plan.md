# TASK-925: keep routine histories out of interactive message admission

Card: TASK-925, PR4 prerequisite. Design: `docs/plans/2026-10-20-agent-tasks-design.md` §3.3 and §12. Base inspected: `a684ebc09` on `68e734184`.

## Verified shape and scope

`POST /api/chat/messages` is the content-bearing browser ingress. `workspaceApi.sendMessage` and AgentView's send/resend path use it; no separate retry, edit-message or continue-message HTTP route exists in the registered chat surface. Existing-conversation admission in `server/routes-chat.ts` currently authenticates, resolves the requested agent, reads `conversations:get`, checks agent identity, commits attachments, binds the stream request and invokes the agent. It never checks origin.

The authoritative `Conversation` already requires `origin: 'web' | 'routine'` (`conversations/src/types.ts`). `rowToConversation` maps pre-origin SQL NULL rows to `web`, so a closed projection does not reject legacy browser chats. The channel-web local ConversationSummary omits that field. This is a missing read of existing data, not a new hook, storage field or migration.

Keep the following surfaces unchanged:

- Stop/interrupt authenticates and resolves the stored owner and agent, ignores request body/query and sends a fixed interrupt. It adds no user content. The builder has already pinned routine cancellation with two positive cases; leaf suite18/18 passed on unchanged production.
- PATCH conversation changes only its display title; DELETE manages the owner's history. Neither is a message edit or a user-message continuation. Preserve their ACLs and behavior.
- GET conversation and SSE stream are reads; SSE replays/subscribes and does not invoke a model. Preserve reads and reconnect behavior.
- Capability/decision approval is a separately authorized host path. Workspace decision approval calls `decisions:approve`, then binds the delivered continuation using stored decision identity and `conversations:get-metadata`. Do not apply a blanket origin fence to conversation hooks, agent:invoke or that continuation path.
- Scheduler invocation and Repeat's ongoing conversation use internal hooks. Those must continue. TASK-919 separately fixes immutable capture classification; do not absorb it.

## Task 1 — fence the content-bearing route and prove both sides [tier: sensitive]

1. Add a focused non-Docker direct-handler test file, e.g. `src/__tests__/server/routes-chat-routine-admission.test.ts`. Supply enough real HookBus services to let an ordinary existing web send succeed202: auth, agent resolution, conversation read, bind-session, attachments commit when exercised, and invoke. Capture every downstream write. Do not count a missing mock/import error as red proof.
2. Observe assertion failures before product edits for owner-authenticated routine-origin sends with active and inactive sessions; a content-bearing attachment reference; forged body/query origin/source/user flags; and a routine conversation paired with another caller-reachable agent. Require exactly404 `{ error: 'conversation-not-found' }` and no attachment commit, bind or invoke. Include ordinary-web202 and ordinary-web agent mismatch400 controls. A caller-supplied routine flag on a stored web conversation must not change authority.
3. Add the existing provider field to the local ConversationSummary projection as `origin: unknown`, then accept an existing conversation for interactive messaging only when its stored answer is exactly `web`. Routine, missing and malformed origins fail closed with the same404; do not invent a fallback to web at this layer. The real provider already performs legacy NULL→web normalization. Add direct malformed/missing-origin cases and explicit web origins to affected positive fake conversation fixtures instead of weakening the guard.
4. Place the origin check immediately after `conversations:get` and BEFORE the existing agent-mismatch branch, attachment commits, request/session binding and invoke. A routine-origin write must not vary to400 with an agent mismatch. Keep the current web mismatch400 and the existing forbidden/not-found projection. Other read errors continue to propagate; do not catch all failures as404. Fresh browser conversation creation still explicitly requests `origin: 'web'` as today, without accepting caller origin fields.
5. Extend `server/routes-chat.test.ts` through its actual HTTP server and real conversations provider. Create an owner routine-origin conversation through `conversations:create` (include one hidden and one non-hidden routine if useful), POST the real URL, assert404 and zero invoke/bind/attachment side effects. Read it back to prove origin/session metadata unchanged. Existing default-origin web creation/follow-up tests prove legacy NULL→web compatibility; retain them and explicit web mismatch controls.
6. Pin a legitimate approval from a routine-origin conversation in the same booted HTTP/kernel shape. A practical small extension is an optional decisions fixture in `routes-chat.test.ts`: load the real decisions plugin (dependency already used by channel-web tests) with default attendance resolution, a deterministic hold policy and inert tool effect; create an actual routine conversation, produce a held effect using its routine context, and approve via the real workspace decision URL. Assert host replay/effect occurs once and the conversation remains routine, while interactive POST into it is still refused. The existing `routes-workspace-approval-actor.test.ts` demonstrates the actual decisions/tool execution wiring. Do not register a fake decisions:approve that merely echoes success, or turn the routine into web to make this pass. Keep fixture teardown/timers/owned tables isolated. No new runtime hook or production dependency is needed.
7. Preserve and run the builder's `routes-chat-interrupt.test.ts` positives. Add a cheap routine read/title/delete preservation assertion only if the audit/fixture change risks those paths; do not create production guards on them.
8. Run focused tests green, then build/lint and the entire changed package. All Docker-backed tests wait for root's explicit lease and use `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`, package suites serially, at most2 workers. Do not restart the daemon or leave fixture databases/containers behind.

No UI component change is needed: task transcript UI is already read-only; the missing server admission is the bug. Do not add an unused policy plugin, bypass flag, metadata index, new endpoint or low-level conversation restriction.

## Task 2 — record the boundary and close the gates [tier: mechanical]

Update the route flow header to state the new stored-origin admission before agent matching/binding. In the Agent Tasks design's read-only transcript paragraph, add the as-built server guarantee and clarify that approval continuation and authorized cancellation remain available; do not rewrite historical walk evidence. The original card's line1437 is route registration, not the handler's admission block; use symbols/current anchors in new prose. Existing UI-read-only prose is true, not a reason to redesign the viewer.

Append material decisions/verification to this task's shard and appropriate new task shards if needed; never edit frozen archives. Record the Vitest invocation trap: use `pnpm --filter @ax/channel-web test <file> --maxWorkers=2`, with no extra `--` before the file. The earlier mistaken broad run was aborted, not a valid gate or red proof.

After latest origin/main integration (TASK-969 may merge during this work), required gates are `pnpm build`, `pnpm lint`, full `@ax/channel-web` tests, `pnpm test:eslint-rules`, `pnpm test:scripts`, memory guard and `git diff --check`. If another package's production changes become necessary, run its whole suite too; this plan needs none. Preserve explicit raw legacy fixtures and sibling changes when integrating main. Commit a clean whole branch before an independent exact-head review; parent is parked and reviewer records start/end SHA/status. All PR checks and the actual ci.yml run must pass for that exact head. Root owns merge/routing/cleanup.

## Security and boundary note

Run the complete security-checklist and include its structured PR note. Sandbox/capability change is a narrowing: caller-controlled text/attachments cannot enter routine contexts through interactive send, with no new process, path, network or env access. Injection: stored origin is the authority; forged caller metadata is ignored, refusal precedes all side effects, and no new string interpolation is introduced. Supply chain: no manifest dependency/lockfile changes. No hook signature or subscriber payload changes, so formal new-hook boundary review is not required; explain that the local projection reads a field the provider already exposes. Keep all checks transport/storage-neutral and do not import conversation implementation into channel-web production code.

## Commands

Non-Docker focused examples (omit any file not added):

```sh
pnpm --filter @ax/channel-web test src/__tests__/server/routes-chat-routine-admission.test.ts src/__tests__/server/routes-chat-interrupt.test.ts --maxWorkers=2
```

After root grants Docker:

```sh
DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/channel-web test src/__tests__/server/routes-chat.test.ts src/__tests__/server/routes-workspace-approval-actor.test.ts --maxWorkers=2
DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/channel-web test --maxWorkers=2
pnpm build
pnpm lint
pnpm test:eslint-rules
pnpm test:scripts
```
