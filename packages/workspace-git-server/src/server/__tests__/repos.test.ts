import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceGitServer, type WorkspaceGitServer } from '../index.js';
import { __setSpawnForTest } from '../repos.js';

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
  __setSpawnForTest(null);
  vi.restoreAllMocks();
});

describe('POST /repos', () => {
  it('creates a bare repo for a valid id and returns 201', async () => {
    const { server, url, repoRoot } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId: 'abc-123' }),
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.workspaceId).toBe('abc-123');
    expect(typeof body.createdAt).toBe('string');
    expect(() => new Date(body.createdAt).toISOString()).not.toThrow();

    // HEAD references refs/heads/main
    const repoPath = join(repoRoot, 'abc-123.git');
    expect(existsSync(repoPath)).toBe(true);
    const head = readFileSync(join(repoPath, 'HEAD'), 'utf8');
    expect(head.trim()).toBe('ref: refs/heads/main');

    // Locked-down config has all five expected entries
    const cfg = readFileSync(join(repoPath, 'config'), 'utf8');
    expect(cfg).toMatch(/denyDeletes\s*=\s*true/i);
    expect(cfg).toMatch(/denyNonFastForwards\s*=\s*true/i);
    expect(cfg).toMatch(/hooksPath\s*=\s*\/dev\/null/);
    expect(cfg).toMatch(/\[protocol\][\s\S]*allow\s*=\s*never/i);
    expect(cfg).toMatch(/allowAnySHA1InWant\s*=\s*false/i);
  });

  it('rejects missing token (401)', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'abc' }),
    });
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error).toBe('unauthorized');
  });

  it('rejects wrong token of same length without echoing it (401)', async () => {
    const { server, url } = await boot();
    active = server;
    const sameLen = 'x'.repeat(TOKEN.length);
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sameLen}`,
      },
      body: JSON.stringify({ workspaceId: 'abc' }),
    });
    expect(r.status).toBe(401);
    const text = await r.text();
    expect(text).not.toContain(sameLen);
    expect(text).not.toContain(TOKEN);
  });

  it('rejects wrong token of different length (401)', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer short`,
      },
      body: JSON.stringify({ workspaceId: 'abc' }),
    });
    expect(r.status).toBe(401);
  });

  it('rejects {} (no workspaceId) with validation 400', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('validation');
  });

  it('rejects extra fields with validation 400 (Zod strict)', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId: 'abc', extra: 1 }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('validation');
  });

  it('rejects ../etc as invalid_workspace_id and creates no directory', async () => {
    const { server, url, repoRoot } = await boot();
    active = server;
    const before = readdirSync(repoRoot);
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId: '../etc' }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_workspace_id');
    // Don't echo the offending input back
    expect(body.message).not.toContain('../etc');
    // No new entries in repoRoot
    const after = readdirSync(repoRoot);
    expect(after).toEqual(before);
  });

  it('rejects uppercase ids', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId: 'AbC' }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_workspace_id');
  });

  it('returns 409 on duplicate POST for the same id', async () => {
    const { server, url } = await boot();
    active = server;
    const r1 = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId: 'dup' }),
    });
    expect(r1.status).toBe(201);
    const r2 = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId: 'dup' }),
    });
    expect(r2.status).toBe(409);
    const body = await r2.json();
    expect(body.error).toBe('workspace_already_exists');
  });

  it('rejects > 1 MiB body with 413 (integration-level reassert)', async () => {
    const { server, url } = await boot();
    active = server;
    const big = 'x'.repeat(2 * 1024 * 1024);
    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: big,
    });
    expect(r.status).toBe(413);
  });

  it('spawns git with the expected argv and env on init', async () => {
    const { server, url, repoRoot } = await boot();
    active = server;

    // Capture argv + env via the test seam — we don't replace the
    // implementation, just observe what gets passed to the real spawn.
    type Call = {
      cmd: string;
      args: readonly string[];
      opts: SpawnOptions;
    };
    const calls: Call[] = [];
    const spy = vi.fn(
      (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess => {
        calls.push({ cmd, args, opts });
        return spawn(cmd, [...args], opts);
      },
    );
    __setSpawnForTest(spy);

    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId: 'spy-id' }),
    });
    expect(r.status).toBe(201);
    expect(calls.length).toBeGreaterThan(0);

    // First call should be `git init --bare --initial-branch=main <repoPath>`.
    const initCall = calls.find(
      (c) =>
        c.cmd === 'git' &&
        c.args[0] === 'init' &&
        c.args.includes('--bare'),
    );
    expect(initCall).toBeDefined();
    expect([...initCall!.args]).toEqual([
      'init',
      '--bare',
      '--initial-branch=main',
      join(repoRoot, 'spy-id.git'),
    ]);
    expect(initCall!.opts.env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      HOME: '/nonexistent',
      PATH: '/usr/bin:/bin',
    });
    // Defense: the env object must not contain any extra GIT_* keys leaked
    // from process.env (only what's in PARANOID_GIT_ENV).
    const envKeys = Object.keys(initCall!.opts.env ?? {});
    expect(envKeys.sort()).toEqual(
      [
        'GIT_CONFIG_NOSYSTEM',
        'GIT_CONFIG_GLOBAL',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'PATH',
      ].sort(),
    );
  });

  it('config-step spawns each carry the paranoid env', async () => {
    const { server, url } = await boot();
    active = server;
    type Call = {
      cmd: string;
      args: readonly string[];
      opts: SpawnOptions;
    };
    const calls: Call[] = [];
    const spy = vi.fn(
      (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess => {
        calls.push({ cmd, args, opts });
        return spawn(cmd, [...args], opts);
      },
    );
    __setSpawnForTest(spy);

    const r = await fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId: 'cfg' }),
    });
    expect(r.status).toBe(201);
    // We expect at least: 1 init + 5 config invocations.
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) {
      if (call.cmd !== 'git') continue;
      expect(call.opts.env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HOME: '/nonexistent',
        PATH: '/usr/bin:/bin',
      });
    }
  });
});

describe('GET /repos/<id>', () => {
  async function postCreate(
    url: string,
    workspaceId: string,
  ): Promise<Response> {
    return fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId }),
    });
  }

  it('returns 404 workspace_not_found for a never-created id', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos/nonexistent`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error).toBe('workspace_not_found');
  });

  it('returns exists:true, headOid:null on a freshly-created repo', async () => {
    const { server, url } = await boot();
    active = server;
    const c = await postCreate(url, 'fresh');
    expect(c.status).toBe(201);
    const r = await fetch(`${url}/repos/fresh`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({
      workspaceId: 'fresh',
      exists: true,
      headOid: null,
    });
  });

  it('returns headOid as the SHA after a fixture commit lands on main', async () => {
    const { server, url, repoRoot } = await boot();
    active = server;
    await postCreate(url, 'has-commit');

    // Seed a commit into the bare repo using git plumbing — purely the
    // server's tooling, no host clone.
    const repoPath = join(repoRoot, 'has-commit.git');
    const env = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      HOME: '/nonexistent',
      PATH: '/usr/bin:/bin',
      GIT_AUTHOR_NAME: 'ax-test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'ax-test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const runSync = (args: string[]): { stdout: string; status: number | null } =>
      new Promise<{ stdout: string; status: number | null }>((resolve, reject) => {
        const child = spawn('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        child.stdout?.on('data', (c) => chunks.push(c as Buffer));
        child.once('error', reject);
        child.once('close', (status) =>
          resolve({ stdout: Buffer.concat(chunks).toString('utf8'), status }),
        );
      }) as unknown as { stdout: string; status: number | null };

    // hash-object: stage a blob in the bare repo's object DB
    const blob = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'git',
        ['-C', repoPath, 'hash-object', '-w', '--stdin'],
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const out: Buffer[] = [];
      child.stdout?.on('data', (c) => out.push(c as Buffer));
      child.once('error', reject);
      child.once('close', () =>
        resolve(Buffer.concat(out).toString('utf8').trim()),
      );
      child.stdin?.end('hello\n');
    });
    expect(blob).toMatch(/^[0-9a-f]{40}$/);

    // mktree: build a tree referencing that blob
    const tree = await new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['-C', repoPath, 'mktree'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      child.stdout?.on('data', (c) => out.push(c as Buffer));
      child.once('error', reject);
      child.once('close', () =>
        resolve(Buffer.concat(out).toString('utf8').trim()),
      );
      child.stdin?.end(`100644 blob ${blob}\thello.txt\n`);
    });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);

    // commit-tree: build a commit on that tree
    const commit = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'git',
        ['-C', repoPath, 'commit-tree', tree, '-m', 'fixture'],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const out: Buffer[] = [];
      child.stdout?.on('data', (c) => out.push(c as Buffer));
      child.once('error', reject);
      child.once('close', () =>
        resolve(Buffer.concat(out).toString('utf8').trim()),
      );
    });
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    // update-ref: point refs/heads/main at the commit
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'git',
        ['-C', repoPath, 'update-ref', 'refs/heads/main', commit],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.once('error', reject);
      child.once('close', () => resolve());
    });

    // Now GET /repos/<id> should return the commit OID.
    const r = await fetch(`${url}/repos/has-commit`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({
      workspaceId: 'has-commit',
      exists: true,
      headOid: commit,
    });
    void runSync; // keep helper above happy if we ever want it
  });

  it('rejects uppercase id in URL with 400', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos/Foo`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_workspace_id');
  });

  it('rejects leading-dash id in URL with 400', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos/-foo`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_workspace_id');
  });

  it('rejects ../etc traversal in URL with 400', async () => {
    const { server, url } = await boot();
    active = server;
    // fetch normalizes ../etc out of the path; build the URL manually.
    const r = await new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const req = http.request(
        {
          hostname: u.hostname,
          port: Number(u.port),
          method: 'GET',
          path: '/repos/../etc',
          headers: { authorization: `Bearer ${TOKEN}` },
        },
        async (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve(
              new Response(body, {
                status: res.statusCode ?? 0,
                headers: { 'content-type': 'application/json' },
              }),
            );
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(r.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const { server, url } = await boot();
    active = server;
    await postCreate(url, 'gated');
    const r = await fetch(`${url}/repos/gated`);
    expect(r.status).toBe(401);
  });

  it('PUT on /repos/<id> returns 405 unsupported_method', async () => {
    const { server, url } = await boot();
    active = server;
    await postCreate(url, 'put-test');
    const r = await fetch(`${url}/repos/put-test`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(405);
  });
});

describe('DELETE /repos/<id>', () => {
  async function postCreate(
    url: string,
    workspaceId: string,
  ): Promise<Response> {
    return fetch(`${url}/repos`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ workspaceId }),
    });
  }

  it('removes an existing repo and returns 204 with empty body', async () => {
    const { server, url, repoRoot } = await boot();
    active = server;
    await postCreate(url, 'doomed');
    expect(existsSync(join(repoRoot, 'doomed.git'))).toBe(true);

    const r = await fetch(`${url}/repos/doomed`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(204);
    const text = await r.text();
    expect(text).toBe('');
    expect(existsSync(join(repoRoot, 'doomed.git'))).toBe(false);
  });

  it('is idempotent — DELETE on nonexistent returns 204', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos/never-existed`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(204);
  });

  it('DELETE then re-POST recreates the repo', async () => {
    const { server, url, repoRoot } = await boot();
    active = server;
    const r1 = await postCreate(url, 'recycled');
    expect(r1.status).toBe(201);
    const d = await fetch(`${url}/repos/recycled`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(d.status).toBe(204);
    const r2 = await postCreate(url, 'recycled');
    expect(r2.status).toBe(201);
    expect(existsSync(join(repoRoot, 'recycled.git'))).toBe(true);
  });

  it('rejects bad id in URL with 400', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/repos/Foo`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('invalid_workspace_id');
  });

  it('returns 401 without auth (no body leak)', async () => {
    const { server, url } = await boot();
    active = server;
    await postCreate(url, 'auth-gated');
    const r = await fetch(`${url}/repos/auth-gated`, { method: 'DELETE' });
    expect(r.status).toBe(401);
  });
});
