/**
 * groupReplies — a reply that ran tools is drawn as one, in the order it
 * happened: step blocks and what the agent said between them.
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
/** The reply's parts as one line each: "say: …" or "steps: a | b". */
const shape = (r: ReplyGroup): string[] =>
  r.parts.map((p) =>
    p.kind === 'text'
      ? `say: ${p.text}`
      : `steps: ${p.entries.map((e) => (e.kind === 'step' ? e.step.text : `(${e.text})`)).join(' | ')}`,
  );
const card = { artifactId: 'art1', version: 1, title: 'Report', kind: 'document', extension: 'PDF' } as const;

describe('groupReplies', () => {
  it('leaves a thread with no steps exactly as it was', () => {
    const thread = [user('u1'), agent('a1', 'Hello')];
    expect(groupReplies(thread)).toEqual(thread.map((message) => ({ kind: 'message', message })));
  });

  it('draws a multi-turn reply in order: what it said, where it said it, between step blocks', () => {
    const items = groupReplies([
      user('u1'),
      steps('t1', 'Let me look at the repo.', [step('Ran a command')]),
      agent('t2', ''),
      steps('t3', '', [step('Read router.js')]),
      agent('t4', 'The router is fine. Checking the tests next.'),
      steps('t5', '', [step('Ran the tests')]),
      agent('t6', 'Here is how it works.'),
    ]);
    expect(items).toHaveLength(2);
    const reply = items[1] as ReplyGroup;
    expect(shape(reply)).toEqual([
      'say: Let me look at the repo.',
      'steps: Ran a command | Read router.js',
      'say: The router is fine. Checking the tests next.',
      'steps: Ran the tests',
      'say: Here is how it works.',
    ]);
    expect(reply.text).toBe('Here is how it works.');
    expect(reply.id).toBe('t6');
    expect(reply.turnIds).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
  });

  it('a message followed by more calls stays a message, and the calls start a new block', () => {
    const reply = groupReplies([
      agent('t2', 'Got it — Oct 14.'),
      steps('t3', '', [step('Saving a note to memory')]),
    ])[0] as ReplyGroup;
    expect(shape(reply)).toEqual(['say: Got it — Oct 14.', 'steps: Saving a note to memory']);
    // Nothing came after the last block, so there is no closing answer.
    expect(reply.text).toBe('');
  });

  it('puts a step summary at the head of its step, inside the block', () => {
    const reply = groupReplies([
      steps('t1', '', [{ ...step('Ran a command'), intent: 'Checking the legs.' }, step('Ran a command')]),
    ])[0] as ReplyGroup;
    expect(shape(reply)).toEqual(['steps: (Checking the legs.) | Ran a command | Ran a command']);
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

  it('a live reply groups exactly like a stored one, so nothing moves when it ends', () => {
    const reply = groupReplies([
      { ...(steps('pending-agent-0', 'Sketching the frame first.', [{ text: 'Ran a command', status: 'done' }]) as object), at: '' } as ThreadMessage,
      { ...(steps('pending-agent-1', 'Now the legs.', [{ text: 'Ran a command — in progress', status: 'running' }]) as object), at: '' } as ThreadMessage,
    ])[0] as ReplyGroup;
    expect(reply.at).toBe('');
    expect(shape(reply)).toEqual([
      'say: Sketching the frame first.',
      'steps: Ran a command',
      'say: Now the legs.',
      'steps: Ran a command — in progress',
    ]);
  });

  it('once stored, a short answer is the answer', () => {
    const reply = groupReplies([
      steps('t1', '', [{ text: 'Ran a command', status: 'done' }]),
      { kind: 'agent', id: 't2', text: 'Done.', at: '2026-09-17T16:12:03.000Z' } as ThreadMessage,
    ])[0] as ReplyGroup;
    expect(reply.text).toBe('Done.');
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
      { kind: 'agent', id: 'pending-agent', text: 'Here it is.\n\nIt pedals.', at: '' },
      {
        kind: 'agent',
        id: 'pending-visuals',
        text: '',
        at: '',
        artifacts: [{ artifactId: 'a', version: 1, title: 'pelican', kind: 'image', extension: 'SVG' }],
      },
    ])[0] as ReplyGroup;
    expect(reply.text).toBe('Here it is.\n\nIt pedals.');
    expect(reply.artifacts.map((a) => a.title)).toEqual(['pelican']);
  });
});
