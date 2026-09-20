/**
 * Picking a stopped agent back up after a grant (TASK-374) — the rule.
 *
 * `WorkspaceGrantResume.test.tsx` pins that the shipped surface runs this; this
 * file pins what it does, which turn it picks, and that every way of failing
 * comes back as a reason rather than a rejection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { workspaceApi, type ThreadMessage } from '@/lib/workspace-api';
import { lastUserText, resumeParkedTurn } from '@/lib/workspace-resume';

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

const detail = (thread: ThreadMessage[]) => ({
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
  thread,
  decisions: { status: 'ok' as const },
  past: [],
  memory: {
    rules: { status: 'unavailable' as const, doc: null },
    learned: { status: 'unavailable' as const, docs: [] },
  },
});

afterEach(() => {
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
});
