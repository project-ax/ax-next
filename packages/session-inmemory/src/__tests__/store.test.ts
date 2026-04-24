import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import { createSessionStore } from '../store.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

describe('@ax/session-inmemory store', () => {
  it('create() returns the sessionId and a 43-char base64url token', () => {
    const store = createSessionStore();
    const rec = store.create('s-1', '/tmp/ws');
    expect(rec.sessionId).toBe('s-1');
    expect(rec.workspaceRoot).toBe('/tmp/ws');
    expect(rec.token).toMatch(TOKEN_RE);
    expect(rec.terminated).toBe(false);
  });

  it('create() throws PluginError(code: duplicate-session) on duplicate sessionId', () => {
    const store = createSessionStore();
    store.create('s-1', '/tmp/ws');
    let caught: unknown;
    try {
      store.create('s-1', '/tmp/ws-2');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('duplicate-session');
  });

  it('two tokens in succession are distinct (crypto randomness sanity check)', () => {
    const store = createSessionStore();
    const a = store.create('s-a', '/tmp/ws');
    const b = store.create('s-b', '/tmp/ws');
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(TOKEN_RE);
    expect(b.token).toMatch(TOKEN_RE);
  });

  it('resolveToken() returns the session for a valid token', () => {
    const store = createSessionStore();
    const rec = store.create('s-1', '/tmp/ws');
    expect(store.resolveToken(rec.token)).toEqual({
      sessionId: 's-1',
      workspaceRoot: '/tmp/ws',
    });
  });

  it('resolveToken() returns null for an unknown token', () => {
    const store = createSessionStore();
    store.create('s-1', '/tmp/ws');
    expect(store.resolveToken('definitely-not-a-real-token-1234567890123456789')).toBeNull();
  });

  it('resolveToken() returns null for a terminated session', () => {
    const store = createSessionStore();
    const rec = store.create('s-1', '/tmp/ws');
    store.terminate('s-1');
    expect(store.resolveToken(rec.token)).toBeNull();
  });

  it('terminate() is idempotent — calling twice does not throw', () => {
    const store = createSessionStore();
    store.create('s-1', '/tmp/ws');
    expect(() => {
      store.terminate('s-1');
      store.terminate('s-1');
    }).not.toThrow();
  });

  it('terminate() on a non-existent session is a no-op', () => {
    const store = createSessionStore();
    expect(() => store.terminate('nope')).not.toThrow();
    // And a subsequent create with that ID must still succeed.
    const rec = store.create('nope', '/tmp/ws');
    expect(rec.sessionId).toBe('nope');
  });
});
