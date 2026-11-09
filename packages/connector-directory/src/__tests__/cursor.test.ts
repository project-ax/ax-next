import { describe, expect, it } from 'vitest';
import { PluginError } from '@ax/core';
import { CURSOR_MAX } from '../contract.js';
import { decodeCursor, encodeCursor } from '../search.js';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** The PluginError decodeCursor throws; fails the test on anything else. */
function refusal(cursor: string): PluginError {
  try {
    decodeCursor(cursor);
  } catch (err) {
    expect(err).toBeInstanceOf(PluginError);
    return err as PluginError;
  }
  throw new Error('expected decodeCursor to throw');
}

describe('search cursor', () => {
  it.each([0, 20, 100_000])('round-trips offset %i', (offset) => {
    const cursor = encodeCursor(offset);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor.length).toBeLessThanOrEqual(CURSOR_MAX);
    expect(decodeCursor(cursor)).toBe(offset);
  });

  it('is base64url of {"o":offset}', () => {
    expect(encodeCursor(20)).toBe(b64('{"o":20}'));
  });

  it.each([
    '!!',
    '',
    b64('nope'),
    b64('{"o":-1}'),
    b64('{"o":1.5}'),
    b64('{"o":100001}'),
    b64('{"o":1,"x":1}'),
    b64('{"o":"1"}'),
    b64('{"x":1}'),
    b64('[1]'),
    b64('null'),
    // A valid offset, but not the cursor we would have written for it.
    b64('{"o":1e3}'),
    b64('{ "o": 1 }'),
    `${b64('{"o":1}')}=`,
  ])('refuses %j as invalid-payload with fixed text', (cursor) => {
    const err = refusal(cursor);
    expect(err.code).toBe('invalid-payload');
    expect(err.plugin).toBe('@ax/connector-directory');
    expect(err.message).toBe('invalid cursor');
  });

  it('the refusal never quotes the cursor', () => {
    const cursor = b64('{"o":"SECRET-TEXT"}');
    expect(refusal(cursor).message).not.toContain(cursor);
    expect(refusal(cursor).message).not.toContain('SECRET-TEXT');
  });
});
