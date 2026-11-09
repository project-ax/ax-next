/**
 * groupReplies — a reply that ran tools is drawn as one: what it did above,
 * what it said, then what it made.
 */
import { describe, expect, it } from 'vitest';
import { groupReplies, liveNote, type ReplyGroup } from '../reply-groups';
import type { ThreadMessage } from '../workspace-types';
import type { WorkspaceStep } from '../workspace-steps';

const step = (text: string): WorkspaceStep => ({ text, status: 'done', kind: 'command' });
const user = (id: string, text = 'hi'): ThreadMessage => ({ kind: 'user', id, text });
const agent = (id: string, text: string, extra: object = {}): ThreadMessage =>
  ({ kind: 'agent', id, text, at: `2026-11-08T00:00:0${id.length}Z`, ...extra }) as ThreadMessage;
const steps = (id: string, text: string, rows: WorkspaceStep[]): ThreadMessage => ({
  kind: 'steps',
  id,
  text,
  at: '2026-11-08T00:00:00Z',
  stepsLabel: '',
  steps: rows,
});
const card = { artifactId: 'art1', version: 1, title: 'Report', kind: 'document', extension: 'PDF' } as const;

describe('groupReplies', () => {
  it('leaves a thread with no steps exactly as it was', () => {
    const thread = [user('u1'), agent('a1', 'Hello')];
    expect(groupReplies(thread)).toEqual(thread.map((message) => ({ kind: 'message', message })));
  });

  it('folds a multi-turn reply into one: notes and steps in order, then the answer', () => {
    const items = groupReplies([
      user('u1'),
      steps('t1', 'Let me look at the repo.', [step('Ran a command')]),
      agent('t2', ''),
      steps('t3', 'Now the router.', [step('Read router.js')]),
      agent('t4', ''),
      agent('t5', 'Here is how it works.'),
    ]);
    expect(items).toHaveLength(2);
    const reply = items[1] as ReplyGroup;
    expect(reply.kind).toBe('reply');
    expect(reply.text).toBe('Here is how it works.');
    expect(reply.id).toBe('t5');
    expect(reply.turnIds).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(reply.activity).toEqual([
      { kind: 'note', turnId: 't1', text: 'Let me look at the repo.' },
      { kind: 'step', step: step('Ran a command') },
      { kind: 'note', turnId: 't3', text: 'Now the router.' },
      { kind: 'step', step: step('Read router.js') },
    ]);
  });

  it('puts an artifact made mid-reply UNDER the answer, with every step above it', () => {
    const items = groupReplies([
      steps('t1', '', [step('Making a report')]),
      agent('t2', '', { artifacts: [card] }),
      steps('t3', '', [step('Checking the report')]),
      agent('t4', 'Done — the report is ready.'),
    ]);
    const reply = items[0] as ReplyGroup;
    expect(reply.activity.map((e) => (e.kind === 'step' ? e.step.text : e.text))).toEqual([
      'Making a report',
      'Checking the report',
    ]);
    expect(reply.text).toBe('Done — the report is ready.');
    expect(reply.artifacts).toEqual([card]);
  });

  it('when nothing was said after the last tool call, that turn\'s words are the answer', () => {
    const reply = groupReplies([
      steps('t1', 'Looking…', [step('a')]),
      steps('t2', 'Here is your file.', [step('b')]),
      agent('t3', '', { artifacts: [card] }),
    ])[0] as ReplyGroup;
    expect(reply.text).toBe('Here is your file.');
    expect(reply.activity.filter((e) => e.kind === 'note')).toEqual([
      { kind: 'note', turnId: 't1', text: 'Looking…' },
    ]);
  });

  it('an answer followed by a silent tool turn stays the answer, not narration', () => {
    const reply = groupReplies([
      agent('t2', 'Got it — Oct 14.'),
      steps('t3', '', [step('Saving a note to memory')]),
    ])[0] as ReplyGroup;
    expect(reply.text).toBe('Got it — Oct 14.');
    expect(reply.id).toBe('t2');
    expect(reply.activity).toEqual([{ kind: 'step', step: step('Saving a note to memory') }]);
  });

  it('keeps the newest version of an artifact the reply published twice', () => {
    const reply = groupReplies([
      steps('t1', '', [step('a')]),
      agent('t2', '', { artifacts: [card] }),
      agent('t3', 'ok', { artifacts: [{ ...card, version: 2 }] }),
    ])[0] as ReplyGroup;
    expect(reply.artifacts).toEqual([{ ...card, version: 2 }]);
  });

  it('never folds across the person or an approval', () => {
    const items = groupReplies([
      steps('t1', 'a', [step('x')]),
      { kind: 'approval', id: 'ap', decisionId: 'd1' },
      agent('t2', 'b'),
      user('u2'),
      steps('t3', 'c', [step('y')]),
    ]);
    expect(items.map((i) => (i.kind === 'reply' ? `reply:${i.id}` : `${i.message.kind}:${i.message.id}`))).toEqual([
      'reply:t1',
      'approval:ap',
      'agent:t2',
      'user:u2',
      'reply:t3',
    ]);
  });

  it('while live, words followed by a call are narration, not the reply', () => {
    const reply = groupReplies([
      { ...(steps('pending-agent', 'Sketching the frame first.', [{ text: 'Ran a command — in progress', status: 'running' }]) as object), at: '' } as ThreadMessage,
    ])[0] as ReplyGroup;
    expect(reply.text).toBe('');
    expect(reply.at).toBe('');
    expect(reply.activity.map((e) => e.kind)).toEqual(['note', 'step']);
  });

  it('while live, only what it says after its LAST call is the reply', () => {
    const reply = groupReplies([
      { ...(steps('pending-agent-0', 'Sketching the frame first.', [{ text: 'Ran a command', status: 'done' }]) as object), at: '' } as ThreadMessage,
      { kind: 'agent', id: 'pending-agent', text: 'Here is the pelican.', at: '' },
    ])[0] as ReplyGroup;
    expect(reply.text).toBe('Here is the pelican.');
    expect(reply.activity.map((e) => (e.kind === 'note' ? e.text : e.step.text))).toEqual([
      'Sketching the frame first.',
      'Ran a command',
    ]);
  });
});

describe('liveNote', () => {
  const note = (text: string) => ({ kind: 'note' as const, turnId: 't', text });
  const step = { kind: 'step' as const, step: { text: 'Ran a command', status: 'done' as const } };

  it('is the first line of the latest note, without the markdown', () => {
    expect(liveNote([note('## **Working** out the `legs`\nmore detail'), step])).toBe('Working out the legs');
  });

  it('stops standing for the steps after a few with no new words', () => {
    expect(liveNote([note('Plan.'), step, step, step])).toBe('Plan.');
    expect(liveNote([note('Plan.'), step, step, step, step])).toBeUndefined();
  });

  it('is nothing when the agent has said nothing', () => {
    expect(liveNote([step])).toBeUndefined();
  });
});

describe('live reply with a card', () => {
  it('keeps the trailing words as the reply when a live card follows them', () => {
    const reply = groupReplies([
      { ...(steps('pending-agent-0', 'Drawing.', [{ text: 'Ran a command', status: 'done' }]) as object), at: '' } as ThreadMessage,
      { kind: 'agent', id: 'pending-agent', text: 'Here it is.', at: '' },
      {
        kind: 'agent',
        id: 'pending-visuals',
        text: '',
        at: '',
        artifacts: [{ artifactId: 'a', version: 1, title: 'pelican', kind: 'image', extension: 'SVG' }],
      },
    ])[0] as ReplyGroup;
    expect(reply.text).toBe('Here it is.');
    expect(reply.artifacts.map((a) => a.title)).toEqual(['pelican']);
  });
});
