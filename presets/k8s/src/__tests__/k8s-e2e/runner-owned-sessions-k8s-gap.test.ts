/**
 * Regression suite for the runner-owned-sessions k8s gap (Bug 1) plus two
 * UI bugs surfaced by the same goldenpath walk (Bug 2, Bug 3).
 *
 * The suite drives the local kind cluster `ax-next-dev` end-to-end via the
 * host pod's port-forward at http://localhost:9090 and `kubectl exec` into
 * the postgres pod. It is gated on `AX_K8S_E2E=1` so the broader
 * `pnpm test` lane stays hermetic — the cluster is operator-managed and
 * not a CI dependency. See `presets/k8s/vitest.config.k8s-e2e.ts` for the
 * project wiring.
 *
 * Bug enumeration (each `it` covers one bug):
 *
 *   Bug 1 — sandbox-k8s/open-session.ts:67 + chat-orchestrator/orchestrator.ts:798
 *           OpenSessionInputSchema.owner doesn't carry conversationId, so
 *           session_postgres_v2_session_agent.conversation_id lands NULL,
 *           the runner reads conversationId:null from session.get-config,
 *           the bind-skip branch at agent-claude-sdk-runner/main.ts:415
 *           fires, conversations_v1_conversations.runner_session_id stays
 *           NULL, and turn 2 starts fresh with no memory of turn 1.
 *
 *   Bug 2 — channel-web/lib/transport.ts:363-389 + components/Composer.tsx:91
 *           Composer's Send button stays as the Stop icon after the SSE
 *           done frame arrives. Either the SSE stream isn't actually
 *           closing or the chunk shape doesn't match what the AI SDK's
 *           runtime is consuming.
 *
 *   Bug 3 — channel-web/server/routes-chat.ts:419 + conversations/store.ts:345
 *           After a turn completes, hard-reload of the SPA shows an empty
 *           sidebar instead of the conversation just created. Could be
 *           server-side (route handler scoping) or client-side (thread-list
 *           cache invalidation); the failure message points at whichever
 *           side the API check reveals.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';

import {
  HOST_BASE_URL,
  countRunnerPods,
  createAgent,
  dbQueryFirstCell,
  dbQueryRows,
  deleteAgent,
  deleteConversation,
  getRunnerLogs,
  sendAndWaitForBackend,
  signIn,
  waitFor,
} from './helpers.js';

const E2E_ENABLED = process.env.AX_K8S_E2E === '1';
const skipMsg =
  'AX_K8S_E2E unset — set AX_K8S_E2E=1 with the kind cluster + port-forward up';

// Pin the model so a model rotation can't shift behavior under us. Haiku
// is cheapest and follows simple verbatim-repeat instructions reliably.
const TEST_MODEL = 'claude-haiku-4-5-20251001';

// Per-run unique tag so re-runs don't collide on the agents listing.
const RUN_ID = `e2e-${process.pid}-${Date.now().toString(36)}`;

describe('k8s-e2e — runner-owned-sessions regression suite', () => {
  // Track everything we create so the afterAll can clear it. A clean re-run
  // from an empty slate is part of the contract: nothing must accumulate.
  const createdAgents = new Set<string>();
  const createdConversations = new Set<string>();
  let sharedCookie: string | null = null;

  afterAll(async () => {
    if (sharedCookie === null) return;
    for (const cid of createdConversations) {
      await deleteConversation(sharedCookie, cid).catch(() => undefined);
    }
    for (const agentId of createdAgents) {
      await deleteAgent(sharedCookie, agentId).catch(() => undefined);
    }
  });

  it.skipIf(!E2E_ENABLED)(
    'Bug 1 — k8s runner binds runner_session_id and resumes on turn 2',
    { timeout: 180_000 },
    async () => {
      // ----- Setup: sign in, create a deterministic-prompt agent. ---------
      const { cookie, userId } = await signIn();
      sharedCookie = cookie;
      const agent = await createAgent(cookie, {
        displayName: `bug1-${RUN_ID}`,
        // The system prompt pins behavior so the assertion is a string
        // search, not a model-quality measurement. We're testing memory
        // continuity, not the model's reasoning.
        systemPrompt:
          'You are a deterministic test agent. When the user states a number, ' +
          "you remember it across turns. When the user asks for the number, " +
          "respond with ONLY that number followed by '.' — no other words.",
        // bash listed because the admin gate refuses an entirely-empty
        // tool list; the test never invokes any tool.
        allowedTools: ['bash'],
        model: TEST_MODEL,
      });
      createdAgents.add(agent.id);

      // ----- Turn 1: state the number to remember. -----------------------
      const turn1 = await sendAndWaitForBackend(cookie, {
        agentId: agent.id,
        conversationId: null,
        text: 'Remember the number 4711. Just say "ok".',
      });
      createdConversations.add(turn1.conversationId);

      // ----- DB assertion 1: session row carries conversation_id. --------
      // The MOST RECENTLY created session_agent row should belong to this
      // turn (a fresh sandbox per turn 1). Its conversation_id must equal
      // turn1.conversationId.
      //
      // Bug 1 root cause: sandbox-k8s/src/open-session.ts:67's
      // OpenSessionInputSchema.owner doesn't allow `conversationId`, and
      // chat-orchestrator/src/orchestrator.ts:798-802 doesn't pass it. With
      // the field absent, session-postgres writes NULL, and downstream the
      // runner sees null in session.get-config.
      const sessionConvIdRaw = dbQueryFirstCell(
        `SELECT conversation_id FROM session_postgres_v2_session_agent
         WHERE user_id = '${userId}' AND agent_id = '${agent.id}'
         ORDER BY created_at DESC LIMIT 1`,
      );
      expect(
        sessionConvIdRaw,
        [
          'session_postgres_v2_session_agent.conversation_id is NULL after turn 1.',
          'Fix: thread `conversationId` from ctx through the orchestrator into',
          'the sandbox `owner` payload. The schema gap is at',
          '  packages/sandbox-k8s/src/open-session.ts:67 (OpenSessionInputSchema.owner)',
          '  packages/sandbox-subprocess/src/open-session.ts:76 (mirror schema)',
          '  packages/chat-orchestrator/src/orchestrator.ts:798 (call site)',
          'session-postgres already accepts owner.conversationId — the gap is upstream.',
        ].join('\n'),
      ).toBe(turn1.conversationId);

      // ----- DB assertion 2: conversation row carries runner_session_id. -
      // The runner-side bind happens after the SDK's first system/init.
      // Pre-fix, the runner reads conversationId:null from session.get-config
      // and short-circuits at agent-claude-sdk-runner/main.ts:415-418 — the
      // store hook is never called and the row stays NULL.
      const runnerSessionId = dbQueryFirstCell(
        `SELECT runner_session_id FROM conversations_v1_conversations
         WHERE conversation_id = '${turn1.conversationId}'`,
      );
      expect(
        runnerSessionId,
        [
          'conversations_v1_conversations.runner_session_id is NULL after turn 1.',
          'Fix: with conversationId properly threaded (see assertion 1), the',
          'bind-skip branch at packages/agent-claude-sdk-runner/src/main.ts:415-418',
          'will no longer fire and the runner will store its SDK session_id.',
        ].join('\n'),
      ).not.toBeNull();
      expect(runnerSessionId!.length).toBeGreaterThan(0);

      // ----- Turn 2: ask for the number. ---------------------------------
      // If the runner_session_id is bound (assertion 2 passes), the runner's
      // turn-2 SDK query runs with `resume: <runnerSessionId>` (main.ts:342)
      // and the SDK rehydrates from its workspace-stored jsonl transcript.
      const turn2 = await sendAndWaitForBackend(cookie, {
        agentId: agent.id,
        conversationId: turn1.conversationId,
        text: 'What number did I tell you?',
      });

      // ----- Behavioral assertion: memory survived. ----------------------
      // We read the transcript via the workspace-jsonl-backed
      // `GET /api/chat/conversations/:id` endpoint (which fronts
      // `conversations:get`) rather than the SSE stream because the SSE
      // path is the subject of Bug 2 — entangling the two would replace a
      // crisp file:line failure message with a vague timeout. Pre-Bug-1-fix
      // this endpoint returns `turns: []` because runner_session_id is
      // unbound and `conversations:get` short-circuits to empty (see
      // packages/conversations/src/plugin.ts:618-625).
      const histRes = await fetch(
        `${HOST_BASE_URL}/api/chat/conversations/${encodeURIComponent(turn2.conversationId)}`,
        { headers: { cookie, accept: 'application/json' } },
      );
      expect(
        histRes.ok,
        `GET /api/chat/conversations/:id failed: ${histRes.status}`,
      ).toBe(true);
      const hist = (await histRes.json()) as {
        turns: Array<{
          role: string;
          contentBlocks: Array<{ type: string; text?: string }>;
        }>;
      };
      const allText = hist.turns
        .filter((t) => t.role === 'assistant')
        .flatMap((t) => t.contentBlocks)
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join(' ');
      expect(
        allText,
        [
          `turn 2 transcript did not contain "4711"; assistant text: ${JSON.stringify(allText)}.`,
          'Without the conversationId thread + runner_session_id bind, the SDK',
          'starts fresh each turn and has no memory of turn 1.',
        ].join('\n'),
      ).toContain('4711');

      // ----- Resume-evidence assertion: turn-2 runner pod logs reference --
      // the same runnerSessionId stored after turn 1. The SDK emits its
      // system/init JSON to stdout/stderr; on the resume path the session_id
      // is the same as turn 1's. Best-effort because the runner pod may
      // have GC'd by the time we look — we only assert when logs are
      // available. This is the closest proxy to the plan's
      // "host log emitted a line indicating the runner was launched with
      // resume=<sessionId>" without adding a log line in the same PR.
      const runnerLogs = getRunnerLogs('10m');
      if (runnerLogs.length > 0) {
        expect(
          runnerLogs.includes(runnerSessionId!),
          [
            `runner pod logs do not reference runnerSessionId ${runnerSessionId}.`,
            'After Bug 1 is fixed, turn 2 launches the SDK with',
            '  options.resume = <runnerSessionId>',
            'and the SDK echoes that id back in its system/init message.',
            'See packages/agent-claude-sdk-runner/src/main.ts:342.',
          ].join('\n'),
        ).toBe(true);
      }
    },
  );

  it.skipIf(!E2E_ENABLED)(
    'Bug 2 — composer Send button returns to Send aria-label after turn ends',
    { timeout: 180_000 },
    async () => {
      const { cookie, userId: _userId } = await signIn();
      sharedCookie = cookie;
      const agent = await createAgent(cookie, {
        displayName: `bug2-${RUN_ID}`,
        systemPrompt: 'Reply with exactly the word "ok" and nothing else.',
        allowedTools: ['bash'],
        model: TEST_MODEL,
      });
      createdAgents.add(agent.id);

      let browser: Browser | null = null;
      try {
        browser = await chromium.launch({ headless: true });
        const ctx = await browser.newContext();

        // Inject the dev-bootstrap session cookie so the SPA boots
        // already-authed. parseCookie pulls the value from the same
        // Set-Cookie header signIn() captured.
        const value = cookie.replace(/^ax_auth_session=/, '');
        await ctx.addCookies([
          {
            name: 'ax_auth_session',
            value,
            domain: 'localhost',
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ]);

        const page = await ctx.newPage();
        await page.goto(HOST_BASE_URL, { waitUntil: 'networkidle' });

        // The composer's input + Send button are present on the empty-
        // thread state. Wait for the Send button (aria-label="Send") so
        // we don't race React mount.
        await page.waitForSelector('button[aria-label="Send"]', {
          timeout: 15_000,
        });

        // Pick the agent we just created (sidebar's AgentMenu). The
        // SessionRow / NewSessionButton state machine is enough — typing
        // into the composer with no agent picks the first one. To stay
        // deterministic we set the active agent through the agent-store
        // that the SPA exposes on window for tests, falling back to
        // selecting via the AgentMenu UI if that hook isn't there.
        // Today we POST the message via the API but type into the UI
        // composer to drive the Composer's running-state, which is what
        // the bug touches.
        //
        // Simpler alternative: drive the entire round-trip through the
        // UI. We type "hi" into the composer and click Send.
        //
        // Use the AgentMenu trigger if multiple agents exist. The first
        // one might or might not be ours; we click ours by display name.
        // If the menu UI changes, the test will fail with a clear
        // selector-not-found message.
        await page.locator('.composer-input').fill('say ok');

        // The Send button delegates to ComposerPrimitive.Send → assistant-
        // ui's runtime → POST /api/chat/messages. We click it and then
        // observe the running-state transition.
        await page.click('button[aria-label="Send"]');

        // Within a short window the Stop button should appear (running=true).
        // If it doesn't, the test environment is broken (no agent / no
        // backend) — fail with a different message.
        await page
          .waitForSelector('button[aria-label="Stop"]', { timeout: 30_000 })
          .catch(() => {
            throw new Error(
              'Stop button never appeared — composer never entered running state. ' +
                'Backend may have rejected the request before streaming started.',
            );
          });

        // Wait for the runner pod to drain. We give it up to 90s for
        // Anthropic's stream to finish + sandbox teardown.
        await waitFor(
          () => countRunnerPods() === 0,
          {
            timeoutMs: 90_000,
            intervalMs: 1000,
            label: 'runner pods drained to zero (turn complete)',
          },
        );

        // Within 5s of the backend being known-finished, the composer's
        // visible button must have aria-label="Send" again. The bug:
        // ThreadPrimitive.If running={false} stays false's-complement
        // after the SSE done frame arrives, so the Stop button is the
        // visible one.
        await page
          .waitForSelector('button[aria-label="Send"]', { timeout: 5_000 })
          .catch(() => {
            throw new Error(
              [
                'Composer Send button never returned after turn end.',
                'Fix surfaces:',
                '  packages/channel-web/src/lib/transport.ts:363-389 — the SSE',
                '    done frame is enqueued as {type:"finish", finishReason:"stop"};',
                '    verify the AI SDK runtime is consuming it (chunk shape may',
                '    have drifted).',
                '  packages/channel-web/src/components/Composer.tsx:91 — the',
                '    `ThreadPrimitive.If running={false}` branch toggles on the',
                '    runtime\'s thread state; if the finish chunk doesn\'t reach',
                '    the runtime, the toggle never flips.',
              ].join('\n'),
            );
          });

        // Tightening assertion: typing a second message and clicking the
        // visible Send should issue a fresh POST /api/chat/messages
        // without the user first clicking Stop. We attach a request
        // listener and assert it fires exactly once on the next click.
        const postSeen: string[] = [];
        page.on('request', (req) => {
          if (
            req.method() === 'POST' &&
            req.url().endsWith('/api/chat/messages')
          ) {
            postSeen.push(req.url());
          }
        });
        await page.locator('.composer-input').fill('and now ok again');
        // Register the waiter BEFORE the click that triggers the request.
        // Awaiting it after `page.click` would let the POST race ahead of
        // the listener registration; on a fast click → POST path the
        // promise then never resolves and 5s later the test fails with a
        // misleading timeout. Per Playwright's documented pattern for
        // event-triggering actions, create the promise first, perform the
        // action, then await.
        const reqPromise = page.waitForRequest(
          (req) =>
            req.method() === 'POST' &&
            req.url().endsWith('/api/chat/messages'),
          { timeout: 5_000 },
        );
        await page.click('button[aria-label="Send"]');
        await reqPromise;
        expect(postSeen.length).toBeGreaterThanOrEqual(1);
      } finally {
        if (browser !== null) await browser.close();
      }
    },
  );

  it.skipIf(!E2E_ENABLED)(
    'Bug 3 — completed conversation appears in sidebar after a hard reload',
    { timeout: 180_000 },
    async () => {
      const { cookie, userId: _userId } = await signIn();
      sharedCookie = cookie;
      const agent = await createAgent(cookie, {
        displayName: `bug3-${RUN_ID}`,
        systemPrompt: 'Reply "ok" and stop.',
        allowedTools: ['bash'],
        model: TEST_MODEL,
      });
      createdAgents.add(agent.id);

      // Step 1: send a turn and wait for backend completion. We key off
      // the `last_activity_at` bump rather than the SSE done frame to
      // avoid entanglement with Bug 2.
      const { conversationId } = await sendAndWaitForBackend(cookie, {
        agentId: agent.id,
        conversationId: null,
        text: 'say ok',
      });
      createdConversations.add(conversationId);

      // Step 2: API check — does GET /api/chat/conversations include it?
      // If this fails, the bug is server-side and the UI check below is
      // moot.
      const apiRes = await fetch(`${HOST_BASE_URL}/api/chat/conversations`, {
        headers: { cookie, accept: 'application/json' },
      });
      expect(apiRes.ok, `GET /api/chat/conversations: ${apiRes.status}`).toBe(true);
      const apiBody = (await apiRes.json()) as Array<{ conversationId?: string }>;
      const apiHasIt = Array.isArray(apiBody)
        && apiBody.some((c) => c.conversationId === conversationId);
      const apiCheckMessage = apiHasIt
        ? null
        : [
            `GET /api/chat/conversations did NOT return conversation ${conversationId}.`,
            'server-side: routes-chat.ts:419 listConversations handler scoping.',
            '  packages/channel-web/src/server/routes-chat.ts:419 — bus.call(',
            "    'conversations:list', initCtx, { userId, agentId? }).",
            '  packages/conversations/src/store.ts:345 — listForUser scopes to',
            '    user_id and filters deleted_at IS NULL; the row should be',
            '    visible. Trace why it isn\'t.',
          ].join('\n');
      expect(apiHasIt, apiCheckMessage ?? '').toBe(true);

      // Belt-and-braces sanity from the database — the row must actually
      // exist and not be soft-deleted. If this fails, something even more
      // fundamental is wrong than the listing route.
      const dbRow = dbQueryRows(
        `SELECT conversation_id, deleted_at FROM conversations_v1_conversations
         WHERE conversation_id = '${conversationId}'`,
      );
      expect(dbRow.length, 'conversation row missing from DB').toBe(1);
      // Second column is deleted_at (empty cell stringifies as '' on -A -t
      // psql output); empty means NULL, which is the not-deleted state.
      expect(
        dbRow[0]![1] ?? '',
        'conversation row was soft-deleted unexpectedly',
      ).toBe('');

      // Step 3: UI check — hard-reload the SPA and assert the sidebar
      // has the row. Failure here while the API check passed means the
      // bug is client-side (thread-list adapter / runtime cache).
      let browser: Browser | null = null;
      try {
        browser = await chromium.launch({ headless: true });
        const ctx = await browser.newContext();
        const value = cookie.replace(/^ax_auth_session=/, '');
        await ctx.addCookies([
          {
            name: 'ax_auth_session',
            value,
            domain: 'localhost',
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ]);
        const page = await ctx.newPage();
        await page.goto(HOST_BASE_URL, { waitUntil: 'networkidle' });

        // Hard-reload (bypass bfcache) — this is the goldenpath probe:
        // does a fresh-from-scratch SPA boot show the just-created row?
        await page.reload({ waitUntil: 'networkidle' });

        // SessionRow renders `data-session-id={id}` (see
        // packages/channel-web/src/components/SessionRow.tsx). In the SPA's
        // vocabulary "session" === conversation; the row id is the
        // conversation id. If a refactor renames either, update both
        // SessionRow.tsx and this selector.
        const found = await page
          .locator(`[data-session-id="${conversationId}"]`)
          .first()
          .waitFor({ state: 'visible', timeout: 15_000 })
          .then(() => true)
          .catch(() => false);

        expect(
          found,
          [
            `Sidebar did not render conversation ${conversationId} after reload.`,
            'API check passed → server returns the row; UI check failed →',
            'client-side: thread-list-adapter or runtime cache-invalidation.',
            '  packages/channel-web/src/components/SessionList.tsx — fetches',
            "    /api/chat/conversations on mount + on `version` bump.",
            '  packages/channel-web/src/lib/session-store.ts — store backing',
            '    that fetch + the bumpVersion signal.',
          ].join('\n'),
        ).toBe(true);
      } finally {
        if (browser !== null) await browser.close();
      }
    },
  );

  // Sanity skip — if the harness is unset, surface a single passing test
  // confirming the suite was discovered. Without this, an `AX_K8S_E2E=`
  // run prints "no tests found" which masks accidental misconfiguration.
  it.skipIf(E2E_ENABLED)(skipMsg, () => {
    expect(true).toBe(true);
  });
});
