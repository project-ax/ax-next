import { describe, it, expect } from 'vitest';
import { CredentialPlaceholderMap, SharedCredentialRegistry } from '../registry.js';

describe('CredentialPlaceholderMap', () => {
  it('register returns ax-cred: prefixed placeholder', () => {
    const m = new CredentialPlaceholderMap();
    const ph = m.register('ANTHROPIC_API_KEY', 'sk-real');
    expect(ph).toMatch(/^ax-cred:[0-9a-f]{32}$/);
  });

  it('replaceAll substitutes placeholder with real value', () => {
    const m = new CredentialPlaceholderMap();
    const ph = m.register('K', 'real-secret');
    expect(m.replaceAll(`auth: ${ph}`)).toBe('auth: real-secret');
  });

  it('hasPlaceholders true when any placeholder appears in input', () => {
    const m = new CredentialPlaceholderMap();
    const ph = m.register('K', 'secret');
    expect(m.hasPlaceholders(`x ${ph} y`)).toBe(true);
    expect(m.hasPlaceholders('no creds here')).toBe(false);
  });

  it('replaceAllBuffer returns same Buffer instance when no placeholders present', () => {
    const m = new CredentialPlaceholderMap();
    m.register('K', 'secret');
    const buf = Buffer.from('plain text');
    expect(m.replaceAllBuffer(buf)).toBe(buf); // identity check, not equality
  });

  it('re-registering same env name replaces previous placeholder', () => {
    const m = new CredentialPlaceholderMap();
    const ph1 = m.register('K', 'v1');
    const ph2 = m.register('K', 'v2');
    expect(ph1).not.toBe(ph2);
    expect(m.hasPlaceholders(ph1)).toBe(false); // old retired
    expect(m.replaceAll(ph2)).toBe('v2');
  });

  it('toEnvMap returns env-name → placeholder map', () => {
    const m = new CredentialPlaceholderMap();
    const ph = m.register('ANTHROPIC_API_KEY', 'sk-real');
    expect(m.toEnvMap()).toEqual({ ANTHROPIC_API_KEY: ph });
  });
});

describe('SharedCredentialRegistry', () => {
  it('substitutes placeholder from any registered session', () => {
    const reg = new SharedCredentialRegistry();
    const m1 = new CredentialPlaceholderMap(); const ph1 = m1.register('K', 'v1');
    const m2 = new CredentialPlaceholderMap(); const ph2 = m2.register('K', 'v2');
    reg.register('s1', m1);
    reg.register('s2', m2);
    expect(reg.replaceAll(`${ph1} ${ph2}`)).toBe('v1 v2');
  });

  it('deregister removes session', () => {
    const reg = new SharedCredentialRegistry();
    const m = new CredentialPlaceholderMap();
    const ph = m.register('K', 'secret');
    reg.register('s', m);
    reg.deregister('s');
    expect(reg.hasPlaceholders(ph)).toBe(false);
  });

  it('replaceAllBuffer returns same Buffer when no session has placeholders', () => {
    const reg = new SharedCredentialRegistry();
    reg.register('s', new CredentialPlaceholderMap());
    const buf = Buffer.from('hello');
    expect(reg.replaceAllBuffer(buf)).toBe(buf);
  });

  it('deregister only removes the named session, leaves others intact', () => {
    const reg = new SharedCredentialRegistry();
    const m1 = new CredentialPlaceholderMap(); const ph1 = m1.register('K', 'v1');
    const m2 = new CredentialPlaceholderMap(); const ph2 = m2.register('K', 'v2');
    reg.register('s1', m1);
    reg.register('s2', m2);
    reg.deregister('s1');
    expect(reg.hasPlaceholders(ph1)).toBe(false);
    expect(reg.replaceAll(`${ph1} ${ph2}`)).toBe(`${ph1} v2`); // s2 still works
  });
});
