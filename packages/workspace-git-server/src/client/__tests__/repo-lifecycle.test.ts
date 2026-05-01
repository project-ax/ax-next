import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspaceGitServer, type WorkspaceGitServer } from '../../server/index.js';
import { createRepoLifecycleClient } from '../repo-lifecycle.js';

// Boots a real server, exercises the REST surface from the host-side client.
// The server is shared across the file (one tempdir, one listener) so tests
// don't pay the spawn cost 10+ times. Each test picks a unique workspaceId.

describe('repo-lifecycle REST client', () => {
  let server: WorkspaceGitServer;
  let repoRoot: string;
  const TOKEN = 'super-secret';

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-rl-client-'));
    server = await createWorkspaceGitServer({
      repoRoot,
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const baseUrl = (): string => `http://127.0.0.1:${server.port}`;

  it('createRepo returns 201 body for a fresh workspaceId', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: TOKEN });
    const r = await client.createRepo('ws1');
    expect(r.workspaceId).toBe('ws1');
    expect(typeof r.createdAt).toBe('string');
    expect(new Date(r.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('createRepo throws "repo already exists" on 409', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: TOKEN });
    await client.createRepo('ws2');
    await expect(client.createRepo('ws2')).rejects.toThrow('repo already exists');
  });

  it('createRepo throws "invalid workspaceId" on 400', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: TOKEN });
    await expect(client.createRepo('NOT/VALID')).rejects.toThrow(
      'invalid workspaceId',
    );
  });

  it('createRepo throws "unauthorized" on 401', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: 'wrong' });
    await expect(client.createRepo('ws3')).rejects.toThrow('unauthorized');
  });

  it('getRepo returns headOid:null for a fresh repo', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: TOKEN });
    await client.createRepo('ws4');
    const r = await client.getRepo('ws4');
    expect(r).not.toBeNull();
    expect(r!.exists).toBe(true);
    expect(r!.headOid).toBeNull();
    expect(r!.workspaceId).toBe('ws4');
  });

  it('getRepo returns null for a missing repo', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: TOKEN });
    const r = await client.getRepo('does-not-exist');
    expect(r).toBeNull();
  });

  it('getRepo throws "unauthorized" on 401', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: 'wrong' });
    await expect(client.getRepo('ws4')).rejects.toThrow('unauthorized');
  });

  it('deleteRepo returns void on 204', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: TOKEN });
    await client.createRepo('ws5');
    await client.deleteRepo('ws5');
    // After delete, getRepo should return null.
    const r = await client.getRepo('ws5');
    expect(r).toBeNull();
  });

  it('deleteRepo is idempotent (204 even if missing)', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: TOKEN });
    await client.deleteRepo('never-existed');
  });

  it('deleteRepo throws "unauthorized" on 401', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: 'wrong' });
    await expect(client.deleteRepo('ws-x')).rejects.toThrow('unauthorized');
  });

  it('isHealthy returns true when the server is up', async () => {
    const client = createRepoLifecycleClient({ baseUrl: baseUrl(), token: TOKEN });
    expect(await client.isHealthy()).toBe(true);
  });

  it('isHealthy returns false when the server is unreachable', async () => {
    const client = createRepoLifecycleClient({
      baseUrl: 'http://127.0.0.1:1', // port 1 is reserved/closed
      token: TOKEN,
    });
    expect(await client.isHealthy()).toBe(false);
  });

  // Token-leak guard: any thrown Error must NOT contain the token. Even on
  // network failures (where the URL is echoed for ops debugging), the token
  // stays out of the message.
  it('thrown errors never contain the token (network failure)', async () => {
    const client = createRepoLifecycleClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 'super-secret',
    });
    let captured: unknown;
    try {
      await client.createRepo('any');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const msg = (captured as Error).message;
    expect(msg).not.toContain('super-secret');
  });

  it('thrown errors never contain the token (wrong-token 401 path)', async () => {
    // Use a server-token mismatch: server expects TOKEN; client sends a
    // different "super-secret-leak-canary" string. A 401 must surface as
    // 'unauthorized' with no leak of the supplied token.
    const wrong = createRepoLifecycleClient({
      baseUrl: baseUrl(),
      token: 'super-secret-leak-canary',
    });
    let capturedAuth: unknown;
    try {
      await wrong.createRepo('ws-leak-check');
    } catch (err) {
      capturedAuth = err;
    }
    expect(capturedAuth).toBeInstanceOf(Error);
    expect((capturedAuth as Error).message).not.toContain('super-secret-leak-canary');
  });

  it('injectable fetch is honored', async () => {
    let calls = 0;
    const stubFetch: typeof fetch = async (..._args) => {
      calls++;
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const client = createRepoLifecycleClient({
      baseUrl: 'http://does-not-matter:0',
      token: 'tok',
      fetch: stubFetch,
    });
    expect(await client.isHealthy()).toBe(true);
    expect(calls).toBe(1);
  });

  it('createRepo aborts when the configured timeoutMs elapses', async () => {
    // Stub fetch that never resolves on its own; only the AbortController
    // can wake it up. If the client doesn't wire timeoutMs correctly, this
    // hangs forever and the vitest timeout fires — that's the failure mode
    // we're guarding against.
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init?.signal ?? null) as AbortSignal | null;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }
      });
    const client = createRepoLifecycleClient({
      baseUrl: 'http://does-not-matter:0',
      token: 'tok',
      fetch: hangingFetch,
      timeoutMs: 50,
    });
    const start = Date.now();
    let captured: unknown;
    try {
      await client.createRepo('any');
    } catch (err) {
      captured = err;
    }
    const elapsed = Date.now() - start;
    expect(captured).toBeInstanceOf(Error);
    // Should reject roughly at the timeout — give a generous upper bound to
    // tolerate slow CI machines, but it must NOT hang (which would push
    // elapsed up to the vitest default timeout of 5s).
    expect(elapsed).toBeLessThan(2_000);
  });
});
