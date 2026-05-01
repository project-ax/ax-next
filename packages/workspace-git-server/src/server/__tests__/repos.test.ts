import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
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
