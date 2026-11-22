import {
  HookBus,
  MEMORY_PRE_CAPTURE_HOOK,
  MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX,
  MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS,
  PluginError,
  makeAgentContext,
  type AgentContext,
  type Logger,
  type MemoryPreCapturePayload,
} from '@ax/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_CHECK_DEADLINE_MS, CAPTURE_VETO_KEY, channelCaptureVeto, subscribeCaptureVeto } from '../capture-veto.js';
import type { ChannelBinding, ChannelThread } from '../channel-store.js';
import { THREAD_SPEAKER_NAMES_MAX } from '../limits.js';

/*
  The capture veto (TASK-1094), as memory sees it: `memory:pre-capture
  { conversationId }` before every extraction pass and every `memory_note`.
  channel-slack refuses a conversation of one of its channel threads when an
  outsider's (external) turn ran in it; and a member's when the thread was
  marked before TASK-1203 (a turn while its channel was private, TASK-1188,
  or switched off, TASK-1202: sticky), or when the channel is no longer
  connected to the thread's agent. A private channel is remembered like any
  other (TASK-1203), and there is no per-channel memory switch (TASK-1202).
  A conversation it never recorded (a web chat, a DM) gets no opinion. It
  fails closed: a lookup that throws, or that misses half of memory's own
  bound, refuses.

  A member's thread it lets memory learn from is answered with the names
  their turns were labelled with (TASK-1146), so memory files nothing said
  there under the speaker's name.
*/

const INSTALL = 'q3VtZ0xH4kTn9Wb2LmPa1A';
const SUPPORT = 'C07SUPPORT1';
const AGENT = 'agt_support';
const THREAD = 'conv-support-thread';

const REFUSED = { rejected: true, reason: 'channel-not-remembered' };
/** An outsider's thread: never remembered. */
const OUTSIDER_THREAD = { rejected: true, reason: 'channel-external-turn' };
/**
 * The check itself failed (a lookup threw or ran out of time): refused, and
 * saying so, never that the channel refused it. Memory logs the reason.
 */
const CHECK_FAILED = { rejected: true, reason: 'capture-check-failed' };

/** A member's thread of #support, remembered, with no names recorded (a row from before TASK-1146), unless told otherwise. */
const thread = (o: Partial<ChannelThread> = {}): ChannelThread => ({
  installId: INSTALL,
  channelId: SUPPORT,
  agentId: AGENT,
  notRemembered: false,
  external: false,
  speakerNames: [],
  ...o,
});

const binding = (o: Partial<ChannelBinding> = {}): ChannelBinding => ({
  installId: INSTALL,
  channelId: SUPPORT,
  agentId: AGENT,
  connectedByUserId: 'usr_ada',
  channelName: 'support',
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

describe('channelCaptureVeto: what it refuses', () => {
  it('a conversation it never recorded (a web chat, a DM) gets no opinion, and no binding is read', async () => {
    const channels = channelsWith();
    expect(await channelCaptureVeto(channels, pass({ conversationId: 'conv-web' }), { conversationId: 'conv-web' })).toBeUndefined();
    expect(channels.getThread).toHaveBeenCalledWith('conv-web');
    expect(channels.get).not.toHaveBeenCalled();
  });

  it("a member's thread whose channel is connected to its agent: no opinion", async () => {
    const channels = channelsWith({ threads: { [THREAD]: thread() } });
    expect(await channelCaptureVeto(channels, pass(), { conversationId: THREAD })).toBeUndefined();
    expect(channels.get).toHaveBeenCalledWith(INSTALL, SUPPORT);
  });

  it('reads no memory switch (TASK-1202): a binding that still carries `remember: false`, as one from before the switch went would, lets memory in', async () => {
    const stray = { ...binding(), remember: false } as ChannelBinding;
    const channels = channelsWith({ threads: { [THREAD]: thread() }, binding: stray });
    expect(await channelCaptureVeto(channels, pass(), { conversationId: THREAD })).toBeUndefined();
  });

  // TASK-1203 (design §4c): a private channel is remembered like any other.
  // Before the fix the veto refused every thread of a binding that didn't
  // plainly say public.
  it('reads no privacy (TASK-1203): a binding that still carries `isPrivate: true`, as one from before the column went would, lets memory in', async () => {
    const stray = { ...binding(), isPrivate: true } as ChannelBinding;
    const channels = channelsWith({ threads: { [THREAD]: thread() }, binding: stray });
    expect(await channelCaptureVeto(channels, pass(), { conversationId: THREAD })).toBeUndefined();
  });

  it.each([
    ['the channel is no longer connected (disconnected, or its install removed)', { threads: { [THREAD]: thread() }, binding: null }],
    ['the channel is connected to another agent now', { threads: { [THREAD]: thread() }, binding: binding({ agentId: 'agt_sales' }) }],
  ] as const)('refuses: %s', async (_name, world) => {
    expect(await channelCaptureVeto(channelsWith(world), pass(), { conversationId: THREAD })).toEqual(REFUSED);
  });

  // Memory leaves its cursor where a refusal stopped it, so a thread marked
  // before TASK-1203 (a turn while its channel was private, TASK-1188, or
  // switched off, TASK-1202) stays refused: let in, the next pass would read
  // the turns said under the old promise.
  it('a thread marked before TASK-1203 is refused as channel-not-remembered, whatever its binding says', async () => {
    const marked = thread({ notRemembered: true, speakerNames: ['Mel', 'U07MEL00001'] });
    const bindings: Array<[string, ChannelBinding | null]> = [
      ['connected to its agent', binding()],
      ['carrying a stray isPrivate: false', { ...binding(), isPrivate: false } as ChannelBinding],
      ['no longer connected', null],
      ['connected to another agent', binding({ agentId: 'agt_sales' })],
    ];
    for (const [why, b] of bindings) {
      const channels = channelsWith({ threads: { [THREAD]: marked }, binding: b });
      expect(await channelCaptureVeto(channels, pass(), { conversationId: THREAD }), why).toEqual(REFUSED);
    }
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
    const channels = channelsWith({ threads: { [THREAD]: thread({ notRemembered: true }) }, binding: binding() });
    expect(await channelCaptureVeto(channels, pass(), { conversationId: THREAD })).toEqual(REFUSED);
    expect(channels.get).not.toHaveBeenCalled();
  });
});

describe("channelCaptureVeto: an outsider's thread is never remembered", () => {
  /*
    An outsider's turn runs `audience: 'shared'`, and a team agent recalls
    shared memory in every turn, a member's private chat included. Learned,
    an outsider's words would come back as facts with a member's authority,
    so memory learns only from members' (attended) threads.
  */
  it.each([
    ['the channel connected, the thread never marked', thread({ external: true })],
    ['and marked before TASK-1203 too', thread({ external: true, notRemembered: true })],
    ['a flag that is anything but false (fails closed)', thread({ external: undefined as unknown as boolean })],
  ] as const)('refuses it: %s, before any binding is read', async (_name, outsider) => {
    const channels = channelsWith({ threads: { [THREAD]: outsider }, binding: binding() });
    expect(await channelCaptureVeto(channels, pass(), { conversationId: THREAD })).toEqual(OUTSIDER_THREAD);
    expect(channels.get).not.toHaveBeenCalled();
  });

  it("a member's thread of the same Slack thread is remembered", async () => {
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
    // @ax/memory's captureCheck: the tool call's ctx, its host-set conversationId as the payload, memory's bound.
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
    expect(await channelCaptureVeto(channelsWith(), pass({ conversationId: 'conv-web' }), poisoned)).toEqual(CHECK_FAILED);
  });
});

describe('channelCaptureVeto: fails closed, and says the check failed', () => {
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
    expect(await channelCaptureVeto(channelsWith(world), pass({ logger }), { conversationId: THREAD })).toEqual(CHECK_FAILED);
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
    expect(settled).toEqual(CHECK_FAILED);
    expect(lines).toEqual([{ level: 'warn', msg: 'slack_capture_check_failed', fields: { code: 'timeout' } }]);
  });

  it('refuses when the binding lookup hangs past a deadline it was given', async () => {
    vi.useFakeTimers();
    const slow = { getThread: vi.fn(async () => thread()), get: vi.fn(() => new Promise<never>(() => {})) };
    const asked = channelCaptureVeto(slow, pass(), { conversationId: THREAD }, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await asked).toEqual(CHECK_FAILED);
  });

  it('leaves no timer behind once it has answered', async () => {
    vi.useFakeTimers();
    expect(await channelCaptureVeto(channelsWith({ threads: { [THREAD]: thread() } }), pass(), { conversationId: THREAD })).toBeUndefined();
    expect(await channelCaptureVeto(channelsWith({ threadLookup: new Error('down') }), pass(), { conversationId: THREAD })).toEqual(
      CHECK_FAILED,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers inside memory's own subscriber bound, so a slow lookup is refused, not skipped", () => {
    expect(CAPTURE_CHECK_DEADLINE_MS).toBe(MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS / 2);
    expect(CAPTURE_CHECK_DEADLINE_MS).toBeLessThan(MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS);
  });

  it("a logger that throws doesn't stop the refusal", async () => {
    const { logger } = recordingLogger({ throws: true });
    expect(await channelCaptureVeto(channelsWith({ threadLookup: new Error('down') }), pass({ logger }), { conversationId: THREAD })).toEqual(
      CHECK_FAILED,
    );
  });

  it("a web chat's pass while the store is down is refused as a failed check, never as a channel's refusal", async () => {
    // A slow or not-ready store refuses EVERY conversation's pass, a web chat's
    // included: the reason must not claim a Slack channel decided it.
    const { logger } = recordingLogger();
    const down = channelsWith({ threadLookup: Object.assign(new Error('not ready'), { code: 'ECONNREFUSED' }) });
    const asked = await channelCaptureVeto(down, pass({ conversationId: 'conv-web', source: 'user', logger }), {
      conversationId: 'conv-web',
    });
    expect(asked).toEqual(CHECK_FAILED);
    expect(asked).not.toEqual(REFUSED);
  });
});

describe('channelCaptureVeto: the speakers memory must not file facts under (TASK-1146)', () => {
  /*
    Memory reads `speakerNames` from the fire's final payload and, in a turn
    that isn't private, stores no statement whose subject is made of them.
    So a name is a fact memory won't file under it: the veto hands over every
    name a member's turns in the thread were labelled with, keeps every name
    an earlier subscriber added, and refuses rather than drop one.
  */

  /** The names Mel's turns in the thread were labelled with: display name, then Slack id. */
  const MEL = ['Mel', 'U07MEL00001'];
  /** Memory is asked about a member's thread: Mel's own pass. */
  const memberPass = (o: Partial<Parameters<typeof makeAgentContext>[0]> = {}) => pass({ source: 'user', userId: 'usr_mel', ...o });
  /** More names, with an earlier subscriber's, than one answer may carry. */
  const OVER_CAP = { rejected: true, reason: 'speaker-names-over-cap' };
  /** A payload it can't read, when it has names to add: refused, never answered over. */
  const UNREADABLE = { rejected: true, reason: 'capture-payload-unreadable' };
  /** `n` names an earlier subscriber added. */
  const earlier = (n: number) => Array.from({ length: n }, (_, i) => `Speaker ${i}`);

  it('a thread it lets memory learn from answers with its names', async () => {
    const channels = channelsWith({ threads: { [THREAD]: thread({ speakerNames: MEL }) } });
    expect(await channelCaptureVeto(channels, memberPass(), { conversationId: THREAD })).toEqual({
      conversationId: THREAD,
      speakerNames: MEL,
    });
  });

  it('a refused thread answers the refusal and no names, whatever names it holds', async () => {
    const named = thread({ speakerNames: MEL });
    const refused: Array<[string, Parameters<typeof channelsWith>[0], unknown]> = [
      ['the thread was marked before TASK-1203', { threads: { [THREAD]: thread({ notRemembered: true, speakerNames: MEL }) } }, REFUSED],
      ['the channel is no longer connected', { threads: { [THREAD]: named }, binding: null }, REFUSED],
      ['the channel is connected to another agent now', { threads: { [THREAD]: named }, binding: binding({ agentId: 'agt_sales' }) }, REFUSED],
      ["outsiders' turns run in it", { threads: { [THREAD]: thread({ external: true, speakerNames: MEL }) } }, OUTSIDER_THREAD],
    ];
    for (const [why, world, refusal] of refused) {
      expect(await channelCaptureVeto(channelsWith(world), memberPass(), { conversationId: THREAD }), why).toEqual(refusal);
    }
    // The control: the same names on a thread it lets through are memory's.
    expect(await channelCaptureVeto(channelsWith({ threads: { [THREAD]: named } }), memberPass(), { conversationId: THREAD })).toEqual({
      conversationId: THREAD,
      speakerNames: MEL,
    });
  });

  it('appends its names to those an earlier subscriber added, once each, and keeps the rest of what it was given', async () => {
    const channels = channelsWith({ threads: { [THREAD]: thread({ speakerNames: MEL }) } });
    expect(
      await channelCaptureVeto(channels, memberPass(), { conversationId: THREAD, speakerNames: ['Ana', 'Mel'], from: 'earlier' }),
    ).toEqual({ conversationId: THREAD, speakerNames: ['Ana', 'Mel', 'U07MEL00001'], from: 'earlier' });
    // With no names of its own (a web chat), it has no opinion: what it was given goes on as it came.
    const web = { conversationId: 'conv-web', speakerNames: ['Ana'] };
    expect(await channelCaptureVeto(channels, memberPass({ conversationId: 'conv-web' }), web)).toBeUndefined();
  });

  it(`refuses rather than drop a name: past ${MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX} in all, nothing is answered, and no name is logged`, async () => {
    const { logger, lines } = recordingLogger();
    const channels = channelsWith({ threads: { [THREAD]: thread({ speakerNames: MEL }) } });
    const ask = (speakerNames: string[]) =>
      channelCaptureVeto(channels, memberPass({ logger }), { conversationId: THREAD, speakerNames });
    // One over the cap with Mel's two.
    expect(await ask(earlier(MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX - 1))).toEqual(OVER_CAP);
    // Exactly the cap: every one of them goes to memory.
    const fits = earlier(MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX - 2);
    expect(await ask(fits)).toEqual({ conversationId: THREAD, speakerNames: [...fits, ...MEL] });
    // A name it shares with an earlier subscriber counts once, so this fits too.
    expect(await ask([...fits, 'Mel'])).toEqual({ conversationId: THREAD, speakerNames: [...fits, 'Mel', 'U07MEL00001'] });
    expect(JSON.stringify(lines)).not.toMatch(/Speaker|Mel/);
  });

  it('both ids it asks about contribute names', async () => {
    const other = 'conv-support-thread-ana';
    const channels = channelsWith({
      threads: { [THREAD]: thread({ speakerNames: MEL }), [other]: thread({ speakerNames: ['Ana', 'U07ANA00001'] }) },
    });
    // An earlier subscriber rewrote the payload to name another thread: memory hears the speakers of both.
    expect(await channelCaptureVeto(channels, memberPass(), { conversationId: other })).toEqual({
      conversationId: other,
      speakerNames: ['Mel', 'U07MEL00001', 'Ana', 'U07ANA00001'],
    });

    // Two full threads still fit one answer: it never refuses over its own names.
    const full = (who: string) => Array.from({ length: THREAD_SPEAKER_NAMES_MAX }, (_, i) => `${who} ${i}`);
    const busy = channelsWith({
      threads: { [THREAD]: thread({ speakerNames: full('Mel') }), [other]: thread({ speakerNames: full('Ana') }) },
    });
    expect(await channelCaptureVeto(busy, memberPass(), { conversationId: other })).toEqual({
      conversationId: other,
      speakerNames: [...full('Mel'), ...full('Ana')],
    });
  });

  it('a payload it cannot read is refused when it has names to add, never answered over', async () => {
    const old = 'conv-support-thread-old';
    const channels = channelsWith({ threads: { [THREAD]: thread({ speakerNames: MEL }), [old]: thread() } });
    for (const unreadable of [
      { conversationId: 7 },
      { conversationId: THREAD, speakerNames: 'Ana' },
      { conversationId: THREAD, speakerNames: [''] },
      { conversationId: THREAD, speakerNames: earlier(MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX + 1) },
    ]) {
      expect(await channelCaptureVeto(channels, memberPass(), unreadable), JSON.stringify(unreadable).slice(0, 60)).toEqual(UNREADABLE);
    }
    // With no names to add it has no opinion, as before TASK-1146: memory won't read that answer either.
    expect(await channelCaptureVeto(channels, memberPass({ conversationId: old }), { conversationId: 7 })).toBeUndefined();
  });

  it('a thread row with no names list at all is refused as a failed check, never read as one with no names', async () => {
    const { logger, lines } = recordingLogger();
    const unread = thread({ speakerNames: undefined as unknown as string[] });
    expect(await channelCaptureVeto(channelsWith({ threads: { [THREAD]: unread } }), memberPass({ logger }), { conversationId: THREAD })).toEqual(
      CHECK_FAILED,
    );
    expect(lines).toEqual([{ level: 'warn', msg: 'slack_capture_check_failed', fields: { code: 'unknown' } }]);
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
      channelsWith({ threads: { 'conv-kept-out': thread({ notRemembered: true }), 'conv-remembered': thread() } }),
    );

    // memory logs `source` as the subscriber that refused, and `reason` as its word for why.
    expect(await fire(bus, 'conv-kept-out')).toEqual({ ...REFUSED, source: CAPTURE_VETO_KEY });
    expect(await fire(bus, 'conv-remembered')).toEqual({ rejected: false, payload: { conversationId: 'conv-remembered' } });
    expect(await fire(bus, 'conv-web')).toEqual({ rejected: false, payload: { conversationId: 'conv-web' } });

    off();
    expect(await fire(bus, 'conv-kept-out')).toEqual({ rejected: false, payload: { conversationId: 'conv-kept-out' } });
    expect(bus.unsubscribe(MEMORY_PRE_CAPTURE_HOOK, CAPTURE_VETO_KEY)).toBe(0);
  });

  it('subscribing again replaces the veto an earlier run left (it outlives a shutdown): one answers, the newest', async () => {
    const bus = new HookBus();
    // The earlier run's store is gone: every lookup fails, so it would refuse everything.
    subscribeCaptureVeto(bus, channelsWith({ threadLookup: new Error('database closed') }));
    subscribeCaptureVeto(bus, channelsWith({ threads: { 'conv-remembered': thread() } }));

    expect(await fire(bus, 'conv-remembered')).toEqual({ rejected: false, payload: { conversationId: 'conv-remembered' } });
    expect(bus.unsubscribe(MEMORY_PRE_CAPTURE_HOOK, CAPTURE_VETO_KEY)).toBe(1);
  });

  it("memory reads the speakers from the fire's final payload: an earlier subscriber's names, then the thread's (TASK-1146)", async () => {
    const bus = new HookBus();
    // An earlier subscriber that names a speaker as the contract says: the payload it was given, its name appended.
    bus.subscribe<MemoryPreCapturePayload>(MEMORY_PRE_CAPTURE_HOOK, 'test-earlier', async (_ctx, payload) => ({
      ...payload,
      speakerNames: [...(payload.speakerNames ?? []), 'Ana'],
    }));
    subscribeCaptureVeto(bus, channelsWith({ threads: { 'conv-remembered': thread({ speakerNames: ['Mel', 'U07MEL00001'] }) } }));

    expect(await fire(bus, 'conv-remembered')).toEqual({
      rejected: false,
      payload: { conversationId: 'conv-remembered', speakerNames: ['Ana', 'Mel', 'U07MEL00001'] },
    });
    // A conversation it never recorded: the earlier subscriber's answer goes on untouched.
    expect(await fire(bus, 'conv-web')).toEqual({ rejected: false, payload: { conversationId: 'conv-web', speakerNames: ['Ana'] } });
  });
});
