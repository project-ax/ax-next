// Read and delete inbox observations written by Phase 1's Observer.
//
// WHY skip-on-malformed rather than throw: Phase 1's Observer is the sole
// producer of inbox files — it always writes canonical YAML frontmatter via
// `buildMarkdownFile`. A malformed file means something external (a manual
// edit, filesystem corruption, a future test fixture gone wrong) put bytes
// on disk that we don't control. Crashing the entire consolidation pass for
// one bad file would block all promotions and decay work; skipping and
// logging is the safer default. The consolidation pass can surface
// skipped-file counts in its structured log so an operator can investigate
// without destroying progress.
//
// WHY guard id + created beyond the YAML fence check: `yamlLoad` returns
// `unknown` — we lie with the cast to MemoryFrontmatter. The consolidation
// pass's decay logic reads `created` to compute observation age; a file with
// a missing or non-string `created` field would corrupt that calculation
// (NaN date arithmetic, wrong age window). Similarly `id` uniquely identifies
// the observation for deletion and audit logging. If either is absent or
// non-string, we treat the file as malformed and skip it silently — the same
// policy as the YAML-fence check above.

import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { INBOX_DIR } from './paths.js';
import type { MemoryFrontmatter } from './types.js';

export interface InboxFile {
  /** Workspace-relative path, e.g. `permanent/memory/inbox/<ISO>.md`. */
  path: string;
  frontmatter: MemoryFrontmatter;
  body: string;
}

/**
 * List and parse every `*.md` file in `<workspaceRoot>/permanent/memory/inbox/`.
 *
 * Returns an empty array when the inbox directory doesn't exist yet (ENOENT),
 * which is normal on the very first pass before the Observer has written
 * anything.
 *
 * Malformed files (no YAML fence, or missing `id`/`created` fields) are
 * silently skipped so one bad file can't block the rest of the pass.
 */
export async function listInbox(workspaceRoot: string): Promise<InboxFile[]> {
  const dir = join(workspaceRoot, INBOX_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: InboxFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const rel = `${INBOX_DIR}/${name}`;
    const raw = await readFile(join(workspaceRoot, rel), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    if (m === null) continue; // malformed fence — skip, don't crash.
    const frontmatter = yamlLoad(m[1]!) as MemoryFrontmatter;
    // Guard the two fields the consolidation pass's decay logic depends on.
    // A YAML-valid file that's missing these is still malformed from our
    // perspective — skip it rather than propagate undefined into decay math.
    if (typeof frontmatter.id !== 'string' || typeof frontmatter.created !== 'string') continue;
    out.push({ path: rel, frontmatter, body: m[2]! });
  }
  return out;
}

/**
 * Delete a single inbox file by its workspace-relative path.
 *
 * Called by the consolidation pass after an observation has been promoted to
 * a `docs/` page or decayed past the retention window. The caller is
 * responsible for only deleting files it obtained from `listInbox` — passing
 * an arbitrary path is a programming error, not a security concern (the
 * workspace plugin's `validatePath` owns that boundary at the IPC layer).
 */
export async function deleteInboxFile(
  workspaceRoot: string,
  inboxPath: string,
): Promise<void> {
  await unlink(join(workspaceRoot, inboxPath));
}
