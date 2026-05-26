# JIT Bundled Approval Card + `chat:permission-request` SSE Frame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the one bundled approval card in chat — the open-mode security boundary (design decision #6) — by adding a `chat:permission-request` subscriber hook that `@ax/skill-broker`'s `request_capability` fires, an SSE frame that carries it to the browser (mirroring the `chat:turn-error → SSE` pattern from PR #137), and a shadcn card whose secure credential field posts **straight to the host credential store** (reusing the existing user-scoped destination route) — never through the model or transcript.

**Architecture:** When the agent calls `request_capability(skillId)` (TASK-34) and the id resolves in the global catalog, the broker reads the skill's declared hosts + credential slots from `skills:get` and **fires `chat:permission-request`** with `{ skillId, description, hosts, slots }` — public manifest data only, never a secret. `@ax/channel-web`'s per-connection SSE handler subscribes to that hook, matches by **`ctx.conversationId`** (the firing ctx is a runner-driven IPC ctx with a *fresh* reqId but the *real* conversationId — see `ipc-server/listener.ts`), and emits a new non-terminal `permissionRequest` SSE frame. The client transport routes that frame into a `permission-card-store` (the same `useSyncExternalStore` shape as `agent-status-store`); a `<PermissionCard>` mounted above the composer renders the hosts + one password field per slot. **Connect** posts each entered key via the existing `setDestinationCredential` helper to `POST /settings/destinations/skill-slot/credential` (scope forced to `user`, ref `skill:<id>:<slot>`, resolved to an `ax-cred:` placeholder by the proxy) and dismisses; **Not now** dismisses. No new credential route, no new IPC action.

**Tech Stack:** TypeScript, pnpm workspace, tsconfig project refs, the in-process hook bus (`bus.fire`/`bus.subscribe`), React + `@assistant-ui/react`, shadcn primitives (`Card`/`Button`/`Input`/`Label`/`Alert`/`Badge`) in `packages/channel-web`, vitest + `@testing-library/react` (jsdom), kysely + Postgres (testcontainers in the canary).

---

## Scope guardrails

- **One new subscriber hook: `chat:permission-request`** (fired by `@ax/skill-broker`, consumed by `@ax/channel-web`'s SSE handler). Boundary-review note (confirming design §11.3): *Alternate impl* — a non-web channel (CLI/Slack) renders the same approval payload as a prompt instead of a card; the payload is channel-agnostic. *Payload fields* — `{ skillId, description, hosts: string[], slots: { slot, kind: 'api-key' }[] }`: `hosts` are hostnames already public in manifests, `slots` are slot **names** (never values), `description`/`skillId` are public manifest fields — **no** `sha`/`pod`/`socket`/`bucket`/`generation`/row vocabulary, and **no secret ever rides this frame**. *Subscriber risk* — none backend-specific; channel-web renders it, a future audit subscriber could log it (only public fields). *Wire surface* — **NOT an IPC action**: it is an in-process host subscriber hook (like `chat:turn-error` / `chat:phase`); the agent never reaches it, and the credential write rides the **already-shipped** `/settings/destinations/skill-slot/credential` route. Firing a subscriber hook needs **no** manifest declaration (the orchestrator fires `chat:turn-error` undeclared); channel-web adds `chat:permission-request` to its `subscribes` list for visibility only.
- **No cross-plugin imports (invariant I2).** `@ax/skill-broker` stays import-clean (`@ax/core` only): it reads the `skills:get` result through the bus and mirrors the `SkillDetail` subset it needs **locally**. `@ax/channel-web` re-declares the `PermissionRequest` payload **locally** in its server `types.ts` (same duplication-with-a-comment posture as `StreamChunk` vs `@ax/ipc-protocol`); its only `@ax/credentials` touch is an erased `import type { Destination }` (already present in `lib/credentials.ts`). The credential write is re-validated independently at the credential route's trust boundary (it forces scope/owner and derives the ref itself).
- **One source of truth (invariant I4).** The card writes the user's key to **one** place — the host credential store, via the **existing** destination route — which is also the settings "My Keys" home (the design's mirror property, P6). No second credential store. The catalog/manifest stays owned by `@ax/skills`; the broker forwards, it does not copy.
- **Capabilities minimized (invariant I5).** The card frame carries only public manifest data; the secret never enters the model, the transcript, or the SSE frame. The SSE route already ACLs to the conversation's owner (auth + `conversations:get-by-req-id` + `agents:resolve`), so a card reaches only the user whose conversation raised it.
- **Security-checklist applies** (credential handling + untrusted content steering the card) — it is a **pre-PR gate** (Task 6 Step 4). Pre-stated threat model in [Security threat model](#security-threat-model-pre-stated) below.
- **UI uses the `shadcn` skill** (invariant #6). Before Task 5, invoke the `shadcn` skill; compose installed primitives with semantic tokens (`text-muted-foreground`, `bg-background`, …) — no raw colors, no hand-rolled `<div>` forms. Workspace flag `-c packages/channel-web`.
- **Half-wired window (stated):** see [Half-wired window](#half-wired-window) — approving the card collects credentials (real) but does not yet allowlist hosts / attach / re-spawn / resume.

## Dependency status & as-built re-verification (READ FIRST)

This card **Depends on TASK-34** (broker tool + `skills:search-catalog`), which depends on **TASK-33** (per-user attach) → **TASK-32** (bundle model). `yolo-ship` only pulls this card once **TASK-34 is Done**, so by execution time TASK-32/33/34 are merged to `main`. This plan was written against design §6A/§10/§11.3 + decisions #5/#6 + the committed TASK-34 impl plan + the **pre-32/33/34** as-built code. Before Task 1, **re-confirm against `main`** (hard requirement #1 — do not trust file:line anchors) and adjust if any of these moved:

- [ ] **`packages/skill-broker/src/tools/request-capability.ts` exists** (TASK-34) and its handler returns `{ status: 'requested' | 'not-found', skillId }`, validating `skillId` against `SKILL_ID_RE` and calling `bus.call('skills:get', toolCtx, { skillId, scope: 'global' })`, translating `skill-not-found` → `{ status: 'not-found' }`. (This plan *extends* that handler; if TASK-34 shipped a different shape, adapt the diff.)
- [ ] **`skills:get` (scope `'global'`) returns a `SkillDetail`** whose `capabilities.allowedHosts: string[]` and `capabilities.credentials: { slot: string; kind: 'api-key' }[]` are populated (`packages/skills/src/plugin.ts` returns `store.get(skillId)`; `SkillDetail extends SkillSummary` which carries `capabilities: SkillCapabilities` — `packages/skills/src/types.ts`). The card reads exactly these two arrays + `description`.
- [ ] **`AgentContext.conversationId` is OPTIONAL but stamped for real chat turns** (`packages/core/src/context.ts`), and the IPC listener stamps it onto the per-request ctx from the auth result (`packages/ipc-server/src/listener.ts` — "stamp the resolved conversationId"). The runner-driven IPC request that dispatches `tool:execute:request_capability` therefore carries a **fresh reqId** but the **real conversationId**. (This is why the SSE match is by `conversationId`, not `reqId`.)
- [ ] **`packages/channel-web/src/server/types.ts` `SseFrame`** is the union `StreamChunk | {reqId,phase} | {reqId,done:true} | {reqId,error}` and **`sse.ts`** attaches per-connection subscribers in `createSseHandler` (the `chat:turn-end` one matches `ctx.conversationId === conversationId`; the `chat:turn-error` one matches `payload.reqId`). The plugin manifest `subscribes` array is at `packages/channel-web/src/server/plugin.ts` (~line 99).
- [ ] **`setDestinationCredential(...)`** in `packages/channel-web/src/lib/credentials.ts` still POSTs `{ destination, scope, ownerId, kind, payloadB64 }` to `/settings/destinations/${destination.kind}/credential` for `scope.scope === 'user'`, with headers `{ 'content-type': 'application/json', 'x-requested-with': 'ax-admin' }` and `credentials: 'include'`; and the server route `POST /settings/destinations/:destinationKind/credential` (`packages/credentials-admin-routes/src/destination-routes.ts`) still forces `scope='user'` + `ownerId=actor.id` and derives ref `skill:<skillId>:<slot>` for `destination.kind === 'skill-slot'`. (`@ax/credentials-admin-routes` is wired in `presets/k8s/src/index.ts`.)
- [ ] **`packages/channel-web/src/lib/transport.ts`** has a client-local `SseFrame` type (~line 104) and a per-line frame switch (~line 637) that dispatches `phase` frames to `agentStatusActions.set(...)` — the model for the new `permissionRequest` branch. Transport tests use the `sseStream(body)` + `drain(...)` + `processResponseStream` harness (`packages/channel-web/src/__tests__/transport.test.ts`).
- [ ] **The store pattern** is `useSyncExternalStore` + an in-module `state`/`listeners`/`actions` object (`packages/channel-web/src/lib/agent-status-store.ts`), and `<AgentStatus />` is mounted inside `ComposerPrimitive.Root` in `packages/channel-web/src/components/Composer.tsx` (~line 139). The new `<PermissionCard />` mounts immediately above it.
- [ ] **shadcn `card.tsx` exports** `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` (`packages/channel-web/src/components/ui/card.tsx`), and `badge.tsx` exports `Badge`. If a subcomponent is missing, add it via the shadcn CLI (`pnpm dlx shadcn@latest add card -c packages/channel-web`) rather than hand-rolling.

> **Implementation forks resolved (hard requirement #7):**
>
> 1. **Who fires `chat:permission-request`, and what is the match key** → **`@ax/skill-broker`'s `request_capability` fires it**, and **`@ax/channel-web` matches by `ctx.conversationId`**. Rationale: the card is "what `request_capability` raises" (card body); the broker already validates the skill via `skills:get`, so reading its hosts/slots and firing is the minimal extension. The broker's runner-driven IPC ctx has a *fresh* reqId (verified in `ipc-server/listener.ts`), so reqId can't be the key; it does carry the real `conversationId`, and there is exactly one active turn per conversation, so conversation is the correct grain. Unlike `chat:turn-error` (which matches by reqId precisely because it *closes* a co-resident stream), the card is **non-terminal** — surfacing it on the conversation's stream is safe. This is a product-neutral plumbing call.
> 2. **What "Connect/Not now" does this phase** → **Connect writes the entered key(s) to the user's credential store (real, via the existing route) and dismisses the card; Not now dismisses.** It does **not** widen the host allowlist, attach the skill, or re-spawn/resume the turn — those are TASK-37 (`proxy:add-host`) and TASK-36 (resume + `skills:attach-for-user`), which own the turn mechanics and need the original reqId the broker doesn't have. This mirrors TASK-34's precedent (build the surface + return/collect the minimum; the orchestration consumer lands in the named later task) and keeps TASK-35 from guessing TASK-36's pending-turn payload. The credential trust path (§10) — the security-critical, hard-to-get-right part — is fully built and tested here.
> 3. **No decision endpoint / no second hook this phase** → TASK-35 introduces exactly one hook (`chat:permission-request`) and reuses the existing credential route; it deliberately does **not** add a decision/resume endpoint or a `chat:permission-decision` hook. Rationale (boundary-review rule): don't promote a decision to a hook before its consumer exists — TASK-36 adds the resume *together with* the endpoint that drives it, so no dead endpoint/no-subscriber hook ships here.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/skill-broker/src/tools/request-capability.ts` | `request_capability` host tool | **change** — read `skills:get` capabilities + `bus.fire('chat:permission-request', …)` |
| `packages/skill-broker/src/__tests__/plugin.test.ts` | broker unit tests | **extend** — stub returns capabilities; assert the card fires |
| `packages/channel-web/src/server/types.ts` | `SseFrame` union + payload types | **add** `PermissionRequest` + `{reqId, permissionRequest}` frame |
| `packages/channel-web/src/server/sse.ts` | per-connection SSE handler | **add** `chat:permission-request` subscriber (conv-matched) → frame |
| `packages/channel-web/src/server/plugin.ts` | manifest + boot wiring | **add** `'chat:permission-request'` to `subscribes` |
| `packages/channel-web/src/__tests__/server/sse.test.ts` | SSE handler tests | **extend** — card emits a frame, conv-scoped, non-terminal |
| `packages/channel-web/src/lib/permission-card-store.ts` | **new** — pending-card store (`useSyncExternalStore`) | **create** |
| `packages/channel-web/src/__tests__/permission-card-store.test.ts` | store unit tests | **create** |
| `packages/channel-web/src/lib/transport.ts` | SSE frame parsing → stores | **add** client `permissionRequest` frame variant + dispatch branch |
| `packages/channel-web/src/__tests__/transport.test.ts` | transport tests | **extend** — a card frame drives the store |
| `packages/channel-web/src/components/PermissionCard.tsx` | **new** — the bundled approval card (shadcn) | **create** |
| `packages/channel-web/src/__tests__/permission-card.test.tsx` | card render/POST tests | **create** |
| `packages/channel-web/src/components/Composer.tsx` | composer chrome | **mount** `<PermissionCard />` above `<AgentStatus />` |
| `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` | end-to-end canary | **extend** — `request_capability` fires the card over the real catalog |

---

## Shared rule: the `PermissionRequest` payload (referenced by Tasks 1, 2, 3, 4, 5)

The card payload is the same object at every hop, re-declared **locally** at each plugin boundary (invariant I2 — no shared import), structurally aligned:

```typescript
interface PermissionRequest {
  skillId: string;                                   // catalog id (validated upstream)
  description: string;                               // human prose from the manifest
  hosts: string[];                                   // hostnames the skill reaches (public)
  slots: { slot: string; kind: 'api-key' }[];        // credential SLOT NAMES — never values
}
```

It carries **no secret** — the key the user types posts straight to the credential store on a separate route and never rides this payload, the SSE frame, the model, or the transcript.

---

### Task 1: Broker `request_capability` fires `chat:permission-request`

**Files:**
- Modify: `packages/skill-broker/src/tools/request-capability.ts`
- Test: `packages/skill-broker/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/skill-broker/src/__tests__/plugin.test.ts`, extend the `busWithStubs()` helper's `skills:get` stub (added in TASK-34) to also return capabilities, then add a describe block. First, the stub change:

```typescript
// inside busWithStubs(), replace the skills:get stub body for the 'linear' case:
bus.registerService('skills:get', 'skills', async (_c, input: unknown) => {
  const skillId = (input as { skillId: string }).skillId;
  if (skillId === 'linear') {
    return {
      id: 'linear',
      description: 'Read your Linear issues',
      capabilities: {
        allowedHosts: ['api.linear.app'],
        credentials: [{ slot: 'api_key', kind: 'api-key' }],
      },
    } as never;
  }
  throw new PluginError({ code: 'skill-not-found', plugin: 'skills', message: 'nope' });
});
```

Then the new cases (the test ctx must carry a conversationId so the fire forwards it):

```typescript
import { makeAgentContext } from '@ax/core';

const convCtx = makeAgentContext({
  sessionId: 's', agentId: 'a', userId: 'u', conversationId: 'cnv_1',
});

describe('request_capability — bundled approval card', () => {
  it('fires chat:permission-request with the skill manifest hosts + slots', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });

    const cards: Array<{ skillId: string; description: string; hosts: string[]; slots: { slot: string; kind: string }[] }> = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p as never);
      return undefined;
    });

    const ack = await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });

    expect(ack).toEqual({ status: 'requested', skillId: 'linear' });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual({
      skillId: 'linear',
      description: 'Read your Linear issues',
      hosts: ['api.linear.app'],
      slots: [{ slot: 'api_key', kind: 'api-key' }],
    });
  });

  it('raises NO card when the skill is not in the catalog', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const cards: unknown[] = [];
    bus.subscribe('chat:permission-request', 'test/capture', async (_c, p) => {
      cards.push(p);
      return undefined;
    });
    const out = await bus.call('tool:execute:request_capability', convCtx, {
      name: 'request_capability',
      input: { skillId: 'ghost' },
    });
    expect(out).toEqual({ status: 'not-found', skillId: 'ghost' });
    expect(cards).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skill-broker test`
Expected: FAIL — no `chat:permission-request` ever fires (TASK-34 only returned the ack).

- [ ] **Step 3: Read capabilities + fire the card**

In `packages/skill-broker/src/tools/request-capability.ts`, add the local detail type near the top (no `@ax/skills` import — I2):

```typescript
// Mirrors the subset of @ax/skills' SkillDetail the broker reads. Re-declared
// locally — the broker reaches the catalog only through the bus (I2). Kept
// structurally in sync with SkillDetail.capabilities by the broker tests.
interface CatalogSkillDetail {
  id: string;
  description: string;
  capabilities: {
    allowedHosts: string[];
    credentials: { slot: string; kind: 'api-key' }[];
  };
}

// The bundled approval card payload. Carries only public manifest data — never
// a secret (the card's key field posts straight to the credential store). The
// matching SSE-frame + render side re-declares this shape in @ax/channel-web.
interface PermissionRequestEvent {
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
}
```

Then change the `skills:get` call to keep the returned detail, and fire the card before returning (replace the existing try/catch + return):

```typescript
let detail: CatalogSkillDetail;
try {
  detail = await bus.call<{ skillId: string; scope: 'global' }, CatalogSkillDetail>(
    'skills:get',
    toolCtx,
    { skillId, scope: 'global' },
  );
} catch (err) {
  if (err instanceof PluginError && err.code === 'skill-not-found') {
    return { status: 'not-found', skillId };
  }
  throw err;
}

// Surface the ONE bundled approval card (design §11.3, decision #6). Public
// manifest data only — request_capability still returns the minimum to the
// model (it must NOT narrate hosts/keys; §7). Match key is the conversation
// (toolCtx carries the real conversationId; reqId is IPC-restamped). Firing a
// subscriber hook needs no manifest declaration.
const card: PermissionRequestEvent = {
  skillId,
  description: detail.description,
  hosts: detail.capabilities.allowedHosts,
  slots: detail.capabilities.credentials.map((c) => ({ slot: c.slot, kind: 'api-key' as const })),
};
await bus.fire('chat:permission-request', toolCtx, card);

return { status: 'requested', skillId };
```

(Keep the `RequestCapabilityResult` return type and the `SKILL_ID_RE` shape-validation from TASK-34 unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skill-broker test`
Expected: PASS (whole broker package green).

- [ ] **Step 5: Commit**

```bash
git add packages/skill-broker/src/tools/request-capability.ts packages/skill-broker/src/__tests__/plugin.test.ts
git commit -m "feat(skill-broker): request_capability raises the chat:permission-request card"
```

---

### Task 2: channel-web server — `permissionRequest` SSE frame + subscriber

**Files:**
- Modify: `packages/channel-web/src/server/types.ts`, `packages/channel-web/src/server/sse.ts`, `packages/channel-web/src/server/plugin.ts`
- Test: `packages/channel-web/src/__tests__/server/sse.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/channel-web/src/__tests__/server/sse.test.ts` (reuse the file's `bootHandler()`, `fakeReq()`, `fakeRes()`, and `ctxWithConversation()` helpers; the default conversation is `cnv_test`):

```typescript
describe('permission-request frame', () => {
  it('emits a card frame for THIS conversation and keeps the stream open', async () => {
    const { bus, initCtx, handler } = bootHandler();
    const { res, captured } = fakeRes();
    await handler(fakeReq({ reqId: 'r-test' }), res);

    await bus.fire(
      'chat:permission-request',
      ctxWithConversation(initCtx, 'cnv_test'),
      {
        skillId: 'linear',
        description: 'Read your Linear issues',
        hosts: ['api.linear.app'],
        slots: [{ slot: 'api_key', kind: 'api-key' }],
      },
    );

    const frames = captured.streamWrites
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
    const card = frames.find((f) => 'permissionRequest' in f);
    expect(card).toMatchObject({
      reqId: 'r-test',
      permissionRequest: {
        skillId: 'linear',
        hosts: ['api.linear.app'],
        slots: [{ slot: 'api_key', kind: 'api-key' }],
      },
    });
    // The card is NON-terminal — unlike turn-error it must not close us.
    expect(captured.streamClosed).toBe(false);
  });

  it('does NOT deliver a card raised on a different conversation', async () => {
    const { bus, initCtx, handler } = bootHandler();
    const { res, captured } = fakeRes();
    await handler(fakeReq({ reqId: 'r-test' }), res);

    await bus.fire(
      'chat:permission-request',
      ctxWithConversation(initCtx, 'cnv_OTHER'),
      { skillId: 'linear', description: 'd', hosts: [], slots: [] },
    );

    const frames = captured.streamWrites
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);
    expect(frames.some((f) => 'permissionRequest' in f)).toBe(false);
    expect(captured.streamClosed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/sse.test.ts`
Expected: FAIL — nothing subscribes to `chat:permission-request`, so no frame is written.

- [ ] **Step 3: Add the frame + payload type**

In `packages/channel-web/src/server/types.ts`, add the payload interface (above `SseFrame`):

```typescript
/**
 * Payload for the `chat:permission-request` subscriber hook AND the inner
 * object of the matching SSE frame. The JIT bundled approval card (design
 * §11.3): the skill id, its description, the hosts it would reach, and the
 * credential SLOT NAMES it declares. NEVER a secret value — the card's key
 * field posts straight to the host credential store (the §10 trust path), so
 * no credential ever rides this frame or the transcript. Backend-agnostic
 * (Invariant I1): hostnames + slot names are public manifest fields.
 *
 * Re-declared here (not imported from @ax/skill-broker) — same cross-plugin
 * duplication-with-a-comment posture as StreamChunk vs @ax/ipc-protocol (I2).
 */
export interface PermissionRequest {
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
}
```

Extend the `SseFrame` union with the new non-terminal variant (and add a doc line next to the others):

```typescript
export type SseFrame =
  | StreamChunk
  | { reqId: string; phase: PhaseKind }
  | { reqId: string; done: true }
  | { reqId: string; error: string }
  | { reqId: string; permissionRequest: PermissionRequest };
```

- [ ] **Step 4: Attach the per-connection subscriber in `sse.ts`**

In `packages/channel-web/src/server/sse.ts`, import the payload type:

```typescript
import type { PermissionRequest, PhaseEvent, SseFrame, StreamChunk } from './types.js';
```

Add a subscriber key next to the others (~line 179) and unsubscribe it in `cleanup()` (~line 193):

```typescript
const permissionSubKey = `${PLUGIN_NAME}/sse-permission/${subscriberSuffix}`;
// ...inside cleanup():
deps.bus.unsubscribe('chat:permission-request', permissionSubKey);
```

After the `chat:turn-error` subscriber block (4c-bis), add:

```typescript
// 4c-ter) Attach the permission-request subscriber. @ax/skill-broker's
// request_capability fires `chat:permission-request` mid-turn to surface the
// bundled approval card (design §11.3). Match by ctx.conversationId — the
// firing ctx is the runner-driven IPC ctx (a FRESH reqId, but the REAL
// conversationId; see ipc-server/listener.ts), so reqId can't be the key here.
// One active turn per conversation makes the conversation the right grain. The
// card is NON-terminal: emit it and KEEP the stream open (unlike turn-error,
// which closes). We stamp the connection's own reqId onto the frame envelope.
deps.bus.subscribe<PermissionRequest>(
  'chat:permission-request',
  permissionSubKey,
  async (ctx, payload) => {
    if (ctx.conversationId !== conversationId) return undefined;
    safeWrite({ reqId, permissionRequest: payload });
    return undefined;
  },
);
```

- [ ] **Step 5: Declare the subscriber in the manifest**

In `packages/channel-web/src/server/plugin.ts`, add `'chat:permission-request'` to the `subscribes` array (~line 99) and to the `subscribes:` comment (~line 46). No boot-level subscriber is added (the subscription is per-connection only, cleaned up in `createSseHandler`'s `cleanup()`):

```typescript
subscribes: ['chat:stream-chunk', 'chat:phase', 'chat:turn-end', 'chat:turn-error', 'chat:permission-request', 'conversations:title-updated'],
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/server/sse.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/channel-web/src/server/types.ts packages/channel-web/src/server/sse.ts \
  packages/channel-web/src/server/plugin.ts packages/channel-web/src/__tests__/server/sse.test.ts
git commit -m "feat(channel-web): chat:permission-request → non-terminal SSE card frame"
```

---

### Task 3: Client `permission-card-store`

**Files:**
- Create: `packages/channel-web/src/lib/permission-card-store.ts`
- Test: `packages/channel-web/src/__tests__/permission-card-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/channel-web/src/__tests__/permission-card-store.test.ts`:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import {
  getPermissionCardSnapshot,
  permissionCardActions,
} from '../lib/permission-card-store';

const sample = {
  skillId: 'linear',
  description: 'Read your Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' as const }],
};

describe('permission-card-store', () => {
  afterEach(() => permissionCardActions.reset());

  it('starts with no pending request', () => {
    expect(getPermissionCardSnapshot().request).toBeNull();
  });

  it('show() stores the request; dismiss() clears it', () => {
    permissionCardActions.show(sample);
    expect(getPermissionCardSnapshot().request?.skillId).toBe('linear');
    permissionCardActions.dismiss();
    expect(getPermissionCardSnapshot().request).toBeNull();
  });

  it('show() notifies subscribers', () => {
    let hits = 0;
    const unsub = permissionCardActions.subscribeForTest(() => {
      hits += 1;
    });
    permissionCardActions.show(sample);
    permissionCardActions.dismiss();
    unsub();
    expect(hits).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card-store.test.ts`
Expected: FAIL — cannot find module `../lib/permission-card-store`.

- [ ] **Step 3: Implement the store**

Create `packages/channel-web/src/lib/permission-card-store.ts` (same `useSyncExternalStore` shape as `agent-status-store.ts`):

```typescript
/**
 * Permission-card store — holds the single pending JIT approval card.
 *
 * The transport routes a `permissionRequest` SSE frame here (design §11.3);
 * `<PermissionCard>` reads it. Lives outside the chat timeline — nothing here
 * is persisted to history, and it never holds a secret (the key the user types
 * stays in the card component's local state and posts straight to the
 * credential store). Same `useSyncExternalStore` shape as agent-status-store.
 */
import { useSyncExternalStore } from 'react';

export interface PermissionRequest {
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
}

export interface PermissionCardState {
  request: PermissionRequest | null;
}

const initial: PermissionCardState = { request: null };

let state: PermissionCardState = initial;
const listeners = new Set<() => void>();

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): PermissionCardState => state;

const notify = (): void => {
  for (const l of listeners) l();
};

const set = (next: PermissionCardState): void => {
  state = next;
  notify();
};

export function usePermissionCardStore(): PermissionCardState {
  return useSyncExternalStore(subscribe, getSnapshot, () => initial);
}

/** Read the current state without subscribing. Use inside effects/tests. */
export const getPermissionCardSnapshot = (): PermissionCardState => state;

export const permissionCardActions = {
  /** Surface a pending card. A new request replaces any prior one. */
  show(request: PermissionRequest): void {
    set({ request });
  },
  /** Clear the card (Connect-complete or Not-now). */
  dismiss(): void {
    set({ request: null });
  },
  /** Test seam — reset between tests. */
  reset(): void {
    set(initial);
  },
  /** Test seam — subscribe without React. */
  subscribeForTest(cb: () => void): () => void {
    return subscribe(cb);
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/permission-card-store.ts packages/channel-web/src/__tests__/permission-card-store.test.ts
git commit -m "feat(channel-web): permission-card store for the JIT approval card"
```

---

### Task 4: Transport routes the `permissionRequest` frame into the store

**Files:**
- Modify: `packages/channel-web/src/lib/transport.ts`
- Test: `packages/channel-web/src/__tests__/transport.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/channel-web/src/__tests__/transport.test.ts` (reuse the file's `sseStream(body)` + `drain(...)` helpers and the existing way it invokes `processResponseStream` — the `StreamFn` cast near the top of the file; mirror however an existing test obtains the callable, e.g. `const run = makeStreamFn();`):

```typescript
import {
  getPermissionCardSnapshot,
  permissionCardActions,
} from '../lib/permission-card-store';

it('a permissionRequest frame drives the permission-card store (non-terminal)', async () => {
  permissionCardActions.reset();
  const body =
    'data: {"reqId":"r1","permissionRequest":{"skillId":"linear","description":"Read your Linear issues","hosts":["api.linear.app"],"slots":[{"slot":"api_key","kind":"api-key"}]}}\n\n' +
    'data: {"reqId":"r1","text":"ok","kind":"text","seq":1}\n\n' +
    'data: {"reqId":"r1","done":true}\n\n';

  // `run` = the file's existing processResponseStream invoker (StreamFn cast).
  const out = await drain(run(sseStream(body)));

  // The card landed in the store...
  expect(getPermissionCardSnapshot().request).toMatchObject({
    skillId: 'linear',
    hosts: ['api.linear.app'],
    slots: [{ slot: 'api_key', kind: 'api-key' }],
  });
  // ...and the stream still produced the trailing content + finish (non-terminal).
  expect(out.some((c) => (c as { type?: string }).type === 'finish')).toBe(true);
  permissionCardActions.reset();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/transport.test.ts`
Expected: FAIL — the frame is ignored; the store stays `null`.

- [ ] **Step 3: Add the client frame variant + dispatch branch**

In `packages/channel-web/src/lib/transport.ts`, import the store action near the other lib imports:

```typescript
import { permissionCardActions } from './permission-card-store';
```

Extend the client-local `SseFrame` union (~line 123) with the new variant:

```typescript
  | { reqId: string; phase: string }
  | { reqId: string; done: true }
  | { reqId: string; error: string }
  | {
      reqId: string;
      permissionRequest: {
        skillId: string;
        description: string;
        hosts: string[];
        slots: { slot: string; kind: 'api-key' }[];
      };
    };
```

In the per-line frame switch, add a branch **immediately after** the `phase` branch (so it is handled out-of-band, before the content-frame seq logic) and `continue` (non-terminal):

```typescript
// permissionRequest frame — out-of-band JIT bundled approval card (§11.3).
// Drives the card store; the stream keeps flowing (non-terminal, like phase).
if ('permissionRequest' in frame && frame.permissionRequest) {
  permissionCardActions.show(frame.permissionRequest);
  continue;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web/src/lib/transport.ts packages/channel-web/src/__tests__/transport.test.ts
git commit -m "feat(channel-web): route the permissionRequest SSE frame into the card store"
```

---

### Task 5: `<PermissionCard>` component + mount in the composer

**Files:**
- Create: `packages/channel-web/src/components/PermissionCard.tsx`
- Modify: `packages/channel-web/src/components/Composer.tsx`
- Test: `packages/channel-web/src/__tests__/permission-card.test.tsx`

> Invoke the **`shadcn`** skill first (invariant #6). Confirm `card.tsx`/`badge.tsx` exports in the re-verification checklist; add any missing primitive via `pnpm dlx shadcn@latest add <name> -c packages/channel-web` rather than hand-rolling.

- [ ] **Step 1: Write the failing test**

Create `packages/channel-web/src/__tests__/permission-card.test.tsx`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PermissionCard } from '../components/PermissionCard';
import {
  getPermissionCardSnapshot,
  permissionCardActions,
} from '../lib/permission-card-store';

const linear = {
  skillId: 'linear',
  description: 'Read your Linear issues',
  hosts: ['api.linear.app'],
  slots: [{ slot: 'api_key', kind: 'api-key' as const }],
};

describe('PermissionCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    permissionCardActions.reset();
  });

  it('renders nothing when no card is pending', () => {
    const { container } = render(<PermissionCard />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the hosts + a key field, and Connect posts the key to the user-scoped store then dismisses', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<PermissionCard />);
    permissionCardActions.show(linear); // re-renders the subscribed component

    expect(await screen.findByText('api.linear.app')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('api_key'), {
      target: { value: 'lin_test_123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith(
      '/settings/destinations/skill-slot/credential',
      expect.objectContaining({
        method: 'POST',
        // base64('lin_test_123') === 'bGluX3Rlc3RfMTIz'
        body: expect.stringContaining('"payloadB64":"bGluX3Rlc3RfMTIz"'),
      }),
    );
    // The POST routed to the USER scope (/settings, not /admin).
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/settings/destinations/skill-slot/credential');
  });

  it('Not now dismisses without writing any credential', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<PermissionCard />);
    permissionCardActions.show(linear);
    fireEvent.click(await screen.findByRole('button', { name: /not now/i }));
    await waitFor(() => expect(getPermissionCardSnapshot().request).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: FAIL — cannot find module `../components/PermissionCard`.

- [ ] **Step 3: Implement the card**

Create `packages/channel-web/src/components/PermissionCard.tsx` (composes installed shadcn primitives + semantic tokens; reuses the `setDestinationCredential` helper — the §10 trust path):

```tsx
import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { setDestinationCredential } from '@/lib/credentials';
import {
  permissionCardActions,
  usePermissionCardStore,
} from '@/lib/permission-card-store';

/**
 * The ONE bundled approval card (JIT design §11.3, decision #6) — the open-mode
 * security boundary. Surfaced by a `chat:permission-request` SSE frame; shows
 * the hosts the skill reaches and one field per credential slot. The key never
 * touches the model or transcript: it posts straight to the host credential
 * store via the user-scoped destination route (`skill:<id>:<slot>`, §10).
 *
 * Half-wired this phase: Connect collects credentials + dismisses; it does not
 * yet allowlist hosts (TASK-37), attach the skill, or re-spawn/resume the turn
 * (TASK-36).
 */
export function PermissionCard() {
  const { request } = usePermissionCardStore();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!request) return null;

  function close(): void {
    setValues({});
    setError(null);
    permissionCardActions.dismiss();
  }

  async function connect(): Promise<void> {
    if (busy || request === null) return;
    setBusy(true);
    setError(null);
    try {
      for (const { slot } of request.slots) {
        const payload = (values[slot] ?? '').trim();
        if (payload.length === 0) continue; // a slot may be left blank
        await setDestinationCredential({
          destination: { kind: 'skill-slot', skillId: request.skillId, slot },
          slot: { kind: 'api-key' },
          scope: { scope: 'user', ownerId: null },
          payload,
        });
      }
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-3" data-testid="permission-card">
      <CardHeader>
        <CardTitle>Connect {request.skillId}</CardTitle>
        {request.description.length > 0 && (
          <CardDescription>{request.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {request.hosts.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Will access</p>
            <div className="flex flex-wrap gap-1.5">
              {request.hosts.map((h) => (
                <Badge key={h} variant="secondary">
                  {h}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {request.slots.map(({ slot }) => (
          <div key={slot} className="grid gap-1.5">
            <Label htmlFor={`perm-cred-${slot}`}>{slot}</Label>
            <Input
              id={`perm-cred-${slot}`}
              type="password"
              autoComplete="off"
              value={values[slot] ?? ''}
              onChange={(e) =>
                setValues((v) => ({ ...v, [slot]: e.target.value }))
              }
            />
          </div>
        ))}
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={close}>
          Not now
        </Button>
        <Button disabled={busy} onClick={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </CardFooter>
    </Card>
  );
}
```

- [ ] **Step 4: Mount it above the composer status row**

In `packages/channel-web/src/components/Composer.tsx`, import and mount `<PermissionCard />` immediately above `<AgentStatus />` (inside `ComposerPrimitive.Root`):

```tsx
import { PermissionCard } from './PermissionCard';
// ...
        <PermissionCard />
        <AgentStatus />
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/channel-web test -- src/__tests__/permission-card.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/channel-web/src/components/PermissionCard.tsx \
  packages/channel-web/src/components/Composer.tsx \
  packages/channel-web/src/__tests__/permission-card.test.tsx
git commit -m "feat(channel-web): bundled approval card UI (hosts + secure key field) above composer"
```

---

### Task 6: End-to-end canary + full verification + security-checklist + PR

**Files:**
- Modify: `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`

- [ ] **Step 1: Extend the canary**

In `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` (TASK-34 already boots `@ax/skills` + the tool-dispatcher + `@ax/skill-broker` and exercises `request_capability`), add a case asserting `request_capability` raises the card over the **real** Postgres-backed catalog. Use the file's existing `bus`/`ctx` handles and its global-upsert helper (give the skill a host + an `api_key` slot so the card carries them); the ctx must carry a `conversationId` so the fire forwards it:

```typescript
it('request_capability surfaces the bundled approval card (chat:permission-request)', async () => {
  // bounded Linear skill: host + key slot (reuse the file's upsert helper).
  await upsertGlobalSkill({
    id: 'linear',
    description: 'Read your Linear issues',
    allowedHosts: ['api.linear.app'],
    slots: ['api_key'],
  });

  const cards: Array<{ skillId: string; hosts: string[]; slots: { slot: string; kind: string }[] }> = [];
  bus.subscribe('chat:permission-request', 'canary/card-capture', async (_c, p) => {
    cards.push(p as never);
    return undefined;
  });

  const convCtx = makeAgentContext({
    sessionId: 's', agentId: 'a', userId: 'u', conversationId: 'cnv_canary',
  });

  const ack = await bus.call('tool:execute:request_capability', convCtx, {
    name: 'request_capability',
    input: { skillId: 'linear' },
  });
  expect(ack).toEqual({ status: 'requested', skillId: 'linear' });
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    skillId: 'linear',
    hosts: ['api.linear.app'],
    slots: [{ slot: 'api_key', kind: 'api-key' }],
  });

  // A not-found request raises NO card.
  const miss = await bus.call('tool:execute:request_capability', convCtx, {
    name: 'request_capability',
    input: { skillId: 'does-not-exist' },
  });
  expect(miss).toEqual({ status: 'not-found', skillId: 'does-not-exist' });
  expect(cards).toHaveLength(1);
});
```

(Import `makeAgentContext` from `@ax/core` if the file doesn't already; adapt `upsertGlobalSkill` to the file's existing upsert mechanism — the goal is one global skill with a host + slot + description.)

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
Expected: all green. `pnpm build` (tsc project refs) is the gate that catches the new `SseFrame` variant not being handled everywhere it's switched on and an undeclared workspace dep vitest tolerates; `pnpm lint` catches an accidental cross-plugin import (`no-restricted-imports`) in `@ax/skill-broker` or `@ax/channel-web`, and a raw color / non-shadcn primitive in `PermissionCard.tsx`. Bug-fix-test policy: any bug found here gets a regression test before the fix is considered done.

- [ ] **Step 4: Run the `security-checklist` skill (pre-PR gate)**

Invoke the `security-checklist` skill and answer all three threat models against the [pre-stated model](#security-threat-model-pre-stated). Confirm: the key never enters the model/transcript/SSE frame (it posts straight to the user-scoped destination route, CSRF-guarded via `x-requested-with: ax-admin`, scope forced server-side); the card's contents are admin-vetted catalog manifest data (the broker validates the id against the global catalog before firing); the card payload carries no secret; the SSE route ACLs the card to the conversation's owner. Paste the structured note into the PR.

- [ ] **Step 5: Commit + open the PR**

```bash
git add packages/skills/src/__tests__/e2e/skill-install.canary.test.ts
git commit -m "test(skills): canary asserts request_capability raises the chat:permission-request card"
```

PR description MUST include:
- **Boundary review** (new hook `chat:permission-request`): *Alternate impl* — a non-web channel renders the approval as a prompt; payload is channel-agnostic. *Fields* — `{ skillId, description, hosts, slots: { slot, kind } }`, public manifest data, no backend vocabulary, **no secret**. *Subscriber risk* — none backend-specific (channel-web renders; a future audit subscriber sees only public fields). *Wire surface* — NOT an IPC action (in-process host subscriber hook like `chat:turn-error`); the credential write rides the existing `/settings/destinations/skill-slot/credential` route.
- **Half-wired window OPEN** (see below).
- The `security-checklist` structured note.

---

## Security threat model (pre-stated)

The `security-checklist` skill is a **pre-PR gate** (Task 6 Step 4). Starting model:

- **Credential handling (the flagged threat).** The secret the user types lives only in `<PermissionCard>`'s local React state (a `type="password"`, `autoComplete="off"` input) and posts **directly** to the host credential store via the existing user-scoped `POST /settings/destinations/skill-slot/credential` route — auth-gated, CSRF-guarded (`x-requested-with: ax-admin` + `credentials: 'include'`), with the server **forcing** `scope='user'` + `ownerId=actor.id` and deriving the ref `skill:<id>:<slot>` itself (a client can't supply an arbitrary ref). The key is base64-framed (not clear text in logs) and stored encrypted, resolved to an `ax-cred:` placeholder by the proxy. It **never** rides the SSE frame, the `chat:permission-request` payload, the model's tool I/O (`request_capability` returns only `{ status, skillId }` — TASK-34), or the transcript. Same posture as the existing destination form.
- **Untrusted content steering the card (the flagged threat).** The card's contents (`skillId`/`description`/`hosts`/`slots`) come from an **admin-vetted catalog skill**: the broker validates the model-supplied `skillId` against `SKILL_ID_RE` and resolves it via `skills:get(scope: 'global')` **before** firing — an id not in the catalog yields `{ status: 'not-found' }` and **no card**. So injected content can at most make the agent request a *real* catalog skill the user didn't intend; the **user is the backstop** — they see the actual hosts + slot names on the card before entering anything, and in open mode (decision #6) the declared hosts/creds are shown before any spawn. The card cannot be steered to request an arbitrary host or key absent from a real skill's manifest. The description/hosts render as React text nodes (auto-escaped — there is no raw-HTML render sink in the component), so a hostile description string can't inject markup.
- **Sandbox / capability leakage.** The card adds **no** sandbox, filesystem, process-spawn, env, or socket reach. The broker gains no new capability (it already reads the catalog in TASK-34); firing `chat:permission-request` is host-side only. The SSE handler delivers the card only on a stream whose owner already passed `auth:require-user` + `conversations:get-by-req-id` + `agents:resolve`, and matches by `conversationId` — so a card never bleeds to another user's stream. No new IPC action widens the agent→host wire surface.
- **Supply chain.** No new third-party dependency: `@ax/skill-broker` stays on `@ax/core` only; `@ax/channel-web` reuses already-installed shadcn primitives + React. (Confirm the `pnpm-lock.yaml` diff shows no new registry packages.)

## Half-wired window

Stated explicitly per hard requirement #5:

1. **Approving the card does not yet complete the connect loop.** This phase: the card surfaces (broker fires `chat:permission-request`), renders, and **writes the user's key to their credential store** (real — via the existing user-scoped route). It does **not** yet (a) widen the live host allowlist — **TASK-37** (`proxy:add-host`), (b) attach the skill for the user — **TASK-33**'s `skills:attach-for-user`, consumed by (c) pause→re-spawn→`resume()` of the brokering turn — **TASK-36**, which also evolves `request_capability` from synchronous-ack to pending-yield and adds the approve→resume endpoint. So a user can connect a key now and it sits in their vault harmlessly (their own key, their own scope); it becomes *used* once TASK-36 attaches the skill and the proxy resolves the `ax-cred:` placeholder. **CLOSES across TASK-36 (+ TASK-37 for hosts).**
2. **What IS fully wired here** (no dead code — invariant #3): the broker fires the card (proven by the canary over the real catalog); channel-web's SSE handler emits the frame (proven by the server test); the transport routes it to the store (proven by the transport test); the card renders + the key write hits the user-scoped credential route (proven by the component test). The whole surface is reachable and tested end-to-end *up to the credential write*.

---

## Self-Review

**Spec coverage** (against design §11.3 component #3, flow §6A, §10 credential trust path, decisions #5/#6, and the card body):

- "A chat-surfaced card via a new SSE frame `chat:permission-request`, mirroring the `chat:turn-error → SSE` pattern from PR #137" → Task 1 (broker fires) + Task 2 (SseFrame variant + per-connection subscriber, structurally the turn-error sibling but non-terminal + conv-matched) + Task 4 (client frame branch). ✓
- "One card collapses install + approve-hosts + enter-key(s)" → Task 5 renders hosts (Badges) + one field per slot under one Connect button. The *install + host-allowlist* effects are the stated half-wired window (TASK-36/37); the card *surface* collapsing them is here. ✓
- "The secure credential field posts straight to the host credential store (reuses the destination-credential route, user scope) — never through the model or transcript; resolved to an `ax-cred:` placeholder" → Task 5 reuses `setDestinationCredential` → `POST /settings/destinations/skill-slot/credential` (scope forced `user`, ref `skill:<id>:<slot>`); the threat model + boundary review confirm no secret on the frame/model/transcript. ✓
- "Approve / Not-now" → Task 5's two buttons (Connect writes creds + dismisses; Not now dismisses). ✓
- "Depends on TASK-34 (the card is what `request_capability` raises)" → Task 1 extends TASK-34's `request_capability`; the dep gate + re-verification section handle merge ordering. ✓
- "Security-checklist (credential handling + untrusted content steering the card)" → pre-PR gate (Task 6 Step 4) + pre-stated threat model. ✓
- "channel-web UI → use the shadcn skill (invariant #6)" → Task 5 header note + the re-verify checkbox for installed primitives. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. The two harness-bound steps (the SSE test reuses `bootHandler`/`fakeRes`/`ctxWithConversation`; the transport test reuses `sseStream`/`drain`/the `StreamFn` invoker) reference the file's existing helpers by name with concrete assertions — matching the template's harness-bound canary task. No TBD/TODO in shipped code. ✓

**Type consistency:** the payload is `{ skillId: string; description: string; hosts: string[]; slots: { slot: string; kind: 'api-key' }[] }` at every hop — the broker's local `PermissionRequestEvent`, channel-web server's `PermissionRequest` (+ the `SseFrame` `{reqId, permissionRequest}` variant), the client transport's `SseFrame` variant, and the client store's `PermissionRequest`. The credential write uses `destination: { kind: 'skill-slot', skillId, slot }` + `scope: { scope: 'user', ownerId: null }` consistently with `setDestinationCredential`'s signature and the route's `DestinationSchema`. `request_capability` still returns `{ status: 'requested' | 'not-found'; skillId }` (TASK-34 shape, unchanged). The SSE match is by `ctx.conversationId` (server) — distinct from `chat:turn-error`'s `payload.reqId` match, and intentional (non-terminal card vs terminal error; broker has conversationId, not the original reqId).

**Known residual / forks (resolved):** (1) the SSE card matches by `conversationId` not `reqId` — correct because the broker's runner-driven ctx has a fresh reqId but the real conversationId, and the card is non-terminal (re-verify the IPC ctx stamping survives TASK-32/33/34); (2) Connect writes creds but does not resume — the deliberate half-wired seam owned by TASK-36/37 (mirrors TASK-34's ack precedent); (3) a slot left blank is skipped rather than blocking Connect — lets a user connect a skill whose key they'll add later via settings (the mirror property, P6); revisit if a slot must be mandatory.
