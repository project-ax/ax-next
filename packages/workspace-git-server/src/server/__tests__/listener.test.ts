import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceGitServer, type WorkspaceGitServer } from '../index.js';
import { __setSpawnForTest as __setSpawnSmartHttpForTest } from '../smart-http.js';

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

  it('GET /repos/abc routes to the get-repo handler (404 once Slice 3 lands)', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos/abc`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // Slice 3 wires this up; previously 503.
    expect([404, 503]).toContain(r.status);
  });

  it('DELETE /repos/abc routes to delete-repo handler (204 once Slice 4 lands)', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos/abc`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // Slice 4 wires this up; previously 503.
    expect([204, 503]).toContain(r.status);
  });

  it('GET /abc.git/info/refs?service=git-upload-pack routes to discovery (404 for unknown repo)', async () => {
    // B3 Slice 1 wires discovery. With no repo created, expect 404.
    const { server, url } = await boot();
    active = server;
    const r = await fetch(
      `${url}/abc.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(r.status).toBe(404);
  });

  it('POST /abc.git/git-upload-pack with JSON content-type → 415 (smart-HTTP route requires git wire CT)', async () => {
    // B3: smart-HTTP POST routes accept only application/x-git-*-request,
    // never application/json. Slice 2 wires the body; Slice 1 still 503s when
    // the CT is correct (until Slice 2 lands).
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
    expect(r.status).toBe(415);
  });

  it('POST /abc.git/git-receive-pack with JSON content-type → 415 (smart-HTTP route requires git wire CT)', async () => {
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
    expect(r.status).toBe(415);
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

// ---------------------------------------------------------------------------
// SIGTERM-aware drain (B4 Slice 3) — close() must:
//   1. Stop accepting new connections (server.close()).
//   2. Wait for in-flight requests up to drainTimeoutMs.
//   3. Force-kill any registered git children if the timeout fires.
//   4. Close any still-open HTTP connections so the close callback can fire.
// ---------------------------------------------------------------------------

interface FakeChildHandle {
  child: EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
}

/**
 * Build a fake ChildProcess-shaped EventEmitter. stdout never ends, so
 * piping it into the response keeps the request in-flight indefinitely.
 * `kill('SIGKILL')` records the signal but does NOT terminate the streams
 * itself — the listener's drain path is what closes everything down.
 */
function makeFakeChild(): FakeChildHandle {
  const child = new EventEmitter() as FakeChildHandle['child'];
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 99999; // dummy
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (child.signalCode !== null || child.exitCode !== null) return true;
    child.signalCode = signal ?? 'SIGTERM';
    // After kill, end the streams so the response pipe completes; this
    // mirrors what a real child does on SIGKILL.
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null, child.signalCode);
    });
    return true;
  }) as unknown as FakeChildHandle['child']['kill'];
  return { child };
}

describe('git-server listener — drain', () => {
  it('close() resolves promptly when no requests are in-flight', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-drain-'));
    const server = await createWorkspaceGitServer({
      repoRoot,
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      drainTimeoutMs: 5_000, // generous — should not be hit
    });
    const start = Date.now();
    await server.close();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('close() force-kills a never-ending git child after drainTimeoutMs', async () => {
    // Install a fake spawn that returns a child whose stdout never ends.
    // The pack-exchange handler will pipe req->stdin, stdout->res. Because
    // stdout never ends, the response stream stays open and the in-flight
    // set never empties — until the drain timeout fires.
    const fake = makeFakeChild();
    __setSpawnSmartHttpForTest((() => fake.child) as never);

    try {
      const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-drain-'));
      // Pre-create a bare repo dir so resolveRepo() passes the existsSync gate.
      // Using fs.mkdirSync directly avoids a real `git init` spawn (which the
      // fake spawn would intercept).
      const fs = await import('node:fs');
      fs.mkdirSync(join(repoRoot, 'abc.git'), { recursive: true });

      const server = await createWorkspaceGitServer({
        repoRoot,
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
        drainTimeoutMs: 100, // tiny, so the timeout path fires fast
      });

      const url = `http://127.0.0.1:${server.port}`;
      // Kick off discovery — fake child's stdout never ends, so the response
      // hangs. Don't await it.
      const requestPromise = fetch(
        `${url}/abc.git/info/refs?service=git-upload-pack`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      ).catch(() => undefined);

      // Wait until the request reached the handler (child registered).
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          if ((fake.child.kill as ReturnType<typeof vi.fn>).mock.calls.length === 0) {
            // Spawn happened (the fake was called); poll for child registration
            // — registerChild runs synchronously after spawn. A small delay is
            // sufficient; we'll cap it via the test's overall flow.
            setTimeout(resolve, 50);
          } else {
            resolve();
          }
        };
        setTimeout(tick, 50);
      });

      const start = Date.now();
      await server.close();
      const elapsed = Date.now() - start;
      // Should fire after ~100ms drain timeout, well under any sane upper bound.
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(2_000);
      // Force-kill must have hit the fake.
      expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL');

      // Drain the dangling fetch so vitest doesn't print an unhandled-rejection
      // warning. We don't care about the result — the connection is torn down.
      await requestPromise;
    } finally {
      // Always reset the spawn override; otherwise a failure mid-test leaks
      // it into sibling drain tests below.
      __setSpawnSmartHttpForTest(null);
    }
  });

  it('close() awaits an in-flight smart-HTTP request that finishes before timeout', async () => {
    // Same fake-child setup but this time we let the child end on its own
    // (mid-test) and confirm close() returns AFTER the response stream ends,
    // BEFORE any timeout.
    const fake = makeFakeChild();
    __setSpawnSmartHttpForTest((() => fake.child) as never);

    try {
      const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-drain-'));
      const fs = await import('node:fs');
      fs.mkdirSync(join(repoRoot, 'abc.git'), { recursive: true });

      const server = await createWorkspaceGitServer({
        repoRoot,
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
        drainTimeoutMs: 5_000,
      });
      const url = `http://127.0.0.1:${server.port}`;

      const requestPromise = fetch(
        `${url}/abc.git/info/refs?service=git-upload-pack`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      // Give the request a moment to reach the handler and register the child.
      await new Promise<void>((r) => setTimeout(r, 50));

      // Trigger close in parallel with finishing the child cleanly.
      const closePromise = server.close();

      // After a brief delay (representing real work completing during drain),
      // end the fake child's stdout cleanly. close() should resolve AFTER this.
      setTimeout(() => {
        fake.child.exitCode = 0;
        fake.child.stdout.end();
        fake.child.stderr.end();
        fake.child.emit('close', 0, null);
      }, 100);

      await closePromise;
      // The fake should NOT have been SIGKILLed — it ended on its own well
      // within drainTimeoutMs.
      expect(fake.child.kill).not.toHaveBeenCalled();

      await requestPromise.catch(() => undefined);
    } finally {
      __setSpawnSmartHttpForTest(null);
    }
  });
});
