import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorExcludedError, workspaceApi, WorkspaceApiError } from '../workspace-api';

// TASK-766 — the attach route answers `403 { error: 'connector-excluded' }`
// when a member re-adds a connector the agent's owner/admin removed. Only
// that body becomes a ConnectorExcludedError; every other 403 stays bare.

function respondWith(body: unknown, status: number) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => vi.restoreAllMocks());

describe('workspaceApi.attachConnector refusals', () => {
  it('a 403 connector-excluded is a ConnectorExcludedError (still a 403 WorkspaceApiError)', async () => {
    respondWith({ error: 'connector-excluded', message: 'server words' }, 403);
    const err = await workspaceApi.attachConnector('a1', 'gh').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorExcludedError);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect((err as WorkspaceApiError).status).toBe(403);
    // Our copy, never the server's text.
    expect((err as Error).message).not.toContain('server words');
  });

  it('a plain 403 forbidden stays a bare WorkspaceApiError', async () => {
    respondWith({ error: 'forbidden' }, 403);
    const err = await workspaceApi.attachConnector('a1', 'gh').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect(err).not.toBeInstanceOf(ConnectorExcludedError);
  });

  it('a 403 with an unreadable body stays a bare WorkspaceApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => {
        throw new SyntaxError('not json');
      },
    } as unknown as Response);
    const err = await workspaceApi.attachConnector('a1', 'gh').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkspaceApiError);
    expect(err).not.toBeInstanceOf(ConnectorExcludedError);
  });

  it('only a 403 is read: a 409 carrying the same code is not this refusal', async () => {
    respondWith({ error: 'connector-excluded' }, 409);
    const err = await workspaceApi.attachConnector('a1', 'gh').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ConnectorExcludedError);
    expect((err as WorkspaceApiError).status).toBe(409);
  });
});
