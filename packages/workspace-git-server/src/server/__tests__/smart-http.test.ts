import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceGitServer, type WorkspaceGitServer } from '../index.js';

// ---------------------------------------------------------------------------
// Smart-HTTP — three routes: GET .../info/refs, POST .../git-upload-pack,
// POST .../git-receive-pack. Tests boot the listener for real, drive `git`
// against it via the spawned binary, and assert wire-shape + clone+push e2e.
// ---------------------------------------------------------------------------

const TOKEN = 'super-secret-token';

interface Booted {
  server: WorkspaceGitServer;
  url: string;
  repoRoot: string;
}

async function boot(): Promise<Booted> {
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

async function createRepo(url: string, workspaceId: string): Promise<void> {
  const r = await fetch(`${url}/repos`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ workspaceId }),
  });
  if (r.status !== 201) {
    const body = await r.text();
    throw new Error(`createRepo failed: ${r.status} ${body}`);
  }
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });
}

/** Seed a single commit directly into a bare repo on disk — does not go
 *  through the server's smart-HTTP push path (used by Slice 1 / Slice 2 tests
 *  before receive-pack is implemented). Uses a temp working tree + direct
 *  push-to-disk; no network involved. */
async function seedCommitDirect(
  bareRepoPath: string,
  fileName: string,
  fileContents: string,
): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'ax-wgs-seed-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  const init = await runGit(['init', '-b', 'main', tmp], { env });
  if (init.code !== 0) throw new Error(`seed init failed: ${init.stderr}`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(tmp, fileName), fileContents);
  const add = await runGit(['-C', tmp, 'add', '.'], { env });
  if (add.code !== 0) throw new Error(`seed add failed: ${add.stderr}`);
  const commit = await runGit(['-C', tmp, 'commit', '-m', 'seed'], { env });
  if (commit.code !== 0) throw new Error(`seed commit failed: ${commit.stderr}`);
  // Push directly to the bare repo on disk (bypasses the HTTP server).
  const push = await runGit(
    ['-C', tmp, 'push', bareRepoPath, 'main:main'],
    { env },
  );
  if (push.code !== 0) throw new Error(`seed push failed: ${push.stderr}`);
}

// --- Slice 1: discovery ---------------------------------------------------

describe('GET /<id>.git/info/refs (smart-HTTP discovery)', () => {
  it('returns 200 with correct content-type and pkt-line preamble (upload-pack)', async () => {
    const { server, url, repoRoot } = await boot();
    active = server;
    await createRepo(url, 'wsdisc1');
    await seedCommitDirect(
      join(repoRoot, 'wsdisc1.git'),
      'hello.txt',
      'hi\n',
    );

    const r = await fetch(`${url}/wsdisc1.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe(
      'application/x-git-upload-pack-advertisement',
    );
    expect(r.headers.get('cache-control')).toContain('no-cache');

    const buf = Buffer.from(await r.arrayBuffer());
    // First pkt-line: 4 hex digits length, then "# service=git-upload-pack\n"
    const lenHex = buf.subarray(0, 4).toString('utf8');
    const len = parseInt(lenHex, 16);
    expect(Number.isFinite(len)).toBe(true);
    expect(len).toBeGreaterThan(4);
    const msg = buf.subarray(4, len).toString('utf8');
    expect(msg).toBe('# service=git-upload-pack\n');
    // Followed by flush packet "0000".
    expect(buf.subarray(len, len + 4).toString('utf8')).toBe('0000');
  });

  it('returns 200 with correct content-type and pkt-line preamble (receive-pack)', async () => {
    const { server, url, repoRoot } = await boot();
    active = server;
    await createRepo(url, 'wsdisc2');
    await seedCommitDirect(
      join(repoRoot, 'wsdisc2.git'),
      'hi.txt',
      'world\n',
    );

    const r = await fetch(`${url}/wsdisc2.git/info/refs?service=git-receive-pack`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe(
      'application/x-git-receive-pack-advertisement',
    );
    const buf = Buffer.from(await r.arrayBuffer());
    const lenHex = buf.subarray(0, 4).toString('utf8');
    const len = parseInt(lenHex, 16);
    const msg = buf.subarray(4, len).toString('utf8');
    expect(msg).toBe('# service=git-receive-pack\n');
    expect(buf.subarray(len, len + 4).toString('utf8')).toBe('0000');
  });

  it('returns 200 for a freshly-created empty repo (no commits)', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wsdisc3');
    const r = await fetch(
      `${url}/wsdisc3.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(r.status).toBe(200);
    const buf = Buffer.from(await r.arrayBuffer());
    // Preamble still present.
    const lenHex = buf.subarray(0, 4).toString('utf8');
    const len = parseInt(lenHex, 16);
    expect(buf.subarray(4, len).toString('utf8')).toBe(
      '# service=git-upload-pack\n',
    );
  });

  it('returns 404 for an unknown workspaceId', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(
      `${url}/never-existed.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error).toBe('workspace_not_found');
  });

  it('returns 400 when service query parameter is missing', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wsdisc4');
    const r = await fetch(`${url}/wsdisc4.git/info/refs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('validation');
  });

  it('returns 400 when service query parameter is unknown', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wsdisc5');
    const r = await fetch(
      `${url}/wsdisc5.git/info/refs?service=git-foobar-pack`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('validation');
  });

  it('returns 401 without auth', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wsdisc6');
    const r = await fetch(
      `${url}/wsdisc6.git/info/refs?service=git-upload-pack`,
    );
    expect(r.status).toBe(401);
  });
});

// --- Slice 2: upload-pack (clone / fetch) ---------------------------------

describe('POST /<id>.git/git-upload-pack', () => {
  it('cloning a seeded repo via the server returns the file content', async () => {
    const { server, url, repoRoot } = await boot();
    active = server;
    await createRepo(url, 'wsclone1');
    await seedCommitDirect(
      join(repoRoot, 'wsclone1.git'),
      'hello.txt',
      'hi from server\n',
    );

    // Clone over HTTP via the listener. http.extraHeader lets `git` send the
    // bearer token; the listener gates on it.
    const cloneDir = mkdtempSync(join(tmpdir(), 'ax-wgs-clone-'));
    const clone = await runGit(
      [
        '-c',
        `http.extraHeader=Authorization: Bearer ${TOKEN}`,
        'clone',
        `${url}/wsclone1.git`,
        cloneDir,
      ],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    );
    if (clone.code !== 0) {
      throw new Error(`clone failed: ${clone.stderr}`);
    }
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(cloneDir, 'hello.txt'), 'utf8')).toBe(
      'hi from server\n',
    );
  });

  it('returns 401 without auth', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wsclone2');
    const r = await fetch(`${url}/wsclone2.git/git-upload-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
      body: '',
    });
    expect(r.status).toBe(401);
  });

  it('returns 415 on application/json content-type (smart-HTTP route requires git wire CT)', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wsclone3');
    const r = await fetch(`${url}/wsclone3.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(415);
  });

  it('returns 404 on nonexistent workspaceId', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/never-existed.git/git-upload-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-upload-pack-request',
        authorization: `Bearer ${TOKEN}`,
      },
      body: '',
    });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error).toBe('workspace_not_found');
  });
});

// --- Slice 3: receive-pack (push) + full e2e -------------------------------

/** Build a non-bare repo with one commit at `tmp/<file>=<contents>`. */
async function makeWorkingRepo(
  fileName: string,
  fileContents: string,
): Promise<{ tmp: string; env: NodeJS.ProcessEnv }> {
  const tmp = mkdtempSync(join(tmpdir(), 'ax-wgs-src-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  const init = await runGit(['init', '-b', 'main', tmp], { env });
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(tmp, fileName), fileContents);
  const add = await runGit(['-C', tmp, 'add', '.'], { env });
  if (add.code !== 0) throw new Error(`add failed: ${add.stderr}`);
  const commit = await runGit(['-C', tmp, 'commit', '-m', 'first'], { env });
  if (commit.code !== 0) throw new Error(`commit failed: ${commit.stderr}`);
  return { tmp, env };
}

describe('POST /<id>.git/git-receive-pack', () => {
  it('e2e: push to a freshly-created repo, then clone it back, contents match', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wstest1');

    const { tmp, env } = await makeWorkingRepo('hello.txt', 'hi from push\n');
    const remote = `${url}/wstest1.git`;

    // Push to the server.
    const push = await runGit(
      [
        '-c',
        `http.extraHeader=Authorization: Bearer ${TOKEN}`,
        '-C',
        tmp,
        'push',
        remote,
        'main:main',
      ],
      { env },
    );
    if (push.code !== 0) {
      throw new Error(`push failed: ${push.stderr}`);
    }

    // Clone from a different tempdir, verify content.
    const cloneDir = mkdtempSync(join(tmpdir(), 'ax-wgs-clone-'));
    const clone = await runGit(
      [
        '-c',
        `http.extraHeader=Authorization: Bearer ${TOKEN}`,
        'clone',
        remote,
        cloneDir,
      ],
      { env },
    );
    if (clone.code !== 0) {
      throw new Error(`clone failed: ${clone.stderr}`);
    }
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(cloneDir, 'hello.txt'), 'utf8')).toBe(
      'hi from push\n',
    );
  });

  it('rejects --force non-fast-forward push (denyNonFastForwards)', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wstest3');
    const remote = `${url}/wstest3.git`;
    const auth = `http.extraHeader=Authorization: Bearer ${TOKEN}`;

    // Source A: build commit A and push.
    const a = await makeWorkingRepo('a.txt', 'A\n');
    const pushA = await runGit(
      ['-c', auth, '-C', a.tmp, 'push', remote, 'main:main'],
      { env: a.env },
    );
    if (pushA.code !== 0) throw new Error(`pushA failed: ${pushA.stderr}`);

    // Source B: independent history (different parent), force-push.
    const b = await makeWorkingRepo('b.txt', 'B\n');
    const pushB = await runGit(
      ['-c', auth, '-C', b.tmp, 'push', '--force', remote, 'main:main'],
      { env: b.env },
    );
    expect(pushB.code).not.toBe(0);
    // The exact wording is "denyNonFastForwards" or "non-fast-forward"; tolerate both.
    expect(pushB.stderr.toLowerCase()).toMatch(
      /(deny ?non-?fast-?forwards?|non-fast-forward)/,
    );
  });

  it('rejects branch deletion (denyDeletes)', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wstest4');
    const remote = `${url}/wstest4.git`;
    const auth = `http.extraHeader=Authorization: Bearer ${TOKEN}`;

    const src = await makeWorkingRepo('a.txt', 'A\n');
    const push1 = await runGit(
      ['-c', auth, '-C', src.tmp, 'push', remote, 'main:main'],
      { env: src.env },
    );
    if (push1.code !== 0) throw new Error(`push1 failed: ${push1.stderr}`);

    const del = await runGit(
      ['-c', auth, '-C', src.tmp, 'push', remote, '--delete', 'main'],
      { env: src.env },
    );
    expect(del.code).not.toBe(0);
    // `receive.denyDeletes=true` causes git to reject with "denying ref
    // deletion" / "deletion prohibited" — assert on either phrasing.
    expect(del.stderr.toLowerCase()).toMatch(
      /(deny ?deletes?|denying ref deletion|deletion prohibited)/,
    );
  });

  it('concurrent pushes: one wins, the loser fast-forwards and retries', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wstest5');
    const remote = `${url}/wstest5.git`;
    const auth = `http.extraHeader=Authorization: Bearer ${TOKEN}`;

    // Seed commit A so both clients can fast-forward from a common base.
    const seed = await makeWorkingRepo('seed.txt', 'seed\n');
    const pushSeed = await runGit(
      ['-c', auth, '-C', seed.tmp, 'push', remote, 'main:main'],
      { env: seed.env },
    );
    if (pushSeed.code !== 0) {
      throw new Error(`pushSeed failed: ${pushSeed.stderr}`);
    }

    // Two clones from the seed.
    const cloneA = mkdtempSync(join(tmpdir(), 'ax-wgs-A-'));
    const cloneB = mkdtempSync(join(tmpdir(), 'ax-wgs-B-'));
    const env = seed.env;
    {
      const r = await runGit(['-c', auth, 'clone', remote, cloneA], { env });
      if (r.code !== 0) throw new Error(`clone A failed: ${r.stderr}`);
    }
    {
      const r = await runGit(['-c', auth, 'clone', remote, cloneB], { env });
      if (r.code !== 0) throw new Error(`clone B failed: ${r.stderr}`);
    }

    // Each makes a commit on top of seed.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(cloneA, 'a.txt'), 'A\n');
    {
      const r1 = await runGit(['-C', cloneA, 'add', '.'], { env });
      if (r1.code !== 0) throw new Error(`add A failed: ${r1.stderr}`);
      const r2 = await runGit(['-C', cloneA, 'commit', '-m', 'A'], { env });
      if (r2.code !== 0) throw new Error(`commit A failed: ${r2.stderr}`);
    }
    writeFileSync(join(cloneB, 'b.txt'), 'B\n');
    {
      const r1 = await runGit(['-C', cloneB, 'add', '.'], { env });
      if (r1.code !== 0) throw new Error(`add B failed: ${r1.stderr}`);
      const r2 = await runGit(['-C', cloneB, 'commit', '-m', 'B'], { env });
      if (r2.code !== 0) throw new Error(`commit B failed: ${r2.stderr}`);
    }

    // Race the two pushes against the same shard. ONE must succeed; the
    // other must fail with non-fast-forward.
    const [pushA, pushB] = await Promise.all([
      runGit(['-c', auth, '-C', cloneA, 'push', remote, 'main:main'], { env }),
      runGit(['-c', auth, '-C', cloneB, 'push', remote, 'main:main'], { env }),
    ]);
    const codes = [pushA.code, pushB.code];
    const wins = codes.filter((c) => c === 0).length;
    const losses = codes.filter((c) => c !== 0 && c !== null).length;
    expect(wins).toBe(1);
    expect(losses).toBe(1);
    const loser = pushA.code === 0 ? pushB : pushA;
    expect(loser.stderr.toLowerCase()).toMatch(
      /(deny ?non-?fast-?forwards?|non-fast-forward|fetch first|rejected)/,
    );

    // Loser fetches, rebases on top of winner, retries.
    const loserDir = pushA.code === 0 ? cloneB : cloneA;
    {
      const r = await runGit(['-c', auth, '-C', loserDir, 'fetch', 'origin'], {
        env,
      });
      if (r.code !== 0) throw new Error(`fetch failed: ${r.stderr}`);
    }
    {
      const r = await runGit(
        ['-C', loserDir, 'rebase', 'origin/main'],
        { env },
      );
      if (r.code !== 0) throw new Error(`rebase failed: ${r.stderr}`);
    }
    {
      const r = await runGit(
        ['-c', auth, '-C', loserDir, 'push', remote, 'main:main'],
        { env },
      );
      expect(r.code).toBe(0);
    }

    // Final history is linear; both files present.
    const finalClone = mkdtempSync(join(tmpdir(), 'ax-wgs-final-'));
    {
      const r = await runGit(['-c', auth, 'clone', remote, finalClone], { env });
      if (r.code !== 0) throw new Error(`final clone failed: ${r.stderr}`);
    }
    const { readFileSync, existsSync } = await import('node:fs');
    expect(existsSync(join(finalClone, 'a.txt'))).toBe(true);
    expect(existsSync(join(finalClone, 'b.txt'))).toBe(true);
    expect(readFileSync(join(finalClone, 'seed.txt'), 'utf8')).toBe('seed\n');
    // Linear: log shows 3 commits in a chain.
    const log = await runGit(
      ['-C', finalClone, 'log', '--oneline', 'main'],
      { env },
    );
    expect(log.code).toBe(0);
    expect(log.stdout.split('\n').filter((l) => l.length > 0)).toHaveLength(3);
  });

  it('returns 415 on application/json content-type', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wstest6');
    const r = await fetch(`${url}/wstest6.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(415);
  });

  it('returns 401 without auth', async () => {
    const { server, url } = await boot();
    active = server;
    await createRepo(url, 'wstest7');
    const r = await fetch(`${url}/wstest7.git/git-receive-pack`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-git-receive-pack-request' },
      body: '',
    });
    expect(r.status).toBe(401);
  });

  it('returns 404 on nonexistent workspaceId', async () => {
    const { server, url } = await boot();
    active = server;
    const r = await fetch(`${url}/never-existed.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-receive-pack-request',
        authorization: `Bearer ${TOKEN}`,
      },
      body: '',
    });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error).toBe('workspace_not_found');
  });
});
