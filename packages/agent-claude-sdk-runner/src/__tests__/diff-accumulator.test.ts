import { describe, expect, it } from 'vitest';
import { createDiffAccumulator, toWireChanges } from '../diff-accumulator.js';

describe('createDiffAccumulator (Task 7c)', () => {
  it('starts empty and reports isEmpty', () => {
    const acc = createDiffAccumulator();
    expect(acc.isEmpty()).toBe(true);
    expect(acc.drain()).toEqual([]);
  });

  it('records puts and deletes; drain returns aggregated and resets', () => {
    const acc = createDiffAccumulator();
    acc.record({
      path: 'a.txt',
      kind: 'put',
      content: Buffer.from('AAA', 'utf8'),
    });
    acc.record({
      path: 'b.txt',
      kind: 'put',
      content: Buffer.from('BBB', 'utf8'),
    });
    acc.record({ path: 'old.txt', kind: 'delete' });

    expect(acc.isEmpty()).toBe(false);
    const drained = acc.drain();
    expect(drained).toHaveLength(3);
    // Drain resets the accumulator.
    expect(acc.isEmpty()).toBe(true);
    expect(acc.drain()).toEqual([]);
  });

  it('last-write-wins per path within the same drain cycle', () => {
    const acc = createDiffAccumulator();
    acc.record({
      path: 'x',
      kind: 'put',
      content: Buffer.from('first', 'utf8'),
    });
    acc.record({ path: 'x', kind: 'delete' });
    acc.record({
      path: 'x',
      kind: 'put',
      content: Buffer.from('final', 'utf8'),
    });
    const drained = acc.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]?.kind).toBe('put');
    if (drained[0]?.kind === 'put') {
      expect(Buffer.from(drained[0].content).toString('utf8')).toBe('final');
    }
  });

  it('snapshot returns the changes WITHOUT clearing the accumulator', () => {
    const acc = createDiffAccumulator();
    acc.record({
      path: 'a',
      kind: 'put',
      content: Buffer.from('AAA', 'utf8'),
    });
    acc.record({ path: 'b', kind: 'delete' });

    const first = acc.snapshot();
    expect(first).toHaveLength(2);
    expect(acc.isEmpty()).toBe(false);

    // Calling snapshot again returns the same state.
    const second = acc.snapshot();
    expect(second).toHaveLength(2);
    expect(acc.isEmpty()).toBe(false);

    // Drain after the snapshot — only now does the accumulator clear.
    const drained = acc.drain();
    expect(drained).toHaveLength(2);
    expect(acc.isEmpty()).toBe(true);
  });

  it('snapshot returns a fresh array each call (caller can mutate without poisoning)', () => {
    const acc = createDiffAccumulator();
    acc.record({
      path: 'x',
      kind: 'put',
      content: Buffer.from('1', 'utf8'),
    });
    const first = acc.snapshot();
    first.push({ path: 'phantom', kind: 'delete' });
    const second = acc.snapshot();
    expect(second).toHaveLength(1);
    expect(second[0]?.path).toBe('x');
  });

  it('records made between snapshot and drain are preserved by drain', () => {
    // The snapshot-then-drain pattern in the runners: take a snapshot,
    // ship it over IPC, drain on success. If new changes land between
    // snapshot and drain (theoretically possible if records arrive out
    // of band), drain captures the full current state — including the
    // post-snapshot ones. That's correct: we don't want to lose the new
    // ones, even though they weren't in the snapshot we just shipped.
    const acc = createDiffAccumulator();
    acc.record({
      path: 'a',
      kind: 'put',
      content: Buffer.from('one', 'utf8'),
    });
    const snap = acc.snapshot();
    expect(snap).toHaveLength(1);
    acc.record({
      path: 'b',
      kind: 'put',
      content: Buffer.from('two', 'utf8'),
    });
    const drained = acc.drain();
    expect(drained).toHaveLength(2);
  });
});

describe('toWireChanges', () => {
  it('base64-encodes put.content; leaves delete unchanged', () => {
    const wire = toWireChanges([
      { path: 'a', kind: 'put', content: Buffer.from('AAA', 'utf8') },
      { path: 'b', kind: 'delete' },
    ]);
    expect(wire).toEqual([
      { path: 'a', kind: 'put', content: Buffer.from('AAA').toString('base64') },
      { path: 'b', kind: 'delete' },
    ]);
  });

  it('round-trips through the workspace.commit-notify wire schema', async () => {
    // Confirm encode-then-Zod-decode reconstitutes the bytes.
    const { FileChangeSchema } = await import('@ax/ipc-protocol');
    const wire = toWireChanges([
      { path: 'x', kind: 'put', content: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const parsed = FileChangeSchema.parse(wire[0]);
    if (parsed.kind === 'put') {
      expect(Array.from(parsed.content)).toEqual([1, 2, 3, 4]);
    } else {
      throw new Error('expected put');
    }
  });
});
