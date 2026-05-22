# Live Title Refresh via SSE — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push conversation-title changes to the browser over SSE so a title that lands after the client's ~10s poll window surfaces in the sidebar with no reload.

**Architecture:** The single title write point (`conversations:set-title`) fires a new in-process bus event `conversations:title-updated` on a real change. A new per-user channel-web SSE route `GET /api/chat/title-events` subscribes to that event (filtered by the authenticated `userId`) and streams `{ conversationId, title }` frames. A long-lived client consumer mounted in the authenticated shell updates the matching `session-store` row directly (and resyncs via `list()` on connect). The existing client poll is left unchanged. Companion design: `docs/plans/2026-05-21-live-title-refresh-sse-design.md`.

**Tech Stack:** TypeScript, `@ax/core` HookBus, `@ax/http-server` `res.stream()` SSE, React 18 + `useSyncExternalStore`, Vitest.

---

## Notes for the implementer

- **No cross-plugin imports (invariant #2).** The event payload type is duck-typed on each side: `@ax/conversations` defines+exports its own `TitleUpdatedEvent`; `@ax/channel-web` defines its own matching interface. They agree by convention, exactly as `chat:stream-chunk` does today.
- **Fired events are NOT declared in the manifest.** `PluginManifest` only has `registers`/`calls`/`subscribes`. The firer (conversations) adds nothing to its manifest. The *subscriber* (channel-web) adds `'conversations:title-updated'` to its `subscribes` array.
- **Run paths:** `pnpm test --filter @ax/conversations`, `pnpm test --filter @ax/channel-web`. Final gate is `pnpm build && pnpm test` + `pnpm lint` at the repo root.
- **Single-replica caveat (design I6):** the event rides the in-process bus, same as the chat SSE. No cross-replica work here.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/conversations/src/types.ts` | add `TitleUpdatedEvent` payload type | Modify |
| `packages/conversations/src/plugin.ts` | fire `conversations:title-updated` from `setConversationTitle` on `updated===true` | Modify (`setConversationTitle`, ~L617) |
| `packages/conversations/src/__tests__/set-title.test.ts` | assert fire on change / silence on no-op + not-found | Modify |
| `packages/channel-web/src/server/title-events.ts` | per-user SSE handler factory | Create |
| `packages/channel-web/src/server/plugin.ts` | instantiate + register `GET /api/chat/title-events`; add subscribe decl | Modify |
| `packages/channel-web/src/__tests__/server/title-events.test.ts` | handler: 401, user isolation, frame format, cleanup | Create |
| `packages/channel-web/src/__tests__/server/plugin.test.ts` | assert the new route is registered (reachable, invariant #3) | Modify |
| `packages/channel-web/src/lib/session-store.ts` | add `applyTitle(conversationId, title)` action | Modify |
| `packages/channel-web/src/lib/title-events.ts` | client SSE consumer (fetch+ReadableStream, reconnect) | Create |
| `packages/channel-web/src/lib/use-title-events.ts` | React hook wiring consumer → store actions | Create |
| `packages/channel-web/src/App.tsx` | mount `useTitleEvents()` in `AppContent` | Modify |
| `packages/channel-web/src/__tests__/session-store-apply-title.test.ts` | `applyTitle` updates row / no-ops unknown id | Create |
| `packages/channel-web/src/__tests__/title-events.test.ts` | client consumer parses frames, ignores junk, reconnects | Create |
| `TODO.md` | remove the completed "Live title refresh" item | Modify |

---

### Task 1: Backend — fire `conversations:title-updated` from the title write point

**Files:**
- Modify: `packages/conversations/src/types.ts`
- Modify: `packages/conversations/src/plugin.ts` (`setConversationTitle`, around L617)
- Test: `packages/conversations/src/__tests__/set-title.test.ts`

- [ ] **Step 1: Add the payload type.** In `packages/conversations/src/types.ts`, add:

```ts
/**
 * Emitted on the in-process bus by the title write path
 * (`conversations:set-title`) whenever a title actually changes. Consumed
 * by channel-web's `/api/chat/title-events` SSE to push live titles to the
 * sidebar. Domain-level only — no storage/transport fields (invariant #1).
 * Subscribers in other plugins duck-type this shape (no cross-plugin import).
 */
export interface TitleUpdatedEvent {
  conversationId: string;
  userId: string;
  title: string;
}
```

- [ ] **Step 2: Write the failing tests.** In `set-title.test.ts`, add a `describe('conversations:title-updated event')` block. Use the file's existing `makeHarness` helper (same as the happy-path test). Subscribe to the event before calling the hook:

```ts
it('fires conversations:title-updated on a real change', async () => {
  const { h, resolveCalls } = await makeHarness({ decide: () => 'allow' });
  const conv = await h.bus.call<CreateInput, CreateOutput>(
    'conversations:create',
    h.ctx({ userId: 'userA' }),
    { userId: 'userA', agentId: 'agt_a' },
  );
  resolveCalls.length = 0;

  const events: Array<{ conversationId: string; userId: string; title: string }> = [];
  h.bus.subscribe<{ conversationId: string; userId: string; title: string }>(
    'conversations:title-updated',
    'test/title-spy',
    async (_ctx, payload) => {
      events.push(payload);
      return undefined;
    },
  );

  await h.bus.call<SetTitleInput, SetTitleOutput>(
    'conversations:set-title',
    h.ctx({ userId: 'userA' }),
    { conversationId: conv.conversationId, userId: 'userA', title: 'Hello' },
  );

  expect(events).toEqual([
    { conversationId: conv.conversationId, userId: 'userA', title: 'Hello' },
  ]);
});

it('does NOT fire on the ifNull already-titled no-op', async () => {
  const { h } = await makeHarness({ decide: () => 'allow' });
  const conv = await h.bus.call<CreateInput, CreateOutput>(
    'conversations:create',
    h.ctx({ userId: 'userA' }),
    { userId: 'userA', agentId: 'agt_a' },
  );
  // First set wins.
  await h.bus.call<SetTitleInput, SetTitleOutput>(
    'conversations:set-title',
    h.ctx({ userId: 'userA' }),
    { conversationId: conv.conversationId, userId: 'userA', title: 'First', ifNull: true },
  );

  const events: unknown[] = [];
  h.bus.subscribe(
    'conversations:title-updated',
    'test/title-spy',
    async (_ctx, payload) => {
      events.push(payload);
      return undefined;
    },
  );

  const out = await h.bus.call<SetTitleInput, SetTitleOutput>(
    'conversations:set-title',
    h.ctx({ userId: 'userA' }),
    { conversationId: conv.conversationId, userId: 'userA', title: 'Second', ifNull: true },
  );
  expect(out).toEqual({ updated: false });
  expect(events).toEqual([]);
});

it('does NOT fire when the conversation is not found', async () => {
  const { h } = await makeHarness({ decide: () => 'allow' });
  const events: unknown[] = [];
  h.bus.subscribe(
    'conversations:title-updated',
    'test/title-spy',
    async (_ctx, payload) => {
      events.push(payload);
      return undefined;
    },
  );
  await expect(
    h.bus.call<SetTitleInput, SetTitleOutput>(
      'conversations:set-title',
      h.ctx({ userId: 'userA' }),
      { conversationId: 'cnv_missing', userId: 'userA', title: 'X' },
    ),
  ).rejects.toThrow();
  expect(events).toEqual([]);
});
```

> Match the existing imports in the file (`CreateInput`/`CreateOutput`/`SetTitleInput`/`SetTitleOutput`, `makeHarness`). If `makeHarness` returns a different field set, adapt the destructuring — read the top of the test file first.

- [ ] **Step 3: Run tests, verify they fail.**

Run: `pnpm test --filter @ax/conversations -- set-title`
Expected: the three new tests FAIL (no event fired).

- [ ] **Step 4: Implement the fire.** In `packages/conversations/src/plugin.ts`, import the type (add to the existing import from `./types.js`):

```ts
import type { /* …existing… */ TitleUpdatedEvent } from './types.js';
```

Then in `setConversationTitle`, replace the `if (updated) { return { updated: true }; }` block (~L617) with:

```ts
  if (updated) {
    // Live-title push (invariant #4 — single source of truth): the only
    // place a title is written is also the only place the change signal
    // is emitted, so every caller (auto-title pipeline today, rename UI
    // later) surfaces in connected sidebars with no reload. Fired ONLY on
    // a real change — never on the ifNull no-op or the not-found path
    // below. Payload is domain-level; channel-web's title-events SSE
    // duck-types it (no cross-plugin import).
    await bus.fire('conversations:title-updated', ctx, {
      conversationId: input.conversationId,
      userId: input.userId,
      title,
    } satisfies TitleUpdatedEvent);
    return { updated: true };
  }
```

- [ ] **Step 5: Run tests, verify they pass.**

Run: `pnpm test --filter @ax/conversations -- set-title`
Expected: PASS (all three new tests + existing).

- [ ] **Step 6: Commit.**

```bash
git add packages/conversations/src/types.ts packages/conversations/src/plugin.ts \
        packages/conversations/src/__tests__/set-title.test.ts
git commit -m "feat(conversations): fire conversations:title-updated on title change"
```

---

### Task 2: Server — per-user `title-events` SSE handler

**Files:**
- Create: `packages/channel-web/src/server/title-events.ts`
- Test: `packages/channel-web/src/__tests__/server/title-events.test.ts`

- [ ] **Step 1: Write the failing test.** Create `title-events.test.ts`. Reuse the `fakeRes()` + mock-bus shape from `sse.test.ts` (copy `fakeRes` and its `CapturedResponse` interface verbatim — read `sse.test.ts` first). Then:

```ts
import { describe, it, expect } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { createTitleEventsHandler } from '../../server/title-events.js';
// + fakeRes() helper copied from sse.test.ts

function boot(opts: { authUser?: { id: string; isAdmin: boolean } | null } = {}) {
  const bus = new HookBus();
  const initCtx = makeAgentContext({
    sessionId: 'init', agentId: '@ax/channel-web', userId: 'system',
  });
  const authUser = opts.authUser === undefined ? { id: 'userA', isAdmin: false } : opts.authUser;
  bus.registerService('auth:require-user', 'mock', async () => {
    if (authUser === null) {
      throw new PluginError({
        code: 'unauthenticated', plugin: 'mock',
        hookName: 'auth:require-user', message: 'no auth',
      });
    }
    return { user: authUser };
  });
  const handler = createTitleEventsHandler({ bus, initCtx });
  return { bus, initCtx, handler };
}

const fire = (bus: HookBus, payload: { conversationId: string; userId: string; title: string }) =>
  bus.fire('conversations:title-updated', makeAgentContext({
    sessionId: 's', agentId: 'a', userId: payload.userId,
  }), payload);

describe('GET /api/chat/title-events', () => {
  it('401s when unauthenticated', async () => {
    const { handler } = boot({ authUser: null });
    const { res, captured } = fakeRes();
    await handler({ headers: {}, body: Buffer.alloc(0), cookies: {}, query: {}, params: {}, signedCookie: () => null }, res);
    expect(captured.statusCode).toBe(401);
    expect(captured.jsonBody).toEqual({ error: 'unauthenticated' });
  });

  it('streams a frame for the caller’s own title-updated event', async () => {
    const { bus, handler } = boot();
    const { res, captured } = fakeRes();
    await handler({ headers: {}, body: Buffer.alloc(0), cookies: {}, query: {}, params: {}, signedCookie: () => null }, res);
    await fire(bus, { conversationId: 'cnv_1', userId: 'userA', title: 'Hello' });
    expect(captured.streamWrites.join('')).toContain('data: {"conversationId":"cnv_1","title":"Hello"}\n\n');
  });

  it('does NOT stream another user’s title event (isolation)', async () => {
    const { bus, handler } = boot(); // authUser userA
    const { res, captured } = fakeRes();
    await handler({ headers: {}, body: Buffer.alloc(0), cookies: {}, query: {}, params: {}, signedCookie: () => null }, res);
    await fire(bus, { conversationId: 'cnv_2', userId: 'userB', title: 'Secret' });
    expect(captured.streamWrites.join('')).not.toContain('cnv_2');
    expect(captured.streamWrites.join('')).not.toContain('Secret');
  });

  it('unsubscribes on client disconnect', async () => {
    const { bus, handler } = boot();
    const { res, captured } = fakeRes();
    await handler({ headers: {}, body: Buffer.alloc(0), cookies: {}, query: {}, params: {}, signedCookie: () => null }, res);
    captured.fireClientClose();
    await fire(bus, { conversationId: 'cnv_3', userId: 'userA', title: 'After close' });
    expect(captured.streamWrites.join('')).not.toContain('cnv_3');
  });
});
```

- [ ] **Step 2: Run test, verify it fails.**

Run: `pnpm test --filter @ax/channel-web -- title-events`
Expected: FAIL — `createTitleEventsHandler` not found.

- [ ] **Step 3: Implement the handler.** Create `packages/channel-web/src/server/title-events.ts`:

```ts
import {
  isRejection,
  PluginError,
  type AgentContext,
  type HookBus,
} from '@ax/core';
// Reuse the duck-typed route interfaces the SSE handler already declares,
// so this file stays free of @ax/http-server imports (invariant I2).
import type { RouteRequest, RouteResponse } from './sse.js';

// ---------------------------------------------------------------------------
// Per-USER title-events SSE. One long-lived connection per browser tab
// surfaces title changes for ANY of the caller's conversations, so the
// sidebar updates without a reload (TODO: live title refresh after the poll
// window). Mirrors createSseHandler (sse.ts) but:
//   - per-user, not per-reqId: subscribe to conversations:title-updated,
//     filter payload.userId === the authenticated userId.
//   - no replay buffer: titles live in the DB and the initial list()
//     already renders current state; we only push CHANGES while connected.
//     The client resyncs via list() on (re)connect for anything missed.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/channel-web';
const SSE_KEEPALIVE_MS = 25_000;

interface TitleUpdatedEvent {
  conversationId: string;
  userId: string;
  title: string;
}

export interface TitleEventsDeps {
  bus: HookBus;
  initCtx: AgentContext;
}

export function createTitleEventsHandler(deps: TitleEventsDeps) {
  return async function handle(
    req: RouteRequest,
    res: RouteResponse,
  ): Promise<void> {
    // 1) Authenticate. The route is closed by default — both PluginError
    //    and bus rejections collapse to 401.
    let userId: string;
    try {
      const result = await deps.bus.call<
        { req: RouteRequest },
        { user: { id: string; isAdmin: boolean } }
      >('auth:require-user', deps.initCtx, { req });
      userId = result.user.id;
    } catch (err) {
      if (err instanceof PluginError || isRejection(err)) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      throw err;
    }

    // 2) Open the stream. From here on we own the response.
    const stream = res.status(200).stream({
      contentType: 'text/event-stream; charset=utf-8',
    });

    let closed = false;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    const subKey = `${PLUGIN_NAME}/title-events/${userId}-${Math.random().toString(36).slice(2, 10)}`;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      deps.bus.unsubscribe('conversations:title-updated', subKey);
    };

    stream.onClose(() => cleanup());

    const safeWrite = (s: string): void => {
      if (closed) return;
      try {
        stream.write(s);
      } catch {
        cleanup();
        try {
          stream.close();
        } catch {
          // already closed
        }
      }
    };

    // 3) Subscribe, filtered to THIS user. Observation-only (never rejects
    //    or mutates the event). A malformed payload is skipped defensively.
    deps.bus.subscribe<TitleUpdatedEvent>(
      'conversations:title-updated',
      subKey,
      async (_ctx, payload) => {
        if (
          payload === null ||
          typeof payload !== 'object' ||
          payload.userId !== userId ||
          typeof payload.conversationId !== 'string' ||
          typeof payload.title !== 'string'
        ) {
          return undefined;
        }
        safeWrite(
          `data: ${JSON.stringify({
            conversationId: payload.conversationId,
            title: payload.title,
          })}\n\n`,
        );
        return undefined;
      },
    );

    // 4) Keepalive. ":\n\n" is dropped by EventSource but keeps proxies and
    //    the http-server idle timeout from culling the connection. unref'd
    //    so a hung connection never blocks process exit.
    keepaliveTimer = setInterval(() => {
      if (closed) return;
      try {
        stream.write(':\n\n');
      } catch {
        cleanup();
      }
    }, SSE_KEEPALIVE_MS);
    if (typeof (keepaliveTimer as { unref?: () => void }).unref === 'function') {
      (keepaliveTimer as { unref: () => void }).unref();
    }
  };
}
```

- [ ] **Step 4: Run test, verify it passes.**

Run: `pnpm test --filter @ax/channel-web -- title-events`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add packages/channel-web/src/server/title-events.ts \
        packages/channel-web/src/__tests__/server/title-events.test.ts
git commit -m "feat(channel-web): per-user title-events SSE handler"
```

---

### Task 3: Server — register the route + declare the subscription

**Files:**
- Modify: `packages/channel-web/src/server/plugin.ts`
- Test: `packages/channel-web/src/__tests__/server/plugin.test.ts`

- [ ] **Step 1: Write the failing assertion.** In `plugin.test.ts`, find the test that boots `createChannelWebServerPlugin()` against a mock `http:register-route` and collects registered route paths. Add `'/api/chat/title-events'` to the expected set (and bump any exact-count assertion by 1). If the file asserts a sorted/`toContain` set, add a `toContain('/api/chat/title-events')` check. Read the file first to match its assertion style.

- [ ] **Step 2: Run test, verify it fails.**

Run: `pnpm test --filter @ax/channel-web -- server/plugin`
Expected: FAIL — route not registered.

- [ ] **Step 3: Implement.** In `plugin.ts`:

1. Add the import:
```ts
import { createTitleEventsHandler } from './title-events.js';
```
2. Add `'conversations:title-updated'` to the manifest `subscribes` array:
```ts
      subscribes: ['chat:stream-chunk', 'chat:phase', 'chat:turn-end', 'conversations:title-updated'],
```
3. In `init()`, after the existing `/api/chat/stream/:reqId` route registration block (after `unregisterRoutes.push(routeResult.unregister);`), add:
```ts
      // Live title push — per-user SSE. Surfaces a title that lands after
      // the client's poll window without a reload (design I5: ships with
      // its consumer in the same PR; the route auto-registers here, no
      // preset change needed).
      const titleEventsHandler = createTitleEventsHandler({ bus, initCtx });
      const titleEventsRoute = await bus.call<
        unknown,
        { unregister: () => void }
      >('http:register-route', initCtx, {
        method: 'GET',
        path: '/api/chat/title-events',
        handler: titleEventsHandler as unknown as (
          req: RouteRequest,
          res: RouteResponse,
        ) => Promise<void>,
      });
      unregisterRoutes.push(titleEventsRoute.unregister);
```
> `RouteRequest`/`RouteResponse` are already imported in `plugin.ts` for the existing stream route — reuse them. If not, add them to the existing `./sse.js` import.

- [ ] **Step 4: Run test, verify it passes.**

Run: `pnpm test --filter @ax/channel-web -- server/plugin`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/channel-web/src/server/plugin.ts \
        packages/channel-web/src/__tests__/server/plugin.test.ts
git commit -m "feat(channel-web): register GET /api/chat/title-events"
```

---

### Task 4: Client — `session-store.applyTitle` action

**Files:**
- Modify: `packages/channel-web/src/lib/session-store.ts`
- Test: `packages/channel-web/src/__tests__/session-store-apply-title.test.ts`

- [ ] **Step 1: Write the failing test.** Create `session-store-apply-title.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { sessionStoreActions, useSessionStore } from '../lib/session-store.js';
import { renderHook, act } from '@testing-library/react';

describe('sessionStoreActions.applyTitle', () => {
  beforeEach(() => {
    act(() => {
      sessionStoreActions.setSessions([
        { id: 'cnv_1', title: 'New Chat', agent_id: 'a', user_id: 'u', created_at: 1, updated_at: 1 },
        { id: 'cnv_2', title: 'Kept', agent_id: 'a', user_id: 'u', created_at: 1, updated_at: 1 },
      ]);
    });
  });

  it('updates the matching row title', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => sessionStoreActions.applyTitle('cnv_1', 'Real Title'));
    expect(result.current.sessions.find((s) => s.id === 'cnv_1')?.title).toBe('Real Title');
    expect(result.current.sessions.find((s) => s.id === 'cnv_2')?.title).toBe('Kept');
  });

  it('no-ops for an unknown conversation id', () => {
    const { result } = renderHook(() => useSessionStore());
    const before = result.current.sessions;
    act(() => sessionStoreActions.applyTitle('cnv_missing', 'X'));
    expect(result.current.sessions).toBe(before); // same reference — no state churn
  });

  it('no-ops when the title is unchanged', () => {
    const { result } = renderHook(() => useSessionStore());
    const before = result.current.sessions;
    act(() => sessionStoreActions.applyTitle('cnv_2', 'Kept'));
    expect(result.current.sessions).toBe(before);
  });
});
```

> If other tests share the module-level store, this file may need to run isolated; the `setSessions` in `beforeEach` resets the relevant rows. Match the `SessionRow` field names exactly (`id`, `title`, `agent_id`, `user_id`, `created_at`, `updated_at`).

- [ ] **Step 2: Run test, verify it fails.**

Run: `pnpm test --filter @ax/channel-web -- session-store-apply-title`
Expected: FAIL — `applyTitle` not a function.

- [ ] **Step 3: Implement.** In `session-store.ts`, add to the `sessionStoreActions` object:

```ts
  /**
   * Apply a single title update pushed over the title-events SSE. Updates
   * the matching row in place (no network). No-ops if the conversation
   * isn't loaded or the title is unchanged — keeps the snapshot reference
   * stable so subscribers don't re-render needlessly.
   */
  applyTitle: (conversationId: string, title: string): void => {
    const idx = state.sessions.findIndex((s) => s.id === conversationId);
    if (idx === -1) return;
    const existing = state.sessions[idx]!;
    if (existing.title === title) return;
    const next = state.sessions.slice();
    next[idx] = { ...existing, title };
    set({ sessions: next });
  },
```

- [ ] **Step 4: Run test, verify it passes.**

Run: `pnpm test --filter @ax/channel-web -- session-store-apply-title`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/channel-web/src/lib/session-store.ts \
        packages/channel-web/src/__tests__/session-store-apply-title.test.ts
git commit -m "feat(channel-web): session-store applyTitle action"
```

---

### Task 5: Client — title-events consumer lib

**Files:**
- Create: `packages/channel-web/src/lib/title-events.ts`
- Test: `packages/channel-web/src/__tests__/title-events.test.ts`

- [ ] **Step 1: Write the failing test.** Create `title-events.test.ts`. Build a mock fetch returning a `ReadableStream` of SSE bytes:

```ts
import { describe, it, expect, vi } from 'vitest';
import { subscribeTitleEvents } from '../lib/title-events.js';

function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('subscribeTitleEvents', () => {
  it('invokes onTitle for each data frame and ignores comments/junk', async () => {
    const frames: Array<{ conversationId: string; title: string }> = [];
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      streamResponse([
        ':\n\n',
        'data: {"conversationId":"cnv_1","title":"One"}\n\n',
        'data: not-json\n\n',
        'data: {"conversationId":"cnv_2","title":"Two"}\n\n',
      ]),
    ).mockResolvedValue(streamResponse([])); // subsequent reconnects: empty
    const stop = subscribeTitleEvents({
      onTitle: (f) => frames.push(f),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseDelayMs: 5,
    });
    await vi.waitFor(() => expect(frames.length).toBe(2));
    stop();
    expect(frames).toEqual([
      { conversationId: 'cnv_1', title: 'One' },
      { conversationId: 'cnv_2', title: 'Two' },
    ]);
  });

  it('calls onOpen on a successful connect', async () => {
    const onOpen = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([]));
    const stop = subscribeTitleEvents({
      onTitle: () => {}, onOpen,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseDelayMs: 5,
    });
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
    stop();
  });

  it('reconnects after the stream ends', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([]));
    const stop = subscribeTitleEvents({
      onTitle: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseDelayMs: 1,
    });
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2));
    stop();
  });
});
```

- [ ] **Step 2: Run test, verify it fails.**

Run: `pnpm test --filter @ax/channel-web -- title-events.test`
Expected: FAIL — `subscribeTitleEvents` not found.

- [ ] **Step 3: Implement.** Create `packages/channel-web/src/lib/title-events.ts`:

```ts
/**
 * Client consumer for GET /api/chat/title-events. One long-lived SSE
 * connection (fetch + ReadableStream, NOT EventSource — EventSource can't
 * send credentials cleanly) surfaces title changes for any of the user's
 * conversations. Reconnects with capped backoff; resync is the caller's job
 * via onOpen. Mirrors the SSE line-parsing in transport.ts.
 */
export interface TitleEventFrame {
  conversationId: string;
  title: string;
}

export interface SubscribeTitleEventsOptions {
  onTitle: (frame: TitleEventFrame) => void;
  /** Fired each time the stream (re)opens — caller resyncs (e.g. list()). */
  onOpen?: () => void;
  api?: string;
  fetchImpl?: typeof fetch;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export function subscribeTitleEvents(
  opts: SubscribeTitleEventsOptions,
): () => void {
  const api = opts.api ?? '/api/chat/title-events';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;

  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;

  const run = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const resp = await fetchImpl(api, {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          credentials: 'include',
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`title-events open failed: ${resp.status}`);
        }
        attempt = 0; // reset backoff once we're connected
        opts.onOpen?.();
        await consume(resp.body, opts.onTitle);
      } catch {
        // transient — fall through to backoff + reconnect
      }
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  };

  void run();

  return () => {
    stopped = true;
    controller?.abort();
  };
}

async function consume(
  body: ReadableStream<Uint8Array>,
  onTitle: (frame: TitleEventFrame) => void,
): Promise<void> {
  const reader = body
    .pipeThrough(
      new TextDecoderStream() as ReadableWritablePair<string, Uint8Array>,
    )
    .getReader();
  let carry = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const data = carry + value;
    const lines = data.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data: ')) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(trimmed.slice(6));
      } catch {
        continue;
      }
      if (
        typeof frame === 'object' &&
        frame !== null &&
        typeof (frame as TitleEventFrame).conversationId === 'string' &&
        typeof (frame as TitleEventFrame).title === 'string'
      ) {
        onTitle({
          conversationId: (frame as TitleEventFrame).conversationId,
          title: (frame as TitleEventFrame).title,
        });
      }
    }
  }
}
```

- [ ] **Step 4: Run test, verify it passes.**

Run: `pnpm test --filter @ax/channel-web -- title-events.test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add packages/channel-web/src/lib/title-events.ts \
        packages/channel-web/src/__tests__/title-events.test.ts
git commit -m "feat(channel-web): client title-events SSE consumer"
```

---

### Task 6: Client — `useTitleEvents` hook + mount in `AppContent`

**Files:**
- Create: `packages/channel-web/src/lib/use-title-events.ts`
- Modify: `packages/channel-web/src/App.tsx` (`AppContent`)
- Test: `packages/channel-web/src/__tests__/use-title-events.test.tsx`

- [ ] **Step 1: Write the failing test.** Create `use-title-events.test.tsx`. Mock the consumer lib so the hook is tested in isolation:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const subscribeMock = vi.fn();
vi.mock('../lib/title-events.js', () => ({
  subscribeTitleEvents: (opts: unknown) => subscribeMock(opts),
}));
const applyTitle = vi.fn();
const bumpVersion = vi.fn();
vi.mock('../lib/session-store.js', () => ({
  sessionStoreActions: { applyTitle: (...a: unknown[]) => applyTitle(...a), bumpVersion: () => bumpVersion() },
}));

import { useTitleEvents } from '../lib/use-title-events.js';

describe('useTitleEvents', () => {
  beforeEach(() => { subscribeMock.mockReset().mockReturnValue(() => {}); applyTitle.mockReset(); bumpVersion.mockReset(); });

  it('subscribes on mount and routes frames to store actions', () => {
    renderHook(() => useTitleEvents());
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    const opts = subscribeMock.mock.calls[0][0] as {
      onTitle: (f: { conversationId: string; title: string }) => void;
      onOpen: () => void;
    };
    opts.onTitle({ conversationId: 'cnv_1', title: 'T' });
    expect(applyTitle).toHaveBeenCalledWith('cnv_1', 'T');
    opts.onOpen();
    expect(bumpVersion).toHaveBeenCalledTimes(1);
  });

  it('stops the subscription on unmount', () => {
    const stop = vi.fn();
    subscribeMock.mockReturnValue(stop);
    const { unmount } = renderHook(() => useTitleEvents());
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails.**

Run: `pnpm test --filter @ax/channel-web -- use-title-events`
Expected: FAIL — hook not found.

- [ ] **Step 3: Implement the hook.** Create `packages/channel-web/src/lib/use-title-events.ts`:

```ts
import { useEffect } from 'react';
import { subscribeTitleEvents } from './title-events.js';
import { sessionStoreActions } from './session-store.js';

/**
 * Opens the long-lived title-events SSE for the duration of the
 * authenticated shell. Each frame updates the matching sidebar row in
 * place; each (re)connect triggers a list() resync (via bumpVersion) so a
 * title that landed while disconnected isn't missed.
 */
export function useTitleEvents(): void {
  useEffect(() => {
    const stop = subscribeTitleEvents({
      onOpen: () => sessionStoreActions.bumpVersion(),
      onTitle: ({ conversationId, title }) =>
        sessionStoreActions.applyTitle(conversationId, title),
    });
    return stop;
  }, []);
}
```

- [ ] **Step 4: Mount it.** In `App.tsx`, add the import and call it inside `AppContent` (top of the component body, before the existing `useEffect`):

```ts
import { useTitleEvents } from './lib/use-title-events';
```
```ts
const AppContent = ({ user }: { user: AuthUser }) => {
  useTitleEvents();
  const { agents, selectedAgentId, pendingAgentId } = useAgentStore();
  // …rest unchanged…
```

- [ ] **Step 5: Run tests, verify they pass.**

Run: `pnpm test --filter @ax/channel-web -- use-title-events`
Expected: PASS (2 tests). Also run `pnpm test --filter @ax/channel-web -- App` (or `boot`) to confirm AppContent still renders.

- [ ] **Step 6: Commit.**

```bash
git add packages/channel-web/src/lib/use-title-events.ts \
        packages/channel-web/src/App.tsx \
        packages/channel-web/src/__tests__/use-title-events.test.tsx
git commit -m "feat(channel-web): mount live title-events consumer in authenticated shell"
```

---

### Task 7: Close out — TODO, gate, security note

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1: Remove the completed TODO item.** Delete the "Live title refresh after the poll window." bullet (TODO.md line ~64). The design + this PR implement it.

- [ ] **Step 2: Run the security-checklist skill.** New HTTP route + an event payload carrying model-generated title text crosses to the browser → invoke `security-checklist`. Confirm: auth-gated, user-filtered (no cross-user leak), read-only, title rendered as React text (no raw-HTML sink). Paste the structured note into the PR body.

- [ ] **Step 3: Full gate (root).**

```bash
pnpm build && pnpm test && pnpm lint
```
Expected: tsc clean, all tests pass, lint clean. (tsc catches what vitest tolerates — do not skip the build.)

- [ ] **Step 4: Commit + push + PR (base main).**

```bash
git add TODO.md
git commit -m "docs(todo): remove completed live-title-refresh item"
```
Open the PR with `--base main`. Include the boundary-review answers (from the design doc) and the security note in the body.

---

## Boundary review (for the PR body)

- **Alternate impl `conversations:title-updated` could have:** titles stored in a KV/document backend — payload `{ conversationId, userId, title }` is unchanged. Holds.
- **Leaky field names:** none — all three are domain-level.
- **Subscriber risk:** the SSE handler keys off `userId` + `conversationId`, both stable domain ids.
- **Wire surface:** the SSE frame `{ conversationId, title }` schema lives in channel-web (route owner), not a central file.

## Self-review (done)

- **Spec coverage:** design §1 → Task 1; §2 → Tasks 2–3; §3 → Tasks 4–6; testing § from design → tests in each task; TODO closure → Task 7. No gaps.
- **Placeholder scan:** none — every code/edit step has concrete code and exact paths.
- **Type consistency:** `TitleUpdatedEvent { conversationId, userId, title }` (firer) ↔ duck-typed identically in `title-events.ts` (handler); client `TitleEventFrame { conversationId, title }`; `applyTitle(conversationId, title)` matches both producer and the hook call site.
