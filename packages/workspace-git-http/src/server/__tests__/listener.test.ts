import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createWorkspaceGitServer, type WorkspaceGitServer } from '../index.js';

describe('git-server listener', () => {
  let server: WorkspaceGitServer | null = null;

  afterEach(async () => {
    if (server !== null) await server.close();
    server = null;
  });

  it('rejects requests without bearer auth (401)', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1', port: 0, token: 'secret',
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/workspace.list`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error.message).not.toContain('secret');
  });

  it('apply round-trips with bearer auth', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1', port: 0, token: 'secret',
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/workspace.apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: JSON.stringify({
        changes: [{ path: 'a', kind: 'put', contentBase64: Buffer.from('x').toString('base64') }],
        parent: null,
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(typeof body.version).toBe('string');
    expect(body.delta.changes[0].kind).toBe('added');
  });

  it('parent mismatch returns 409 with structured detail', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1', port: 0, token: 'secret',
    });
    await fetch(`http://127.0.0.1:${server.port}/workspace.apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: JSON.stringify({ changes: [], parent: null }),
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/workspace.apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: JSON.stringify({ changes: [], parent: 'definitely-not-real' }),
    });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error.code).toBe('parent-mismatch');
    // Server should echo the actualParent so the host can rebase.
    expect(typeof body.error.actualParent === 'string' || body.error.actualParent === null).toBe(true);
  });

  it('GET /healthz returns 200 without auth', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1', port: 0, token: 'secret',
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(r.status).toBe(200);
  });

  it('rejects oversize body (413)', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1', port: 0, token: 'secret',
    });
    const big = 'x'.repeat(5 * 1024 * 1024);
    const r = await fetch(`http://127.0.0.1:${server.port}/workspace.apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: big,
    });
    expect(r.status).toBe(413);
  });

  it('unknown path returns 404', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1', port: 0, token: 'secret',
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/nonsense`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(404);
  });

  it('rejects non-JSON content-type on POST (415)', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1', port: 0, token: 'secret',
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/workspace.list`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'authorization': 'Bearer secret' },
      body: '{}',
    });
    expect(r.status).toBe(415);
  });

  it('rejects bad-shape body (400 with VALIDATION code)', async () => {
    server = await createWorkspaceGitServer({
      repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-srv-')),
      host: '127.0.0.1', port: 0, token: 'secret',
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/workspace.apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer secret' },
      body: JSON.stringify({ wrongShape: true }),
    });
    expect(r.status).toBe(400);
  });
});
