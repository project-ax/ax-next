import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { PluginError } from '@ax/core';

const PLUGIN_NAME = '@ax/tool-file-io';

/**
 * Resolve `candidate` relative to `root` and confirm the resolved path cannot
 * escape `root` — even through symlinks or `..` segments.
 *
 * We realpath BOTH sides before the containment check. A naive
 * `resolve().startsWith(root)` is not enough: a symlink inside root pointing
 * outside would slip past it. For a candidate that doesn't exist yet (e.g.
 * writing a new file), we realpath the parent directory, then rejoin the
 * basename so the containment check runs against a fully-canonicalized path.
 */
export async function safePath(root: string, candidate: string): Promise<string> {
  if (isAbsolute(candidate)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `absolute paths rejected: '${candidate}'`,
    });
  }

  const resolved = resolve(root, candidate);

  const realRoot = await realpath(root);

  // Walk up ancestors until realpath succeeds, so that "write a new file"
  // (target doesn't exist) and "write into a new subdir" both work while
  // still canonicalizing any symlink in the ancestor chain.
  const realResolved = await realpathAncestor(resolved);

  const rel = relative(realRoot, realResolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `path escapes workspace: '${candidate}'`,
    });
  }

  return realResolved;
}

async function realpathAncestor(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  while (true) {
    try {
      const real = await realpath(cur);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = dirname(cur);
      if (parent === cur) throw e; // hit filesystem root, give up
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}
