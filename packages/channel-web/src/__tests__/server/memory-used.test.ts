/**
 * TASK-628 — attaching `memory:recall-receipts` to the answer they belong to.
 *
 * Attribution is by TIME: a receipt stamped at `t` belongs to the exchange
 * opened by the last person turn at or before `t`, and the chip goes on the
 * LAST assistant message (`agent` | `steps`) of that exchange.
 */
import { describe, it, expect } from 'vitest';
import {
  attachMemoryUsed,
  MEMORY_USED_MAX_STATEMENTS,
  type MemoryUsedTurn,
} from '../../server/memory-used.js';
import type { ThreadMessage } from '../../lib/workspace-types.js';

function stmt(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    about: 'person',
    relation: 'prefers',
    value: `value-${id}`,
    when: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const turns: MemoryUsedTurn[] = [
  { turnId: 'u1', role: 'user', createdAt: '2026-09-27T10:00:00.000Z' },
  { turnId: 'a1', role: 'assistant', createdAt: '2026-09-27T10:00:05.000Z' },
  { turnId: 'u2', role: 'user', createdAt: '2026-09-27T10:05:00.000Z' },
  { turnId: 'a2s', role: 'assistant', createdAt: '2026-09-27T10:05:03.000Z' },
  { turnId: 'tool2', role: 'tool', createdAt: '2026-09-27T10:05:04.000Z' },
  { turnId: 'a2', role: 'assistant', createdAt: '2026-09-27T10:05:09.000Z' },
];

function thread(): ThreadMessage[] {
  return [
    { kind: 'user', id: 'u1', text: 'first' },
    { kind: 'agent', id: 'a1', text: 'one', at: '2026-09-27T10:00:05.000Z' },
    { kind: 'user', id: 'u2', text: 'second' },
    {
      kind: 'steps',
      id: 'a2s',
      text: '',
      at: '2026-09-27T10:05:03.000Z',
      stepsLabel: 'Checked memory',
      steps: [],
    },
    { kind: 'agent', id: 'a2', text: 'two', at: '2026-09-27T10:05:09.000Z' },
  ];
}

function used(t: ThreadMessage[], id: string): unknown {
  const m = t.find((x) => x.id === id) as Record<string, unknown> | undefined;
  return m?.memoryUsed;
}

describe('attachMemoryUsed (TASK-628)', () => {
  it('attributes each receipt to its own exchange by time', () => {
    const out = attachMemoryUsed(
      thread(),
      turns,
      [
        { at: '2026-09-27T10:00:02.000Z', statements: [stmt('m1')] },
        { at: '2026-09-27T10:05:02.000Z', statements: [stmt('m2')] },
      ],
      'personal',
    );
    expect(used(out, 'a1')).toEqual({
      statements: [
        {
          id: 'm1',
          about: 'person',
          relation: 'prefers',
          value: 'value-m1',
          when: '2026-09-01T00:00:00.000Z',
        },
      ],
      visibility: 'personal',
    });
    expect((used(out, 'a2') as { statements: Array<{ id: string }> }).statements.map((s) => s.id)).toEqual(['m2']);
  });

  it('puts a multi-turn answer\'s chip on the FINAL assistant message only', () => {
    const out = attachMemoryUsed(
      thread(),
      turns,
      [{ at: '2026-09-27T10:05:03.500Z', statements: [stmt('m2')] }],
      undefined,
    );
    expect(used(out, 'a2s')).toBeUndefined();
    expect(used(out, 'a2')).toEqual({ statements: [expect.objectContaining({ id: 'm2' })] });
    expect(used(out, 'a1')).toBeUndefined();
  });

  it('drops a receipt whose exchange has no assistant message yet (live turn)', () => {
    const live: MemoryUsedTurn[] = [
      ...turns,
      { turnId: 'u3', role: 'user', createdAt: '2026-09-27T10:10:00.000Z' },
    ];
    const t: ThreadMessage[] = [...thread(), { kind: 'user', id: 'u3', text: 'third' }];
    const out = attachMemoryUsed(
      t,
      live,
      [{ at: '2026-09-27T10:10:02.000Z', statements: [stmt('m3')] }],
      undefined,
    );
    expect(out.some((m) => 'memoryUsed' in m)).toBe(false);
  });

  it('drops a receipt before any person turn, and one with an unparseable time', () => {
    const out = attachMemoryUsed(
      thread(),
      turns,
      [
        { at: '2026-09-27T09:00:00.000Z', statements: [stmt('early')] },
        { at: 'not-a-time', statements: [stmt('junk')] },
      ],
      undefined,
    );
    expect(out.some((m) => 'memoryUsed' in m)).toBe(false);
  });

  it('merges two receipts in one exchange in order, deduped by id (first wins)', () => {
    const out = attachMemoryUsed(
      thread(),
      turns,
      [
        { at: '2026-09-27T10:05:02.000Z', statements: [stmt('m1'), stmt('m2', { value: 'first' })] },
        { at: '2026-09-27T10:05:06.000Z', statements: [stmt('m2', { value: 'second' }), stmt('m3')] },
      ],
      'team',
    );
    const got = used(out, 'a2') as { statements: Array<{ id: string; value: string }>; visibility: string };
    expect(got.statements.map((s) => s.id)).toEqual(['m1', 'm2', 'm3']);
    expect(got.statements[1]!.value).toBe('first');
    expect(got.visibility).toBe('team');
  });

  it('copies fields one at a time and drops malformed statements', () => {
    const out = attachMemoryUsed(
      thread(),
      turns,
      [
        {
          at: '2026-09-27T10:00:02.000Z',
          statements: [
            stmt('ok', {
              until: '2026-09-20T00:00:00.000Z',
              kind: 'preference',
              slot: 'coffee',
              aboutText: 'You',
              savedBy: 'person',
              closedSince: 'retracted',
              // Not on the wire contract — must not ride along.
              secret: 'leak',
              closedBy: 'x',
            }),
            stmt('bad-enums', { savedBy: 'robot', closedSince: 'vanished', kind: 7 }),
            { id: 'missing-value', about: 'a', relation: 'r', when: 'w' },
            { ...stmt(''), id: 42 },
            null,
            'nope',
          ],
        },
      ],
      undefined,
    );
    const got = used(out, 'a1') as { statements: Array<Record<string, unknown>> };
    expect(got.statements).toEqual([
      {
        id: 'ok',
        about: 'person',
        relation: 'prefers',
        value: 'value-ok',
        when: '2026-09-01T00:00:00.000Z',
        until: '2026-09-20T00:00:00.000Z',
        kind: 'preference',
        slot: 'coffee',
        aboutText: 'You',
        savedBy: 'person',
        closedSince: 'retracted',
      },
      {
        id: 'bad-enums',
        about: 'person',
        relation: 'prefers',
        value: 'value-bad-enums',
        when: '2026-09-01T00:00:00.000Z',
      },
    ]);
  });

  it('caps statements per message', () => {
    const many = Array.from({ length: MEMORY_USED_MAX_STATEMENTS + 20 }, (_, i) => stmt(`m${i}`));
    const out = attachMemoryUsed(
      thread(),
      turns,
      [{ at: '2026-09-27T10:00:02.000Z', statements: many }],
      undefined,
    );
    expect((used(out, 'a1') as { statements: unknown[] }).statements).toHaveLength(
      MEMORY_USED_MAX_STATEMENTS,
    );
  });

  it('ignores a receipt whose statements are all malformed (no empty chip)', () => {
    const out = attachMemoryUsed(
      thread(),
      turns,
      [{ at: '2026-09-27T10:00:02.000Z', statements: [null, 3] }],
      undefined,
    );
    expect(out.some((m) => 'memoryUsed' in m)).toBe(false);
  });
});
