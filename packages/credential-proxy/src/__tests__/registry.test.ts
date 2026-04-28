import { describe, it, expect } from 'vitest';
import { CredentialPlaceholderMap } from '../registry.js';

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
