/**
 * Picking a stopped agent back up after a grant (TASK-374) — the rule.
 *
 * `WorkspaceGrantResume.test.tsx` pins that the shipped surface runs this; this
 * file pins what it does, which turn it picks, and that every way of failing
 * comes back as a reason rather than a rejection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { workspaceApi, type StreamHandlers, type ThreadMessage } from '@/lib/workspace-api';
import { ConversationReadOnlyError } from '@/lib/conversation-read-only';
import {
  grantResumeFor,
  lastUserText,
  RESUME_WAIT_MS,
  resumeParkedTurn,
} from '@/lib/workspace-resume';

const userMsg = (id: string, text: string): ThreadMessage => ({
  kind: 'user',
  id,
  text,
});

const agentMsg = (id: string, text: string): ThreadMessage => ({
  kind: 'agent',
  id,
  text,
  at: '2026-09-17T10:04:00.000Z',
});

/**
 * The thread an asking turn actually leaves behind: the person's message, then
 * the agent saying it has asked for something. The agent line is LAST, which is
 * the whole reason `lastUserText` scans backwards instead of reading `at(-1)`.
 */
const askedThread: ThreadMessage[] = [
  userMsg('t1', 'file my open Linear issues'),
  agentMsg('t2', 'I have asked for access to Linear.'),
];

const detail = (thread: ThreadMessage[], liveReqId?: string | null) => ({
  agent: {
    id: 'a-quill',
    name: 'Quill',
    state: 'resting' as const,
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
  },
  conversationId: 'cnv-1',
  ...(liveReqId === undefined ? {} : { liveReqId }),
  thread,
  decisions: { status: 'ok' as const },
  past: [],
  memory: {
    rules: { status: 'unavailable' as const, doc: null },
    learned: { status: 'unavailable' as const, docs: [] },
  },
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('which turn gets re-issued', () => {
  it('is the last thing the person said, not the last thing in the thread', () => {
    expect(lastUserText(askedThread)).toBe('file my open Linear issues');
  });

  it('is the MOST RECENT user turn when there are several', () => {
    expect(
      lastUserText([
        userMsg('t1', 'what is on my plate'),
        agentMsg('t2', 'Three things.'),
        userMsg('t3', 'file my open Linear issues'),
        agentMsg('t4', 'I have asked for access to Linear.'),
      ]),
    ).toBe('file my open Linear issues');
  });

  it('is nothing at all when the agent started the conversation', () => {
    // A routine's own opening turn, say: nothing a person wrote to re-send.
    expect(lastUserText([agentMsg('t1', 'Morning. I have asked for access.')])).toBe(
      null,
    );
    expect(lastUserText([])).toBe(null);
  });

  it('is nothing when the last user turn is blank', () => {
    /*
      Not merely tidiness. `sendMessage` would post a `{ type: 'text', text: '' }`
      block, so treating whitespace as re-sendable trades a sentence that says
      what happened for an empty turn that looks like the agent answered nothing.
    */
    expect(lastUserText([userMsg('t1', '   \n ')])).toBe(null);
  });

  it('ignores the OTHER thread kinds rather than re-sending one', () => {
    /*
      `buildThread` appends an `approval` card per open decision, and `status` /
      `fold` variants exist. None of them is something a person typed. A scan
      that matched on "has a text field" would re-send a fold marker.

      All three of the non-`user` kinds that can sit at the END of a thread are
      here, `status` included: `fold` and `status` both carry a `text` and are
      the ones a loosened predicate would grab, and `approval` is the one with
      no `text` at all, which a predicate written the other way round would
      throw on.
    */
    expect(
      lastUserText([
        userMsg('t1', 'file my open Linear issues'),
        { kind: 'fold', id: 't2', text: 'Earlier turns were summarised' },
        { kind: 'status', id: 't3', text: 'Waiting on approval' },
        { kind: 'approval', id: 't4', decisionId: 'dec-1' },
      ]),
    ).toBe('file my open Linear issues');
  });
});

describe('the re-issue itself', () => {
  it('re-sends that text into the GRANT’s conversation', async () => {
    vi.spyOn(workspaceApi, 'agent').mockResolvedValue(detail(askedThread));
    const send = vi
      .spyOn(workspaceApi, 'sendMessage')
      .mockResolvedValue({ conversationId: 'cnv-1', reqId: 'req-resume' });

    const result = await resumeParkedTurn({
      agentId: 'a-quill',
      conversationId: 'cnv-1',
    });

    /*
      BOTH ids are asserted, and the read one is the sharper of the two. A
      resume that read the agent's CURRENT conversation would pass every
      assertion about the POST and still re-issue the wrong turn for a grant
      answered on Today, where the agent may have moved on since it asked.
    */
    expect(workspaceApi.agent).toHaveBeenCalledWith('a-quill', 'cnv-1');
    expect(send).toHaveBeenCalledWith({
      agentId: 'a-quill',
      conversationId: 'cnv-1',
      text: 'file my open Linear issues',
    });
    expect(result).toEqual({
      resumed: true,
      reqId: 'req-resume',
      conversationId: 'cnv-1',
      text: 'file my open Linear issues',
    });
  });
});

describe('every way it can fail to resume', () => {
  /*
    NONE OF THESE MAY REJECT. The caller is a row whose grant has already been
    applied — the capability landed — so a rejection would surface as "connecting
    failed", sending someone back to re-enter a key that is already saved.
  */
  it('reports an unreadable conversation instead of throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(workspaceApi, 'agent').mockRejectedValue(new Error('boom'));
    const send = vi.spyOn(workspaceApi, 'sendMessage');

    await expect(
      resumeParkedTurn({ agentId: 'a-quill', conversationId: 'cnv-1' }),
    ).resolves.toEqual({ resumed: false, reason: 'thread-unreadable' });
    // And it does not guess: nothing was posted on the strength of a read that
    // failed.
    expect(send).not.toHaveBeenCalled();
  });

  it('reports an empty conversation instead of posting an empty turn', async () => {
    vi.spyOn(workspaceApi, 'agent').mockResolvedValue(detail([]));
    const send = vi.spyOn(workspaceApi, 'sendMessage');

    await expect(
      resumeParkedTurn({ agentId: 'a-quill', conversationId: 'cnv-1' }),
    ).resolves.toEqual({ resumed: false, reason: 'nothing-to-resume' });
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a refused re-send instead of throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(workspaceApi, 'agent').mockResolvedValue(detail(askedThread));
    vi.spyOn(workspaceApi, 'sendMessage').mockRejectedValue(new Error('503'));

    await expect(
      resumeParkedTurn({ agentId: 'a-quill', conversationId: 'cnv-1' }),
    ).resolves.toEqual({ resumed: false, reason: 'send-failed' });
  });

  /*
    TASK-1093 — a conversation that takes its messages somewhere else refuses a
    re-send from here. Only a SLACK thread gets its own reason: the row then
    says to reply in Slack. A routine's conversation is refused by the same
    route, but "reply to it in Slack" would be wrong
    there, so it keeps the plain refused-send reason and its sentence.
  */
  it('reports a refused re-send on a Slack thread as read-only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(workspaceApi, 'agent').mockResolvedValue({
      ...detail(askedThread),
      origin: 'slack',
    });
    vi.spyOn(workspaceApi, 'sendMessage').mockRejectedValue(
      new ConversationReadOnlyError('/api/chat/messages'),
    );

    await expect(
      resumeParkedTurn({ agentId: 'a-quill', conversationId: 'cnv-1' }),
    ).resolves.toEqual({ resumed: false, reason: 'read-only' });
  });

  // `undefined`: an older host that names no origin at all.
  it.each<[string | null | undefined]>([['routine'], [null], [undefined]])(
    'reports a read-only refusal on a non-Slack conversation (origin %s) as a refused send',
    async (origin) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(workspaceApi, 'agent').mockResolvedValue({
        ...detail(askedThread),
        ...(origin === undefined ? {} : { origin }),
      });
      vi.spyOn(workspaceApi, 'sendMessage').mockRejectedValue(
        new ConversationReadOnlyError('/api/chat/messages'),
      );

      await expect(
        resumeParkedTurn({ agentId: 'a-quill', conversationId: 'cnv-1' }),
      ).resolves.toEqual({ resumed: false, reason: 'send-failed' });
    },
  );
});

/**
 * TASK-1150 — Connect is live while the asking reply is still being written, so
 * the resume can land under a running turn. Re-sending then would restart the
 * session under that reply (TASK-1127 marks it; routing retires a marked
 * session even mid-turn), so the resume follows the reply to its end first.
 */
describe('a reply still being written in that conversation', () => {
  const ASK = 'file my open Linear issues';
  const target = { agentId: 'a-quill', conversationId: 'cnv-1' };

  /** A `streamReply` that stays open until the test ends it. */
  function holdStream() {
    const seen: { reqId: string; handlers: StreamHandlers }[] = [];
    const stream = vi
      .spyOn(workspaceApi, 'streamReply')
      .mockImplementation((reqId, handlers) => {
        seen.push({ reqId, handlers });
        return new Promise<void>(() => undefined);
      });
    return { stream, seen };
  }

  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  function sendOk() {
    return vi
      .spyOn(workspaceApi, 'sendMessage')
      .mockResolvedValue({ conversationId: 'cnv-1', reqId: 'req-resume' });
  }

  it('waits for it, then re-sends', async () => {
    vi.spyOn(workspaceApi, 'agent').mockResolvedValue(detail(askedThread, 'req-ask'));
    const send = sendOk();
    const { stream, seen } = holdStream();

    const pending = resumeParkedTurn(target);
    await flush();

    expect(send).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledWith(
      'req-ask',
      expect.objectContaining({ resume: true, signal: expect.any(AbortSignal) }),
    );
    const signal = seen[0]?.handlers.signal;

    seen[0]?.handlers.onDone();

    await expect(pending).resolves.toEqual({
      resumed: true,
      reqId: 'req-resume',
      conversationId: 'cnv-1',
      text: ASK,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });

  it('a stream that cannot be proven ended is re-read: no live reply left, so it re-sends', async () => {
    const read = vi
      .spyOn(workspaceApi, 'agent')
      .mockResolvedValueOnce(detail(askedThread, 'req-ask'))
      .mockResolvedValueOnce(detail(askedThread, null));
    const send = sendOk();
    const { stream, seen } = holdStream();

    const pending = resumeParkedTurn(target);
    await flush();
    // The stream was opened on the live reply; without this the optional
    // chain below would no-op on unfixed code and the test would pass anyway.
    expect(stream).toHaveBeenCalledWith('req-ask', expect.anything());
    seen[0]!.handlers.onError('x');

    await expect(pending).resolves.toMatchObject({ resumed: true });
    expect(read).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a transport failure while the reply is still live sends nothing', async () => {
    // `onError` also fires for a failed first open, a 401/403/429/5xx, or spent
    // reconnects: none proves the reply ended, and a re-send would cut it off.
    const read = vi
      .spyOn(workspaceApi, 'agent')
      .mockResolvedValue(detail(askedThread, 'req-ask'));
    const send = sendOk();
    const { stream, seen } = holdStream();

    const pending = resumeParkedTurn(target);
    await flush();
    expect(stream).toHaveBeenCalledWith('req-ask', expect.anything());
    seen[0]!.handlers.onError('The connection dropped.');

    await expect(pending).resolves.toEqual({ resumed: false, reason: 'still-running' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    // And the row says the busy sentence, not the generic failure one.
    expect(grantResumeFor('still-running')).toBe('reply-when-done');
  });

  it('a transport failure whose re-read also fails sends nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(workspaceApi, 'agent')
      .mockResolvedValueOnce(detail(askedThread, 'req-ask'))
      .mockRejectedValueOnce(new Error('503'));
    const send = sendOk();
    const { stream, seen } = holdStream();

    const pending = resumeParkedTurn(target);
    await flush();
    expect(stream).toHaveBeenCalledWith('req-ask', expect.anything());
    seen[0]!.handlers.onError('x');

    await expect(pending).resolves.toEqual({ resumed: false, reason: 'still-running' });
    expect(send).not.toHaveBeenCalled();
  });

  it('a different reply now live is still a running reply: sends nothing', async () => {
    vi.spyOn(workspaceApi, 'agent')
      .mockResolvedValueOnce(detail(askedThread, 'req-ask'))
      .mockResolvedValueOnce(detail(askedThread, 'req-other'));
    const send = sendOk();
    const { stream, seen } = holdStream();

    const pending = resumeParkedTurn(target);
    await flush();
    expect(stream).toHaveBeenCalledWith('req-ask', expect.anything());
    seen[0]!.handlers.onError('x');

    await expect(pending).resolves.toEqual({ resumed: false, reason: 'still-running' });
    expect(send).not.toHaveBeenCalled();
  });

  it('a stream that returns with no terminal frame takes the same re-read path', async () => {
    const read = vi
      .spyOn(workspaceApi, 'agent')
      .mockResolvedValueOnce(detail(askedThread, 'req-ask'))
      .mockResolvedValueOnce(detail(askedThread, 'req-ask'));
    const send = sendOk();
    const stream = vi.spyOn(workspaceApi, 'streamReply').mockResolvedValue(undefined);

    await expect(resumeParkedTurn(target)).resolves.toEqual({
      resumed: false,
      reason: 'still-running',
    });
    expect(stream).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it('a bare resolve with the reply gone from the re-read re-sends', async () => {
    const read = vi
      .spyOn(workspaceApi, 'agent')
      .mockResolvedValueOnce(detail(askedThread, 'req-ask'))
      .mockResolvedValueOnce(detail(askedThread, null));
    const send = sendOk();
    vi.spyOn(workspaceApi, 'streamReply').mockResolvedValue(undefined);

    await expect(resumeParkedTurn(target)).resolves.toMatchObject({ resumed: true });
    // Proves the re-read happened: without it the send would still go out.
    expect(read).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  describe('a reply that provably ended is re-read too', () => {
    // A continuation approved during the wait binds its own request and runs
    // after the followed reply's `done`; a re-send would retire its session.
    async function endAfterWait() {
      const { stream, seen } = holdStream();
      const pending = resumeParkedTurn(target);
      await flush();
      expect(stream).toHaveBeenCalledWith('req-ask', expect.anything());
      seen[0]!.handlers.onDone();
      return pending;
    }

    it('a different reply now live sends nothing', async () => {
      const read = vi
        .spyOn(workspaceApi, 'agent')
        .mockResolvedValueOnce(detail(askedThread, 'req-ask'))
        .mockResolvedValueOnce(detail(askedThread, 'req-continuation'));
      const send = sendOk();

      await expect(endAfterWait()).resolves.toEqual({
        resumed: false,
        reason: 'still-running',
      });
      expect(read).toHaveBeenCalledTimes(2);
      expect(send).not.toHaveBeenCalled();
    });

    it('the followed reply still bound (not yet cleared) does not block the re-send', async () => {
      const read = vi
        .spyOn(workspaceApi, 'agent')
        .mockResolvedValueOnce(detail(askedThread, 'req-ask'))
        .mockResolvedValueOnce(detail(askedThread, 'req-ask'));
      const send = sendOk();

      await expect(endAfterWait()).resolves.toMatchObject({ resumed: true });
      expect(read).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('nothing live re-sends', async () => {
      const read = vi
        .spyOn(workspaceApi, 'agent')
        .mockResolvedValueOnce(detail(askedThread, 'req-ask'))
        .mockResolvedValueOnce(detail(askedThread, null));
      const send = sendOk();

      await expect(endAfterWait()).resolves.toMatchObject({ resumed: true });
      // The re-read happened, and it read the grant's own conversation, not
      // whichever one the agent is on now.
      expect(read).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenNthCalledWith(2, 'a-quill', 'cnv-1');
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('a failed re-read withholds, like the unproven path', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(workspaceApi, 'agent')
        .mockResolvedValueOnce(detail(askedThread, 'req-ask'))
        .mockRejectedValueOnce(new Error('503'));
      const send = sendOk();

      await expect(endAfterWait()).resolves.toEqual({
        resumed: false,
        reason: 'still-running',
      });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('a stream that rejects takes the re-read path too: still live sends nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(workspaceApi, 'agent').mockResolvedValue(detail(askedThread, 'req-ask'));
    const send = sendOk();
    const stream = vi
      .spyOn(workspaceApi, 'streamReply')
      .mockRejectedValue(new Error('reader bug'));

    await expect(resumeParkedTurn(target)).resolves.toEqual({
      resumed: false,
      reason: 'still-running',
    });
    expect(stream).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('still going when we stop waiting: sends nothing and lets the stream go', async () => {
    vi.useFakeTimers();
    vi.spyOn(workspaceApi, 'agent').mockResolvedValue(detail(askedThread, 'req-ask'));
    const send = sendOk();
    const { seen } = holdStream();

    let result: unknown;
    void resumeParkedTurn(target).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS - 1);
    expect(result).toBeUndefined();
    expect(seen[0]?.handlers.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(result).toEqual({ resumed: false, reason: 'still-running' });
    expect(send).not.toHaveBeenCalled();
    expect(seen[0]?.handlers.signal?.aborted).toBe(true);
  });

  it('with nothing in flight, re-sends at once and follows nothing', async () => {
    vi.spyOn(workspaceApi, 'agent').mockResolvedValue(detail(askedThread, null));
    const send = sendOk();
    const stream = vi.spyOn(workspaceApi, 'streamReply');

    await expect(resumeParkedTurn(target)).resolves.toMatchObject({ resumed: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
  });

  it('an empty liveReqId is nothing in flight', async () => {
    vi.spyOn(workspaceApi, 'agent').mockResolvedValue(detail(askedThread, ''));
    sendOk();
    const stream = vi.spyOn(workspaceApi, 'streamReply');

    await expect(resumeParkedTurn(target)).resolves.toMatchObject({ resumed: true });
    expect(stream).not.toHaveBeenCalled();
  });
});

describe('what the row is told', () => {
  it.each<[Parameters<typeof grantResumeFor>[0], ReturnType<typeof grantResumeFor>]>([
    ['read-only', 'reply-elsewhere'],
    ['still-running', 'reply-when-done'],
    ['thread-unreadable', false],
    ['nothing-to-resume', false],
    ['send-failed', false],
  ])('%s reads as %s', (reason, expected) => {
    expect(grantResumeFor(reason)).toBe(expected);
  });
});
