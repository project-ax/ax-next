import {
  HookBus,
  MEMORY_PRE_CAPTURE_HOOK,
  MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS,
  PluginError,
  makeAgentContext,
  type AgentContext,
  type Logger,
} from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_CHECK_DEADLINE_MS, CAPTURE_VETO_KEY, channelCaptureVeto, subscribeCaptureVeto } from '../capture-veto.js';
import type { ChannelBinding, ChannelThread } from '../channel-store.js';

/*
  The "Let the agent remember this channel" switch (TASK-1094), as memory
  sees it: `memory:pre-capture { conversationId }` before every extraction
  pass and every `memory_note`. channel-slack refuses a conversation of one of
  its channel threads when an outsider's (external) turn ran in it, whatever
  the switch says; and a member's when the thread ever had a turn while the
  switch was off (sticky), when the channel is no longer connected to the
  thread's agent, or when the switch is off now. A conversation it never
  recorded (a web chat, a DM) gets no opinion. It fails closed: a lookup that
  throws, or that misses half of memory's own bound, refuses.
*/

const INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const SUPPORT = 'C07SUPPORT1';
const AGENT = 'agt_support';
const THREAD = 'conv-support-thread';

const REFUSED = { rejected: true, reason: 'channel-not-remembered' };
/** An outsider's thread: never remembered, whatever the switch says. */
const OUTSIDER_THREAD = { rejected: true, reason: 'channel-external-turn' };

/** A member's thread of #support, remembered, unless told otherwise. */
const thread = (o: Partial<ChannelThread> = {}): ChannelThread => ({
  installId: INSTALL,
  channelId: SUPPORT,
  agentId: AGENT,
  notRemembered: false,
  external: false,
  ...o,
});

const binding = (o: Partial<ChannelBinding> = {}): ChannelBinding => ({
  installId: INSTALL,
  channelId: SUPPORT,
  agentId: AGENT,
  connectedByUserId: 'usr_ada',
  channelName: 'support',
  remember: true,
  createdAt: new Date('2026-11-13T09:00:00Z'),
  ...o,
});

/**
 * The two reads the veto makes: the thread map, and the channel's binding.
 * `binding: null` is a channel with nothing connected; an Error is a read
 * that fails.
 */
function channelsWith(o: {
  threads?: Record<string, ChannelThread>;
  binding?: ChannelBinding | null | Error;
  threadLookup?: Error;
} = {}) {
  return {
    getThread: vi.fn(async (conversationId: string): Promise<ChannelThread | null> => {
      if (o.threadLookup !== undefined) throw o.threadLookup;
      return o.threads?.[conversationId] ?? null;
    }),
    get: vi.fn(async (installId: string, channelId: string): Promise<ChannelBinding | null> => {
      const b = o.binding === undefined ? binding() : o.binding;
      if (b instanceof Error) throw b;
      return b !== null && b.installId === installId && b.channelId === channelId ? b : null;
    }),
  };
}

interface Line {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function recordingLogger(o: { throws?: boolean } = {}): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, msg, fields });
      if (o.throws === true) throw new Error('log sink down');
    };
  const logger: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: () => logger };
  return { logger, lines };
}

/** A memory pass on the thread's conversation: an outsider's turn, run as the connector. */
function pass(o: Partial<Parameters<typeof makeAgentContext>[0]> = {}): AgentContext {
  return makeAgentContext({
    sessionId: 's',
    agentId: AGENT,
    userId: 'usr_ada',
    conversationId: THREAD,
    source: 'external',
    audience: 'shared',
    logger: recordingLogger().logger,
    ...o,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('channelCaptureVeto: what the switch refuses', () => {
  it('a conversation it never recorded (a web chat, a DM) gets no opinion, and no binding is read', async () => {
    const channels = channelsWith();
    expect(await channelCaptureVeto(channels, pass({ conversationId: 'conv-web' }), { conversationId: 'conv-web' })).toBeUndefined();
    expect(channels.getThread).toHaveBeenCalledWith('conv-web');
    expect(channels.get).not.toHaveBeenCalled();
  });

  it('a thread whose channel is connected, with the switch on, that never had a turn while off: no opinion', async () => {
    const channels = channelsWith({ threads: { [THREAD]: thread() } });
    expect(await channelCaptureVeto(channels, pass(), { conversationId: THREAD })).toBeUndefined();
    expect(channels.get).toHaveBeenCalledWith(INSTALL, SUPPORT);
  });

  it.each([
    ['a thread that had a turn while the switch was off, though it is on now', { threads: { [THREAD]: thread({ notRemembered: true }) } }],
    ['the switch is off now', { threads: { [THREAD]: thread() }, binding: binding({ remember: false }) }],
    ['the channel is no longer connected (disconnected, or its install removed)', { threads: { [THREAD]: thread() }, binding: null }],
    ['the channel is connected to another agent now', { threads: { [THREAD]: thread() }, binding: binding({ agentId: 'agt_sales' }) }],
  ] as const)('refuses: %s', async (_name, world) => {
    expect(await channelCaptureVeto(channelsWith(world), pass(), { conversationId: THREAD })).toEqual(REFUSED);
  });

  it("is keyed on the conversation, never on who asks: any source, user or agent on a tainted thread is refused", async () => {
    const channels = channelsWith({ threads: { [THREAD]: thread({ notRemembered: true }) } });
    const noSource = makeAgentContext({ sessionId: 's', agentId: AGENT, userId: 'usr_ada', conversationId: THREAD });
    for (const ctx of [
      pass(),
      pass({ source: 'user', userId: 'usr_alice' }),
      pass({ source: 'routine' }),
      pass({ agentId: 'agt_sales' }),
      noSource,
    ]) {
      expect(await channelCaptureVeto(channels, ctx, { conversationId: THREAD }), ctx.source ?? 'no source').toEqual(REFUSED);
    }
  });

  it('a tainted thread is refused before its binding is read: nothing it could answer changes that', async () => {
    const channels = channelsWith({ threads: { [THREAD]: thread({ notRemembered: true }) }, binding: binding({ remember: true }) });
    expect(await channelCaptureVeto(channels, pass(), { conversationId: THREAD })).toEqual(REFUSED);
    expect(channels.get).not.toHaveBeenCalled();
  });
});

describe("channelCaptureVeto: an outsider's thread is never remembered", () => {
  /*
    An outsider's turn runs `audience: 'shared'`, and a team agent recalls
    shared memory in every turn, a member's private chat included. Learned,
    an outsider's words would come back as facts with a member's authority,
    so the switch governs members' (attended) threads only.
  */
  it.each([
    ['the switch on, the channel connected, never a turn while off', thread({ external: true })],
    ['and a turn while the switch was off too', thread({ external: true, notRemembered: true })],
    ['a flag that is anything but false (fails closed)', thread({ external: undefined as unknown as boolean })],
  ] as const)('refuses it: %s, before any binding is read', async (_name, outsider) => {
    const channels = channelsWith({ threads: { [THREAD]: outsider }, binding: binding({ remember: true }) });
    expect(await channelCaptureVeto(channels, pass(), { conversationId: THREAD })).toEqual(OUTSIDER_THREAD);
    expect(channels.get).not.toHaveBeenCalled();
  });

  it("a member's thread of the same Slack thread is remembered while the switch is on", async () => {
    // One Slack thread, two conversations: the member's own, and the connector's for outsiders.
    const member = 'conv-support-thread-member';
    const channels = channelsWith({ threads: { [THREAD]: thread({ external: true }), [member]: thread() } });
    const memberPass = pass({ conversationId: member, source: 'user', userId: 'usr_alice' });
    expect(await channelCaptureVeto(channels, memberPass, { conversationId: member })).toBeUndefined();
    expect(await channelCaptureVeto(channels, pass(), { conversationId: THREAD })).toEqual(OUTSIDER_THREAD);
  });

  it("memory_note in an outsider's turn asks as memory asks (the turn's own ctx and its conversation id) and is refused", async () => {
    const bus = new HookBus();
    subscribeCaptureVeto(bus, channelsWith({ threads: { [THREAD]: thread({ external: true }) } }));
    // @ax/memory's captureRefusal: the tool call's ctx, its host-set conversationId as the payload, memory's bound.
    const noteCtx = pass();
    expect(
      await bus.fire(MEMORY_PRE_CAPTURE_HOOK, noteCtx, { conversationId: noteCtx.conversationId }, {
        subscriberTimeoutMs: MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS,
      }),
    ).toEqual({ ...OUTSIDER_THREAD, source: CAPTURE_VETO_KEY });
  });

  it("refuses when either id it asks about is an outsider's thread", async () => {
    const channels = channelsWith({ threads: { [THREAD]: thread({ external: true }) } });
    expect(await channelCaptureVeto(channels, pass({ conversationId: 'conv-web' }), { conversationId: THREAD })).toEqual(
      OUTSIDER_THREAD,
    );
    expect(await channelCaptureVeto(channels, pass({ conversationId: THREAD }), { conversationId: 'conv-web' })).toEqual(
      OUTSIDER_THREAD,
    );
  });
});

describe('channelCaptureVeto: which conversation it asks about', () => {
  it('asks about the host-set ctx.conversationId AND the payload id, and refuses when either is refused', async () => {
    const channels = channelsWith({ threads: { [THREAD]: thread({ notRemembered: true }) } });
    // The pass is on the tainted thread, but the payload (rewritten by an earlier subscriber) names a web chat.
    expect(await channelCaptureVeto(channels, pass({ conversationId: THREAD }), { conversationId: 'conv-web' })).toEqual(REFUSED);
    expect(channels.getThread.mock.calls.map(([id]) => id).sort()).toEqual(['conv-web', THREAD].sort());
    // And a payload naming the tainted thread is refused whatever ctx says.
    expect(await channelCaptureVeto(channels, pass({ conversationId: 'conv-web' }), { conversationId: THREAD })).toEqual(REFUSED);
    // Neither is a refused thread: no opinion.
    expect(await channelCaptureVeto(channels, pass({ conversationId: 'conv-web' }), { conversationId: 'conv-dm' })).toBeUndefined();
  });

  it('falls back to ctx.conversationId when the payload is unreadable, and asks nothing when there is no conversation', async () => {
    const channels = channelsWith({ threads: { [THREAD]: thread({ notRemembered: true }) } });
    expect(await channelCaptureVeto(channels, pass(), { conversationId: 7 })).toEqual(REFUSED);
    expect(channels.getThread).toHaveBeenCalledWith(THREAD);

    const none = channelsWith({ threads: { [THREAD]: thread({ notRemembered: true }) } });
    const noConversation = makeAgentContext({ sessionId: 's', agentId: AGENT, userId: 'usr_ada' });
    expect(await channelCaptureVeto(none, noConversation, null)).toBeUndefined();
    expect(await channelCaptureVeto(none, pass({ conversationId: '' }), { conversationId: '' })).toBeUndefined();
    expect(none.getThread).not.toHaveBeenCalled();
  });

  it('a payload that throws when read is refused, not skipped', async () => {
    const poisoned = {
      get conversationId(): string {
        throw new Error('unreadable');
      },
    };
    expect(await channelCaptureVeto(channelsWith(), pass({ conversationId: 'conv-web' }), poisoned)).toEqual(REFUSED);
  });
});

describe('channelCaptureVeto: fails closed', () => {
  it.each([
    ['the thread lookup', { threadLookup: Object.assign(new Error('PRIVATE pg text at 10.0.0.7 conv-support-thread'), { code: '57P01' }) }, '57P01'],
    [
      'the binding lookup',
      {
        threads: { [THREAD]: thread() },
        binding: new PluginError({ code: 'store-unavailable', plugin: 'fake-store', message: `db down: ${SUPPORT}` }),
      },
      'store-unavailable',
    ],
  ] as const)('refuses when %s throws, and logs its code alone', async (_name, world, code) => {
    const { logger, lines } = recordingLogger();
    expect(await channelCaptureVeto(channelsWith(world), pass({ logger }), { conversationId: THREAD })).toEqual(REFUSED);
    expect(lines).toEqual([{ level: 'warn', msg: 'slack_capture_check_failed', fields: { code } }]);
    // No conversation, channel, install or agent id, and none of the failure's text.
    const all = JSON.stringify(lines);
    for (const leak of [THREAD, SUPPORT, INSTALL, AGENT, 'PRIVATE', 'db down']) expect(all, leak).not.toContain(leak);
  });

  it('refuses when the thread lookup takes longer than its deadline, and not a moment before', async () => {
    vi.useFakeTimers();
    const { logger, lines } = recordingLogger();
    const hung = { getThread: vi.fn(() => new Promise<never>(() => {})), get: vi.fn() };
    let settled: unknown = 'pending';
    const asked = channelCaptureVeto(hung, pass({ logger }), { conversationId: THREAD }).then((r) => {
      settled = r;
    });
    await vi.advanceTimersByTimeAsync(CAPTURE_CHECK_DEADLINE_MS - 1);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await asked;
    expect(settled).toEqual(REFUSED);
    expect(lines).toEqual([{ level: 'warn', msg: 'slack_capture_check_failed', fields: { code: 'timeout' } }]);
  });

  it('refuses when the binding lookup hangs past a deadline it was given', async () => {
    vi.useFakeTimers();
    const slow = { getThread: vi.fn(async () => thread()), get: vi.fn(() => new Promise<never>(() => {})) };
    const asked = channelCaptureVeto(slow, pass(), { conversationId: THREAD }, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await asked).toEqual(REFUSED);
  });

  it('leaves no timer behind once it has answered', async () => {
    vi.useFakeTimers();
    expect(await channelCaptureVeto(channelsWith({ threads: { [THREAD]: thread() } }), pass(), { conversationId: THREAD })).toBeUndefined();
    expect(await channelCaptureVeto(channelsWith({ threadLookup: new Error('down') }), pass(), { conversationId: THREAD })).toEqual(REFUSED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers inside memory's own subscriber bound, so a slow lookup is refused, not skipped", () => {
    expect(CAPTURE_CHECK_DEADLINE_MS).toBe(MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS / 2);
    expect(CAPTURE_CHECK_DEADLINE_MS).toBeLessThan(MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS);
  });

  it("a logger that throws doesn't stop the refusal", async () => {
    const { logger } = recordingLogger({ throws: true });
    expect(await channelCaptureVeto(channelsWith({ threadLookup: new Error('down') }), pass({ logger }), { conversationId: THREAD })).toEqual(
      REFUSED,
    );
  });
});

describe('subscribeCaptureVeto', () => {
  const fire = (bus: HookBus, conversationId: string) =>
    bus.fire(MEMORY_PRE_CAPTURE_HOOK, pass({ conversationId }), { conversationId }, {
      subscriberTimeoutMs: MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS,
    });

  it('answers memory:pre-capture on the bus as CAPTURE_VETO_KEY; the function it returns takes it off', async () => {
    const bus = new HookBus();
    const off = subscribeCaptureVeto(
      bus,
      channelsWith({ threads: { 'conv-off': thread({ notRemembered: true }), 'conv-on': thread() } }),
    );

    // memory logs `source` as the subscriber that refused, and `reason` as its word for why.
    expect(await fire(bus, 'conv-off')).toEqual({ ...REFUSED, source: CAPTURE_VETO_KEY });
    expect(await fire(bus, 'conv-on')).toEqual({ rejected: false, payload: { conversationId: 'conv-on' } });
    expect(await fire(bus, 'conv-web')).toEqual({ rejected: false, payload: { conversationId: 'conv-web' } });

    off();
    expect(await fire(bus, 'conv-off')).toEqual({ rejected: false, payload: { conversationId: 'conv-off' } });
    expect(bus.unsubscribe(MEMORY_PRE_CAPTURE_HOOK, CAPTURE_VETO_KEY)).toBe(0);
  });

  it('subscribing again replaces the veto an earlier run left (it outlives a shutdown): one answers, the newest', async () => {
    const bus = new HookBus();
    // The earlier run's store is gone: every lookup fails, so it would refuse everything.
    subscribeCaptureVeto(bus, channelsWith({ threadLookup: new Error('database closed') }));
    subscribeCaptureVeto(bus, channelsWith({ threads: { 'conv-on': thread() } }));

    expect(await fire(bus, 'conv-on')).toEqual({ rejected: false, payload: { conversationId: 'conv-on' } });
    expect(bus.unsubscribe(MEMORY_PRE_CAPTURE_HOOK, CAPTURE_VETO_KEY)).toBe(1);
  });
});
