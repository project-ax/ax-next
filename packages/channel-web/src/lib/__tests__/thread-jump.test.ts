/**
 * `turnSources` (TASK-642): which speaker each turn on screen came from, so
 * the rail's source link can say "your message" or "the agent's reply" by
 * reading the turn itself rather than guessing from the fact's subject.
 */
import { describe, expect, it } from 'vitest';
import type { ThreadMessage } from '@/lib/workspace-api';
import { SOURCE_EXCERPT_MAX, sourceExcerpt, turnSources } from '../thread-jump';

describe('turnSources', () => {
  const thread: ThreadMessage[] = [
    { kind: 'user', id: 't1', text: 'Our go-live moved to Oct 14.' },
    { kind: 'agent', id: 't2', text: 'Got it — **Oct 14**.', at: '2026-09-28T06:37:00.000Z' },
    {
      kind: 'steps',
      id: 't3',
      text: '',
      at: '2026-09-28T06:38:00.000Z',
      stepsLabel: '2 steps',
      steps: [],
    },
    { kind: 'status', id: 'pending-status', text: 'Thinking…' },
    { kind: 'approval', id: 'ap', decisionId: 'd1' },
  ];

  it('names the person for a user turn and the agent for a reply or a tool-only turn', () => {
    const sources = turnSources(thread);
    expect(sources.get('t1')).toEqual({ speaker: 'person', excerpt: 'Our go-live moved to Oct 14.' });
    expect(sources.get('t2')).toEqual({ speaker: 'agent', excerpt: 'Got it — Oct 14.' });
    expect(sources.get('t3')).toEqual({ speaker: 'agent', excerpt: '' });
  });

  it('knows nothing about a row that is not a message, or a turn not on screen', () => {
    const sources = turnSources(thread);
    expect(sources.has('pending-status')).toBe(false);
    expect(sources.has('ap')).toBe(false);
    expect(sources.has('gone')).toBe(false);
  });
});

describe('sourceExcerpt', () => {
  it('collapses whitespace and drops markdown marks', () => {
    expect(sourceExcerpt('# Plan\n\n- **ship** `it`  _today_')).toBe('Plan - ship it today');
  });

  it('cuts a long message at a word and marks the cut', () => {
    const long = 'word '.repeat(40).trim();
    const out = sourceExcerpt(long);
    expect(out.length).toBeLessThanOrEqual(SOURCE_EXCERPT_MAX + 1);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1).endsWith('word')).toBe(true);
  });

  it('leaves a short message whole', () => {
    expect(sourceExcerpt('hi')).toBe('hi');
  });
});
