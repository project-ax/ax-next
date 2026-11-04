import { describe, expect, it } from 'vitest';
import { faultLogFields } from '../fault-code.js';
import { PluginError } from '../errors.js';
import { SafeToolError } from '../safe-tool-error.js';

describe('faultLogFields', () => {
  it("names a PluginError's code, class, hook and plugin", () => {
    expect(
      faultLogFields(new PluginError({ code: 'corrupt-row', plugin: '@ax/connectors', hookName: 'connectors:get', message: 'secret text' })),
    ).toEqual({ code: 'corrupt-row', name: 'PluginError', plugin: '@ax/connectors', hookName: 'connectors:get' });
  });

  it("names a SafeToolError's tool code, not the invalid-payload it extends", () => {
    expect(faultLogFields(new SafeToolError('busy', 'input')).code).toBe('busy');
  });

  it('re-checks a mutated tool code against the closed set', () => {
    const mutated = Object.assign(new SafeToolError('validation', 'input'), { toolCode: 'SECRET' });
    expect(faultLogFields(mutated).code).toBe('unavailable');
  });

  it("adds the cause's code and class one level down (the bus's 'unknown' wrap)", () => {
    const raw = Object.assign(new Error('relation "x" does not exist'), { code: '42P01' });
    const wrapped = new PluginError({ code: 'unknown', plugin: 'core', hookName: 'h', message: `threw: ${raw.message}`, cause: raw });
    expect(faultLogFields(wrapped)).toMatchObject({ code: 'unknown', causeCode: '42P01', causeName: 'Error', hookName: 'h' });
  });

  it('says which hook failed for a codeless raw throw behind the bus', () => {
    const raw = new TypeError('PRIVATE cannot read x of undefined');
    const wrapped = new PluginError({ code: 'unknown', plugin: '@ax/core', hookName: 'routines:get', message: `threw: ${raw.message}`, cause: raw });
    const out = faultLogFields(wrapped);
    expect(out).toMatchObject({ code: 'unknown', hookName: 'routines:get', causeName: 'TypeError' });
    expect(JSON.stringify(out)).not.toContain('PRIVATE');
  });

  it('keeps an identifier-shaped code on a plain error (SQLSTATE, errno)', () => {
    expect(faultLogFields(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toEqual({ code: 'ECONNREFUSED', name: 'Error' });
  });

  it('drops a field that is not identifier-shaped, and never writes a message', () => {
    const odd = Object.assign(new Error('secret message'), { code: 'has spaces: secret', name: 'Name with secret' });
    const out = faultLogFields(new Error('outer secret', { cause: odd }));
    expect(out).toEqual({ name: 'Error' });
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('keeps a sub-plugin name', () => {
    for (const plugin of ['@ax/cli/dev-agents-stub', '@ax/credentials-admin-routes/destinations', 'teams']) {
      expect(faultLogFields(new PluginError({ code: 'x', plugin, message: 'm' })).plugin).toBe(plugin);
    }
  });

  it('drops a credential URL, email or path in any field', () => {
    for (const secret of ['postgres://admin:hunter2@db.internal:5432/prod', 'alice.smith@example.com', 'home/alice/.ssh/id_rsa', 'home/alice/secrets']) {
      const inner = Object.assign(new Error('x'), { code: secret, name: secret });
      const outer = Object.assign(new PluginError({ code: secret, plugin: secret, hookName: secret, message: 'x', cause: inner }), { name: secret });
      expect(JSON.stringify(faultLogFields(outer))).not.toContain(secret);
    }
  });

  it('answers nothing for a non-Error', () => {
    expect(faultLogFields('boom')).toEqual({});
    expect(faultLogFields(undefined)).toEqual({});
  });

  it('never throws on a hostile getter', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'code', { get() { throw new Error('nope'); } });
    Object.defineProperty(hostile, 'name', { get() { throw new Error('nope'); } });
    expect(faultLogFields(hostile)).toEqual({});
  });
});
