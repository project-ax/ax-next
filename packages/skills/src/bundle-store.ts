/**
 * @ax/skills content-addressed bundle byte-store (JIT git-tree backing,
 * design §9.2 / decision #10).
 *
 * Stores a skill bundle's EXTRA (non-SKILL.md) files as a git tree in a bare
 * repo @ax/skills OWNS — using `isomorphic-git` directly (the same third-party
 * library @ax/workspace-git-core uses; NOT a cross-plugin import, NOT the
 * workspace plugin's hooks). The catalog row's `bundle_tree_sha` points at the
 * root tree. Reusing git's object format buys: integrity (the SHA pins exact
 * bytes — tampering changes the SHA), dedup (identical blobs share an OID),
 * and versioning (a new file set = a new tree).
 *
 * READ-SIDE VALIDATION (the git-extract boundary, design §9.2): git can
 * natively represent symlinks (120000) and the exec bit (100755), so readTree
 * rejects any blob whose mode isn't 100644, any non-blob/tree object, and
 * re-runs validateBundleFiles on the reconstructed paths. This is the
 * validateMcpEntry defense-in-depth pattern — independent of the write-side
 * validateBundleFiles (invariant I2) — and is the forward guard for the P5/P6
 * flow where a tree comes from an author's workspace repo, not from already-
 * validated files[].
 *
 * Single-replica posture: the repo lives on the host PVC. Multi-replica
 * (ARCH-9) is a deferred lift, same split as @ax/workspace-git local vs -server.
 */
import { existsSync, mkdirSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { validateBundleFiles, type BundleFile } from './bundle-files.js';

const FILE_MODE = '100644'; // regular, non-executable
const TREE_MODE = '040000'; // subdirectory

export interface BundleStore {
  /**
   * Write the extra files as a content-addressed git tree; return the root
   * tree SHA. An empty file set returns `null` (no tree, no row pointer).
   * Caller is responsible for write-side validateBundleFiles (plugin.ts).
   */
  writeTree(files: BundleFile[]): Promise<string | null>;
  /**
   * Read a tree SHA back into extra files. Rejects forbidden git modes/types
   * and re-validates paths/veto/caps at this trust boundary. Returns files
   * sorted by path for determinism.
   */
  readTree(treeSha: string): Promise<BundleFile[]>;
}

export function createBundleStore(repoRoot: string): BundleStore {
  const gitdir = join(repoRoot, 'bundles.git');
  let ready: Promise<void> | undefined;

  // Lazy, idempotent init — mirrors @ax/workspace-git-core's ensureRepo.
  function ensureRepo(): Promise<void> {
    if (ready === undefined) {
      ready = (async () => {
        mkdirSync(repoRoot, { recursive: true });
        if (!existsSync(join(gitdir, 'HEAD'))) {
          await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
        }
      })();
    }
    return ready;
  }

  return {
    async writeTree(files) {
      if (files.length === 0) return null;
      await ensureRepo();

      // First pass: write every blob, remember its OID.
      const blobOids = new Map<string, string>();
      for (const f of files) {
        const oid = await git.writeBlob({
          fs,
          gitdir,
          blob: Buffer.from(f.contents, 'utf-8'),
        });
        blobOids.set(f.path, oid);
      }

      // Build the directory map (dirPath '' = root) → entries, mirroring
      // @ax/workspace-git-core's writeSnapshotTree so nested paths
      // (scripts/run.py) write correctly nested trees.
      type Entry =
        | { kind: 'blob'; oid: string }
        | { kind: 'tree'; childDir: string };
      const dirs = new Map<string, Map<string, Entry>>();
      const ensureDir = (d: string): Map<string, Entry> => {
        let m = dirs.get(d);
        if (m === undefined) {
          m = new Map();
          dirs.set(d, m);
        }
        return m;
      };
      ensureDir('');
      for (const [path, oid] of blobOids) {
        const parts = path.split('/');
        const fileName = parts[parts.length - 1]!;
        let parentDir = '';
        for (let i = 0; i < parts.length - 1; i++) {
          const segment = parts[i]!;
          const childDir = parentDir === '' ? segment : `${parentDir}/${segment}`;
          const parentMap = ensureDir(parentDir);
          if (parentMap.get(segment) === undefined) {
            parentMap.set(segment, { kind: 'tree', childDir });
          }
          ensureDir(childDir);
          parentDir = childDir;
        }
        ensureDir(parentDir).set(fileName, { kind: 'blob', oid });
      }

      // Write trees leaves-up, memoized by dir path.
      const treeOids = new Map<string, string>();
      const writeDir = async (dirPath: string): Promise<string> => {
        const cached = treeOids.get(dirPath);
        if (cached !== undefined) return cached;
        const entries = dirs.get(dirPath) ?? new Map<string, Entry>();
        const tree: {
          mode: string;
          path: string;
          oid: string;
          type: 'blob' | 'tree';
        }[] = [];
        for (const [name, entry] of entries) {
          if (entry.kind === 'blob') {
            tree.push({ mode: FILE_MODE, path: name, oid: entry.oid, type: 'blob' });
          } else {
            const childOid = await writeDir(entry.childDir);
            tree.push({ mode: TREE_MODE, path: name, oid: childOid, type: 'tree' });
          }
        }
        tree.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const oid = await git.writeTree({ fs, gitdir, tree });
        treeOids.set(dirPath, oid);
        return oid;
      };
      return writeDir('');
    },

    async readTree(treeSha) {
      await ensureRepo();
      const out: BundleFile[] = [];

      const walk = async (oid: string, prefix: string): Promise<void> => {
        const { tree } = await git.readTree({ fs, gitdir, oid });
        for (const entry of tree) {
          const rel = prefix === '' ? entry.path : `${prefix}/${entry.path}`;
          if (entry.type === 'tree') {
            await walk(entry.oid, rel);
          } else if (entry.type === 'blob') {
            // Git-extract mode guard: only a plain regular file is allowed.
            // 100755 = exec bit, 120000 = symlink — both rejected here.
            if (entry.mode !== FILE_MODE) {
              throw new Error(
                `bundle file '${rel}' has forbidden git mode ${entry.mode} ` +
                  `(only 100644 allowed; exec-bit/symlink rejected at extract)`,
              );
            }
            const { blob } = await git.readBlob({ fs, gitdir, oid: entry.oid });
            out.push({ path: rel, contents: Buffer.from(blob).toString('utf-8') });
          } else {
            // 'commit' = gitlink/submodule.
            throw new Error(
              `bundle tree entry '${rel}' is a ${entry.type} (submodule rejected at extract)`,
            );
          }
        }
      };
      await walk(treeSha, '');

      // Defense-in-depth: the reconstructed extra-file set must still satisfy
      // the canonical path/veto/caps rules (independent of the write-side
      // check — invariant I2 / validateMcpEntry pattern).
      validateBundleFiles(out);

      out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return out;
    },
  };
}
