import { describe, expect, it } from 'vitest';
import { chunkBufferOptsFor } from '../../server/plugin';

const MIN = 60_000;
const SLACK = 5 * MIN;

describe('chunk buffer shell max age', () => {
  it('shell max age follows the turn cap, not the default timeout', () => {
    expect(chunkBufferOptsFor({ chatTimeoutMs: 10 * MIN, maxTurnMs: 120 * MIN })).toEqual({
      shellMaxAgeMs: 120 * MIN + SLACK,
    });
  });

  it('without a turn cap it sizes from the chat timeout, as before', () => {
    expect(chunkBufferOptsFor({ chatTimeoutMs: 10 * MIN })).toEqual({ shellMaxAgeMs: 10 * MIN + SLACK });
  });

  it('with neither, the buffer keeps its own default', () => {
    expect(chunkBufferOptsFor({})).toEqual({});
  });
});
