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
