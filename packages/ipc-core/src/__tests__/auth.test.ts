import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import type {
  SessionCreateInput,
  SessionCreateOutput,
  SessionTerminateInput,
  SessionTerminateOutput,
} from '@ax/session-inmemory';
import { authenticate } from '../auth.js';

// ---------------------------------------------------------------------------
// Auth middleware tests
//
// We drive authenticate() directly against a live session store. No HTTP
// here — the middleware's contract is `(authHeader, bus, ctx) -> AuthResult`.
//
// Every negative path asserts the token value is ABSENT from the message
// (I9). Positive path asserts the returned sessionId + workspaceRoot match
// what was registered.
// ---------------------------------------------------------------------------

async function makeHarnessWithSession(sessionId: string, workspaceRoot: string) {
  const h = await createTestHarness({ plugins: [createSessionInmemoryPlugin()] });
  const ctx = h.ctx();
  const { token } = await h.bus.call<SessionCreateInput, SessionCreateOutput>(
    'session:create',
    ctx,
    { sessionId, workspaceRoot },
  );
  return { ...h, token };
}

describe('authenticate', () => {
  it('rejects a missing Authorization header with 401 / missing authorization', async () => {
    const h = await makeHarnessWithSession('s-1', '/tmp/ws');
    const result = await authenticate(undefined, h.bus, h.ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('SESSION_INVALID');
    expect(result.body.error.message).toBe('missing authorization');
    // No token value in message (there isn't one to leak, but assert structure).
    expect(result.body.error.message).not.toContain(h.token);
  });

  it('rejects a malformed scheme (Basic xyz) with 401 / invalid authorization scheme', async () => {
    const h = await makeHarnessWithSession('s-2', '/tmp/ws');
    const result = await authenticate('Basic xyz', h.bus, h.ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('SESSION_INVALID');
    expect(result.body.error.message).toBe('invalid authorization scheme');
    expect(result.body.error.message).not.toContain('xyz');
  });

  it('rejects Bearer <unknown-token> with 401 / unknown token, without echoing the token', async () => {
    const h = await makeHarnessWithSession('s-3', '/tmp/ws');
    const badToken = 'totally-bogus-token-value';
    const result = await authenticate(`Bearer ${badToken}`, h.bus, h.ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('SESSION_INVALID');
    expect(result.body.error.message).toBe('unknown token');
    // I9: the offending token MUST NOT appear in the error body.
    expect(result.body.error.message).not.toContain(badToken);
  });

  it('accepts Bearer <valid-token> and returns sessionId + workspaceRoot', async () => {
    const h = await makeHarnessWithSession('s-4', '/tmp/ws-4');
    const result = await authenticate(`Bearer ${h.token}`, h.bus, h.ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBe('s-4');
    expect(result.workspaceRoot).toBe('/tmp/ws-4');
  });

  it('rejects a terminated session with 401 / unknown token', async () => {
    const h = await makeHarnessWithSession('s-5', '/tmp/ws');
    await h.bus.call<SessionTerminateInput, SessionTerminateOutput>(
      'session:terminate',
      h.ctx(),
      { sessionId: 's-5' },
    );
    const result = await authenticate(`Bearer ${h.token}`, h.bus, h.ctx());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('SESSION_INVALID');
    // The token no longer resolves; message stays generic.
    expect(result.body.error.message).toBe('unknown token');
    expect(result.body.error.message).not.toContain(h.token);
  });

  it('matches the Bearer scheme case-insensitively', async () => {
    const h = await makeHarnessWithSession('s-6', '/tmp/ws-6');
    const result = await authenticate(`bearer ${h.token}`, h.bus, h.ctx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBe('s-6');
    expect(result.workspaceRoot).toBe('/tmp/ws-6');
  });
});
