import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { createBundleStore } from '../bundle-store.js';

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ax-skills-bundle-test-'));
}

describe('bundle-store', () => {
  it('round-trips a multi-file bundle through a content-addressed tree', async () => {
    const store = createBundleStore(freshRoot());
    const files = [
      { path: 'scripts/run.py', contents: 'print("hi")' },
      { path: 'data/x.json', contents: '{}' },
    ];
    const sha = await store.writeTree(files);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const read = await store.readTree(sha!);
    // readTree returns paths sorted; assert set equality.
    expect(read).toEqual([
      { path: 'data/x.json', contents: '{}' },
      { path: 'scripts/run.py', contents: 'print("hi")' },
    ]);
  });

  it('returns null for an empty file set (no tree written)', async () => {
    const store = createBundleStore(freshRoot());
    expect(await store.writeTree([])).toBeNull();
  });

  it('is content-addressed: identical bytes → identical tree SHA (dedup)', async () => {
    const store = createBundleStore(freshRoot());
    const a = await store.writeTree([{ path: 'a.txt', contents: 'same' }]);
    const b = await store.writeTree([{ path: 'a.txt', contents: 'same' }]);
    expect(a).toBe(b);
  });

  it('rejects a tree carrying an exec-bit blob at extract', async () => {
    const root = freshRoot();
    const store = createBundleStore(root);
    // Force-init the same repo and craft a malicious tree directly.
    const gitdir = join(root, 'bundles.git');
    await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
    const blobOid = await git.writeBlob({ fs, gitdir, blob: Buffer.from('payload') });
    const evilTree = await git.writeTree({
      fs,
      gitdir,
      tree: [{ mode: '100755', path: 'run.sh', oid: blobOid, type: 'blob' }],
    });
    await expect(store.readTree(evilTree)).rejects.toThrow(/mode|exec|forbidden/i);
  });

  it('rejects a tree carrying a symlink blob at extract', async () => {
    const root = freshRoot();
    const store = createBundleStore(root);
    const gitdir = join(root, 'bundles.git');
    await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
    const blobOid = await git.writeBlob({ fs, gitdir, blob: Buffer.from('/etc/passwd') });
    const evilTree = await git.writeTree({
      fs,
      gitdir,
      tree: [{ mode: '120000', path: 'link', oid: blobOid, type: 'blob' }],
    });
    await expect(store.readTree(evilTree)).rejects.toThrow(/mode|symlink|forbidden/i);
  });

  it('rejects a tree whose paths fail the bundle veto rules at extract', async () => {
    const root = freshRoot();
    const store = createBundleStore(root);
    const gitdir = join(root, 'bundles.git');
    await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
    const blobOid = await git.writeBlob({ fs, gitdir, blob: Buffer.from('{}') });
    // A regular 100644 blob, but at a vetoed path (.mcp.json).
    const tree = await git.writeTree({
      fs,
      gitdir,
      tree: [{ mode: '100644', path: '.mcp.json', oid: blobOid, type: 'blob' }],
    });
    await expect(store.readTree(tree)).rejects.toThrow(/reserved|invalid/i);
  });
});
