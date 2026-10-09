import fs from 'node:fs';
import { lstat, readdir, realpath, readFile, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import git from 'isomorphic-git';

const REF = 'refs/heads/main';
class RetirementError extends Error {}
const fail = (code: string): never => { throw new RetirementError(code); };

/** Refuse symlink/special-file repositories, including symlinked object/ref dirs. */
async function checkTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('unsafe-path');
  if (stat.isDirectory()) for (const name of await readdir(path)) await checkTree(join(path, name));
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Operator-only, host-stopped maintenance of direct agent bare repositories.
 * No hook is registered. Bodies are never read or parsed; history is retained.
 * Counts report matching entries in dry-run and committed deletions in apply.
 */
export async function retireRoutineFiles({ repoRoot, dryRun, now }: {
  repoRoot: string; dryRun: boolean; now: Date;
}): Promise<{ repositories: number; removed: number; failures: Array<{ repository: string; code: string }> }> {
  const result = { repositories: 0, removed: 0, failures: [] as Array<{ repository: string; code: string }> };
  const record = (repository: string, error: unknown) => result.failures.push({ repository, code: error instanceof RetirementError ? error.message : 'maintenance-failed' });
  let root: string;
  let names: string[];
  try {
    if (!isAbsolute(repoRoot) || !Number.isFinite(now.getTime())) fail('invalid-root');
    const stat = await lstat(resolve(repoRoot));
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe-path');
    root = await realpath(resolve(repoRoot));
    names = (await readdir(root)).sort();
  } catch (error) { record('<root>', error); return result; }
  for (const name of names) {
    // Ignore store metadata, but never silently skip an unknown repository.
    if (!name.endsWith('.git')) continue;
    const safeName = /^ws-[0-9a-f]{16}\.git$/.test(name);
    const repository = safeName ? name : '<unknown>';
    try {
      if (!safeName) fail('unexpected-repository');
      const gitdir = join(root, name);
      await checkTree(gitdir);
      if (!(await lstat(gitdir)).isDirectory() || await realpath(gitdir) !== gitdir) fail('unsafe-path');
      for (const path of ['HEAD', 'config', 'objects', 'refs/heads']) {
        if (!await exists(join(gitdir, path))) fail('unexpected-layout');
      }
      const options = { fs, gitdir };
      if (await readFile(join(gitdir, 'HEAD'), 'utf8') !== `ref: ${REF}\n`
        || await git.getConfig({ ...options, path: 'core.bare' }) !== true
        || await exists(join(gitdir, 'commondir'))
        || await exists(join(gitdir, 'objects/info/alternates'))
        || await exists(join(gitdir, 'objects/info/http-alternates'))) fail('unexpected-layout');
      result.repositories++;
      let head: string;
      try { head = await git.resolveRef({ ...options, ref: REF }); } catch (error) {
        if ((error as { code?: string }).code === 'NotFoundError'
          && !await exists(join(gitdir, REF)) && !await exists(join(gitdir, 'packed-refs'))) continue;
        throw error;
      }
      const { commit } = await git.readCommit({ ...options, oid: head });
      let count = 0;
      async function rewrite(oid: string, prefix = ''): Promise<string> {
        const { tree } = await git.readTree({ ...options, oid });
        const next: typeof tree = [];
        let changed = false;
        for (const entry of tree) {
          if (entry.path.includes('/') || entry.path === '.' || entry.path === '..') fail('unexpected-layout');
          const path = prefix + entry.path;
          if (/^\.ax\/routines\/[^/]+\.md$/.test(path) && entry.type === 'blob') {
            count++; changed = true; continue;
          }
          // Only traverse the two relevant trees. Everything else keeps its OID.
          if (entry.type === 'tree' && (path === '.ax' || path === '.ax/routines')) {
            const child = await rewrite(entry.oid, `${path}/`);
            changed ||= child !== entry.oid;
            next.push({ ...entry, oid: child });
          } else next.push(entry);
        }
        return changed && !dryRun ? git.writeTree({ ...options, tree: next }) : oid;
      }
      const tree = await rewrite(commit.tree);
      if (!count) continue;
      if (dryRun) { result.removed += count; continue; }
      const author = { name: 'AX offline maintenance', email: 'maintenance@ax.local', timestamp: Math.floor(now.getTime() / 1000), timezoneOffset: 0 };
      const oid = await git.writeCommit({ ...options, commit: { tree, parent: [head], author, committer: author, message: 'Retire legacy routine files\n' } });
      // isomorphic-git writeRef has no expected-old-value option. Use Git's
      // exclusive loose-ref lock protocol, check under lock, then atomic rename.
      // Host and git-server MUST be stopped; no online writer bypass is added.
      const lockPath = join(gitdir, `${REF}.lock`);
      let lock;
      try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('ref-locked');
        throw error;
      }
      let ownsLock = true;
      try {
        if (await readFile(join(gitdir, 'HEAD'), 'utf8') !== `ref: ${REF}\n`
          || await git.resolveRef({ ...options, ref: REF }) !== head) fail('ref-changed');
        await lock.writeFile(`${oid}\n`);
        await lock.sync();
        await lock.close();
        await rename(lockPath, join(gitdir, REF));
        ownsLock = false;
        result.removed += count;
      } finally {
        await lock.close();
        if (ownsLock) await unlink(lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      }
    } catch (error) { record(repository, error); }
  }
  return result;
}
