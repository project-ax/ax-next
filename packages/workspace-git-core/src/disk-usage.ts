import type { Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How many entries are stat'ed / listed at once. A repo with 100k loose
 * objects must not open 100k handles at the same time.
 */
const CONCURRENCY = 16;

function isMissing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Bytes a file really takes on disk: the allocated blocks, so a sparse file
 * counts what it occupies and a 1-byte file counts a whole block. A
 * filesystem that reports no block count (or 0 for a small file it stores
 * inline) falls back to the logical size.
 */
function allocatedBytes(st: Stats): number {
  const blocks = st.blocks;
  return Number.isFinite(blocks) && blocks > 0 ? blocks * 512 : st.size;
}

/**
 * Total allocated bytes of everything under `dir`, files only (the
 * directories themselves are not counted; they are a rounding error next to
 * the files they hold).
 *
 *   - A symlink is counted as the link itself and never followed, so a link
 *     planted inside the tree cannot pull an outside file (or a loop) into
 *     the total.
 *   - ENOENT at any level counts as 0 for that entry: a missing `dir` is 0,
 *     and a file removed while we walk is skipped.
 *   - Any other error propagates. A number we could not fully measure would
 *     be a wrong number, and a quota built on it would be quietly wrong.
 *
 * The walk goes one level at a time with a fixed pool, so open handles stay
 * bounded whatever the shape of the tree.
 */
export async function measureDirBytes(dir: string): Promise<number> {
  let total = 0;
  let frontier: string[] = [dir];

  while (frontier.length > 0) {
    const current = frontier;
    const next: string[] = [];
    let cursor = 0;
    let failed = false;

    const visit = async (path: string): Promise<void> => {
      let st: Stats;
      try {
        st = await lstat(path);
      } catch (err) {
        if (isMissing(err)) return;
        throw err;
      }
      if (!st.isDirectory()) {
        total += allocatedBytes(st);
        return;
      }
      let names: string[];
      try {
        names = await readdir(path);
      } catch (err) {
        if (isMissing(err)) return;
        throw err;
      }
      for (const name of names) next.push(join(path, name));
    };

    const worker = async (): Promise<void> => {
      while (!failed && cursor < current.length) {
        const path = current[cursor++]!;
        try {
          await visit(path);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, current.length) }, worker),
    );
    frontier = next;
  }

  return total;
}
