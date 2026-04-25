import { describe, it, expect } from 'vitest';
import { checkBearerToken } from '../auth.js';

describe('git-server bearer auth', () => {
  it('accepts the exact token', () => {
    const r = checkBearerToken('Bearer abc123', 'abc123');
    expect(r.ok).toBe(true);
  });
  it('rejects missing header', () => {
    const r = checkBearerToken(undefined, 'abc123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
  it('rejects wrong scheme', () => {
    const r = checkBearerToken('Basic abc123', 'abc123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
  it('rejects wrong token', () => {
    const r = checkBearerToken('Bearer wrong', 'abc123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
  it('does not echo token in error message', () => {
    const r = checkBearerToken('Bearer my-leaked-token', 'abc123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('my-leaked-token');
  });
  it('mismatched-length token does not throw on timingSafeEqual', () => {
    expect(() => checkBearerToken('Bearer x', 'abc123')).not.toThrow();
  });
});
