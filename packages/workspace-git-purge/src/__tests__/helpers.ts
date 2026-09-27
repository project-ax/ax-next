import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import type { GitRunResult, RunGit } from '../purge.js';

export interface Sandbox {
  root: string;
  runGit: RunGit;
  /** Run git; throw on non-zero exit. Returns stdout. */
  git: (args: readonly string[], input?: Buffer) => Promise<Buffer>;
  cleanup: () => void;
}

export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(os.tmpdir(), 'ax-purge-test-'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.test',
    GIT_COMMITTER_NAME: 'Test Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.test',
    LC_ALL: 'C',
  };
  const runGit: RunGit = (args, opts) =>
    new Promise<GitRunResult>((resolve, reject) => {
      const child = spawn('git', [...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.stderr.on('data', (b: Buffer) => err.push(b));
      child.on('error', reject);
      child.stdin.on('error', () => {
        /* child may exit before reading stdin; the exit code tells the story */
      });
      child.on('close', (code) =>
        resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }),
      );
      child.stdin.end(opts?.input);
    });
  const git = async (args: readonly string[], input?: Buffer): Promise<Buffer> => {
    const r = await runGit(args, input === undefined ? undefined : { input });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  return { root, runGit, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A scratch working clone used to author history for a bare repo. */
export class Scratch {
  private n = 0;
  constructor(
    private readonly sb: Sandbox,
    readonly dir: string,
  ) {}

  static async init(sb: Sandbox, name = 'work'): Promise<Scratch> {
    const dir = join(sb.root, name);
    await sb.git(['init', '-q', '-b', 'main', dir]);
    return new Scratch(sb, dir);
  }

  write(path: string, content: string | Buffer): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  remove(path: string): void {
    unlinkSync(join(this.dir, path));
  }

  g(args: readonly string[]): Promise<Buffer> {
    return this.sb.git(['-C', this.dir, ...args]);
  }

  /** Commit everything with a deterministic, distinct date per commit. */
  async commit(message: string): Promise<string> {
    this.n += 1;
    const date = `${1_700_000_000 + this.n * 3600} +0530`;
    await this.g(['add', '-A']);
    await this.sb.git([
      '-C',
      this.dir,
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '--allow-empty',
      '--cleanup=verbatim',
      '--date',
      date,
      '-m',
      message,
    ]);
    return (await this.g(['rev-parse', 'HEAD'])).toString().trim();
  }
}

export async function bareClone(sb: Sandbox, from: string, name = 'repo.git'): Promise<string> {
  const gitdir = join(sb.root, name);
  await sb.git(['clone', '-q', '--bare', from, gitdir]);
  await sb.git(['--git-dir=' + gitdir, 'config', '--unset', 'remote.origin.url']).catch(() => {});
  // Bare repos keep no reflogs by default; production servers may. Turn them
  // on and seed one so a purge that forgot to expire reflogs would leave the
  // old history reachable (and fail the object-store assertions).
  await sb.git(['--git-dir=' + gitdir, 'config', 'core.logAllRefUpdates', 'always']);
  const tip = (await sb.git(['--git-dir=' + gitdir, 'rev-parse', 'refs/heads/main'])).toString().trim();
  await sb.git(['--git-dir=' + gitdir, 'update-ref', '-m', 'seed reflog', 'refs/heads/main', tip]);
  return gitdir;
}
