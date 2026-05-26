# JIT Pending-Turn → Re-spawn → Resume Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the JIT happy path's last seam — when the user approves the bundled card, the just-granted catalog skill is attached for the user, the stale warm runner is retired, and the conversation **re-spawns and resumes** so the agent answers the still-pending original ask. After this card, `you: "check my Linear issues"` → card → **Connect** → the agent answers, as one continuous exchange with a permission interlude (design §6A/§7).

**Architecture:** The runner reads skills/MCP/env **only at session init** (`main.ts:124-137`, "frozen at spawn"), and the SDK turn cannot be paused mid-tool-call — so "re-spawn" is implemented by **retiring the warm session and re-issuing the turn**, which the orchestrator's existing fresh-path already handles with `resume` (it re-opens a fresh sandbox and the runner passes `options.resume = runnerSessionId`, rehydrating the transcript from `.claude/projects/*/<sid>.jsonl` — `main.ts:674-683`). One new host-side service hook, **`agent:apply-capability-grant`** (`@ax/chat-orchestrator`), does the control-plane prep: derive the skill's per-slot credential bindings, `skills:attach-for-user` (TASK-33), and `session:terminate` the conversation's warm session so the next turn re-spawns. A new auth+ACL-gated endpoint **`POST /api/chat/permission-decision`** (`@ax/channel-web`) calls it. The browser then **re-issues the original turn via the existing `chat.regenerate()` path** (runtime.tsx:64-79 already does "terminated session → fresh re-spawn → resume → re-run the last user turn" for the retry banner) — so the answer streams seamlessly with **no new client stream machinery**. Re-spawn failure surfaces via the existing `chat:turn-error → SSE` path (§13), since the answer turn is a normal `agent:invoke`.

**Tech Stack:** TypeScript, pnpm workspace, tsconfig project refs, the in-process hook bus, kysely + Postgres (testcontainers in the canary), React + `@assistant-ui/react` + `@ai-sdk/react`, shadcn primitives in `packages/channel-web`, vitest + `@testing-library/react` (jsdom).

---

## Scope guardrails

- **One new service hook: `agent:apply-capability-grant`** (registered by `@ax/chat-orchestrator`, called host-side by `@ax/channel-web`). Boundary-review note (refining design §11.5): *Alternate impl* — today's **re-spawn** backend (terminate warm session → fresh open resumes); a future **hot-reload** backend would signal the live runner to reload skills with no terminate (the design notes re-spawn is needed *only because* there is no hot-reload today, §7 table). The hook abstracts "make a just-granted capability take effect and let the conversation continue," not "re-spawn." *Payload fields* — in `{ conversationId, userId, agentId, skillId }`, out `{ attached: boolean }`: all are domain identifiers (a `skillId` is a catalog id) — **no** `sha`/`pod`/`socket`/`bucket`/`generation`/`session`-row vocabulary, **no secret**. *Subscriber risk* — none; it's a service hook (single impl), not a subscriber. *Wire surface* — **NOT an IPC action**: it is host-side only (channel-web → orchestrator); the agent/runner never reaches it, so the agent→host wire surface does not widen.
- **No cross-plugin imports (invariant I2).** `@ax/chat-orchestrator` reaches `@ax/skills` only through the bus (`skills:resolve`, `skills:attach-for-user`) and the session backend through `session:terminate` / `session:is-alive` / `conversations:get` — no new `@ax/*` import beyond `@ax/core`. The `skill:<id>:<slot>` credential-ref scheme is **re-derived locally** (it is already an accepted local-re-derivation convention — `@ax/credentials/src/refs.ts:30`, `credentials-admin-routes/src/destination-routes.ts:65`, and `@ax/skills`' own purge at `plugin.ts:110` each re-derive it; this plan re-derives it in the orchestrator with the same posture, not via a shared import).
- **One source of truth (invariant I4).** Per-user attachments are owned by `@ax/skills` (TASK-33's `skills_v1_user_attachments`); the hook *writes through* `skills:attach-for-user`, it does not keep its own copy. The credential the user typed lives in the **one** host credential store (written by TASK-35's card via the existing destination route); the hook only binds the **ref** to it. The per-chat control plane (route-vs-fresh, terminate, re-spawn) stays in `@ax/chat-orchestrator` — channel-web does not re-implement it.
- **Capabilities minimized (invariant I5).** The grant widens exactly the user's **own** already-isolated sandbox by exactly the hosts/slots the **vetted catalog skill** declares (design decision #3) — never blanket egress, never another user. The new hook is host-side (no IPC widening). The secret never enters the model, the transcript, the SSE frame, or this hook's payload.
- **Security-checklist applies** (sandbox re-spawn + credential binding + untrusted-content-steering-a-re-spawn) — it is a **pre-PR gate** (Task 6 Step 4). Pre-stated threat model in [Security threat model](#security-threat-model-pre-stated) below. (The card body cites design §7/§11.5/§13; design §10 mandates the security-checklist for the JIT surface, and this card touches the sandbox boundary + credential path, so it is gated here per CLAUDE.md invariant #5.)
- **UI uses the `shadcn` skill** (invariant #6). Task 4 only *extends* TASK-35's existing `<PermissionCard>` (no new primitive); still invoke the `shadcn` skill before editing it and keep semantic tokens / installed primitives (workspace flag `-c packages/channel-web`).
- **Half-wired window (stated):** see [Half-wired window](#half-wired-window) — this card **CLOSES** TASK-34's `request_capability`-downstream window and TASK-35's card-doesn't-attach/re-spawn window; what remains open is owned by other named cards (TASK-37 reactive-wall, TASK-38 flag, TASK-39 authoring, Part II vault/settings/admit).

## Dependency status & as-built re-verification (READ FIRST)

This card **Depends on TASK-34** (broker tool + `request_capability`) **and TASK-35** (bundled approval card + `chat:permission-request` SSE frame). `yolo-ship` only pulls it once **both are Done**, so by execution time TASK-32/33/34/35 are merged to `main`. **At the time this plan was written, TASK-34 was In Progress and TASK-35 was To Do — neither was on `main`.** This plan was therefore written against (a) the **committed TASK-34/35 impl plans** for the broker/card contracts and (b) the **as-built `main`** for the orchestrator/runner/skills-attach machinery (verified file:line anchors below). Before Task 1, **re-confirm against `main`** (hard requirement #1 — do not trust file:line anchors) and adjust if any of these moved:

- [ ] **`skills:attach-for-user` shape (TASK-33, on `main`).** Handler at `packages/skills/src/plugin.ts:523-561`; input `{ userId, agentId, skillId, credentialBindings: Record<string,string> }` → `{ created: boolean }` (`packages/skills/src/types.ts:126-134`). It resolves the skill (user scope then global), then `validateAttachmentBindings(declaredSlots, bindings)` which **requires a binding for EVERY declared slot** and **rejects orphan slots** (`packages/skills/src/attachment-validation.ts:21`). So the hook MUST bind all declared slots (Task 1 derives them) — a partially-filled card cannot attach.
- [ ] **`skills:list-user-attachments` + the orchestrator union (TASK-33, on `main`).** `skills:list-user-attachments({ userId, agentId }) → { attachments: { skillId, credentialBindings }[] }` (`plugin.ts:563-574`). The orchestrator's fresh-path union reads it and applies **per-user > agent-global > default-attached** precedence (`orchestrator.ts:~1059-1222`); each attached skill's declared slots resolve a `{ ref, kind }` threaded into the proxy from `attachment.credentialBindings[slot]`, and a **missing** binding hard-fails the turn with `skill-binding-missing` (`orchestrator.ts:1153-1191`). This is why Task 1 binds every slot to `skill:<id>:<slot>` and the card (Task 4) requires every slot filled.
- [ ] **`skills:resolve` shape (on `main`).** Returns resolved skills carrying `capabilities.credentials: { slot, kind }[]` and `capabilities.allowedHosts: string[]` (`orchestrator.ts` calls `skills:resolve({ skillIds, ownerUserId })`). Task 1 reads `capabilities.credentials.map(c => c.slot)` from it. (Confirm `skills:resolve` resolves a **global catalog** skill for a user with no user-scoped copy — it does today; the broker only proposes catalog skills.)
- [ ] **Orchestrator route-vs-fresh + terminate are intact (on `main`).** Route decision at `orchestrator.ts:739-799`: `conversations:get` → `activeSessionId` → `session:is-alive`; **fresh path is taken when the session is dead OR the active id is null/placeholder**. The orchestrator already `calls` `session:terminate` + `agents:resolve` and registers `agent:invoke` (`plugin.ts:28,42-47`). The `onSessionTerminate` fault-A subscriber only fires `chat:turn-error` when a **live unsettled waiter** exists for the session (`orchestrator.ts:586-601`); after a keepAlive turn ends the waiter is resolved + unregistered (`onTurnEnd` keepAlive branch + `runAgentInvoke` finally), **so terminating the warm session during the grant raises NO spurious turn-error**. Re-verify this property holds.
- [ ] **Re-spawn resumes via `runnerSessionId` (on `main`).** A fresh `sandbox:open-session` does NOT carry a resume id; the runner fetches it at boot via `session.get-config`, which **composes `runnerSessionId` from `conversations:get-metadata`** for conversation-scoped sessions (`packages/ipc-core/src/handlers/session-get-config.ts:101-128`) and passes it as `options.resume` (`agent-claude-sdk-runner/src/main.ts:674-683`). `runner_session_id` lives on the **conversation row** and is bound after the first host-accepted turn-end commit (`main.ts:597-655`); `session:terminate` clears `active_session_id` but **not** `runner_session_id`, so resume survives the retire. The brokering turn commits its jsonl at turn-end (`git add -A` stages the transcript), so `runner_session_id` is bound before the user finishes approving (the race + fallback are addressed in Task 1).
- [ ] **`chat.regenerate()` retry path (on `main`).** `useChatThreadRuntime` holds the `@ai-sdk/react` `chat` and the retry banner calls `chat.regenerate()` (`packages/channel-web/src/lib/runtime.tsx:69-79`); its comment confirms "regenerate re-runs the last user turn; the dead session's active_session_id was cleared by session:terminate, so it routes to a fresh sandbox." Task 3/4 reuse exactly this. Confirm `chat.regenerate` is still the symbol and the transport's `sendMessages` re-POSTs the last user turn to `/api/chat/messages` (`transport.ts:289-359`).
- [ ] **`useConversationId()` (on `main`).** `packages/channel-web/src/lib/use-conversation-id.ts` exports `useConversationId(): string | null` (the active conversation) — the card (Task 4) reads it for the decision POST.
- [ ] **TASK-35 surfaces exist after merge.** `packages/channel-web/src/components/PermissionCard.tsx` with a `Connect` handler that writes each filled slot via `setDestinationCredential` to `skill:<id>:<slot>` and a `permission-card-store` whose request carries `{ skillId, description, hosts, slots: { slot, kind }[] }`. Task 4 *extends* this Connect handler; if TASK-35 shipped a different file/shape, adapt the diff (the credential-write half is unchanged — Task 4 adds the decision POST + continue trigger after it).
- [ ] **TASK-34's `request_capability` description.** `packages/skill-broker/src/tools/request-capability.ts` already says "Do not narrate this step or restate any keys" — Task 5 refines it to add "you'll continue automatically once it's connected; don't tell the user to re-ask." If TASK-34 shipped different prose, adapt.
- [ ] **channel-web manifest `calls`.** `packages/channel-web/src/server/plugin.ts:83-99` lists `agent:invoke` as a hard `calls` dep — Task 2 adds `agent:apply-capability-grant` to the same array (orchestrator + channel-web always co-deploy in `presets/k8s`).

> **Implementation forks resolved (hard requirement #7):**
>
> 1. **How "hold the brokering turn pending → re-spawn → resume" maps onto the as-built runner.** The runner runs **one persistent `query()`**; a tool call cannot pause it (the SDK sequences tool → result → turn-end before the runner could intervene — `main.ts:910-1150`). So "re-spawn" is **retire-the-warm-session + re-issue-the-turn**, which the orchestrator's existing fresh path already turns into "fresh open → `options.resume` → rehydrated transcript." The "pending" turn is simply the brokering turn that ended without answering (the agent called `request_capability` and stopped); the original ask is unanswered until the grant applies. **Rationale:** this is the design's own "robust path / Opt-2 plumbing" (§7) realized against the frozen-at-spawn runner — no new pause primitive, no SDK fork.
>
> 2. **Server-drives-the-answer-turn vs. client `regenerate()`.** **Client `regenerate()`.** Rationale: the runtime *already* has the exact "terminated session → fresh re-spawn → resume → re-run the last user turn" machinery, wired for the retry banner (`runtime.tsx:64-79`), including the re-spawn-failure → error-banner path (§13). A server-driven answer turn would instead have to mint a fresh `reqId` and the browser would need new machinery to attach an out-of-band server-minted stream and inject it as an assistant message — assistant-ui has no natural API for that, so it would be fragile new code. `regenerate()` reuses the normal POST → `/api/chat/stream/:reqId` flow, so the answer streams seamlessly and **no new client stream code ships**. This is a product-neutral plumbing call.
>
> 3. **The synthetic "continue" content + "stays hidden."** With fork #2, the "synthetic continue" **is the user's own original turn, re-issued by `regenerate()`** — there is no separate injected message to hide on the live stream (only the assistant answer streams; the re-issued user turn is not echoed as a new bubble — `regenerate` replaces the brokering assistant bubble in place). **Known residual** (the design's sanctioned graceful degradation): the server jsonl ends up with the original user turn twice (resumed copy + the regenerate re-issue) plus the brokering tool-call turn, so a **reload** of the conversation shows the ask twice. The *live* experience reads as one continuous answer. A follow-up could drop the brokering turn via `conversations:drop-turn`; out of scope here.
>
> 4. **Who builds `credentialBindings`, and the blank-slot tension.** The **orchestrator hook** derives `{ slot: \`skill:<id>:<slot>\` }` for **every** declared slot (re-derived locally per the established convention). Because `validateAttachmentBindings` requires all declared slots bound, the **card (Task 4) requires every declared slot filled before Connect triggers the grant** — this tightens TASK-35's "a slot may be left blank" specifically for the re-spawn path (a skill cannot become *active* with a missing key, since the proxy resolve would fail). A skill with **no** credential slots (inert / host-only) attaches with `{}` bindings and Connect proceeds immediately. This is product-neutral (it makes "Connect" mean "this capability is now usable").

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/chat-orchestrator/src/orchestrator.ts` | per-chat control plane | **add** `applyCapabilityGrant` (derive bindings → `skills:attach-for-user` → retire warm session) + export from the factory |
| `packages/chat-orchestrator/src/plugin.ts` | manifest + hook registration | **register** `agent:apply-capability-grant`; **add** its optional peer calls to the manifest comment |
| `packages/chat-orchestrator/src/__tests__/apply-capability-grant.test.ts` | **new** — hook unit tests | **create** |
| `packages/channel-web/src/server/routes-chat.ts` | chat HTTP routes | **add** `POST /api/chat/permission-decision` handler + route registration |
| `packages/channel-web/src/server/plugin.ts` | manifest | **add** `'agent:apply-capability-grant'` to `calls` |
| `packages/channel-web/src/__tests__/server/routes-chat.test.ts` | route tests | **extend** — decision endpoint auth/ACL + hook dispatch |
| `packages/channel-web/src/lib/resume-actions.ts` | **new** — client "continue after grant" seam (module store holding the runtime's `regenerate`) | **create** |
| `packages/channel-web/src/__tests__/resume-actions.test.ts` | store unit tests | **create** |
| `packages/channel-web/src/lib/runtime.tsx` | runtime wiring | **register** `chat.regenerate` into `resume-actions` |
| `packages/channel-web/src/components/PermissionCard.tsx` | the bundled approval card (TASK-35) | **change** Connect: require all slots → write creds → POST decision → `continueAfterGrant()` |
| `packages/channel-web/src/__tests__/permission-card.test.tsx` | card tests (TASK-35) | **extend** — Connect posts the decision + triggers continue; blank slot disables Connect |
| `packages/agent-claude-sdk-runner/src/system-prompt.ts` | SDK system-prompt assembly | **add** a brief, harmless JIT-handoff operational note |
| `packages/agent-claude-sdk-runner/src/__tests__/system-prompt.test.ts` | system-prompt tests | **extend** — the handoff note is present |
| `packages/skill-broker/src/tools/request-capability.ts` | `request_capability` tool (TASK-34) | **change** description: "you'll continue automatically once connected" |
| `packages/skill-broker/src/__tests__/plugin.test.ts` | broker tests (TASK-34/35) | **extend** — description mentions continue-automatically |
| `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` | end-to-end canary | **extend** — request_capability → card → `apply-capability-grant` attaches + a fresh open's `installedSkills` includes the skill |

---

## Shared rule: deriving per-slot credential bindings (referenced by Tasks 1, 6)

For a catalog skill `<skillId>` with declared credential slots `slot₁..slotₙ`, the attachment's bindings are:

```
{ slot₁: `skill:<skillId>:slot₁`, …, slotₙ: `skill:<skillId>:slotₙ` }
```

— exactly the deterministic ref TASK-35's card wrote each filled key to (`refForDestination({ kind: 'skill-slot', skillId, slot })`). This is the **established per-skill credential convention**, re-derived locally (no cross-plugin import) — the same posture as `credentials-admin-routes` inlining it from `@ax/credentials/refs.ts` and `@ax/skills` re-deriving it in its purge routine. A skill that declares **zero** slots binds `{}`.

---

### Task 1: Orchestrator `agent:apply-capability-grant` hook

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`, `packages/chat-orchestrator/src/plugin.ts`
- Test: `packages/chat-orchestrator/src/__tests__/apply-capability-grant.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/chat-orchestrator/src/__tests__/apply-capability-grant.test.ts` (mirrors `route-by-conversation.test.ts`'s `createTestHarness({ services, plugins })` + `makeAgentContext` pattern):

```typescript
import { describe, it, expect } from 'vitest';
import { makeAgentContext, createLogger, type ServiceHandler } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

interface Trace {
  attach: Array<{ userId: string; agentId: string; skillId: string; credentialBindings: Record<string, string> }>;
  terminate: string[];
  isAlive: string[];
}

function buildMocks(opts: {
  slots: string[]; // declared credential slots of the skill being granted
  activeSessionId: string | null;
  liveSessions: Set<string>;
}): { trace: Trace; services: Record<string, ServiceHandler> } {
  const trace: Trace = { attach: [], terminate: [], isAlive: [] };
  const services: Record<string, ServiceHandler> = {
    'agents:resolve': async () => ({
      agent: {
        id: 'agent-1', ownerId: 'user-1', ownerType: 'user', visibility: 'personal',
        displayName: 'A', systemPrompt: '', allowedTools: [], mcpConfigIds: [],
        model: 'claude-sonnet-4-7', workspaceRef: null,
      },
    }),
    'skills:resolve': async (_c, input: unknown) => {
      const ids = (input as { skillIds: string[] }).skillIds;
      return {
        skills: ids.map((id) => ({
          id,
          manifestYaml: '', bodyMd: '',
          capabilities: {
            allowedHosts: ['api.linear.app'],
            credentials: opts.slots.map((s) => ({ slot: s, kind: 'api-key' as const })),
            mcpServers: [], packages: { npm: [], pypi: [] },
          },
        })),
      };
    },
    'skills:attach-for-user': async (_c, input: unknown) => {
      trace.attach.push(input as Trace['attach'][number]);
      return { created: true };
    },
    'conversations:get': async (_c, input: unknown) => {
      const i = input as { conversationId: string; userId: string };
      return {
        conversation: {
          conversationId: i.conversationId, userId: i.userId, agentId: 'agent-1',
          activeSessionId: opts.activeSessionId, activeReqId: null,
        },
      };
    },
    'session:is-alive': async (_c, input: unknown) => {
      const sid = (input as { sessionId: string }).sessionId;
      trace.isAlive.push(sid);
      return { alive: opts.liveSessions.has(sid) };
    },
    'session:terminate': async (_c, input: unknown) => {
      trace.terminate.push((input as { sessionId: string }).sessionId);
      return {};
    },
  };
  return { trace, services };
}

function ctx() {
  return makeAgentContext({
    sessionId: 's', agentId: 'agent-1', userId: 'user-1', conversationId: 'cnv-1',
    logger: createLogger({ reqId: 'grant-test', writer: () => undefined }),
  });
}

async function harnessFor(mocks: ReturnType<typeof buildMocks>) {
  return createTestHarness({
    services: mocks.services,
    plugins: [createChatOrchestratorPlugin({ runnerBinary: '/irrelevant', keepAlive: true })],
  });
}

describe('agent:apply-capability-grant', () => {
  it('attaches the skill with all declared slots bound to skill:<id>:<slot>', async () => {
    const mocks = buildMocks({ slots: ['api_key'], activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']) });
    const h = await harnessFor(mocks);
    const out = await h.bus.call('agent:apply-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear',
    });
    expect(out).toEqual({ attached: true });
    expect(mocks.trace.attach).toEqual([
      { userId: 'user-1', agentId: 'agent-1', skillId: 'linear', credentialBindings: { api_key: 'skill:linear:api_key' } },
    ]);
  });

  it('terminates the warm session so the next turn re-spawns', async () => {
    const mocks = buildMocks({ slots: [], activeSessionId: 'sess-warm', liveSessions: new Set(['sess-warm']) });
    const h = await harnessFor(mocks);
    await h.bus.call('agent:apply-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'notes',
    });
    expect(mocks.trace.terminate).toEqual(['sess-warm']);
  });

  it('binds {} for a slotless skill and does not terminate a dead/absent session', async () => {
    const mocks = buildMocks({ slots: [], activeSessionId: null, liveSessions: new Set() });
    const h = await harnessFor(mocks);
    await h.bus.call('agent:apply-capability-grant', ctx(), {
      conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'notes',
    });
    expect(mocks.trace.attach[0]?.credentialBindings).toEqual({});
    expect(mocks.trace.terminate).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/chat-orchestrator test -- src/__tests__/apply-capability-grant.test.ts`
Expected: FAIL — `no service registered for 'agent:apply-capability-grant'`.

- [ ] **Step 3: Implement `applyCapabilityGrant` in the orchestrator factory**

In `packages/chat-orchestrator/src/orchestrator.ts`, add the I/O types near the other `*Input`/`Output` interfaces:

```typescript
export interface ApplyCapabilityGrantInput {
  conversationId: string;
  userId: string;
  agentId: string;
  skillId: string;
}
export interface ApplyCapabilityGrantOutput {
  attached: boolean;
}
```

Inside `createOrchestrator(...)` (alongside `runAgentInvoke`, before the `return { ... }`), add:

```typescript
// JIT (design §7/§11.5): apply a user-approved capability grant, then retire
// the conversation's warm session so the NEXT turn re-spawns and resumes
// (the runner reads skills only at session init — main.ts "frozen at spawn").
// Host-side only; never an IPC action. The channel re-issues the turn (web:
// chat.regenerate) — this hook is the control-plane prep, not the answer turn.
async function applyCapabilityGrant(
  ctx: AgentContext,
  input: ApplyCapabilityGrantInput,
): Promise<ApplyCapabilityGrantOutput> {
  // 1. Resolve the catalog skill's declared slots so we can bind every one
  //    (skills:attach-for-user requires a binding for each — validateAttachmentBindings).
  let declaredSlots: string[] = [];
  if (bus.hasService('skills:resolve')) {
    const r = await bus.call<
      { skillIds: string[]; ownerUserId?: string },
      { skills: Array<{ id: string; capabilities: { credentials: Array<{ slot: string }> } }> }
    >('skills:resolve', ctx, { skillIds: [input.skillId], ownerUserId: input.userId });
    declaredSlots = r.skills[0]?.capabilities.credentials.map((c) => c.slot) ?? [];
  }

  // 2. Derive per-slot bindings: slot → `skill:<id>:<slot>` (the deterministic
  //    ref TASK-35's card wrote each key to). Established local-re-derivation
  //    convention — same posture as credentials-admin-routes inlining it.
  const credentialBindings: Record<string, string> = {};
  for (const slot of declaredSlots) {
    credentialBindings[slot] = `skill:${input.skillId}:${slot}`;
  }

  // 3. Attach for the user (TASK-33). Errors propagate as PluginError — the
  //    caller (the decision endpoint) maps them to an HTTP error.
  let attached = false;
  if (bus.hasService('skills:attach-for-user')) {
    const r = await bus.call<
      { userId: string; agentId: string; skillId: string; credentialBindings: Record<string, string> },
      { created: boolean }
    >('skills:attach-for-user', ctx, {
      userId: input.userId,
      agentId: input.agentId,
      skillId: input.skillId,
      credentialBindings,
    });
    attached = r.created;
  }

  // 4. Retire the conversation's warm session (if any is alive) so the next
  //    turn takes the fresh path → fresh sandbox + options.resume (it reads
  //    the now-attached skill). session:terminate clears active_session_id
  //    (not runner_session_id), so resume survives. No live waiter exists for
  //    a finished keepAlive turn, so onSessionTerminate fires no turn-error.
  if (
    bus.hasService('conversations:get') &&
    bus.hasService('session:is-alive')
  ) {
    try {
      const conv = await bus.call<
        ConversationsGetInput,
        ConversationsGetOutput
      >('conversations:get', ctx, { conversationId: input.conversationId, userId: input.userId });
      const candidate = conv.conversation.activeSessionId;
      if (candidate !== null && candidate.length > 0) {
        const alive = await bus.call<
          SessionIsAliveInput,
          SessionIsAliveOutput
        >('session:is-alive', ctx, { sessionId: candidate });
        if (alive.alive) {
          await bus.call('session:terminate', ctx, { sessionId: candidate });
        }
      }
    } catch (err) {
      // Best-effort retire: if we can't read/terminate the warm session, the
      // next turn's route-vs-fresh still picks fresh once is-alive sees it
      // dead, or routes into a stale-but-skill-frozen session (degraded, not
      // unsafe). Log and continue — the attach already landed.
      ctx.logger.warn('apply_capability_grant_retire_failed', {
        conversationId: input.conversationId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return { attached };
}
```

Add `applyCapabilityGrant` to the factory's returned object:

```typescript
return { runAgentInvoke, onChatEnd, onTurnEnd, onSessionTerminate, applyCapabilityGrant };
```

(`ConversationsGetInput`/`Output`, `SessionIsAliveInput`/`Output` already exist in this file — reuse them. If `skills:resolve`'s local result type differs, read `capabilities.credentials[].slot` from whatever shape the file already uses for resolved skills.)

- [ ] **Step 4: Register the hook in `plugin.ts`**

In `packages/chat-orchestrator/src/plugin.ts`, import the new I/O types and register the service inside `init()` (after the `agent:invoke` registration). The peer calls are **conditional** (gated by `hasService`, like the existing `conversations:*` peers), so they stay out of `calls`:

```typescript
import {
  createOrchestrator, PLUGIN_NAME,
  type ChatOrchestratorConfig, type AgentInvokeInput,
  type ApplyCapabilityGrantInput, type ApplyCapabilityGrantOutput,
} from './orchestrator.js';
// ...
bus.registerService<ApplyCapabilityGrantInput, ApplyCapabilityGrantOutput>(
  'agent:apply-capability-grant',
  PLUGIN_NAME,
  async (ctx, input) => orch.applyCapabilityGrant(ctx, input),
);
```

Add `'agent:apply-capability-grant'` to the manifest `registers` array, and extend the manifest comment block noting that `skills:resolve` / `skills:attach-for-user` are **conditionally-called peers** (gated by `hasService` — present only where `@ax/skills` is wired, e.g. the k8s preset).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/chat-orchestrator test -- src/__tests__/apply-capability-grant.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/plugin.ts \
  packages/chat-orchestrator/src/__tests__/apply-capability-grant.test.ts
git commit -m "feat(chat-orchestrator): agent:apply-capability-grant (attach + retire warm session for re-spawn)"
```

---

### Task 2: channel-web `POST /api/chat/permission-decision` endpoint

**Files:**
- Modify: `packages/channel-web/src/server/routes-chat.ts`, `packages/channel-web/src/server/plugin.ts`
- Test: `packages/channel-web/src/__tests__/server/routes-chat.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/channel-web/src/__tests__/server/routes-chat.test.ts` (reuse the file's existing harness that boots the chat routes with stubbed `auth:require-user`, `agents:resolve`, `conversations:*`; mirror however the file builds a `RouteRequest`/`RouteResponse` for `postMessage`):

```typescript
describe('POST /api/chat/permission-decision', () => {
  it('auths, resolves the agent, and calls agent:apply-capability-grant', async () => {
    const grants: unknown[] = [];
    const h = bootChatRoutes({
      services: {
        'auth:require-user': async () => ({ user: { id: 'user-1', isAdmin: false } }),
        'agents:resolve': async () => ({ agent: { id: 'agent-1' } }),
        'conversations:get': async () => ({
          conversation: { conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', activeSessionId: null, activeReqId: null },
        }),
        'agent:apply-capability-grant': async (_c, input) => {
          grants.push(input);
          return { attached: true };
        },
      },
    });
    const { res, body } = await h.invoke('POST', '/api/chat/permission-decision', {
      conversationId: 'cnv-1', skillId: 'linear',
    });
    expect(res.statusCode).toBe(200);
    expect(body).toEqual({ ok: true, attached: true });
    expect(grants).toEqual([
      { conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear' },
    ]);
  });

  it('401 when unauthenticated', async () => {
    const h = bootChatRoutes({
      services: { 'auth:require-user': async () => { throw new Error('nope'); } },
    });
    const { res } = await h.invoke('POST', '/api/chat/permission-decision', { conversationId: 'cnv-1', skillId: 'linear' });
    expect(res.statusCode).toBe(401);
  });

  it('400 on a malformed body', async () => {
    const h = bootChatRoutes({
      services: { 'auth:require-user': async () => ({ user: { id: 'user-1', isAdmin: false } }) },
    });
    const { res } = await h.invoke('POST', '/api/chat/permission-decision', { conversationId: 'cnv-1' });
    expect(res.statusCode).toBe(400);
  });
});
```

(`bootChatRoutes` / `h.invoke` are placeholders for the file's existing route-test harness — use the real helpers the file already uses to drive `postMessage`. The agent id comes from `conversations:get` so the client need not send it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/routes-chat.test.ts`
Expected: FAIL — `/api/chat/permission-decision` is not registered (404).

- [ ] **Step 3: Add the handler + route + body schema**

In `packages/channel-web/src/server/routes-chat.ts`, add a zod schema near the other request schemas:

```typescript
const PermissionDecisionRequestSchema = z.object({
  conversationId: z.string().min(1),
  skillId: z.string().min(1).max(128),
});
```

Add a handler to the object returned by `createChatRouteHandlers` (mirror `postMessage`'s auth → parse → ACL shape, but resolve the agent from the conversation rather than the body):

```typescript
async postPermissionDecision(req: RouteRequest, res: RouteResponse): Promise<void> {
  // 1. Auth.
  let userId: string;
  try {
    const r = await bus.call<AuthRequireUserInput, AuthRequireUserOutput>('auth:require-user', initCtx, { req });
    userId = r.user.id;
  } catch {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  // 2. Parse.
  const parsed = PermissionDecisionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid-payload' });
    return;
  }
  const { conversationId, skillId } = parsed.data;
  // 3. Resolve the conversation (ownership) → its agentId.
  let agentId: string;
  try {
    const got = await bus.call<ConversationsGetInput, ConversationsGetOutput>(
      'conversations:get', initCtx, { conversationId, userId },
    );
    agentId = got.conversation.agentId;
  } catch {
    res.status(404).json({ error: 'not-found' });
    return;
  }
  // 4. ACL gate on the agent (same posture as postMessage).
  try {
    await bus.call<AgentsResolveInput, AgentsResolveOutput>('agents:resolve', initCtx, { agentId, userId });
  } catch (err) {
    const code = err instanceof PluginError ? err.code : '';
    res.status(code === 'forbidden' ? 403 : 404).json({ error: code || 'not-found' });
    return;
  }
  // 5. Apply the grant (attach + retire warm session so the next turn re-spawns).
  const grantCtx = makeAgentContext({ sessionId: makeReqId(), agentId, userId, conversationId, reqId: makeReqId() });
  try {
    const out = await bus.call<
      { conversationId: string; userId: string; agentId: string; skillId: string },
      { attached: boolean }
    >('agent:apply-capability-grant', grantCtx, { conversationId, userId, agentId, skillId });
    res.status(200).json({ ok: true, attached: out.attached });
  } catch (err) {
    grantCtx.logger.warn('permission_decision_grant_failed', {
      conversationId, skillId, err: err instanceof Error ? err : new Error(String(err)),
    });
    res.status(500).json({ error: 'grant-failed' });
  }
}
```

Register the route in the `routes` array of `registerChatRoutes`:

```typescript
{ method: 'POST', path: '/api/chat/permission-decision', handler: handlers.postPermissionDecision as unknown as RouteHandler },
```

(Reuse the file's existing imports for `AuthRequireUserInput/Output`, `ConversationsGetInput/Output`, `AgentsResolveInput/Output`, `PluginError`, `makeAgentContext`, `makeReqId`, `z`. The CSRF guard for this state-changing POST is applied by `@ax/http-server`'s subscriber, same as `/api/chat/messages` — no per-handler work.)

- [ ] **Step 4: Declare the dependency in the manifest**

In `packages/channel-web/src/server/plugin.ts`, add `'agent:apply-capability-grant'` to the `calls` array (next to `'agent:invoke'`) and to the `calls:` comment. (Orchestrator + channel-web always co-deploy in `presets/k8s`; the `preset.test.ts` reachability guard confirms the producer is present.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/routes-chat.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/server/routes-chat.ts packages/channel-web/src/server/plugin.ts \
  packages/channel-web/src/__tests__/server/routes-chat.test.ts
git commit -m "feat(channel-web): POST /api/chat/permission-decision → agent:apply-capability-grant"
```

---

### Task 3: Client `resume-actions` seam (register the runtime's `regenerate`)

**Files:**
- Create: `packages/channel-web/src/lib/resume-actions.ts`
- Modify: `packages/channel-web/src/lib/runtime.tsx`
- Test: `packages/channel-web/src/__tests__/resume-actions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/channel-web/src/__tests__/resume-actions.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeActions } from '../lib/resume-actions';

describe('resume-actions', () => {
  afterEach(() => resumeActions.reset());

  it('continueAfterGrant() invokes the registered regenerate', () => {
    const regen = vi.fn();
    resumeActions.registerRegenerate(regen);
    resumeActions.continueAfterGrant();
    expect(regen).toHaveBeenCalledTimes(1);
  });

  it('continueAfterGrant() is a no-op when nothing is registered', () => {
    expect(() => resumeActions.continueAfterGrant()).not.toThrow();
  });

  it('the latest registration wins (runtime re-mounts)', () => {
    const a = vi.fn();
    const b = vi.fn();
    resumeActions.registerRegenerate(a);
    resumeActions.registerRegenerate(b);
    resumeActions.continueAfterGrant();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/resume-actions.test.ts`
Expected: FAIL — cannot find module `../lib/resume-actions`.

- [ ] **Step 3: Implement the seam**

Create `packages/channel-web/src/lib/resume-actions.ts` (the same module-ref posture the retry banner already uses to reach `regenerate` from outside the component tree — `runtime.tsx` holds `chatRef` and `applyTurnError` calls `() => chatRef.current?.regenerate()`):

```typescript
/**
 * Resume seam for the JIT permission card (design §7). After the user approves
 * a capability (POST /api/chat/permission-decision attaches the skill + retires
 * the warm session), the conversation must RE-ISSUE the original turn so it
 * re-spawns + resumes and the agent answers. We reuse the runtime's existing
 * `regenerate()` — the exact "terminated session → fresh re-spawn → resume →
 * re-run last user turn" path the retry banner uses (runtime.tsx). The runtime
 * registers its `regenerate` here; the card calls `continueAfterGrant()`.
 *
 * No secret, no transcript, no SSE here — purely a client-side trigger.
 */
let regenerate: (() => void) | null = null;

export const resumeActions = {
  /** Runtime wires its `chat.regenerate` here on mount. Latest wins. */
  registerRegenerate(fn: () => void): void {
    regenerate = fn;
  },
  /** Re-issue the pending original turn after a grant lands. No-op if unwired. */
  continueAfterGrant(): void {
    regenerate?.();
  },
  /** Test seam. */
  reset(): void {
    regenerate = null;
  },
};
```

- [ ] **Step 4: Register `regenerate` from the runtime**

In `packages/channel-web/src/lib/runtime.tsx`, import the seam and register `chat.regenerate` next to where `chatRef.current = chat` is set inside `useChatThreadRuntime`:

```typescript
import { resumeActions } from './resume-actions';
// ...
  chatRef.current = chat;
  // JIT resume: expose this thread's regenerate so <PermissionCard> can
  // re-issue the pending original turn after a capability grant lands.
  resumeActions.registerRegenerate(() => {
    void chatRef.current?.regenerate();
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/resume-actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/lib/resume-actions.ts packages/channel-web/src/lib/runtime.tsx \
  packages/channel-web/src/__tests__/resume-actions.test.ts
git commit -m "feat(channel-web): resume-actions seam exposing the runtime's regenerate to the card"
```

---

### Task 4: Card Connect → decision POST → continue (extend TASK-35's `<PermissionCard>`)

**Files:**
- Modify: `packages/channel-web/src/components/PermissionCard.tsx`
- Test: `packages/channel-web/src/__tests__/permission-card.test.tsx`

> Invoke the **`shadcn`** skill first (invariant #6) — this only edits existing primitives, but keep semantic tokens / installed primitives, workspace flag `-c packages/channel-web`.

- [ ] **Step 1: Write the failing test**

Add to `packages/channel-web/src/__tests__/permission-card.test.tsx` (reuse the file's `linear` fixture + `permissionCardActions`; mock `useConversationId` so the card has a conversation, and `resumeActions.continueAfterGrant`):

```typescript
import { resumeActions } from '../lib/resume-actions';
import * as convId from '../lib/use-conversation-id';

it('Connect posts the decision then triggers continue, after writing the key', async () => {
  vi.spyOn(convId, 'useConversationId').mockReturnValue('cnv-1');
  const continueSpy = vi.spyOn(resumeActions, 'continueAfterGrant').mockImplementation(() => undefined);
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ ok: true, attached: true }), { status: 200 }));

  render(<PermissionCard />);
  permissionCardActions.show(linear); // one slot: api_key
  fireEvent.change(screen.getByLabelText('api_key'), { target: { value: 'lin_test_123' } });
  fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

  await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
  // credential write (TASK-35 route) + decision POST both fired.
  const urls = fetchMock.mock.calls.map((c) => c[0]);
  expect(urls).toContain('/settings/destinations/skill-slot/credential');
  expect(urls).toContain('/api/chat/permission-decision');
  const decisionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/chat/permission-decision');
  expect(decisionCall?.[1]?.body).toContain('"skillId":"linear"');
  expect(decisionCall?.[1]?.body).toContain('"conversationId":"cnv-1"');
  expect(continueSpy).toHaveBeenCalledTimes(1);
});

it('Connect is disabled until every declared slot is filled', async () => {
  vi.spyOn(convId, 'useConversationId').mockReturnValue('cnv-1');
  render(<PermissionCard />);
  permissionCardActions.show(linear);
  expect(screen.getByRole('button', { name: /^connect$/i })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('api_key'), { target: { value: 'k' } });
  expect(screen.getByRole('button', { name: /^connect$/i })).not.toBeDisabled();
});

it('Not now dismisses without posting a decision or continuing', async () => {
  vi.spyOn(convId, 'useConversationId').mockReturnValue('cnv-1');
  const continueSpy = vi.spyOn(resumeActions, 'continueAfterGrant').mockImplementation(() => undefined);
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  render(<PermissionCard />);
  permissionCardActions.show(linear);
  fireEvent.click(await screen.findByRole('button', { name: /not now/i }));
  await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
  expect(fetchMock).not.toHaveBeenCalled();
  expect(continueSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: FAIL — Connect doesn't POST the decision / isn't gated on all-slots-filled / doesn't call continue.

- [ ] **Step 3: Extend the Connect handler + slot gating**

In `packages/channel-web/src/components/PermissionCard.tsx`, import the seam + the conversation id:

```typescript
import { resumeActions } from '@/lib/resume-actions';
import { useConversationId } from '@/lib/use-conversation-id';
```

Inside the component, read the conversation id and compute "all slots filled":

```typescript
const conversationId = useConversationId();
// Every declared slot must have a non-empty value: a skill becomes USABLE only
// once its keys are present (the re-spawn's proxy resolves skill:<id>:<slot>).
const allSlotsFilled =
  request === null ||
  request.slots.every(({ slot }) => (values[slot] ?? '').trim().length > 0);
```

Extend `connect()` to POST the decision and trigger continue after the credential writes succeed (keep TASK-35's credential-write loop unchanged):

```typescript
async function connect(): Promise<void> {
  if (busy || request === null || conversationId === null || !allSlotsFilled) return;
  setBusy(true);
  setError(null);
  try {
    // (TASK-35) write each entered key straight to the host credential store.
    for (const { slot } of request.slots) {
      const payload = (values[slot] ?? '').trim();
      if (payload.length === 0) continue;
      await setDestinationCredential({
        destination: { kind: 'skill-slot', skillId: request.skillId, slot },
        slot: { kind: 'api-key' },
        scope: { scope: 'user', ownerId: null },
        payload,
      });
    }
    // (TASK-36) apply the grant: attach the skill + retire the warm session.
    const resp = await fetch('/api/chat/permission-decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
      body: JSON.stringify({ conversationId, skillId: request.skillId }),
      credentials: 'include',
    });
    if (!resp.ok) throw new Error(`connect failed: ${resp.status}`);
    close();
    // (TASK-36) re-issue the pending original turn → fresh re-spawn + resume
    // → the agent answers, with the now-attached skill (design §7).
    resumeActions.continueAfterGrant();
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    setBusy(false);
  }
}
```

Disable Connect until every slot is filled (and a conversation exists):

```tsx
<Button disabled={busy || !allSlotsFilled || conversationId === null} onClick={() => void connect()}>
  {busy ? 'Connecting…' : 'Connect'}
</Button>
```

(Leave **Not now** as TASK-35's `close()`-only handler — it posts nothing and does not continue.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/components/PermissionCard.tsx packages/channel-web/src/__tests__/permission-card.test.tsx
git commit -m "feat(channel-web): card Connect applies the grant + re-issues the turn (require all slots)"
```

---

### Task 5: Prompt tuning — don't narrate the handoff

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/system-prompt.ts`, `packages/skill-broker/src/tools/request-capability.ts`
- Test: `packages/agent-claude-sdk-runner/src/__tests__/system-prompt.test.ts`, `packages/skill-broker/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/agent-claude-sdk-runner/src/__tests__/system-prompt.test.ts` (mirror its existing `buildSystemPrompt(...)` assertions):

```typescript
it('includes the JIT capability-handoff note', () => {
  const out = buildSystemPrompt('', '/ws', undefined, false);
  const text = typeof out === 'string' ? out : (out.append ?? '');
  expect(text.toLowerCase()).toContain('continue automatically');
});
```

Add to `packages/skill-broker/src/__tests__/plugin.test.ts`:

```typescript
it('request_capability description tells the model it continues automatically', () => {
  expect(REQUEST_CAPABILITY_DESCRIPTOR.description.toLowerCase()).toContain('continue automatically');
});
```

(Import `REQUEST_CAPABILITY_DESCRIPTOR` from `../tools/request-capability.js` if not already.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @ax/agent-claude-sdk-runner test -- src/__tests__/system-prompt.test.ts` and `pnpm -F @ax/skill-broker test`
Expected: FAIL — neither string is present.

- [ ] **Step 3: Add the system-prompt note**

In `packages/agent-claude-sdk-runner/src/system-prompt.ts`, add a fixed runner-authored note (no untrusted input) and include it in the assembled `notes` (alongside `workspaceNote(...)`):

```typescript
function capabilityHandoffNote(): string {
  return [
    'When you connect a new capability mid-conversation (e.g. via a',
    'connect/approval tool), do not narrate the mechanics or restate any',
    'keys, and do not tell the user to re-ask — once they approve, the',
    'conversation will continue automatically and you should just answer',
    'their original request.',
  ].join(' ');
}
```

Push it unconditionally where the other notes are assembled in `buildSystemPrompt` (it is harmless when no connect tool exists):

```typescript
const notes: string[] = [workspaceNote(workspaceRoot), capabilityHandoffNote()];
```

- [ ] **Step 4: Refine the `request_capability` description**

In `packages/skill-broker/src/tools/request-capability.ts`, extend `REQUEST_CAPABILITY_DESCRIPTOR.description` so it ends with the continue-automatically guidance (keep TASK-34's "Do not narrate this step or restate any keys"):

```typescript
  description:
    'Request that a catalog skill be connected for the user. Pass a skill id from ' +
    'search_catalog results. The user will be asked to approve the hosts it reaches and ' +
    'enter any required keys. Do not narrate this step or restate any keys — the approval ' +
    'surface handles it. Once the user approves, the conversation will continue automatically; ' +
    'do not ask the user to repeat their request.',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -F @ax/agent-claude-sdk-runner test -- src/__tests__/system-prompt.test.ts` and `pnpm -F @ax/skill-broker test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/system-prompt.ts packages/agent-claude-sdk-runner/src/__tests__/system-prompt.test.ts \
  packages/skill-broker/src/tools/request-capability.ts packages/skill-broker/src/__tests__/plugin.test.ts
git commit -m "feat(jit): tune system prompt + request_capability so the agent doesn't narrate the handoff"
```

---

### Task 6: End-to-end canary + full verification + security-checklist + PR

**Files:**
- Modify: `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`

- [ ] **Step 1: Extend the canary**

In `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` (TASK-34/35 already boot `@ax/skills` + the tool-dispatcher + `@ax/skill-broker` + `@ax/chat-orchestrator` over the real Postgres catalog), add a case that walks the **server seam** end-to-end: `request_capability` fires the card → `agent:apply-capability-grant` attaches over the real store → a **fresh** `agent:invoke` opens a sandbox whose `installedSkills` now includes the skill (proving the re-spawn picks it up). Use the file's existing global-upsert helper + a mock `sandbox:open-session` that captures `installedSkills`:

```typescript
it('approve → apply-capability-grant attaches; a fresh re-spawn includes the skill', async () => {
  // bounded Linear skill: host + api_key slot (reuse the file's upsert helper).
  await upsertGlobalSkill({ id: 'linear', description: 'Read your Linear issues', allowedHosts: ['api.linear.app'], slots: ['api_key'] });

  const convCtx = makeAgentContext({ sessionId: 's', agentId: 'agent-1', userId: 'user-1', conversationId: 'cnv-1' });

  // (TASK-35) request_capability raises the card.
  const ack = await bus.call('tool:execute:request_capability', convCtx, {
    name: 'request_capability', input: { skillId: 'linear' },
  });
  expect(ack).toEqual({ status: 'requested', skillId: 'linear' });

  // (TASK-36) apply the grant over the real per-user attach store.
  const grant = await bus.call('agent:apply-capability-grant', convCtx, {
    conversationId: 'cnv-1', userId: 'user-1', agentId: 'agent-1', skillId: 'linear',
  });
  expect(grant).toEqual({ attached: true });

  const after = await bus.call('skills:list-user-attachments', convCtx, { userId: 'user-1', agentId: 'agent-1' });
  expect((after as { attachments: Array<{ skillId: string; credentialBindings: Record<string, string> }> }).attachments)
    .toContainEqual({ skillId: 'linear', credentialBindings: { api_key: 'skill:linear:api_key' } });

  // A fresh agent:invoke for this user/agent re-spawns and MUST carry the skill.
  // (The file's harness exposes the captured sandbox:open-session input; adapt
  // to its existing capture mechanism.)
  const opened = await openFreshAndCaptureInstalledSkills({ userId: 'user-1', agentId: 'agent-1', conversationId: 'cnv-2' });
  expect(opened.map((s) => s.id)).toContain('linear');
});
```

(`upsertGlobalSkill` / `openFreshAndCaptureInstalledSkills` are the file's existing mechanisms — adapt to whatever capture the canary already uses for `installedSkills`. The goal: prove the attach lands in the real store **and** a fresh open's union includes it. Import `makeAgentContext` from `@ax/core` if absent. The skill's `api_key` credential need not actually exist for this assertion — attach validates binding *presence*, and the captured open is a mock that doesn't run the proxy resolve.)

- [ ] **Step 2: Run the canary**

Run: `pnpm -F @ax/skills test -- src/__tests__/e2e/skill-install.canary.test.ts`
Expected: PASS.

- [ ] **Step 3: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. `pnpm build` (tsc project refs) catches the new orchestrator I/O types not threading through `plugin.ts`, the new channel-web route handler shape, and any undeclared workspace dep vitest tolerates. `pnpm lint` catches an accidental cross-plugin import (`no-restricted-imports`) in `@ax/chat-orchestrator`/`@ax/channel-web`, and a raw color / non-shadcn primitive if `PermissionCard.tsx` drifted. Bug-fix-test policy: any bug found here gets a regression test before the fix is considered done.

- [ ] **Step 4: Run the `security-checklist` skill (pre-PR gate)**

Invoke the `security-checklist` skill and answer all three threat models against the [pre-stated model](#security-threat-model-pre-stated). Confirm: the grant widens only the user's own sandbox by exactly the vetted skill's declared hosts/slots (re-spawn recomputes the allowlist/creds — no new sandbox primitive); the credential the user typed never enters the model/transcript/SSE/this hook's payload (TASK-35 wrote it to the host store; the hook only binds the ref); the re-spawn is user-gated by the card (decision #6) and attaches only a catalog skill (`skills:attach-for-user` throws `skill-not-found` otherwise); the decision endpoint is auth-gated + ACL'd + CSRF-guarded + scoped to the actor's own conversation; the new hook is host-side only (no IPC widening); no new third-party dependency. Paste the structured note into the PR.

- [ ] **Step 5: Commit + open the PR**

```bash
git add packages/skills/src/__tests__/e2e/skill-install.canary.test.ts
git commit -m "test(skills): canary — approve → apply-capability-grant → fresh re-spawn includes the skill"
```

PR description MUST include:
- **Boundary review** (new hook `agent:apply-capability-grant`): *Alternate impl* — re-spawn backend (terminate → fresh resume) today, hot-reload backend tomorrow (no terminate); the hook abstracts "activate a just-granted capability + let the conversation continue." *Fields* — `{ conversationId, userId, agentId, skillId }` / `{ attached }`, domain ids only, no backend vocabulary, **no secret**. *Subscriber risk* — none (single-impl service hook). *Wire surface* — **NOT an IPC action** (host-side; channel-web → orchestrator); the agent→host wire surface does not widen.
- **Half-wired window** (see below) — this card CLOSES TASK-34/35's open windows; the curated happy path is now fully wired + canary-proven.
- The `security-checklist` structured note.

---

## Security threat model (pre-stated)

The `security-checklist` skill is a **pre-PR gate** (Task 6 Step 4). Starting model:

- **Sandbox / re-spawn (the flagged surface).** `agent:apply-capability-grant` attaches a catalog skill and `session:terminate`s the conversation's warm session; the answer turn re-opens a **fresh** sandbox via the *existing* `sandbox:open-session` path — **no new sandbox primitive, no new IPC action**. The newly-attached catalog skill materializes read-only via TASK-32's bundle contract (path-safe + no-exec-bit + veto-list at the extract boundary, unchanged here). The re-spawn recomputes the proxy allowlist + credentials from the unioned skills exactly as any fresh open does; the only widening is the user's **own** already-isolated sandbox gaining exactly the hosts/slots the **vetted** skill declares (design decision #3 — always the user's own call, their own session). `runner_session_id` (resume pointer) is unaffected by terminate, so the re-spawn rehydrates the user's own transcript and nothing else.
- **Credential trust path (invariant).** The key the user typed posted **straight to the host credential store** at `skill:<id>:<slot>` (TASK-35, user-scoped, encrypted, CSRF-guarded), never through the model/transcript/SSE. This hook only **binds the ref** (`slot → skill:<id>:<slot>`) into the attachment; the re-spawn's proxy resolves it to an `ax-cred:` placeholder, so the secret never enters the sandbox in plaintext, the model, the transcript, or this hook's payload (which carries ids only).
- **Prompt injection / untrusted content steering the re-spawn (the flagged threat).** The re-spawn is gated by the **user clicking Connect** (the §6/decision-#6 backstop). Injected content can at most make the agent call `request_capability` for a **real** catalog skill — the user sees the declared hosts + slot names on the card before approving, and `skills:attach-for-user` resolves the id against the catalog (`skill-not-found` otherwise), so a card can never request a host/slot absent from a vetted skill's manifest. The "synthetic continue" is the **user's own original turn re-issued via `regenerate()`** — not attacker-controlled, not a new injected instruction. The decision endpoint is `auth:require-user`-gated + `agents:resolve`-ACL'd + CSRF-guarded (`x-requested-with: ax-admin`) + scoped to the actor's own conversation (resolved via `conversations:get`), so a grant never crosses to another user or agent.
- **Sandbox / capability leakage.** The new hook is **host-side only** — the agent/runner cannot call it (no IPC action added). It grants exactly: attach one catalog skill for one `(user, agent)` + terminate that conversation's own warm session.
- **Supply chain.** No new third-party dependency: the changes are workspace-only across `@ax/chat-orchestrator`, `@ax/channel-web`, `@ax/agent-claude-sdk-runner`, and `@ax/skill-broker`. (Confirm the `pnpm-lock.yaml` diff shows no new registry packages.)

## Half-wired window

Stated explicitly per hard requirement #5:

1. **This card CLOSES the prior open windows.** TASK-34 left `request_capability`'s downstream open ("nothing pauses → re-spawns → resumes + installs"); TASK-35 left the card collecting credentials but not attaching/re-spawning. **TASK-36 closes both**: the card's Connect now attaches the skill (`skills:attach-for-user`, TASK-33), retires the warm session (`agent:apply-capability-grant`), and re-issues the turn (`regenerate()`) so the agent answers with the skill present. The curated happy path — broker → card → approve → re-spawn → resume → answer — is **fully wired and reachable from the canary**, and exercised end-to-end up to the answer turn (the live model answer is the manual-acceptance `(walk)` per design §14, not part of this `yolo-ship` PR).
2. **What remains open is owned by OTHER named cards** (not half-wired *by* TASK-36): the **reactive-wall** ad-hoc-host path (`proxy:add-host`) is **TASK-37** — note the *skill-install* path here already allowlists the skill's declared hosts via the re-spawn (the union recomputes them), so TASK-36 needs no `proxy:add-host`; the **`allow_user_installed_skills`** flag is **TASK-38**; **open-mode authoring** is **TASK-39**; the **service-keyed vault** (P2), **settings mirror** (P3), and **admit-to-catalog** (§6D) are Part II.
3. **Known residual (graceful degradation, not a window).** Because the answer turn is the user's original turn re-issued via `regenerate()`, the server jsonl ends with the original ask twice (resumed copy + re-issue) plus the brokering tool-call turn — so a **reload** shows the ask twice. The *live* experience reads as one continuous answer (only the assistant answer streams; `regenerate` replaces the brokering bubble in place). A follow-up could drop the brokering turn via `conversations:drop-turn`; out of scope here.

`agent:apply-capability-grant`, the decision endpoint, the resume seam, the card evolution, and the prompt tuning are all **fully wired** end-to-end (broker → card → grant → attach → fresh re-spawn includes the skill), proven by the canary over the real Postgres catalog.

---

## Self-Review

**Spec coverage** (against design §7 turn/re-spawn mechanics, §11.5 component #5, §13 error handling, decision #6, and the card body):

- "Hold the brokering turn as pending (broker tool yields without committing a final assistant turn)" → resolved against the as-built frozen-at-spawn runner: the brokering turn ends without *answering* (the agent stops after `request_capability`); the prompt tuning (Task 5) keeps it from narrating. Fork #1 documents why a literal mid-tool pause is impossible and unnecessary. ✓
- "On approval: install/attach/bind → re-spawn → resume() → answer the still-pending original message" → Task 1 (attach + bind via `skills:attach-for-user`; retire warm session) + Task 2 (decision endpoint) + Tasks 3/4 (re-issue via `regenerate()` → orchestrator fresh path → `options.resume`). ✓
- "Tune the card + system prompt so the agent doesn't narrate; synthetic continue stays hidden; degrades gracefully" → Task 5 (system prompt + tool description). The synthetic continue is the re-issued user turn (not streamed → hidden live); the visible "approve and I'll continue" degradation is the brokering turn's own text if the model narrates. Fork #3 documents the reload residual. ✓
- "Re-spawn failure surfaces via chat:turn-error → SSE (§13)" → the answer turn is a normal `agent:invoke`, so a failed fresh open already fires `chat:turn-error` → the SSE error frame → the retry banner (existing path, runtime.tsx); Task 6 Step 3's full build/test keeps it green (no new code needed). ✓
- "Depends on TASK-34 + TASK-35" → Task 4 extends TASK-35's card; the dep gate + the as-built re-verification section handle merge ordering (deps were NOT on `main` at authoring time — re-verify before Task 1). ✓
- "Security-checklist (sandbox re-spawn + credentials + untrusted steering)" → pre-PR gate (Task 6 Step 4) + pre-stated threat model. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. The harness-bound steps (the orchestrator test reuses `createTestHarness` + the `buildMocks`/`ctx` pattern from `route-by-conversation.test.ts`; the channel-web route + card tests reuse the files' existing harnesses; the canary reuses the file's upsert + open-capture helpers) name the existing helpers and provide concrete assertions — matching the template's harness-bound canary task. No TBD/TODO in shipped code. ✓

**Type consistency:** the new hook is `agent:apply-capability-grant({ conversationId, userId, agentId, skillId }) → { attached: boolean }` at every hop — `ApplyCapabilityGrantInput`/`Output` (orchestrator), the `plugin.ts` registration generic, the channel-web endpoint's `bus.call` generic, and the canary assertion. `credentialBindings` is `Record<string,string>` mapping `slot → \`skill:<id>:<slot>\`` consistently in Task 1, the canary, and matching `skills:attach-for-user`'s TASK-33 shape. The decision endpoint body is `{ conversationId, skillId }` in the route schema, the card POST, and the route test. `resumeActions.registerRegenerate`/`continueAfterGrant` match between the store, the runtime registration, and the card call.

**Known residual / forks (resolved):** (1) re-spawn = retire-warm-session + re-issue-turn (no SDK pause primitive — runner is frozen at spawn); (2) client `regenerate()` reuses the existing retry machinery rather than new server-driven-stream client code; (3) the reload shows the original ask twice (the live experience is seamless) — a `conversations:drop-turn` follow-up could clean it; (4) the card requires every declared slot filled before Connect (a skill becomes *usable* only with its keys), tightening TASK-35's blank-slot allowance for the re-spawn path. The `runnerSessionId`-not-yet-bound race (user approves before the brokering turn commits) is handled by the orchestrator's route-vs-fresh `session:is-alive` (still re-spawns) — degraded to a fresh-without-resume only in the sub-second window before the jsonl commits, where the re-issued original turn still carries the ask.
