import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { PluginError } from '@ax/core';
import { createWorkspaceGitServer, type WorkspaceGitServer } from '../server/index.js';
import { createWorkspaceGitHttpClient } from '../client.js';

describe('workspace-git-http client', () => {
  let server: WorkspaceGitServer | null = null;
  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  async function freshClient() {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-client-')),
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
    });
    return createWorkspaceGitHttpClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: 'secret',
    });
  }

  it('apply round-trips end-to-end', async () => {
    const c = await freshClient();
    const r = await c.apply({
      changes: [
        { path: 'a', kind: 'put', contentBase64: Buffer.from('x').toString('base64') },
      ],
      parent: null,
    });
    expect(r.delta.changes[0]?.kind).toBe('added');
  });

  it('parent-mismatch from server surfaces as PluginError with structured cause', async () => {
    const c = await freshClient();
    const seed = await c.apply({ changes: [], parent: null });
    let caught: unknown;
    try {
      await c.apply({ changes: [], parent: 'wrong' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    const err = caught as PluginError;
    expect(err.code).toBe('parent-mismatch');
    const cause = err.cause as { actualParent?: string | null } | undefined;
    expect(cause?.actualParent).toBe(seed.version);
  });

  it('connection refused surfaces as WorkspaceServerUnavailableError', async () => {
    const c = createWorkspaceGitHttpClient({
      // Port 1 is unbound on basically every machine.
      baseUrl: 'http://127.0.0.1:1',
      token: 'secret',
      maxRetries: 0,
    });
    await expect(c.list({})).rejects.toMatchObject({
      name: 'WorkspaceServerUnavailableError',
    });
  });

  it('respects per-action timeout override', async () => {
    // freshClient() is called for its side effect of populating the outer
    // `server` (used by `fast` below). The returned client is unused here.
    await freshClient();
    const fast = createWorkspaceGitHttpClient({
      baseUrl: `http://127.0.0.1:${server!.port}`,
      token: 'secret',
      timeouts: { 'workspace.apply': 1 },
      maxRetries: 0,
    });
    await expect(fast.apply({ changes: [], parent: null })).rejects.toMatchObject({
      name: 'WorkspaceServerUnavailableError',
    });
  });

  it('read found / not-found round-trip', async () => {
    const c = await freshClient();
    const r1 = await c.read({ path: 'nope' });
    expect(r1.found).toBe(false);
    await c.apply({
      changes: [
        { path: 'a', kind: 'put', contentBase64: Buffer.from('hi').toString('base64') },
      ],
      parent: null,
    });
    const r2 = await c.read({ path: 'a' });
    expect(r2.found).toBe(true);
    if (r2.found) {
      expect(Buffer.from(r2.bytesBase64, 'base64').toString()).toBe('hi');
    }
  });

  it('list with pathGlob honors the glob', async () => {
    const c = await freshClient();
    await c.apply({
      changes: [
        { path: 'src/a.ts', kind: 'put', contentBase64: Buffer.from('a').toString('base64') },
        { path: 'src/b.ts', kind: 'put', contentBase64: Buffer.from('b').toString('base64') },
        { path: 'README.md', kind: 'put', contentBase64: Buffer.from('r').toString('base64') },
      ],
      parent: null,
    });
    const list = await c.list({ pathGlob: 'src/**' });
    expect([...list.paths].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
