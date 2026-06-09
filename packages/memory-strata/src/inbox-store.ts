// Read, write, and delete inbox observations for the memory-strata plugin.
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

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { load as yamlLoad } from 'js-yaml';
import { buildMarkdownFile } from './frontmatter.js';
import { INBOX_DIR, inboxFile } from './paths.js';
import type { MemoryFrontmatter, Observation } from './types.js';

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

/**
 * Write a single Observation to the inbox directory.
 *
 * Shared by the Observer (Phase 1) and the `memory_note` agent tool (Phase 2B).
 * Both paths must go through this function to keep the on-disk format
 * consistent and to enforce a single code path for frontmatter assembly.
 *
 * `index` disambiguates multiple observations sharing the same `now` timestamp
 * (e.g., a single Observer run that extracts several facts). For agent-authored
 * notes (from `memory_note`) pass `0` — a single note per call, no batch ordering.
 *
 * `sourceMessages` is the number of transcript messages the observation was
 * extracted from. Pass `0` for agent-authored notes (honest: no transcript).
 *
 * `conversationId` is the durable id of the conversation this observation was
 * extracted from (`AgentContext.conversationId`), used downstream to count
 * DISTINCT conversations for the skill-crystallization recurrence gate
 * (TASK-187). Pass `undefined` when there's no conversation (a context minted
 * without one — canary tests, ephemeral admin probes, agent-authored notes).
 * An undefined value writes NO `conversation_id` frontmatter field, so the
 * observation contributes nothing to any doc's distinct-conversation count.
 *
 * Returns the workspace-relative path of the written file.
 */
export async function writeInboxObservation(
  workspaceRoot: string,
  obs: Observation,
  now: Date,
  index: number,
  sourceMessages: number,
  conversationId?: string | undefined,
): Promise<string> {
  // index disambiguates multiple observations sharing the same now.toISO().
  // randomUUID is cryptographically unique per call but the filename
  // index keeps lexicographic ordering stable inside a single Observer run.
  const id = randomUUID();
  const rel = inboxFile(now, `${String(index).padStart(2, '0')}-${id.slice(0, 8)}`);
  const abs = join(workspaceRoot, rel);
  await mkdir(dirname(abs), { recursive: true });

  const nowIso = now.toISOString();
  const fm: MemoryFrontmatter = {
    id,
    type: 'inbox/observation',
    created: nowIso,
    confidence: obs.confidence,
    pinned: false,
    summary: obs.fact,
    subject: obs.subject,
    factType: obs.factType,
    source_messages: sourceMessages,
    // Only stamp conversation_id when we actually have one — a missing field
    // is the honest signal "no conversation" (the recurrence count treats it
    // as contributing zero distinct conversations).
    ...(conversationId !== undefined && conversationId.length > 0
      ? { conversation_id: conversationId }
      : {}),
    event_time: nowIso,
    recorded_at: nowIso,
  };

  const body = `# Observation\n\n${obs.fact}\n`;
  await writeFile(abs, buildMarkdownFile(fm, body), 'utf8');
  return rel;
}
