import { describe, it, expect } from 'vitest';
import { requireKeys } from '../env.js';

describe('requireKeys', () => {
  it('throws listing every missing key', () => {
    expect(() =>
      requireKeys({ A: undefined, B: 'set', C: undefined }),
    ).toThrow(/missing.*A.*C/i);
  });

  it('returns the value object when all keys present', () => {
    expect(requireKeys({ A: 'a', B: 'b' })).toEqual({ A: 'a', B: 'b' });
  });
});
