import { describe, expect, it } from 'vitest';
import { faultLogFields } from '../fault-code.js';
import { PluginError } from '../errors.js';
import { SafeToolError } from '../safe-tool-error.js';

describe('faultLogFields', () => {
  it("names a PluginError's code", () => {
    expect(faultLogFields(new PluginError({ code: 'corrupt-row', plugin: 'p', message: 'secret text' }))).toEqual({
      code: 'corrupt-row',
    });
  });

  it("names a SafeToolError's tool code, not the invalid-payload it extends", () => {
    expect(faultLogFields(new SafeToolError('busy', 'input'))).toEqual({ code: 'busy' });
  });

  it('re-checks a mutated tool code against the closed set', () => {
    const mutated = Object.assign(new SafeToolError('validation', 'input'), { toolCode: 'SECRET' });
    expect(faultLogFields(mutated)).toEqual({ code: 'unavailable' });
  });

  it("adds the cause's code one level down (the bus's 'unknown' wrap)", () => {
    const raw = Object.assign(new Error('relation "x" does not exist'), { code: '42P01' });
    const wrapped = new PluginError({ code: 'unknown', plugin: 'core', hookName: 'h', message: `threw: ${raw.message}`, cause: raw });
    expect(faultLogFields(wrapped)).toEqual({ code: 'unknown', causeCode: '42P01' });
  });

  it('keeps an identifier-shaped code on a plain error (SQLSTATE, errno)', () => {
    expect(faultLogFields(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toEqual({ code: 'ECONNREFUSED' });
  });

  it('drops a code that is not identifier-shaped, and never writes a message', () => {
    const odd = Object.assign(new Error('secret message'), { code: 'has spaces: secret' });
    const out = faultLogFields(new Error('outer secret', { cause: odd }));
    expect(out).toEqual({});
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('answers nothing for a non-Error or a codeless error', () => {
    expect(faultLogFields('boom')).toEqual({});
    expect(faultLogFields(undefined)).toEqual({});
    expect(faultLogFields(new Error('boom'))).toEqual({});
  });

  it('never throws on a hostile getter', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'code', { get() { throw new Error('nope'); } });
    expect(faultLogFields(hostile)).toEqual({});
  });
});
