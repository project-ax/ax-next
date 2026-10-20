/**
 * The seam this card exists to close: one event, two tabs, one clock.
 *
 * A walk against the deployment read the SAME message as `12:56 AM` in the chat
 * tab and `8:56 PM yesterday` in the `did` (Activity) tab — four hours and one
 * calendar day apart, with nothing on either label saying which timezone it was
 * speaking in. The chat bubble's clock was formatted on the SERVER, in the
 * SERVER's zone; the feed's was formatted in the browser, in the READER's. Both
 * were internally consistent and one of them was wrong for every reader outside
 * the host's zone.
 *
 * WHY THIS TEST MOVES `process.env.TZ`, AND WHY IT WOULD BE VACUOUS OTHERWISE.
 * A timezone test run entirely in one zone passes against the UNFIXED code:
 * `shortTime` would be formatting in the same zone the renderer reads back, so
 * the two surfaces would agree by accident and the assertion would prove
 * nothing. The disagreement only exists when the host and the reader sit in
 * different zones, so that is what this reproduces — the wire is built with the
 * process in `UTC` (the host), and only then does the process move to
 * `America/New_York` (the reader) for the rendering. Measured on Node 24:
 * assigning `process.env.TZ` takes effect immediately, on already-constructed
 * `Date` objects included.
 *
 * The instant and the zones are the walk's own: `2026-09-19T00:56:00.000Z` read
 * from UTC is `12:56 AM` on the 19th, and read from EDT is `8:56 PM` on the
 * 18th. Against the unfixed code this file fails on its first assertion with
 * exactly those two strings.
 *
 * Locale, deliberately, is NOT pinned. Production formats in the reader's
 * locale (`toLocaleTimeString(undefined, …)`) and pinning one here would test a
 * formatter this code does not use. So the expectations are derived rather than
 * literal: what must hold is that the two surfaces agree, that what they agree
 * on is the READER's instant, and that it is not what the host would have said.
 * Under the `en-US` default those three read `8:56 PM`, `8:56 PM`, `12:56 AM`.
 */
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  HookBus,
  PluginError,
  makeAgentContext,
  type AgentContext,
} from '@ax/core';
import { makeWorkspaceHandlers } from '@/server/routes-workspace';
import type { RouteRequest, RouteResponse } from '@/server/routes-chat';
import { AgentConversation } from '@/components/workspace/AgentConversation';
import { ActivityFeed } from '@/components/workspace/ActivityFeed';
import type {
  ActivityEvent,
  PastConversation,
  ThreadMessage,
  WorkspaceAgent,
} from '@/lib/workspace-api';

/** The walk's instant. `00:56Z` is late evening the PREVIOUS day in EDT. */
const INSTANT = '2026-09-19T00:56:00.000Z';
/** Mid-morning on the 19th in EDT, so `INSTANT` falls under "Yesterday". */
const NOW = '2026-09-19T14:00:00.000Z';
const HOST_TZ = 'UTC';
const READER_TZ = 'America/New_York';

/** An older conversation, for the "Previous conversations" row. */
const PAST_INSTANT = '2026-09-12T18:00:00.000Z';

const REPLY = 'Done — the invoice went out.';

/**
 * The formatter this card DELETED, kept here as the thing the fix must stop
 * producing. Run with the process in `HOST_TZ` it answers what the server used
 * to put on the wire, which is the string every assertion below is measured
 * against. Inlined rather than imported precisely because the production copy
 * is gone: if someone re-adds a server-side formatter, this constant is what
 * the new bubble would have to match, and the test says it must not.
 */
function asTheHostWouldHaveSaid(iso: string): string {
  const d = new Date(iso);
  const h24 = d.getHours();
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, '0')} ${suffix}`;
}

const quill: WorkspaceAgent = {
  id: 'a1',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

/**
 * Whatever clock the surface drew, read back out of the DOM rather than
 * asserted into it — the point is to compare what two components said, and a
 * reader that only matches the expected string cannot report the wrong one.
 *
 * Accepts a 24-hour reading too, so the helper does not quietly assume the
 * `en-US` default the expectations avoid depending on.
 */
function readClock(container: HTMLElement): string {
  const seen = new Set<string>();
  for (const el of container.querySelectorAll('div, span, time, p')) {
    const text = (el.textContent ?? '').trim();
    if (/^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(text)) seen.add(text);
  }
  const hits = [...seen];
  if (hits.length === 0) throw new Error('no clock was rendered');
  if (hits.length > 1) {
    throw new Error(`expected one clock, found: ${hits.join(' / ')}`);
  }
  return hits[0]!;
}

/**
 * The feed's day heading — the bucket label, not the row count beside it.
 *
 * Found by SHAPE rather than by position. "The first `span` in the container"
 * happens to be the heading today only because this test scopes the feed to one
 * agent, which drops the agent-name button that would otherwise come first; a
 * fixture that stopped passing `agentId` would silently start reading a
 * different node and the assertion below would be about the wrong thing.
 *
 * `Today` / `Yesterday` / a rendered date, and nothing else, so a wrong node is
 * a thrown error rather than a quiet pass.
 */
function readDayLabel(container: HTMLElement): string {
  const seen = new Set<string>();
  for (const el of container.querySelectorAll('span')) {
    const text = (el.textContent ?? '').trim();
    if (text === 'Today' || text === 'Yesterday' || /\d/.test(text)) {
      // The count badge is a bare number; the heading never is.
      if (/^\d+$/.test(text)) continue;
      if (/^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(text)) continue;
      seen.add(text);
    }
  }
  const hits = [...seen];
  if (hits.length === 0) throw new Error('no day heading was rendered');
  if (hits.length > 1) {
    throw new Error(`expected one day heading, found: ${hits.join(' / ')}`);
  }
  return hits[0]!;
}

// ---------------------------------------------------------------------------
// The wire: the real `GET /api/workspace/agents/:id` over a stubbed transcript.
// ---------------------------------------------------------------------------

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

function mkReq(): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query: {},
    params: { agentId: 'a1' },
    signedCookie: () => null,
  } as unknown as RouteRequest;
}

function mkRes(): {
  res: RouteResponse;
  captured: { status: number; body: unknown };
} {
  const captured = { status: 0, body: undefined as unknown };
  const res = {
    status(n: number) {
      captured.status = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
    },
    text() {},
    end() {},
  } as unknown as RouteResponse;
  return { res, captured };
}

function conversation(id: string, lastActivityAt: string | null) {
  return {
    conversationId: id,
    userId: 'u1',
    agentId: 'a1',
    title: id === 'c1' ? null : 'The invoice thread',
    activeSessionId: null,
    activeReqId: null,
    createdAt: id === 'c1' ? INSTANT : PAST_INSTANT,
    lastActivityAt,
  };
}

interface Wire {
  thread: ThreadMessage[];
  past: PastConversation[];
}

async function readWire(): Promise<Wire> {
  const bus = new HookBus();
  const notFound = (): PluginError =>
    new PluginError({ code: 'not-found', plugin: 'test', message: 'nope' });
  bus.registerService('auth:require-user', 'auth', async () => ({
    user: { id: 'u1', isAdmin: false },
  }));
  bus.registerService('agents:list-for-user', 'agents', async () => ({
    agents: [{ id: 'a1', displayName: 'Quill', visibility: 'personal' }],
  }));
  bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
    if ((i as { agentId: string }).agentId !== 'a1') throw notFound();
    return { agent: { id: 'a1', displayName: 'Quill', visibility: 'personal' } };
  });
  bus.registerService('conversations:list', 'conversations', async () => [
    conversation('c1', INSTANT),
    conversation('c0', PAST_INSTANT),
  ]);
  bus.registerService('conversations:get', 'conversations', async () => ({
    conversation: conversation('c1', INSTANT),
    turns: [
      {
        turnId: 't1',
        turnIndex: 0,
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'send the invoice' }],
        createdAt: INSTANT,
      },
      {
        turnId: 't2',
        turnIndex: 1,
        role: 'assistant',
        contentBlocks: [{ type: 'text', text: REPLY }],
        createdAt: INSTANT,
      },
    ],
  }));

  const handlers = makeWorkspaceHandlers({ bus, initCtx });
  const { res, captured } = mkRes();
  await handlers.agentDetail(mkReq(), res);
  expect(captured.status).toBe(200);
  return captured.body as Wire;
}

function conversationProps(
  thread: ThreadMessage[],
): ComponentProps<typeof AgentConversation> {
  return {
    agent: quill,
    thread,
    conversationId: 'c1',
    decisions: [],
    readOnly: false,
    onSend: vi.fn(),
    onApprove: vi.fn(),
    onDismiss: vi.fn(),
    onUndo: vi.fn(),
    approvalRead: 'ok',
    onRetryApprovals: vi.fn(),
    grants: [],
    onGrantResolved: vi.fn(),
    onGranted: vi.fn(async () => true),
  };
}

/** The same event, as the `did` feed carries it: an instant and nothing else. */
const activityRow: ActivityEvent = {
  id: `a1|invoice|${INSTANT}`,
  agentId: 'a1',
  at: INSTANT,
  text: REPLY,
  kind: 'done',
  detail: null,
  tag: null,
  decisionId: null,
};

describe('one event, two tabs', () => {
  let savedTz: string | undefined;

  beforeEach(() => {
    savedTz = process.env.TZ;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it('reads the same clock in the chat tab and the did tab, in the READER zone', async () => {
    // ---- the host, in UTC -------------------------------------------------
    process.env.TZ = HOST_TZ;
    const wire = await readWire();
    const hostReading = asTheHostWouldHaveSaid(INSTANT);

    // ---- the reader, in EDT -----------------------------------------------
    process.env.TZ = READER_TZ;
    // Only `Date` is faked. The React scheduler and RTL run on real timers, so
    // pinning "now" for the day bucket cannot deadlock the render.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));

    // The flip really took. Without this, a machine already sitting in EDT
    // would run the whole test in one zone and prove nothing — which is the
    // trap this file is built around.
    const readerSide = new Date(INSTANT);
    expect(readerSide.getHours()).toBe(20);
    expect(readerSide.getDate()).toBe(18);
    const readerReading = readerSide.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(readerReading).not.toBe(hostReading);

    const chat = render(<AgentConversation {...conversationProps(wire.thread)} />);
    const chatClock = readClock(chat.container);
    chat.unmount();

    const did = render(
      <ActivityFeed events={[activityRow]} agents={[quill]} agentId="a1" />,
    );
    const didClock = readClock(did.container);
    const didDay = readDayLabel(did.container);

    // ---- what the card asks for -------------------------------------------
    // The one assertion the card is named after. Against the unfixed code the
    // two sides read `12:56 AM` and `8:56 PM`.
    expect(chatClock).toBe(didClock);
    // ...and what they agree on is the READER's reading of the instant, not
    // the host's. Both halves matter: the first alone would pass if BOTH
    // surfaces regressed to the server's zone together.
    expect(chatClock).toBe(readerReading);
    expect(chatClock).not.toBe(hostReading);
    // The date boundary, which is the half that turns a four-hour error into a
    // wrong day: this event is the evening BEFORE the day the reader is in.
    expect(didDay).toBe('Yesterday');
    did.unmount();
  });

  it('carries an instant on the wire and no display string at all', async () => {
    process.env.TZ = HOST_TZ;
    const wire = await readWire();

    const agentMsg = wire.thread.find((m) => m.kind === 'agent');
    if (agentMsg === undefined) throw new Error('no agent message on the wire');
    expect(agentMsg.at).toBe(INSTANT);

    /*
      NEGATIVE SPACE, on purpose. `expect(agentMsg.at).toBe(INSTANT)` passes
      perfectly well on a message that ALSO still carries the old `time:
      '12:56 AM'` — a round-trip assertion cannot see a field that is merely
      extra. Pinning the whole key set is what makes "no display string on the
      wire" an enforced claim rather than a sentence in a PR description.
    */
    expect(Object.keys(agentMsg).sort()).toEqual(['at', 'id', 'kind', 'text']);

    const past = wire.past[0];
    if (past === undefined) throw new Error('no past conversation on the wire');
    expect(past.lastActivityAt).toBe(PAST_INSTANT);
    expect(Object.keys(past).sort()).toEqual(['id', 'lastActivityAt', 'title']);
  });
});
