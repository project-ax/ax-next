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

  it('rejects request with non-string action', () => {
    expect(WireRequestSchema.safeParse({ id: '1', action: 5, payload: {} }).success).toBe(false);
  });

  it('rejects request with id over 64 chars', () => {
    expect(WireRequestSchema.safeParse({ id: 'a'.repeat(65), action: 'x', payload: {} }).success).toBe(false);
  });

  it('round-trips ok + err response variants', () => {
    expect(WireResponseSchema.safeParse({ id: '1', ok: true, result: { stdout: '' } }).success).toBe(true);
    expect(WireResponseSchema.safeParse({ id: '1', ok: false, error: { code: 'timeout', message: 't' } }).success).toBe(true);
  });

  it('rejects discriminator missing', () => {
    expect(WireResponseSchema.safeParse({ id: '1', result: {} }).success).toBe(false);
  });
});
