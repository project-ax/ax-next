# Sandbox Idle-Keepalive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a sandbox runner warm for a short idle window after a turn so the next turn on the same conversation reuses it (skipping pod-create + workspace re-materialize), with a host-driven idle reaper that survives a wedged runner.

**Architecture:** The runner is already persistent and the orchestrator already has a route-into-live-session path; the only thing forcing a fresh pod per turn is the `oneShot` cancel on `chat:turn-end`. We add a caller-set `keepAlive` mode: the per-request deferred resolves on `chat:turn-end` and the runner is left warm; a host-side per-session idle timer reaps it graceful-first (queue `cancel`, then force `handle.kill()` after a grace window) — the force step is what survives a hung runner. A runner-side inbox idle floor reaps healthy pods if the host process dies, and `activeDeadlineSeconds` (raised to 6 hr) is the absolute ceiling.

**Tech Stack:** TypeScript, pnpm workspaces, vitest, `@ax/core` HookBus, `@ax/test-harness`, Zod.

**Design doc:** `docs/plans/2026-05-22-sandbox-idle-keepalive-design.md`

**Ship as one PR.** `keepAlive: true` is wired into the k8s preset (Task 6) in the same PR that adds orchestrator support (Tasks 3–5) — no half-wired window (invariant I3).

---

## File Structure

- **`packages/sandbox-k8s/src/config.ts`** — bump `activeDeadlineSeconds` default 3600 → 21600 (Task 1).
- **`packages/agent-claude-sdk-runner/src/inbox-loop.ts`** — add a cumulative `idleTimeoutMs` to the long-poll loop; a new `'idle-timeout'` entry type (Task 2).
- **`packages/agent-claude-sdk-runner/src/main.ts`** — treat `'idle-timeout'` like `cancel` in the userMessages generator (Task 2).
- **`packages/chat-orchestrator/src/orchestrator.ts`** — the bulk: config fields, `resolveWaiterFor` helper, warm-session registry, keepalive turn-end resolution, skip-teardown tail, idle reaper, proxy-close relocation (Tasks 3–5).
- **`packages/chat-orchestrator/src/plugin.ts`** — pass the `chat:turn-end` payload through to `onTurnEnd` (Task 3).
- **`presets/k8s/src/index.ts`** — set `keepAlive: true` on the orchestrator config (Task 6).
- **Tests:** `packages/agent-claude-sdk-runner/src/__tests__/inbox-loop.test.ts`, `packages/chat-orchestrator/src/__tests__/keepalive.test.ts`, `packages/sandbox-k8s/src/__tests__/config.test.ts` (extend if present).

---

## Task 1: Raise the k8s pod lifetime ceiling to 6 hours

**Files:**
- Modify: `packages/sandbox-k8s/src/config.ts:120`
- Test: `packages/sandbox-k8s/src/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/sandbox-k8s/src/__tests__/config.test.ts` (create if absent, mirroring the existing config-resolve test shape — import `resolveSandboxK8sConfig` or whatever the resolver export is named in `config.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { resolveSandboxK8sConfig } from '../config.js';

describe('sandbox-k8s config defaults', () => {
  it('defaults activeDeadlineSeconds to 6 hours (21600s) — keepalive ceiling', () => {
    const cfg = resolveSandboxK8sConfig({ image: 'ax-runner:test', hostIpcUrl: 'http://host:8080' });
    expect(cfg.activeDeadlineSeconds).toBe(21600);
  });

  it('still honors an explicit activeDeadlineSeconds override', () => {
    const cfg = resolveSandboxK8sConfig({
      image: 'ax-runner:test',
      hostIpcUrl: 'http://host:8080',
      activeDeadlineSeconds: 120,
    });
    expect(cfg.activeDeadlineSeconds).toBe(120);
  });
});
```

> If the resolver is named differently (e.g. `resolveConfig`), match the existing export in `config.ts`. Read `config.ts:1-130` first to confirm the export name and required input fields.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ax/sandbox-k8s test -- config`
Expected: FAIL — `expected 3600 to be 21600`.

- [ ] **Step 3: Make the change**

In `packages/sandbox-k8s/src/config.ts:120`:

```ts
    activeDeadlineSeconds: raw.activeDeadlineSeconds ?? 21600,
```

Update the doc comment near the field (config.ts:48 / :93) to read:

```ts
  /** Hard wall-clock pod lifetime cap (seconds). Default 6 h (21600). With
   *  idle-keepalive a warm pod can live across many turns; this is the
   *  ceiling that bounds a continuously-active conversation and the rare
   *  host-crash-plus-wedged-runner orphan. Idle pods are reaped far sooner
   *  by the host idle timer / runner idle floor. */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ax/sandbox-k8s test -- config`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-k8s/src/config.ts packages/sandbox-k8s/src/__tests__/config.test.ts
git commit -m "feat(sandbox-k8s): raise activeDeadlineSeconds default to 6h for keepalive ceiling"
```

---

## Task 2: Runner inbox idle floor (host-crash robustness)

The runner self-exits if it sits idle longer than a floor (longer than the host idle window, so the host normally reaps first). On expiry the userMessages generator `return`s exactly as on `cancel`, the SDK drains, and the runner emits its single `event.chat-end` and exits.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/inbox-loop.ts`
- Modify: `packages/agent-claude-sdk-runner/src/main.ts:399-400`
- Test: `packages/agent-claude-sdk-runner/src/__tests__/inbox-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-claude-sdk-runner/src/__tests__/inbox-loop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createInboxLoop } from '../inbox-loop.js';

// A fake IpcClient whose callGet always reports a host long-poll timeout, so
// next() would loop forever without the idle floor.
function alwaysTimeoutClient() {
  return {
    callGet: async (_action: string, params: { cursor: string }) => ({
      type: 'timeout' as const,
      cursor: Number(params.cursor),
    }),
  } as unknown as Parameters<typeof createInboxLoop>[0]['client'];
}

describe('inbox-loop idle floor', () => {
  it('returns an idle-timeout entry once the cumulative idle floor elapses', async () => {
    let nowMs = 1_000_000;
    const inbox = createInboxLoop({
      client: alwaysTimeoutClient(),
      idleTimeoutMs: 500,
      now: () => nowMs,
      // Each "sleep" simply advances the fake clock past the deadline and
      // resolves, modeling the floor timer winning the race.
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    });

    const entry = await inbox.next();
    expect(entry.type).toBe('idle-timeout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test -- inbox-loop`
Expected: FAIL — `createInboxLoop` doesn't accept `idleTimeoutMs`/`now`/`sleep`, and no `'idle-timeout'` entry type exists (TS error or timeout).

- [ ] **Step 3: Implement the idle floor in `inbox-loop.ts`**

Replace the contents of `packages/agent-claude-sdk-runner/src/inbox-loop.ts` `InboxLoopOptions`, `InboxLoopEntry`, and `createInboxLoop` with:

```ts
/** Default inbox idle floor — 15 min. Longer than the host idle window so the
 *  host-side reaper normally wins; this is the host-crash fallback only. */
const DEFAULT_INBOX_IDLE_MS = 15 * 60 * 1000;

export interface InboxLoopOptions {
  client: IpcClient;
  initialCursor?: number;
  /** Cumulative idle floor per next() call (ms). If no real entry arrives
   *  within this window, next() returns { type: 'idle-timeout' }. */
  idleTimeoutMs?: number;
  /** Testable seam — defaults to Date.now. */
  now?: () => number;
  /** Testable seam — defaults to setTimeout-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface InboxLoopEntry {
  type: 'user-message' | 'cancel' | 'idle-timeout';
  payload?: AgentMessage;
  reqId?: string;
}
```

Add near the other module constants the default sleep:

```ts
const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const IDLE_SENTINEL = Symbol('inbox-idle');
```

Rewrite `next()` inside `createInboxLoop` so each call has its own deadline and races the long-poll against the remaining floor:

```ts
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_INBOX_IDLE_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const next = async (): Promise<InboxLoopEntry> => {
    const deadline = now() + idleTimeoutMs;
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) return { type: 'idle-timeout' };

      const pollP = opts.client.callGet('session.next-message', {
        cursor: String(cursor),
      }) as Promise<WireResponse>;
      const idleP = sleep(remaining).then(() => IDLE_SENTINEL);

      const raw = await Promise.race([pollP, idleP]);
      // The floor won the race — the in-flight GET is abandoned (the runner
      // exits right after this, so a dangling poll is moot).
      if (raw === IDLE_SENTINEL) return { type: 'idle-timeout' };

      const resp = raw as WireResponse;
      if (resp.type === 'timeout') continue;
      if (resp.type === 'user-message') {
        cursor = resp.cursor;
        return { type: 'user-message', payload: resp.payload, reqId: resp.reqId };
      }
      if (resp.type === 'cancel') {
        cursor = resp.cursor;
        return { type: 'cancel' };
      }
      throw new Error(
        `inbox-loop: unexpected session.next-message response type: ${String((resp as { type?: unknown }).type)}`,
      );
    }
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test -- inbox-loop`
Expected: PASS.

- [ ] **Step 5: Handle `idle-timeout` in the runner generator**

In `packages/agent-claude-sdk-runner/src/main.ts` at the inbox pull (lines 399-400), add the floor branch:

```ts
      const entry = await inbox.next();
      if (entry.type === 'cancel') return;
      if (entry.type === 'idle-timeout') {
        // Host-crash floor: nobody is going to send us another message and
        // the host idle reaper isn't around to cancel us. Drain the SDK and
        // exit cleanly (same as cancel) — we still emit our single chat:end
        // on the way out (main.ts tail), which the host's session:terminate
        // path keys off.
        process.stderr.write('runner: inbox idle floor reached; exiting\n');
        return;
      }
```

- [ ] **Step 6: Run the package test + typecheck**

Run: `pnpm --filter @ax/agent-claude-sdk-runner test && pnpm --filter @ax/agent-claude-sdk-runner build`
Expected: PASS + clean tsc.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/inbox-loop.ts packages/agent-claude-sdk-runner/src/main.ts packages/agent-claude-sdk-runner/src/__tests__/inbox-loop.test.ts
git commit -m "feat(runner): inbox idle floor — self-exit after idle as host-crash fallback"
```

---

## Task 3: Orchestrator config fields + payload plumbing + DRY waiter resolution

Foundation for Tasks 4–5. No behavior change yet (keepAlive defaults off; `resolveWaiterFor` is a pure refactor of `onChatEnd`).

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` (config interface ~line 79; reads ~line 483; `onChatEnd` ~line 1260; `onTurnEnd` signature ~line 1293; return-type ~line 441)
- Modify: `packages/chat-orchestrator/src/plugin.ts:106-113`
- Test: `packages/chat-orchestrator/src/__tests__/keepalive.test.ts` (new; full harness lands in Task 4 — Task 3 only needs the existing suites to stay green)

- [ ] **Step 1: Add the config fields**

In `ChatOrchestratorConfig` (orchestrator.ts), after the `oneShot?: boolean;` field (line 79):

```ts
  /**
   * Keepalive mode (default false). When true, a turn completes on
   * `chat:turn-end` and the runner is LEFT WARM instead of cancelled; a
   * per-session idle timer reaps it later (graceful cancel → force kill).
   * The channel-web/k8s preset sets this; the CLI canary stays one-shot.
   * Mutually exclusive in spirit with `oneShot` — when keepAlive is true the
   * one-shot cancel path is not taken.
   */
  keepAlive?: boolean;
  /** Idle window before the reaper queues a graceful cancel (ms). Default 5 min. */
  idleWindowMs?: number;
  /** Grace after the cancel before a force handle.kill() (ms). Default 10 s. */
  idleGraceMs?: number;
```

- [ ] **Step 2: Read the config fields**

Near `const oneShot = config.oneShot ?? true;` (orchestrator.ts:483) add:

```ts
  const keepAlive = config.keepAlive ?? false;
  const idleWindowMs = config.idleWindowMs ?? 5 * 60 * 1000;
  const idleGraceMs = config.idleGraceMs ?? 10 * 1000;
```

- [ ] **Step 3: Extract `resolveWaiterFor` and rewrite `onChatEnd` to use it**

Add this helper next to `registerWaiter`/`unregisterWaiter` (orchestrator.ts ~line 481):

```ts
  // Resolve the waiting deferred for a turn/chat completion. Prefer the
  // originating reqId; fall back to the session index (the IPC server stamps
  // a fresh ctx.reqId on runner-driven events, so the reqId lookup misses and
  // we resolve the oldest waiter for the session — FIFO matches emit order).
  function resolveWaiterFor(
    reqId: string | undefined,
    sessionId: string,
    outcome: AgentOutcome,
  ): void {
    let deferred = reqId !== undefined ? waitersByReqId.get(reqId) : undefined;
    if (deferred === undefined) {
      const reqIds = reqIdsBySession.get(sessionId);
      if (reqIds !== undefined && reqIds.size > 0) {
        const firstReqId = reqIds.values().next().value as string;
        deferred = waitersByReqId.get(firstReqId);
      }
    }
    if (deferred !== undefined && !deferred.settled) {
      deferred.resolve(outcome);
    }
  }
```

Replace the body of `onChatEnd` (orchestrator.ts:1260-1291) so it delegates:

```ts
  function onChatEnd(ctx: AgentContext, payload: { outcome: AgentOutcome }): void {
    resolveWaiterFor(ctx.reqId, ctx.sessionId, payload.outcome);
    // Forget any cancel bookkeeping for this session (set stays bounded in a
    // long-lived host).
    cancelledSessions.delete(ctx.sessionId);
  }
```

- [ ] **Step 4: Change `onTurnEnd` signature to accept the payload**

Update the return-type annotation of `createOrchestrator` (orchestrator.ts:441):

```ts
  onTurnEnd(ctx: AgentContext, payload?: { reqId?: string }): void;
```

Update the `onTurnEnd` declaration (orchestrator.ts:1293) to accept (but not yet use) the payload:

```ts
  function onTurnEnd(ctx: AgentContext, payload?: { reqId?: string }): void {
```

- [ ] **Step 5: Plumb the payload through the subscriber in `plugin.ts`**

Replace the `chat:turn-end` subscription (plugin.ts:106-113):

```ts
      bus.subscribe<{ reason?: string; reqId?: string }>(
        'chat:turn-end',
        PLUGIN_NAME,
        async (ctx, payload) => {
          orch.onTurnEnd(ctx, payload);
          return undefined;
        },
      );
```

- [ ] **Step 6: Run the orchestrator suite + typecheck**

Run: `pnpm --filter @ax/chat-orchestrator test && pnpm --filter @ax/chat-orchestrator build`
Expected: PASS — existing route-by-conversation / orchestrator / augment suites are unchanged (keepAlive defaults off; `resolveWaiterFor` reproduces the old `onChatEnd` behavior exactly).

- [ ] **Step 7: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/plugin.ts
git commit -m "refactor(chat-orchestrator): add keepAlive config fields + resolveWaiterFor + turn-end payload plumbing"
```

---

## Task 4: Keepalive — turn completes without teardown, second turn reuses

In keepalive mode `onTurnEnd` resolves the per-request deferred (synthesized `complete`) and the runner is left warm: no cancel, no `handle.kill()` at turn end, proxy session left open. The warm handle is stashed in a registry and a single `handle.exited` cleanup closes the proxy + drops the entry. The existing route-into-live-session path then reuses it on the next turn.

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` (registry + helpers ~line 481; `onTurnEnd` ~line 1293; fresh-spawn handle stash ~line 1076; step-7 kill ~line 1224; finally proxy-close ~line 1234)
- Test: `packages/chat-orchestrator/src/__tests__/keepalive.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/chat-orchestrator/src/__tests__/keepalive.test.ts`. It reuses the harness conventions from `route-by-conversation.test.ts` (read that file's `buildMocks`/`ctxWith` first; the snippet below is self-contained).

```ts
import { describe, it, expect } from 'vitest';
import {
  HookBus, makeAgentContext, createLogger,
  type AgentMessage, type AgentOutcome, type ServiceHandler,
} from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createChatOrchestratorPlugin } from '../index.js';

const TEST_AGENT = {
  id: 'test-agent', ownerId: 'test-user', ownerType: 'user' as const,
  visibility: 'personal' as const, displayName: 'Test', systemPrompt: 'be helpful',
  allowedTools: ['file.read'], mcpConfigIds: [], model: 'claude-sonnet-4-7', workspaceRef: null,
};

// A controllable warm sandbox: kill() flips a flag + resolves exited.
function makeHandle() {
  let resolveExit!: () => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    resolveExit = () => res({ code: 0, signal: null });
  });
  const state = { kills: 0 };
  return {
    state,
    handle: {
      kill: async () => { state.kills += 1; resolveExit(); },
      exited,
    },
    forceExit: () => resolveExit(),
  };
}

function ctxWith(o: { sessionId: string; conversationId?: string; reqId: string }) {
  return makeAgentContext({
    sessionId: o.sessionId, agentId: 'test-agent', userId: 'test-user',
    ...(o.conversationId !== undefined ? { conversationId: o.conversationId } : {}),
    reqId: o.reqId,
    logger: createLogger({ reqId: o.reqId, writer: () => undefined }),
  });
}

// Fire chat:turn-end carrying the originating reqId (the runner stamps it).
function fireTurnEnd(bus: HookBus, sessionId: string, reqId: string) {
  setImmediate(() => {
    void bus.fire('chat:turn-end',
      makeAgentContext({ sessionId, agentId: 'a', userId: 'u', reqId: 'ipc-fresh',
        logger: createLogger({ reqId: 'ipc-fresh', writer: () => undefined }) }),
      { reason: 'user-message-wait', reqId });
  });
}

describe('chat-orchestrator keepalive', () => {
  it('keepalive: turn resolves on turn-end, runner left warm, 2nd turn reuses (no 2nd open, no kill)', async () => {
    const conv: Record<string, { activeSessionId: string | null }> = {
      'conv-1': { activeSessionId: null },
    };
    const live = new Set<string>();
    const hk = makeHandle();
    let opens = 0;
    const queued: Array<{ sessionId: string; type: string }> = [];

    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
      'session:queue-work': async (_c, input: unknown) => {
        const i = input as { sessionId: string; entry: { type: string } };
        queued.push({ sessionId: i.sessionId, type: i.entry.type });
        return { cursor: 0 };
      },
      'session:terminate': async () => ({}),
      'session:is-alive': async (_c, input: unknown) => ({
        alive: live.has((input as { sessionId: string }).sessionId),
      }),
      'conversations:get': async (_c, input: unknown) => {
        const i = input as { conversationId: string; userId: string };
        return { conversation: {
          conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent',
          activeSessionId: conv[i.conversationId]!.activeSessionId, activeReqId: null,
        } };
      },
      'conversations:bind-session': async (_c, input: unknown) => {
        const i = input as { sessionId: string };
        conv['conv-1']!.activeSessionId = i.sessionId; // simulate the row write
        live.add(i.sessionId);                          // and mark it alive
        return undefined;
      },
      'sandbox:open-session': async () => {
        opens += 1;
        return { runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle };
      },
      'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {} }),
      'proxy:close-session': async () => ({}),
    };

    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({
        runnerBinary: '/irrelevant', chatTimeoutMs: 5_000,
        keepAlive: true, idleWindowMs: 60_000, idleGraceMs: 1_000,
      })],
    });

    // Turn 1 — fresh spawn, resolves on turn-end.
    fireTurnEnd(h.bus, 's-1', 'req-1');
    const out1 = await h.bus.call<unknown, AgentOutcome>('agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-1' }),
      { message: { role: 'user', content: 'hi' } });
    expect(out1).toEqual({ kind: 'complete', messages: [] });
    expect(opens).toBe(1);
    expect(hk.state.kills).toBe(0);                 // NOT killed at turn end
    expect(queued.filter((q) => q.type === 'cancel')).toHaveLength(0); // NO one-shot cancel

    // Turn 2 — same conversation, session alive → routed, no new open, still warm.
    fireTurnEnd(h.bus, 's-1', 'req-2');
    const out2 = await h.bus.call<unknown, AgentOutcome>('agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-2' }),
      { message: { role: 'user', content: 'again' } });
    expect(out2).toEqual({ kind: 'complete', messages: [] });
    expect(opens).toBe(1);                          // reused — no second pod
    expect(hk.state.kills).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ax/chat-orchestrator test -- keepalive`
Expected: FAIL — without the keepalive tail, turn 1 hangs until `chatTimeoutMs` (no `chat:end` fires) and/or the sandbox is killed.

- [ ] **Step 3: Add the warm-session registry + types**

After `unregisterWaiter` / `resolveWaiterFor` (orchestrator.ts ~line 481) add:

```ts
  // Keepalive: warm sandboxes whose runner is left alive between turns. The
  // entry outlives the agent:invoke that opened it; reaped by the idle timer
  // (Task 5), the runner floor, the force-kill, or the pod ceiling.
  interface WarmEntry {
    handle: OpenSessionHandle;
    idleTimer: ReturnType<typeof setTimeout> | null;
    graceTimer: ReturnType<typeof setTimeout> | null;
  }
  const warmSessions = new Map<string, WarmEntry>();
```

- [ ] **Step 4: Resolve-on-turn-end in `onTurnEnd` (keepalive branch)**

In `onTurnEnd`, AFTER the existing `proxy:rotate-session` block and BEFORE the `if (!oneShot) return;` line (orchestrator.ts ~1332), insert:

```ts
    if (keepAlive) {
      // Keepalive: the turn is complete. The real reply already streamed via
      // SSE and persisted via chat:turn-end → conversations; channel-web
      // dispatched agent:invoke fire-and-forget, so this synthesized outcome
      // is unused by the caller. Resolve the per-request waiter, leave the
      // runner WARM (no cancel), and arm the idle reaper (Task 5).
      // Idempotent across the two turn-ends one user message emits.
      resolveWaiterFor(payload?.reqId, ctx.sessionId, { kind: 'complete', messages: [] });
      armReapTimer(ctx); // defined in Task 5
      return;
    }
```

> Task 4 introduces a temporary no-op `armReapTimer` so this compiles; Task 5 replaces it with the real reaper. Add right after `warmSessions` (Step 3):
> ```ts
>   // Placeholder — real implementation lands in Task 5.
>   function armReapTimer(_ctx: AgentContext): void { /* no-op until Task 5 */ }
> ```

- [ ] **Step 5: Stash the handle + register the exit cleanup (fresh-spawn path)**

In `runAgentInvoke`, immediately after `handle = opened.handle;` (orchestrator.ts:1076), add a keepalive block. (`proxyOpened` is the existing flag set when `proxy:open-session` succeeded; declare `let proxyCloseDeferredToHandle = false;` next to `proxyOpened` near the top of `runAgentInvoke`.)

```ts
      if (keepAlive) {
        // Warm the session: the runner outlives this request. One handle.exited
        // cleanup covers every reap path (graceful cancel, force kill, runner
        // floor, ceiling): close the proxy session once and drop the registry
        // entry. This is also why the per-invoke finally must NOT close the
        // proxy in keepalive mode (see Step 7).
        warmSessions.set(sessionId, { handle, idleTimer: null, graceTimer: null });
        proxyCloseDeferredToHandle = proxyOpened;
        const warmCtx = ctx;
        void handle.exited
          .then(() => {
            const entry = warmSessions.get(sessionId);
            if (entry !== undefined) {
              if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
              if (entry.graceTimer !== null) clearTimeout(entry.graceTimer);
            }
            warmSessions.delete(sessionId);
            cancelledSessions.delete(sessionId);
            if (proxyOpened) {
              void bus
                .call<ProxyCloseSessionInput, Record<string, never>>(
                  'proxy:close-session', warmCtx, { sessionId: warmCtx.sessionId },
                )
                .catch((err: unknown) => {
                  warmCtx.logger.warn('proxy_close_session_failed', {
                    sessionId: warmCtx.sessionId,
                    err: err instanceof Error ? err : new Error(String(err)),
                  });
                });
            }
          })
          .catch(() => undefined);
      }
```

- [ ] **Step 6: Skip the step-7 `handle.kill()` in keepalive mode**

At orchestrator.ts:1224-1231, guard the kill:

```ts
    // 7. Kill the sandbox if it's still alive — ONE-SHOT ONLY. In keepalive
    //    mode the runner is left warm and reaped by the idle timer.
    if (!keepAlive) {
      try {
        await handle.kill();
      } catch {
        // best-effort
      }
    }
```

- [ ] **Step 7: Relocate proxy-close in the `finally` (keepalive defers to handle.exited)**

At orchestrator.ts:1240, change the `finally` proxy-close guard from `if (proxyOpened)` to:

```ts
      // I7 — proxy:close fires exactly once per opened proxy session. In
      // keepalive mode a SUCCESSFUL spawn defers the close to handle.exited
      // (Step 5); only close here when that deferral didn't happen (one-shot,
      // or a keepalive spawn that failed before warming the handle).
      if (proxyOpened && !proxyCloseDeferredToHandle) {
```

(Leave the body — the `proxy:close-session` call — unchanged.)

- [ ] **Step 8: Run the keepalive test + full orchestrator suite + typecheck**

Run: `pnpm --filter @ax/chat-orchestrator test && pnpm --filter @ax/chat-orchestrator build`
Expected: the keepalive reuse test PASSES; all existing one-shot suites stay green (keepAlive defaults off, so step-7 kill + finally close are unchanged for them).

- [ ] **Step 9: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/__tests__/keepalive.test.ts
git commit -m "feat(chat-orchestrator): keepalive turn-end resolution + warm-session registry + proxy-close on exit"
```

---

## Task 5: Idle reaper — graceful cancel then force kill

Replace the placeholder `armReapTimer` with the real reaper, and clear timers on turn-start so a warm session is only reaped while genuinely idle.

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` (`armReapTimer`/`clearReapTimers` ~line 481; routed-path clear ~line 617)
- Test: `packages/chat-orchestrator/src/__tests__/keepalive.test.ts`

- [ ] **Step 1: Write the failing test (use fake timers)**

Add to `keepalive.test.ts`:

```ts
import { vi } from 'vitest';

it('keepalive idle reaper: queues a graceful cancel, then force-kills after grace', async () => {
  vi.useFakeTimers();
  try {
    const live = new Set<string>(['s-1']);
    const hk = makeHandle();
    const queued: Array<{ sessionId: string; type: string }> = [];
    const services: Record<string, ServiceHandler> = {
      'agents:resolve': async () => ({ agent: { ...TEST_AGENT } }),
      'session:queue-work': async (_c, input: unknown) => {
        const i = input as { sessionId: string; entry: { type: string } };
        queued.push({ sessionId: i.sessionId, type: i.entry.type });
        return { cursor: 0 };
      },
      'session:terminate': async () => ({}),
      'session:is-alive': async (_c, input: unknown) => ({ alive: live.has((input as { sessionId: string }).sessionId) }),
      'conversations:get': async (_c, input: unknown) => {
        const i = input as { conversationId: string; userId: string };
        return { conversation: { conversationId: i.conversationId, userId: i.userId, agentId: 'test-agent', activeSessionId: null, activeReqId: null } };
      },
      'conversations:bind-session': async () => undefined,
      'sandbox:open-session': async () => ({ runnerEndpoint: 'unix:///tmp/m.sock', handle: hk.handle }),
      'proxy:open-session': async () => ({ proxyEndpoint: 'tcp://127.0.0.1:1', caCertPem: 'CA', envMap: {} }),
      'proxy:close-session': async () => ({}),
    };
    const h = await createTestHarness({
      services,
      plugins: [createChatOrchestratorPlugin({
        runnerBinary: '/irrelevant', chatTimeoutMs: 5_000,
        keepAlive: true, idleWindowMs: 1_000, idleGraceMs: 500,
      })],
    });

    fireTurnEnd(h.bus, 's-1', 'req-1');
    await vi.advanceTimersByTimeAsync(0); // let setImmediate + turn-end run
    await h.bus.call<unknown, AgentOutcome>('agent:invoke',
      ctxWith({ sessionId: 's-1', conversationId: 'conv-1', reqId: 'req-1' }),
      { message: { role: 'user', content: 'hi' } });

    expect(queued.filter((q) => q.type === 'cancel')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);      // idle window elapses → cancel
    expect(queued.filter((q) => q.type === 'cancel')).toHaveLength(1);
    expect(hk.state.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(500);        // grace elapses → force kill
    expect(hk.state.kills).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ax/chat-orchestrator test -- keepalive`
Expected: FAIL — the placeholder `armReapTimer` is a no-op, so no cancel/kill ever happens.

- [ ] **Step 3: Replace the placeholder with the real reaper**

Replace the placeholder `armReapTimer` (added in Task 4 Step 4) with both helpers:

```ts
  function clearReapTimers(sessionId: string): void {
    const entry = warmSessions.get(sessionId);
    if (entry === undefined) return;
    if (entry.idleTimer !== null) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    if (entry.graceTimer !== null) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
  }

  function armReapTimer(ctx: AgentContext): void {
    const sessionId = ctx.sessionId;
    const entry = warmSessions.get(sessionId);
    // No warm handle (e.g. routed into a session this host process didn't
    // open — after a restart). Nothing to reap from here; the runner floor /
    // pod ceiling cover it.
    if (entry === undefined) return;
    clearReapTimers(sessionId);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      // Graceful first: queue a cancel so a HEALTHY runner drains and emits
      // its single chat:end (memory-strata's consolidation trigger). Dedup so
      // a re-arm race can't double-queue.
      if (!cancelledSessions.has(sessionId)) {
        cancelledSessions.add(sessionId);
        void bus
          .call<SessionQueueWorkInput, SessionQueueWorkOutput>(
            'session:queue-work', ctx, { sessionId, entry: { type: 'cancel' } },
          )
          .catch((err) => {
            ctx.logger.warn('keepalive_reap_cancel_failed', { sessionId, err });
          });
      }
      // Force after grace: a WEDGED runner can't process the cancel.
      // handle.kill() (→ killPod → kubelet SIGKILL) doesn't trust the runner.
      entry.graceTimer = setTimeout(() => {
        entry.graceTimer = null;
        void entry.handle.kill().catch(() => undefined);
      }, idleGraceMs);
      entry.graceTimer.unref?.();
    }, idleWindowMs);
    entry.idleTimer.unref?.();
  }
```

- [ ] **Step 4: Clear timers on turn-start (routed path)**

A warm session must not be reaped while a new turn is in flight. At the top of the routed branch — right after `const sessionId = routedSessionId;` (orchestrator.ts:632) — add:

```ts
      // Turn starting on a warm session: cancel any pending idle reap. It is
      // re-armed on this turn's chat:turn-end. (Narrow race: if the idle timer
      // already fired and queued a cancel during its grace window, that cancel
      // is in the inbox FIFO ahead of this message; the runner exits, this
      // turn resolves terminated, and the next turn re-spawns fresh. Accepted
      // for the simplest single-user slice.)
      if (keepAlive) clearReapTimers(sessionId);
```

- [ ] **Step 5: Run the keepalive suite + full orchestrator suite + typecheck**

Run: `pnpm --filter @ax/chat-orchestrator test && pnpm --filter @ax/chat-orchestrator build`
Expected: both keepalive tests PASS; all existing suites stay green.

- [ ] **Step 6: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/__tests__/keepalive.test.ts
git commit -m "feat(chat-orchestrator): idle reaper — graceful cancel then force kill; clear on turn-start"
```

---

## Task 6: Wire `keepAlive: true` into the k8s preset (close the half-wired window)

**Files:**
- Modify: `presets/k8s/src/index.ts:637-640`
- Test: `presets/k8s/src/__tests__/` (extend the existing preset/orchestrator-wiring test if present; otherwise a focused assertion)

- [ ] **Step 1: Write/extend the failing test**

In the k8s preset test suite (find the file that builds the preset plugin list — likely `presets/k8s/src/__tests__/preset.test.ts`), add an assertion that the orchestrator is wired with `keepAlive: true`. If the suite asserts on a captured config, add:

```ts
it('wires the chat-orchestrator in keepalive mode (warm sandboxes for the chat UI)', () => {
  // However the suite captures plugin config — assert keepAlive is true.
  // If config isn't directly inspectable, assert via a spy on
  // createChatOrchestratorPlugin (vi.mock '@ax/chat-orchestrator').
  expect(capturedOrchestratorCfg.keepAlive).toBe(true);
});
```

> If no such inspectable seam exists, add a `vi.mock('@ax/chat-orchestrator', ...)` that captures the config argument, mirroring how other preset tests assert wiring. Read the existing preset test first to match its style.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ax/preset-k8s test` (use the actual package name from `presets/k8s/package.json`)
Expected: FAIL — `keepAlive` is undefined.

- [ ] **Step 3: Set `keepAlive: true` in the preset**

In `presets/k8s/src/index.ts` (line 637-640):

```ts
  const orchestratorCfg: Parameters<typeof createChatOrchestratorPlugin>[0] = {
    runnerBinary: config.chat?.runnerBinary ?? defaultRunnerBinary(),
    chatTimeoutMs: config.chat?.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
    // Keepalive: the channel-web chat UI is multi-turn. Leave the runner warm
    // between turns so a follow-up reuses it (skips pod-create + workspace
    // re-materialize). Idle windows use orchestrator defaults (5 min / 10 s
    // grace); the pod ceiling is sandbox-k8s activeDeadlineSeconds (6 h).
    keepAlive: true,
  };
```

(Leave the `config.chat?.oneShot` override block — an explicit `oneShot` still wins for any operator who sets it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ax/preset-k8s test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add presets/k8s/src/index.ts presets/k8s/src/__tests__/
git commit -m "feat(preset-k8s): run chat-orchestrator in keepalive mode (warm sandboxes)"
```

---

## Task 7: Whole-branch verification

**Files:** none (verification only).

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: clean tsc across the workspace (catches any cross-package type drift the per-package builds missed — see the project's "run tsc alongside vitest" rule).

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all packages green, including the new `keepalive.test.ts`, `inbox-loop.test.ts`, and the preset wiring test.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: clean (no `no-restricted-imports` violations — none of these changes add cross-plugin imports).

- [ ] **Step 4: Manual acceptance note for the PR description**

The orchestrator/runner unit tests cover the reuse + reap logic, but the latency win and the warm-pod survival across turns are only observable end-to-end. Record in the PR that a kind `ax-next-dev` walk should: send a turn, confirm the SSE completes, send a second turn within ~5 min, and confirm via `kubectl get pods -l ax.io/plane=execution` that the SAME runner pod served both (no new pod, no re-materialize in the runner logs). Then idle >5 min and confirm the pod is gone. Use the `k8s-acceptance-loop` skill for the browser-driven walk.

- [ ] **Step 5: Boundary review note for the PR description**

No new service hooks or hook-payload fields are introduced. `chat:turn-end` now carries `reqId` to a new consumer (the orchestrator's keepalive resolution) but the field already exists in `EventTurnEndSchema`. No backend vocabulary leaks. The `keepAlive` flag is a code-level caller config, not a wire field.

---

## Self-Review

**Spec coverage:**
- Three reaper layers — host idle timer (Task 5), runner floor (Task 2), 6 h ceiling (Task 1). ✅
- Graceful-then-force reap — Task 5 Step 3 (cancel → grace → kill). ✅
- Resolve on turn-end / leave warm / no step-7 kill / proxy-close relocation — Task 4. ✅
- Subscriber semantics unchanged (SSE, audit-log, memory-strata, CLI one-shot) — no tasks touch them; memory-strata still fires via the graceful cancel's real `chat:end`. ✅
- Preset wiring closes the half-wired window — Task 6, same PR. ✅
- `session:is-alive` unchanged — no task. ✅ (matches spec "deferred").

**Placeholder scan:** Task 4 Step 4 intentionally introduces a temporary no-op `armReapTimer` that Task 5 Step 3 replaces — this is a sequenced build-up, not a plan placeholder; both the interim and final code are shown in full.

**Type consistency:** `armReapTimer(ctx)` takes `AgentContext` in both Task 4 (placeholder) and Task 5 (real). `resolveWaiterFor(reqId, sessionId, outcome)` is used by `onChatEnd` (Task 3) and the keepalive branch of `onTurnEnd` (Task 4) with matching signatures. `WarmEntry` fields (`handle`/`idleTimer`/`graceTimer`) are consistent across Tasks 4–5. `keepAlive`/`idleWindowMs`/`idleGraceMs` names match between the config interface (Task 3 Step 1), the reads (Task 3 Step 2), and the preset (Task 6).
