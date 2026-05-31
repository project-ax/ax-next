# TASK-84 — SSE open backoff/retry on cold-respawn 404 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser's first `GET /api/chat/stream/:reqId` open survive the cold-respawn race (where the per-reqId binding / host route isn't ready yet and the GET 404s) by retrying the SSE open with bounded backoff, so the chat no longer needs a manual retry on gated/cold-spawn turns.

**Architecture:** Client-only change in `packages/channel-web/src/lib/transport.ts`. The `sendMessages` two-phase flow currently does a SINGLE SSE-open fetch and throws on any non-ok response. We wrap the SSE-open fetch in a bounded retry loop that retries on transient open failures (HTTP 404/425/429/502/503/504 or a thrown network error) with short backoff, and gives up (throws, as today) on a real client error (401/403/400/413) or once the attempt budget is spent. The GET is idempotent (it replays a bounded per-reqId buffer; it never starts/duplicates a turn — only POST does), so retrying it is safe — unlike a `regenerate()` re-POST. An honored `abortSignal` short-circuits the loop immediately.

**Tech Stack:** TypeScript, the AI SDK `HttpChatTransport`, the browser `fetch` API, vitest. No new dependencies.

**Root cause (systematic-debugging Phase 1):** The SSE handler 404s from `conversations:get-by-req-id` returning not-found (sse.ts step 2) — the `/api/chat/stream/:reqId` route is registered at host boot, so the 404 is the reqId lookup, not a missing route. The server-side early-bind in `routes-chat.ts` (awaited before the 202) narrows but does not close the window: read-after-write lag, a best-effort bind that silently fell through, or a host pod still coming up during a cold respawn all leave a sub-second gap where the browser's SSE GET (fired microseconds after the 202) finds no bound reqId → 404. TASK-82 made the approval CARD durable so a manual retry recovers it, but the first-connect 404 → manual-retry symptom persists. A bounded client retry on the idempotent GET is the defense-in-depth fix that works regardless of which of those causes fired (the systematic-debugging prescription for a genuinely timing-dependent race).

---

## File Structure

- **Modify:** `packages/channel-web/src/lib/transport.ts`
  - Add SSE-open retry constants + a private `openSseStream` helper that retries the SSE-open fetch with bounded backoff on transient failures, honoring `abortSignal`.
  - Call it from `sendMessages` in place of the inline single-attempt fetch.
- **Test:** `packages/channel-web/src/__tests__/transport.test.ts`
  - Add regression tests: a 404-then-200 open succeeds without throwing (the cold-respawn race); a persistent 404 throws after the budget; a real 403 throws WITHOUT retrying; an abort during the retry wait stops the loop.

No server change, no preset/chart change, no hook-surface change → no boundary review, no security-checklist (the change touches no auth/routing boundary — it only re-issues the same already-authenticated, same-Origin idempotent GET the client already makes; the server's J9 ACL on the GET is unchanged and re-enforced on every attempt).

---

### Task 1: SSE-open retry with bounded backoff

**Files:**
- Modify: `packages/channel-web/src/lib/transport.ts` (constants near the other module consts ~line 88; the SSE phase inside `sendMessages` ~lines 381-401; a new private method on `AxChatTransport`)
- Test: `packages/channel-web/src/__tests__/transport.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the `describe('AxChatTransport sendMessages two-phase exchange', ...)` block in `transport.test.ts`. The existing `makeFetchMock` only returns one SSE status; these tests use a custom fetch that varies the SSE response per call. Use fake timers so the backoff waits don't slow the suite.

```ts
  test('retries SSE open on a transient 404 (cold-respawn race) then succeeds', async () => {
    vi.useFakeTimers();
    try {
      let sseOpens = 0;
      const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes('/api/chat/messages')) {
          return new Response(JSON.stringify({ conversationId: 'c1', reqId: 'r1' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          });
        }
        // SSE: 404 on the first open (reqId not bound yet), 200 on the second.
        sseOpens += 1;
        if (sseOpens === 1) {
          return new Response('not-found', { status: 404 });
        }
        return new Response(sseStream(`data: {"reqId":"r1","done":true}\n\n`), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as unknown as typeof fetch;

      const transport = new AxChatTransport({ fetch: fetchFn, getAgentId: () => 'a' });
      const streamPromise = transport.sendMessages({
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      } as unknown as Parameters<typeof transport.sendMessages>[0]);
      // Let the first (404) open settle, then advance past the backoff so the
      // retry fires.
      await vi.advanceTimersByTimeAsync(1000);
      const stream = await streamPromise;
      const chunks = (await drain(stream)) as Array<{ type: string }>;
      expect(chunks.map((c) => c.type)).toEqual(['finish']);
      expect(sseOpens).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('throws after the retry budget is exhausted on a persistent SSE 404', async () => {
    vi.useFakeTimers();
    try {
      let sseOpens = 0;
      const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes('/api/chat/messages')) {
          return new Response(JSON.stringify({ conversationId: 'c1', reqId: 'r1' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          });
        }
        sseOpens += 1;
        return new Response('not-found', { status: 404 });
      }) as unknown as typeof fetch;

      const transport = new AxChatTransport({ fetch: fetchFn, getAgentId: () => 'a' });
      const p = transport.sendMessages({
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      } as unknown as Parameters<typeof transport.sendMessages>[0]);
      // Attach the rejection handler BEFORE advancing timers so an early
      // rejection isn't an unhandled rejection; advance well past the total
      // backoff budget to drive every retry.
      const settled = expect(p).rejects.toThrow(/SSE open failed/);
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
      // SSE_OPEN_MAX_ATTEMPTS opens, all 404.
      expect(sseOpens).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does NOT retry a non-transient SSE open failure (403)', async () => {
    let sseOpens = 0;
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/api/chat/messages')) {
        return new Response(JSON.stringify({ conversationId: 'c1', reqId: 'r1' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      sseOpens += 1;
      return new Response('forbidden', { status: 403 });
    }) as unknown as typeof fetch;

    const transport = new AxChatTransport({ fetch: fetchFn, getAgentId: () => 'a' });
    await expect(
      transport.sendMessages({
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      } as unknown as Parameters<typeof transport.sendMessages>[0]),
    ).rejects.toThrow(/SSE open failed/);
    // A real client error is NOT a cold-boot race — one attempt only.
    expect(sseOpens).toBe(1);
  });

  test('aborts the SSE-open retry loop when the signal fires during backoff', async () => {
    vi.useFakeTimers();
    try {
      let sseOpens = 0;
      const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        if (u.includes('/api/chat/messages')) {
          return new Response(JSON.stringify({ conversationId: 'c1', reqId: 'r1' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          });
        }
        sseOpens += 1;
        return new Response('not-found', { status: 404 });
      }) as unknown as typeof fetch;

      const ac = new AbortController();
      const transport = new AxChatTransport({ fetch: fetchFn, getAgentId: () => 'a' });
      const p = transport.sendMessages({
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        abortSignal: ac.signal,
      } as unknown as Parameters<typeof transport.sendMessages>[0]);
      const settled = expect(p).rejects.toThrow();
      // First 404 open has happened; abort while we're in the backoff wait.
      await vi.advanceTimersByTimeAsync(50);
      ac.abort();
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
      // The loop stopped on abort — it did not exhaust the full attempt budget.
      expect(sseOpens).toBeLessThan(4);
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "$WT/packages/channel-web" && ./node_modules/.bin/vitest run src/__tests__/transport.test.ts -t "SSE open"`
Expected: FAIL — the current single-attempt code throws on the first 404 (the retry test sees `sseOpens === 1` then a thrown `chat-flow SSE open failed`), and the budget/abort tests don't observe the expected attempt counts. (`$WT` = the worktree root captured at Phase 0.)

- [ ] **Step 3: Implement the retry helper + constants**

In `transport.ts`, add the constants near `CONNECTION_LOST` (~line 88):

```ts
/**
 * SSE-open retry policy (TASK-84). The browser opens GET /api/chat/stream/:reqId
 * microseconds after the POST's 202. On a cold-respawn gated turn the per-reqId
 * binding / host route can lag that GET by a beat, so the FIRST open 404s and —
 * before this — the user had to retry by hand. The GET is idempotent (it only
 * REPLAYS a bounded per-reqId buffer; it never starts or duplicates a turn —
 * that's POST's job), so re-opening it is safe, unlike a regenerate() re-POST.
 * We retry a SMALL number of times with short backoff on TRANSIENT open
 * failures only; a real client error (401/403/400/413) is not a boot race and
 * throws on the first attempt.
 */
const SSE_OPEN_MAX_ATTEMPTS = 4;
const SSE_OPEN_BACKOFF_MS = [150, 400, 900];
/** HTTP statuses that signal "not ready yet / try again", not "you're wrong". */
const SSE_OPEN_RETRYABLE_STATUS = new Set([404, 425, 429, 502, 503, 504]);
```

Replace the SSE phase inside `sendMessages` (the block from `// Phase 2: SSE.` through `return this.buildTurnStream(...)`, ~lines 381-401) with a call to the new helper:

```ts
    // Phase 2: SSE. Open the stream for the minted reqId with bounded backoff/
    // retry on a transient open failure (TASK-84 — the cold-respawn 404 race),
    // then feed its body to buildTurnStream. A FAILED open after the retry
    // budget is a request-time error (the turn may or may not have started) —
    // surface it as a thrown rejection so the runtime shows the banner rather
    // than auto-RE-POSTING (which could duplicate a started turn).
    const sseBody = await this.openSseStream(postOut.reqId, abortSignal);
    return this.buildTurnStream(sseBody, abortSignal);
```

Add the private method to the `AxChatTransport` class (place it just after `sendMessages`, before `processResponseStream`):

```ts
  /**
   * Open GET /api/chat/stream/:reqId, retrying on a transient open failure with
   * bounded backoff (TASK-84). Returns the SSE response body on success; throws
   * once the attempt budget is spent OR on a non-retryable status. Retrying the
   * GET is safe because it only replays the server's bounded per-reqId buffer —
   * it never starts a turn (only POST does). Honors abortSignal: an abort during
   * a fetch or a backoff wait stops the loop immediately.
   */
  private async openSseStream(
    reqId: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `${this.streamApi}/${encodeURIComponent(reqId)}`;
    let lastStatus = 0;
    let lastStatusText = '';
    for (let attempt = 0; attempt < SSE_OPEN_MAX_ATTEMPTS; attempt += 1) {
      if (abortSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const sseInit: RequestInit = {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        credentials: 'include',
      };
      if (abortSignal) sseInit.signal = abortSignal;

      let resp: Response;
      try {
        resp = await this.fetchImpl(url, sseInit);
      } catch (err) {
        // A network-level throw (connection refused / reset while the host is
        // still coming up) is transient — retry it like a retryable status.
        // But a caller-driven abort is NOT: re-throw so the SDK's normal
        // cancellation runs (no spurious retry).
        if (abortSignal?.aborted) throw err;
        lastStatus = 0;
        lastStatusText = err instanceof Error ? err.message : 'network error';
        if (attempt < SSE_OPEN_MAX_ATTEMPTS - 1) {
          await this.sseBackoffWait(attempt, abortSignal);
          continue;
        }
        break;
      }

      if (resp.ok && resp.body) {
        return resp.body;
      }
      lastStatus = resp.status;
      lastStatusText = resp.statusText;
      // A non-retryable status (e.g. 401/403/400/413) is a real error, not a
      // boot race — fail fast without burning the budget.
      if (!SSE_OPEN_RETRYABLE_STATUS.has(resp.status)) {
        break;
      }
      if (attempt < SSE_OPEN_MAX_ATTEMPTS - 1) {
        await this.sseBackoffWait(attempt, abortSignal);
      }
    }
    throw new Error(`chat-flow SSE open failed: ${lastStatus} ${lastStatusText}`);
  }

  /**
   * Sleep for the configured backoff for `attempt`, resolving early (and
   * leaving the abort to be observed by the next loop guard) if the signal
   * fires. Pure timer wait — no fetch — so an abort never leaks a pending
   * connection.
   */
  private sseBackoffWait(
    attempt: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<void> {
    const ms = SSE_OPEN_BACKOFF_MS[attempt] ?? SSE_OPEN_BACKOFF_MS[SSE_OPEN_BACKOFF_MS.length - 1]!;
    return new Promise<void>((resolve) => {
      if (abortSignal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        abortSignal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cd "$WT/packages/channel-web" && ./node_modules/.bin/vitest run src/__tests__/transport.test.ts -t "SSE open"`
Expected: PASS (4 new tests).

- [ ] **Step 5: Run the full transport test file (no regressions)**

Run: `cd "$WT/packages/channel-web" && ./node_modules/.bin/vitest run src/__tests__/transport.test.ts`
Expected: PASS — including the existing `throws on POST failure` and `POSTs … then opens SSE` happy-path tests (the happy path returns 200 on the first SSE open, so the retry loop returns immediately on attempt 0).

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add packages/channel-web/src/lib/transport.ts packages/channel-web/src/__tests__/transport.test.ts docs/superpowers/plans/2026-05-30-task-84-sse-coldboot-404-retry.md
git -C "$WT" commit -m "$(cat <<'EOF'
[TASK-84] channel-web: retry SSE open on cold-respawn 404 with bounded backoff

The browser opens GET /api/chat/stream/:reqId microseconds after the POST's
202. On a cold-respawn gated turn the per-reqId binding / host route can lag
that GET, so the first open 404s and the user had to retry by hand (TASK-82
made the approval card durable but the 404 itself persisted). The GET is
idempotent (it only replays a bounded per-reqId buffer; only POST starts a
turn), so re-opening it is safe — unlike a regenerate() re-POST. Retry a small
number of times with short backoff on transient open failures (404/425/429/
5xx or a network throw); a real client error (401/403/400/413) still fails
fast; an abort stops the loop.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:** The card's two options were "route-ready-before-202" OR "client backoff/retry on the SSE open 404." This plan implements the second (the server early-bind already does the best achievable route-ready-before-202; the residual race is covered by the idempotent-GET retry). The card's required "regression test for the cold-spawn SSE-open race" is Task 1 Step 1 test #1 (404-then-200). Covered.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases" — every step has concrete code and exact run commands.

**3. Type consistency:** `openSseStream(reqId, abortSignal) → Promise<ReadableStream<Uint8Array>>` matches `buildTurnStream(body, abortSignal)`'s first param type. `sseBackoffWait(attempt, abortSignal) → Promise<void>`. `SSE_OPEN_BACKOFF_MS` is indexed `[attempt]` with a fallback to its last element; with `SSE_OPEN_MAX_ATTEMPTS = 4` and 3 backoff entries, attempt indices 0/1/2 map to the three waits and attempt 3 is the final try with no trailing wait. Consistent.
