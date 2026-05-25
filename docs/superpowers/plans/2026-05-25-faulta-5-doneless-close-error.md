# FAULTA-5 — Done-less SSE close: silent retry then error banner

> **For agentic workers:** Implement task-by-task with strict TDD (test first, watch it fail, implement, watch it pass, commit). Steps use checkbox (`- [ ]`) syntax.

**Goal:** When the chat SSE stream closes mid-turn without a `done` (or `error`) frame — a host bounce (Fault B) or network drop (Fault D) — the client must stop silently finalizing the turn as if it succeeded. It must silently retry the turn once; if the retry also fails, surface the existing error banner with a retry affordance.

**Architecture (as shipped — note the Codex-review evolution below):** The transport's `processResponseStream` `flush()` originally synthesized a `finish`/`stop` chunk on a `done`-less close (the bug). The first draft changed it to emit an AI-SDK `error` chunk (`CONNECTION_LOST`) and had the runtime silently `regenerate()` once. **Codex review (round 4, P1) showed that a client-side `regenerate()` re-POSTs and can DUPLICATE a still-running server turn** (a client SSE disconnect does not terminate the runner; every POST mints a fresh reqId + `agent:invoke`). The shipped design therefore moves silent recovery INTO the transport as a transparent same-reqId RECONNECT: `sendMessages` POSTs once, then `buildReconnectingStream` re-GETs `/stream/:reqId` on a non-terminal drop (graceful done-less close OR hard body error), bounded at `MAX_RECONNECTS`. Reconnect is GET-only → never duplicates the turn. **Codex rounds 5–7 then showed count-based dedup of the server's bounded replay buffer is unsound** (the server can outrun its 256-chunk buffer while the client is disconnected, and the wire has no per-chunk sequence number, so a partial replay can silently drop output). The shipped resolution: silent reconnect is gated on **pre-content only** (`emittedContent === 0`) — the common "blip before the first token" case (sandbox-starting / proxy idle-cull / tab refocus), where the replay is necessarily complete-from-the-start and no dedup is needed. Once any content has streamed, a drop surfaces `CONNECTION_LOST` → the existing `AgentStatus` error banner with a manual-retry (`regenerate`) affordance, rather than risk a lossy resume. Same for reconnect-GET-404 (host bounce, reqId gone), the reconnect cap, and an abort (which closes cleanly, no banner). The runtime's `onError` is just `applyTurnError` (banner). No new UI components — reuses the existing `AgentStatus` row. **Follow-up:** a server-side per-chunk sequence number on the SSE wire would let the client dedup an arbitrary partial replay exactly and resume mid-content (returned in the handoff for auto-ship). See `.claude/memory/decisions.md` (2026-05-25 FAULTA-5 entries) for the full round-by-round rationale.

**Tech Stack:** TypeScript, `ai` (HttpChatTransport / UIMessageChunk), `@ai-sdk/react` (useChat onError/regenerate), vitest. Package: `@ax/channel-web`.

**Invariants honored:** I1 (no new hook payload; the sentinel is an internal `@ax/channel-web` constant, shared exactly like `DEFAULT_TURN_ERROR`), I2 (transport imports only `ai` + `@ax/ipc-protocol`; runtime stays in-package), I5 (untrusted model text path unchanged), I6 (no new shadcn primitives — existing AgentStatus row). No hook-surface change → no boundary review. No sandbox/IPC/plugin-loading/dependency change → no security-checklist trigger.

---

## File Structure

- `packages/channel-web/src/lib/transport.ts` — MODIFY. Add `CONNECTION_LOST` exported constant; change `flush()` to emit an `error` chunk with `errorText: CONNECTION_LOST` instead of a `finish`. The `done` and `error` (orchestrator) frame paths are unchanged.
- `packages/channel-web/src/lib/turn-error.ts` — MODIFY. Add a pure `handleTurnError({ error, isFirstFailure, silentRetry, showError })` helper that decides silent-retry vs banner. Keep `applyTurnError` (still used as the banner path).
- `packages/channel-web/src/lib/runtime.tsx` — MODIFY. Track a per-turn retry-attempt ref; wire `onError` through the new helper so the first connection-lost failure silently regenerates and later failures show the banner.
- `packages/channel-web/src/__tests__/transport.test.ts` — MODIFY. Replace the now-wrong "flush emits finish on done-less close" expectation with the corrected one (emits an `error` chunk carrying `CONNECTION_LOST`, no `finish`). This is the Bug-Fix-Policy regression test.
- `packages/channel-web/src/__tests__/turn-error.test.ts` — MODIFY. Add unit tests for `handleTurnError` (silent retry on first connection-lost; banner on second; banner immediately for a non-connection-lost error).

---

## Task 1: Transport emits a connection-lost error chunk on a done-less close

**Files:**
- Modify: `packages/channel-web/src/lib/transport.ts`
- Test: `packages/channel-web/src/__tests__/transport.test.ts`

- [ ] **Step 1: Replace the obsolete silent-finalize test with the corrected regression test.**

In `transport.test.ts`, the existing test (around lines 245-252):

```ts
  test('flush emits finish if stream closes without an explicit done frame', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body = `data: {"reqId":"r1","text":"stub","kind":"text"}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{ type: string; finishReason?: string }>;
    const finish = chunks.find((c) => c.type === 'finish') as { finishReason: string } | undefined;
    expect(finish).toBeTruthy();
    expect(finish?.finishReason).toBe('stop');
  });
```

is replaced by (add `CONNECTION_LOST` to the import from `../lib/transport`):

```ts
  // Faults B/D — the stream closes mid-turn with NO terminal frame (host
  // bounce / network drop). Previously flush() synthesized a finish/stop,
  // which looked like a successful turn and silently dropped the half-
  // streamed answer. It MUST instead close any open part and emit an
  // `error` chunk carrying the CONNECTION_LOST sentinel so the runtime can
  // silently retry (then surface the banner) — NOT a silent finish.
  test('done-less close emits a connection-lost error chunk, not a silent finish', async () => {
    const transport = new AxChatTransport({ getAgentId: () => 'a' });
    const body = `data: {"reqId":"r1","text":"stub","kind":"text"}\n\n`;
    const chunks = await drain(asProcess(transport)(sseStream(body))) as Array<{
      type: string;
      errorText?: string;
    }>;
    const types = chunks.map((c) => c.type);
    // The open text part is closed before the error.
    expect(types).toContain('text-end');
    // It ends as an error, NOT a finish.
    expect(types).toContain('error');
    expect(types).not.toContain('finish');
    expect(types[types.length - 1]).toBe('error');
    const errorChunk = chunks.find((c) => c.type === 'error') as
      | { errorText: string }
      | undefined;
    expect(errorChunk?.errorText).toBe(CONNECTION_LOST);
  });
```

Update the import line at the top:

```ts
import { AxChatTransport, toContentBlocksForTesting, CONNECTION_LOST } from '../lib/transport';
```

Also fix the two `makeEmptyFinishStream`-backed sendMessages tests' assumption: those POST/GET happy-path tests use an SSE body that ALWAYS ends with a `done` frame, so they are unaffected. The `default fetch is bound to globalThis` test's stream body is `data: {"reqId":"r1","done":true}\n\n` (has `done`) — unaffected. No other test relies on the done-less → finish behavior.

- [ ] **Step 2: Run the test, watch it fail.**

Run: `corepack pnpm --filter @ax/channel-web exec vitest run src/__tests__/transport.test.ts -t "done-less close"`
Expected: FAIL — current flush emits `finish`, so `types` contains `finish` and lacks `error`; also `CONNECTION_LOST` is not exported yet (compile error).

- [ ] **Step 3: Add the `CONNECTION_LOST` constant and change `flush()`.**

In `transport.ts`, after the `DEFAULT_TURN_ERROR` export (around line 70), add:

```ts
/**
 * Sentinel error text for a `done`-less stream close (Faults B/D — the
 * host bounced or the network dropped mid-turn, so the SSE connection died
 * before any terminal `done`/`error` frame arrived). This is an INTERNAL
 * @ax/channel-web contract (NOT a hook payload) shared between this file
 * and the runtime's onError — exactly like DEFAULT_TURN_ERROR. The runtime
 * matches `error.message === CONNECTION_LOST` to decide a SILENT retry
 * (first failure) vs surfacing the error banner (second failure). The
 * wording also doubles as the banner text if the silent retry is exhausted.
 */
export const CONNECTION_LOST = 'Connection lost. Retrying…';
```

Then change the `flush(controller)` body (around lines 570-578) from:

```ts
          flush(controller) {
            if (finished) return;
            // Stream closed without an explicit done frame — close any
            // open parts and synthesize a finish so the runtime returns
            // to ready state instead of hanging.
            closeOpen(controller);
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
            finished = true;
          },
```

to:

```ts
          flush(controller) {
            if (finished) return;
            // Faults B/D — the stream closed WITHOUT a terminal `done` or
            // `error` frame: a host bounce (process died → the replica-local
            // chunk buffer is gone) or a network drop (TCP severed) killed
            // the connection mid-turn. We must NOT synthesize a finish/stop
            // here — that looks like a successful turn and silently drops the
            // half-streamed answer (the FAULTA-5 bug). Close any open part
            // and emit an `error` chunk carrying the CONNECTION_LOST sentinel;
            // the runtime's onError silently retries once (regenerate → fresh
            // reqId + sandbox), then surfaces the error banner if that fails.
            closeOpen(controller);
            controller.enqueue({ type: 'error', errorText: CONNECTION_LOST });
            finished = true;
          },
```

Update the class-doc comment line that says `- stream close (no done frame) → same finish posture.` (around line 375) to:

```ts
   *   - stream close (no done frame) → close any open part, emit an
   *     `error` chunk (CONNECTION_LOST) so the runtime can silently retry
   *     then surface the banner — Faults B/D, NOT a silent finish.
```

- [ ] **Step 4: Run the test, watch it pass.**

Run: `corepack pnpm --filter @ax/channel-web exec vitest run src/__tests__/transport.test.ts`
Expected: PASS (the whole transport suite — confirm no other test regressed).

- [ ] **Step 5: Commit.**

```bash
git add packages/channel-web/src/lib/transport.ts packages/channel-web/src/__tests__/transport.test.ts
git commit -m "[FAULTA-5] transport: emit connection-lost error chunk on done-less close, not a silent finish"
```

---

## Task 2: Pure `handleTurnError` helper — silent retry then banner

**Files:**
- Modify: `packages/channel-web/src/lib/turn-error.ts`
- Test: `packages/channel-web/src/__tests__/turn-error.test.ts`

- [ ] **Step 1: Write the failing tests for `handleTurnError`.**

Append to `turn-error.test.ts` (add `handleTurnError` to the import from `../lib/turn-error` and `CONNECTION_LOST` from `../lib/transport`):

```ts
import { applyTurnError, handleTurnError } from '../lib/turn-error';
import { CONNECTION_LOST } from '../lib/transport';

describe('handleTurnError — Faults B/D silent-retry then banner', () => {
  afterEach(() => {
    agentStatusActions.reset();
  });

  it('silently retries (no banner) on the FIRST connection-lost error', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new Error(CONNECTION_LOST),
      isFirstFailure: true,
      silentRetry,
      showError,
    });
    expect(silentRetry).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
    // The row shows a transient working-mode label, NOT the error banner.
    const snap = getAgentStatusSnapshot();
    expect(snap.mode).toBe('working');
    expect(snap.text).toBe(CONNECTION_LOST);
  });

  it('shows the error banner on a SECOND connection-lost error', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: new Error(CONNECTION_LOST),
      isFirstFailure: false,
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(new Error(CONNECTION_LOST));
  });

  it('shows the error banner immediately for a non-connection-lost error (even on first failure)', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    const err = new Error('chat-run-timeout mapped label');
    handleTurnError({
      error: err,
      isFirstFailure: true,
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(err);
  });

  it('treats a non-Error value as a non-connection-lost error → banner', () => {
    const silentRetry = vi.fn();
    const showError = vi.fn();
    handleTurnError({
      error: 'weird string',
      isFirstFailure: true,
      silentRetry,
      showError,
    });
    expect(silentRetry).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests, watch them fail.**

Run: `corepack pnpm --filter @ax/channel-web exec vitest run src/__tests__/turn-error.test.ts -t "handleTurnError"`
Expected: FAIL — `handleTurnError` is not exported yet (compile error).

- [ ] **Step 3: Implement `handleTurnError`.**

In `turn-error.ts`, add the import for the sentinel and the helper. The file becomes:

```ts
/**
 * Fault A — turn the AI-SDK `onError` (raised by the transport's `error`
 * UIMessageChunk when the host emits an SSE `error` frame) into a
 * user-visible error+retry on the agent-status row.
 *
 * Faults B/D (FAULTA-5) — a `done`-less stream close (host bounce / network
 * drop mid-turn) surfaces as an `error` chunk carrying the CONNECTION_LOST
 * sentinel. `handleTurnError` routes that case through a SILENT retry on the
 * first failure, then the same error banner on the second.
 *
 * Kept as pure helpers (no React) so they're unit-testable without rendering
 * `useChat`. The runtime wires them.
 *
 * `regenerate()` re-runs the last user turn — history is persisted
 * server-side and the dead session's `active_session_id` was cleared by
 * `session:terminate`'s conversations subscriber, so retry routes to a
 * fresh sandbox and re-answers.
 */
import { agentStatusActions } from './agent-status-store';
import { CONNECTION_LOST, DEFAULT_TURN_ERROR } from './transport';

export function applyTurnError(error: unknown, retry: () => void): void {
  const text =
    error instanceof Error && error.message ? error.message : DEFAULT_TURN_ERROR;
  agentStatusActions.error(text, { retry });
}

/** True iff this error is the transport's `done`-less-close sentinel. */
function isConnectionLost(error: unknown): boolean {
  return error instanceof Error && error.message === CONNECTION_LOST;
}

export interface HandleTurnErrorArgs {
  /** The error raised to useChat's onError (AI-SDK reconstructs a plain
   *  Error from the transport's `error` chunk errorText). */
  error: unknown;
  /** True if no silent retry has been spent for the current turn yet. */
  isFirstFailure: boolean;
  /** Re-run the last user turn silently (the runtime's regenerate()). */
  silentRetry: () => void;
  /** Surface the error banner with a (manual) retry affordance. */
  showError: (error: unknown) => void;
}

/**
 * Decide between a silent retry and the error banner for a failed turn.
 *
 *   - connection-lost (Faults B/D) AND first failure → SILENT retry: set a
 *     transient working-mode "Connection lost. Retrying…" label (no banner)
 *     and call silentRetry().
 *   - connection-lost AND already retried once → error banner.
 *   - any other error (Fault A / orchestrator-terminated) → error banner
 *     immediately, regardless of attempt count.
 */
export function handleTurnError(args: HandleTurnErrorArgs): void {
  const { error, isFirstFailure, silentRetry, showError } = args;
  if (isConnectionLost(error) && isFirstFailure) {
    // Transient working label — NOT the persistent red error banner. The
    // status row stays in working mode so the next turn's RunningEffect
    // hides it cleanly on success.
    agentStatusActions.set(CONNECTION_LOST);
    silentRetry();
    return;
  }
  showError(error);
}
```

- [ ] **Step 4: Run the tests, watch them pass.**

Run: `corepack pnpm --filter @ax/channel-web exec vitest run src/__tests__/turn-error.test.ts`
Expected: PASS (both the existing `applyTurnError` tests and the new `handleTurnError` tests).

Note: `agentStatusActions.set(CONNECTION_LOST)` — when the row is `hidden` it promotes to working mode (see agent-status-store.set), and when working it just swaps the label. The RunningEffect seeds "Thinking…" at turn start, so by the time onError fires the row is in working mode; either way `set` lands it on working+CONNECTION_LOST.

- [ ] **Step 5: Commit.**

```bash
git add packages/channel-web/src/lib/turn-error.ts packages/channel-web/src/__tests__/turn-error.test.ts
git commit -m "[FAULTA-5] turn-error: handleTurnError routes connection-lost to silent retry then banner"
```

---

## Task 3: Wire the runtime's onError through `handleTurnError`

**Files:**
- Modify: `packages/channel-web/src/lib/runtime.tsx`

- [ ] **Step 1: Update the runtime wiring.**

In `runtime.tsx`, change the import:

```ts
import { applyTurnError, handleTurnError } from './turn-error';
```

Replace the `useChatThreadRuntime` body's chat-construction block. Current:

```ts
  const chatRef = useRef<ReturnType<typeof useChat> | null>(null);
  const chat = useChat({
    id,
    transport,
    onError: (error) => {
      applyTurnError(error, () => {
        void chatRef.current?.regenerate();
      });
    },
  });
  chatRef.current = chat;
```

becomes:

```ts
  // Fault A — an orchestrator-terminated turn surfaces an `error` chunk;
  // useChat raises it to onError and we flip the status row to error+retry.
  //
  // Faults B/D (FAULTA-5) — a `done`-less close (host bounce / network drop)
  // surfaces the CONNECTION_LOST sentinel. `handleTurnError` SILENTLY retries
  // it ONCE (regenerate → fresh reqId + sandbox), then shows the error banner
  // if the retry also fails. `retryCountRef` tracks the single silent attempt
  // spent per turn; it resets when a new turn starts streaming so the next
  // genuine drop gets its own silent retry.
  const chatRef = useRef<ReturnType<typeof useChat> | null>(null);
  const silentRetriedRef = useRef(false);
  const chat = useChat({
    id,
    transport,
    onError: (error) => {
      handleTurnError({
        error,
        isFirstFailure: !silentRetriedRef.current,
        silentRetry: () => {
          silentRetriedRef.current = true;
          void chatRef.current?.regenerate();
        },
        showError: (e) =>
          applyTurnError(e, () => {
            // Manual retry from the banner button: reset the silent-retry
            // budget so a fresh drop can silently retry again.
            silentRetriedRef.current = false;
            void chatRef.current?.regenerate();
          }),
      });
    },
    onFinish: () => {
      // A turn completed normally (done frame → finish). Reset the silent-
      // retry budget so the NEXT turn's first drop gets its own silent retry.
      silentRetriedRef.current = false;
    },
  });
  chatRef.current = chat;
```

- [ ] **Step 2: Verify `onFinish` exists on the useChat options.**

Run: `grep -n "onFinish" node_modules/.pnpm/@ai-sdk+react@*/node_modules/@ai-sdk/react/dist/index.d.ts | head`
Expected: shows an `onFinish` option on the chat hook. If it does NOT exist on `useChat` (only on `useCompletion`), drop the `onFinish` block and instead reset `silentRetriedRef` at the START of a successful regenerate is NOT possible — fall back to resetting in `showError`/`silentRetry` only and accept that a successful turn after a silent retry leaves the budget spent until the next error. See Step 3 fallback.

- [ ] **Step 3: Fallback if `useChat` has no `onFinish`.**

If Step 2 shows no `onFinish` on useChat: remove the `onFinish` block. The budget then resets only via `showError`'s manual retry and `silentRetry`. To still reset on a fresh turn, key the reset off the message-send instead — but since the runtime can't easily hook "send", the acceptable MVP behavior is: each distinct error event that is NOT preceded by a spent budget retries silently. Because `regenerate()` produces a fresh stream, a successful regenerate fires no further onError, so `silentRetriedRef` simply stays `true` harmlessly until the next manual retry resets it. A subsequent unrelated turn that drops would then go straight to the banner. Document this as a deferred refinement (follow-up card) rather than blocking. PREFER the `onFinish` path if available.

- [ ] **Step 4: Build + typecheck the package.**

Run: `corepack pnpm --filter @ax/channel-web build`
Expected: clean tsc (no type errors on the useChat options object).

- [ ] **Step 5: Run the full channel-web test suite.**

Run: `corepack pnpm --filter @ax/channel-web test`
Expected: PASS — including `runtime-conversation-ref.test.tsx` (it mocks useChat so the onError shape change is inert there) and the transport/turn-error suites.

- [ ] **Step 6: Commit.**

```bash
git add packages/channel-web/src/lib/runtime.tsx
git commit -m "[FAULTA-5] runtime: silent-retry done-less close once, then error banner"
```

---

## Self-Review

**Spec coverage:**
- "Fix the client's done-less close so it surfaces an error instead of silently finalizing" → Task 1 (transport emits `error`, not `finish`).
- "Silent retry first" → Task 2 + Task 3 (first connection-lost error → `silentRetry()`/`regenerate()` with transient label, no banner).
- "if that fails, an error banner with a retry affordance" → Task 2 + Task 3 (`showError` → `applyTurnError` → existing AgentStatus error row with retry button).
- "Add a test that would have caught the silent-finalize bug (Bug Fix Policy)" → Task 1 Step 1 (the replaced transport test asserts `error`/`CONNECTION_LOST`, `not finish`).
- shadcn invariant → no new components; reuses AgentStatus (existing semantic tokens).

**Placeholder scan:** none — all steps carry concrete code/commands. Step 3 of Task 3 is a documented fallback contingent on a verified API fact (Step 2), not a placeholder.

**Type consistency:** `CONNECTION_LOST` (transport.ts export) used identically in turn-error.ts and the tests. `handleTurnError`/`HandleTurnErrorArgs` field names (`error`, `isFirstFailure`, `silentRetry`, `showError`) match across the helper, tests, and runtime call site.
