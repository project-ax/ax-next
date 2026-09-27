// TASK-576 — POST /repos/<id>/purge on the storage tier.
//
// Real git, real listener. The route erases a path selector from every
// version of one bare repo (irreversibly), so the gates in front of it and the
// repo's own push protections afterwards are pinned here, not assumed.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceGitServer, type WorkspaceGitServer } from '../index.js';

const TOKEN = 'purge-route-test-token';
const SELECTOR = {
  prefixes: ['memory/', 'permanent/memory/facts/'],
  keep: ['memory/system/rules.md'],
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

function git(args: string[], cwd?: string): string {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function boot(): Promise<{ server: WorkspaceGitServer; url: string; repoRoot: string }> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-purge-'));
  const server = await createWorkspaceGitServer({
    repoRoot,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
  cleanups.push(() => server.close());
  return { server, url: `http://127.0.0.1:${server.port}`, repoRoot };
}

async function createRepo(url: string, workspaceId: string): Promise<void> {
  const r = await fetch(`${url}/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ workspaceId }),
  });
  expect(r.status).toBe(201);
}

/** Pushes several commits (with a delete) into the bare repo; returns the head oid. */
function seedHistory(bare: string): { head: string; secretCommit: string } {
  const work = mkdtempSync(join(tmpdir(), 'ax-wgs-purge-work-'));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  git(['init', '-q', '-b', 'main', work]);
  const write = (p: string, body: string) => {
    mkdirSync(dirname(join(work, p)), { recursive: true });
    writeFileSync(join(work, p), body);
  };
  const commit = (msg: string) => {
    git(['add', '-A'], work);
    git(['commit', '-q', '-m', msg], work);
    return git(['rev-parse', 'HEAD'], work).trim();
  };
  write('.ax/IDENTITY.md', 'identity\n');
  write('memory/system/rules.md', 'rule one\n');
  write('memory/system/agent.md', 'derived\n');
  write('notes/x.md', 'note\n');
  commit('one');
  write('memory/docs/secret.md', 'SECRET\n');
  write('permanent/memory/facts/profile.md', 'FACT\n');
  const secretCommit = commit('two');
  rmSync(join(work, 'memory/docs/secret.md'));
  write('memory/system/rules.md', 'rule one\nrule two\n');
  const head = commit('three');
  git(['push', '-q', bare, 'main:refs/heads/main'], work);
  return { head, secretCommit };
}

function post(url: string, path: string, body: unknown, init: { auth?: string; ct?: string } = {}) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': init.ct ?? 'application/json',
      authorization: init.auth ?? `Bearer ${TOKEN}`,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /repos/<id>/purge', () => {
  it('401 without a valid bearer token (and touches nothing)', async () => {
    const { url, repoRoot } = await boot();
    await createRepo(url, 'ws-auth');
    const bare = join(repoRoot, 'ws-auth.git');
    const { head } = seedHistory(bare);
    for (const auth of ['', 'Bearer wrong-token-xxxxxxxxxxxxxx', 'Basic abc']) {
      const r = await post(url, '/repos/ws-auth/purge', SELECTOR, { auth });
      expect(r.status).toBe(401);
      const text = await r.text();
      expect(text).not.toContain(TOKEN);
    }
    expect(git(['--git-dir', bare, 'rev-parse', 'refs/heads/main']).trim()).toBe(head);
  });

  it('415 for a non-JSON content type', async () => {
    const { url } = await boot();
    const r = await post(url, '/repos/ws-ct/purge', SELECTOR, { ct: 'text/plain' });
    expect(r.status).toBe(415);
  });

  it('400 for a malformed body or selector', async () => {
    const { url, repoRoot } = await boot();
    await createRepo(url, 'ws-bad');
    const bare = join(repoRoot, 'ws-bad.git');
    const { head } = seedHistory(bare);
    const bad: unknown[] = [
      {},
      { prefixes: [] },
      { prefixes: ['memory'] },
      { prefixes: ['../x/'] },
      { prefixes: ['memory/'], keep: ['notes/x.md'] },
      { prefixes: ['memory/'], extra: true },
      { prefixes: 'memory/' },
    ];
    for (const body of bad) {
      const r = await post(url, '/repos/ws-bad/purge', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await r.json()).error).toBe('validation');
    }
    const junk = await post(url, '/repos/ws-bad/purge', '{not json');
    expect(junk.status).toBe(400);
    expect(git(['--git-dir', bare, 'rev-parse', 'refs/heads/main']).trim()).toBe(head);
  });

  it('400 for an invalid workspace id', async () => {
    const { url } = await boot();
    const r = await post(url, '/repos/..%2Fetc/purge', SELECTOR);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_workspace_id');
  });

  it('404 for an unknown repo, without creating it', async () => {
    const { url, repoRoot } = await boot();
    const r = await post(url, '/repos/ws-missing/purge', SELECTOR);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('workspace_not_found');
    const get = await fetch(`${url}/repos/ws-missing`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
    expect(existsSync(join(repoRoot, 'ws-missing.git'))).toBe(false);
  });

  it('removes the selector from all history; re-run is a no-op; push protections intact', async () => {
    const { url, repoRoot } = await boot();
    await createRepo(url, 'ws-happy');
    const bare = join(repoRoot, 'ws-happy.git');
    const { head, secretCommit } = seedHistory(bare);

    const r = await post(url, '/repos/ws-happy/purge', SELECTOR);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { purged: string[]; headOid: string | null; rewritten: boolean };
    expect(body.rewritten).toBe(true);
    expect(body.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(body.headOid).not.toBe(head);
    expect(body.purged).toEqual([
      'memory/docs/secret.md',
      'memory/system/agent.md',
      'permanent/memory/facts/profile.md',
    ]);

    // Tip + every commit: no selector path; rules + others kept.
    const tip = git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'refs/heads/main'])
      .split('\n')
      .filter(Boolean);
    expect(tip).toEqual(['.ax/IDENTITY.md', 'memory/system/rules.md', 'notes/x.md']);
    const everPath = git(['--git-dir', bare, 'log', '--all', '--name-only', '--format=']);
    expect(everPath).not.toContain('memory/docs/secret.md');
    expect(everPath).not.toContain('permanent/memory/facts/profile.md');
    // The old commits are gone from the object store.
    for (const oid of [head, secretCommit]) {
      const probe = spawnSync('git', ['--git-dir', bare, 'cat-file', '-e', oid], { env: GIT_ENV });
      expect(probe.status).not.toBe(0);
    }
    expect(git(['--git-dir', bare, 'show', 'refs/heads/main:memory/system/rules.md'])).toBe(
      'rule one\nrule two\n',
    );

    // GET agrees with the reply.
    const get = await fetch(`${url}/repos/ws-happy`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect((await get.json()).headOid).toBe(body.headOid);

    // Re-run: no-op.
    const again = await post(url, '/repos/ws-happy/purge', SELECTOR);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ purged: [], headOid: body.headOid, rewritten: false });

    // The repo's push protections survived the rewrite.
    const cfg = readFileSync(join(bare, 'config'), 'utf8');
    expect(cfg).toMatch(/denyNonFastForwards\s*=\s*true/i);
    expect(cfg).toMatch(/denyDeletes\s*=\s*true/i);
    expect(git(['--git-dir', bare, 'config', '--get', 'receive.denyNonFastForwards']).trim()).toBe(
      'true',
    );
  });

  it('an empty repo answers 200 with a null head', async () => {
    const { url } = await boot();
    await createRepo(url, 'ws-empty');
    const r = await post(url, '/repos/ws-empty/purge', SELECTOR);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ purged: [], headOid: null, rewritten: false });
  });

  it('concurrent purges of one repo are serialized (both succeed, one rewrite)', async () => {
    const { url, repoRoot } = await boot();
    await createRepo(url, 'ws-concurrent');
    seedHistory(join(repoRoot, 'ws-concurrent.git'));
    const [a, b] = await Promise.all([
      post(url, '/repos/ws-concurrent/purge', SELECTOR),
      post(url, '/repos/ws-concurrent/purge', SELECTOR),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [await a.json(), await b.json()] as Array<{ rewritten: boolean; headOid: string }>;
    expect(bodies.filter((x) => x.rewritten)).toHaveLength(1);
    expect(bodies[0]!.headOid).toBe(bodies[1]!.headOid);
  });
});
