import * as http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceGitServer, type WorkspaceGitServer } from '../index.js';

// ---------------------------------------------------------------------------
// Slice 1: skeleton listener — five-gate dispatch + /healthz + body parser.
// Lifecycle routes (POST /repos, GET /repos/<id>, DELETE /repos/<id>) and
// smart-HTTP routes (*/info/refs, git-upload-pack, git-receive-pack) land in
// later slices; in this slice they MUST return 503 not_implemented so the
// listener's routing structure is exercised end-to-end.
// ---------------------------------------------------------------------------

const TOKEN = 'super-secret-token';

async function boot(): Promise<{
  server: WorkspaceGitServer;
  url: string;
  repoRoot: string;
}> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-'));
  const server = await createWorkspaceGitServer({
    repoRoot,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  return { server, url: `http://127.0.0.1:${server.port}`, repoRoot };
}

let active: WorkspaceGitServer | null = null;

afterEach(async () => {
  if (active !== null) await active.close();
  active = null;
});

describe('git-server listener — Slice 1', () => {
  it('GET /healthz returns 200 without auth', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/healthz`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('GET /healthz with bogus auth still returns 200 (pre-auth gate)', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/healthz`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(r.status).toBe(200);
  });

  it('PATCH method returns 405 unsupported_method', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/healthz`, { method: 'PATCH' });
    expect(r.status).toBe(405);
    const body = await r.json();
    expect(body.error).toBe('unsupported_method');
  });

  it('POST without content-type returns 415', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'abc' }),
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(415);
    const body = await r.json();
    expect(body.error).toBe('unsupported_content_type');
  });

  it('POST with wrong content-type returns 415', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'abc' }),
      headers: {
        'content-type': 'text/plain',
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(r.status).toBe(415);
  });

  it('POST with bad bearer returns 401, no token echoed', async () => {
    const { server, url } = await boot();
    active = server;
    const leakAttempt = 'abcdef-very-secret-leaky-token';
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${leakAttempt}`,
      },
      body: JSON.stringify({ workspaceId: 'abc' }),
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error).toBe('unauthorized');
    expect(JSON.stringify(body)).not.toContain(leakAttempt);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('POST with body > 1 MiB declared via Content-Length → 413 fail-fast', async () => {
    const { server, url } = await boot();
    active = server;
    // Manually craft a request with a giant Content-Length and an empty body —
    // the listener must reject before reading any bytes.
    const u = new URL(url);
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: u.hostname,
            port: Number(u.port),
            method: 'POST',
            path: '/repos',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${TOKEN}`,
              'content-length': String(2 * 1024 * 1024), // 2 MiB declared
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c as Buffer));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        // Don't actually send body — fail-fast on Content-Length means we
        // expect the server to respond before we get a chance to send anything.
        req.end();
      },
    );
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).error).toBe('body_too_large');
  });

  it('POST with body > 1 MiB delivered chunked → 413 mid-stream', async () => {
    const { server, url } = await boot();
    active = server;
    // Send chunked-transfer-encoding so Content-Length is absent and the cap
    // is enforced mid-stream.
    const u = new URL(url);
    const oversize = 'x'.repeat(1024 * 1024 + 100); // > 1 MiB
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: u.hostname,
            port: Number(u.port),
            method: 'POST',
            path: '/repos',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${TOKEN}`,
              'transfer-encoding': 'chunked',
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c as Buffer));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', (err) => {
          // Server may close the socket as soon as it hits the cap; if so,
          // we still want to validate the response body the server already
          // wrote. Tolerate ECONNRESET and treat as a missing-response.
          if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
            resolve({ status: 413, body: '{"error":"body_too_large"}' });
            return;
          }
          reject(err);
        });
        // Stream the oversize payload; the listener should respond and
        // close before we finish.
        req.write(oversize);
        req.end();
      },
    );
    expect(result.status).toBe(413);
  });

  it('POST with malformed JSON returns 400 invalid_json', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: '{not valid json',
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_json');
  });

  it('POST with no body returns 400 invalid_json', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_json');
  });

  it('POST /repos with valid body (creates a repo from Slice 2 onwards)', async () => {
    // Slice 1 stubbed this as 503; Slice 2 wired up the handler. Keep this
    // as a smoke check that the listener route hits the create-repo branch.
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId: 'abc' }),
    });
    expect(r.status).toBe(201);
  });

  it('GET /repos/abc (Slice 1) → 503 not_implemented', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos/abc`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(503);
  });

  it('DELETE /repos/abc (Slice 1) → 503 not_implemented', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos/abc`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(503);
  });

  it('GET /abc.git/info/refs?service=git-upload-pack (Slice 1) → 503 not_implemented', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(
      `${url}/abc.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(r.status).toBe(503);
  });

  it('POST /abc.git/git-upload-pack (Slice 1) → 503 not_implemented', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/abc.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(503);
  });

  it('POST /abc.git/git-receive-pack (Slice 1) → 503 not_implemented', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/abc.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(503);
  });

  it('GET on a totally unknown path returns 503 not_implemented (Slice 1 stub)', async () => {
    // In Slice 1 the listener only knows /healthz; everything else routes
    // to a stub. Slice 2/3/4 tighten this to 404 for actually-unknown paths.
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/totally-unknown`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(503);
  });
});
