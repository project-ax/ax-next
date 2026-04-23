import { describe, it, expect } from 'vitest';
import { WireRequestSchema, WireResponseSchema } from '../wire.js';

describe('wire schemas', () => {
  it('accepts a well-formed request', () => {
    const ok = WireRequestSchema.safeParse({
      id: '01JABC',
      action: 'tool:execute:bash',
      payload: { command: 'echo hi', args: [] },
    });
    expect(ok.success).toBe(true);
  });
  it('rejects unknown action shape', () => {
    const bad = WireRequestSchema.safeParse({ id: '1', action: 5, payload: {} });
    expect(bad.success).toBe(false);
  });
  it('response round-trips ok + err variants', () => {
    expect(WireResponseSchema.safeParse({ id: '1', ok: true, result: { stdout: '' } }).success).toBe(true);
    expect(WireResponseSchema.safeParse({ id: '1', ok: false, error: { code: 'timeout', message: 't' } }).success).toBe(true);
  });
  it('rejects an id longer than 64 chars', () => {
    const bad = WireRequestSchema.safeParse({
      id: 'a'.repeat(65),
      action: 'tool:execute:bash',
      payload: {},
    });
    expect(bad.success).toBe(false);
  });
  it('rejects an action longer than 128 chars', () => {
    const bad = WireRequestSchema.safeParse({
      id: '1',
      action: 'a'.repeat(129),
      payload: {},
    });
    expect(bad.success).toBe(false);
  });
});
