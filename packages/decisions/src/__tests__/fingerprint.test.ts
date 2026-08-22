import { describe, expect, it } from 'vitest';
import { callFingerprint } from '../fingerprint.js';

describe('callFingerprint', () => {
  it('is stable across key order', () => {
    expect(callFingerprint({ name: 'gmail_send', input: { a: 1, b: 2 } })).toBe(
      callFingerprint({ name: 'gmail_send', input: { b: 2, a: 1 } }),
    );
  });

  it('is stable across nested key order', () => {
    expect(callFingerprint({ name: 't', input: { x: { p: 1, q: 2 } } })).toBe(
      callFingerprint({ name: 't', input: { x: { q: 2, p: 1 } } }),
    );
  });

  it('changes when any value changes', () => {
    expect(callFingerprint({ name: 't', input: { a: 1 } })).not.toBe(
      callFingerprint({ name: 't', input: { a: 2 } }),
    );
  });

  it('changes when the tool name changes', () => {
    expect(callFingerprint({ name: 'a', input: {} })).not.toBe(
      callFingerprint({ name: 'b', input: {} }),
    );
  });

  it('does NOT depend on the call id — the same call retried is the same call', () => {
    expect(callFingerprint({ name: 't', input: {}, id: 'x' } as never)).toBe(
      callFingerprint({ name: 't', input: {}, id: 'y' } as never),
    );
  });

  it('distinguishes array order', () => {
    expect(callFingerprint({ name: 't', input: { a: [1, 2] } })).not.toBe(
      callFingerprint({ name: 't', input: { a: [2, 1] } }),
    );
  });

  // ---------------------------------------------------------------------
  // Below the plan's list: the shapes an attacker-shaped input can take.
  // The fingerprint is a security boundary — "the human approved exactly
  // this" — so a collision between two DIFFERENT calls is the bug that
  // matters, not a false miss.
  // ---------------------------------------------------------------------

  it('is a 64-char lowercase hex digest', () => {
    expect(callFingerprint({ name: 't', input: {} })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not collide when a key name is chosen to look like the encoding', () => {
    // A naive `k=v` / JSON.stringify concatenation collides on inputs like
    // these; the length-free canonical form must not.
    expect(callFingerprint({ name: 't', input: { 'a":1,"b': 2 } })).not.toBe(
      callFingerprint({ name: 't', input: { a: 1, b: 2 } }),
    );
  });

  it('separates the tool name from the input', () => {
    // `['ab', {}]` must not hash the same as `['a', 'b{}']`-ish smears.
    expect(callFingerprint({ name: 'ab', input: null })).not.toBe(
      callFingerprint({ name: 'a', input: 'b' }),
    );
  });

  it('distinguishes an absent key from an explicit null', () => {
    expect(callFingerprint({ name: 't', input: { a: null } })).not.toBe(
      callFingerprint({ name: 't', input: {} }),
    );
  });

  it('treats an explicitly-undefined key as absent, matching JSON round-trip', () => {
    // The call is persisted as JSON and read back; `{a: undefined}` becomes
    // `{}` on that trip. If the fingerprint disagreed, an approved call would
    // never match itself after a restart.
    expect(callFingerprint({ name: 't', input: { a: undefined } })).toBe(
      callFingerprint({ name: 't', input: {} }),
    );
  });

  it('survives a non-object input', () => {
    expect(callFingerprint({ name: 't', input: 'plain' })).toMatch(/^[0-9a-f]{64}$/);
    expect(callFingerprint({ name: 't', input: undefined })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is total — an unserialisable input throws nothing at the caller', () => {
    // A BigInt would make JSON.stringify throw. The gate calls this before it
    // can veto anything, and a throw there is swallowed by HookBus.fire as a
    // clean pass, i.e. a silent allow.
    expect(() => callFingerprint({ name: 't', input: { a: 1n } })).not.toThrow();
  });

  it('is total on a cyclic input', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => callFingerprint({ name: 't', input: cyclic })).not.toThrow();
  });
});
