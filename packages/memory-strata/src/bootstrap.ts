import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildMarkdownFile, stripFrontmatter } from './frontmatter.js';
import { systemFile, mapFile, type SystemFileName } from './paths.js';

/**
 * The system files bootstrap seeds. `rules` — the HUMAN tier (TASK-234) — is
 * excluded at the TYPE level, not just left out of a literal: bootstrap is an
 * automatic writer, and the only writer of the human tier should be the one a
 * person reaches. `MemoryFileType` has no `system/rules` member for the same
 * reason, so widening this alias fails the build before it fails a user.
 */
type SeededSystemFileName = Exclude<SystemFileName, 'rules'>;
import type { MemoryFrontmatter } from './types.js';
import { guardAutomaticWrite } from './human-tier.js';

/** The seeded system files, in creation order. `rules` is absent (see above). */
const SEEDED_SYSTEM_FILES: readonly SeededSystemFileName[] = ['agent', 'user', 'session'];

/**
 * Every file `bootstrapMemoryTree` may create, as scratch-relative paths
 * (`permanent/memory/system/...`). This is the ONE list: bootstrap's own loops
 * are driven from the same sources below, and a drift test asserts it equals
 * what bootstrap creates on an empty root.
 *
 * Why it's exported (TASK-513): chat:start hydrates ONLY these paths from the
 * `/agent` tier instead of the whole memory subtree, because bootstrap needs
 * nothing else — it only asks "does each seed file exist?". A seed file missing
 * from this list would look absent on every turn and be re-seeded over the
 * agent's real content.
 */
export const BOOTSTRAP_SEED_FILES: readonly string[] = Object.freeze([
  ...SEEDED_SYSTEM_FILES.map((name) => systemFile(name)),
  mapFile(),
]);

export interface BootstrapInput {
  /**
   * Absolute path to the agent's workspace root. Memory files land
   * under `<workspaceRoot>/permanent/memory/`.
   */
  workspaceRoot: string;
  /**
   * The agent's composed identity — its `.ax/IDENTITY.md` + `.ax/SOUL.md`
   * rendered as markdown (TASK-142; previously the legacy `system_prompt`
   * string). Becomes the body of `agent.md` so the agent can re-read its own
   * identity from disk on cold-start. Empty string when the agent has no
   * identity files yet (e.g. still bootstrapping) — agent.md is seeded with a
   * placeholder body in that case.
   */
  composedIdentity: string;
  /**
   * Bench temporal-fidelity seam (TASK-204). The clock the seed files' `created`
   * / `event_time` / `recorded_at` frontmatter is stamped from. Production omits
   * it, so it defaults to `() => new Date()` and every stamp is wall-clock —
   * unchanged. An e2e replay threads the plugin's `nowFn` through here so the
   * seeded `system/{agent,user,session}.md` + `system/map.md` carry the corpus's
   * historical date instead of fiction-vs-reality wall-clock.
   */
  nowFn?: () => Date;
}

/**
 * Seed the per-agent memory tree if it doesn't already exist. Idempotent:
 * if the system files already exist (regardless of content), the call
 * is a no-op for that file. This matters because the bootstrap subscriber
 * fires on every `chat:start` (no `agent:created` hook exists yet — see
 * deviation D4 in the plan); the second through Nth chats must not
 * clobber memory the agent has accumulated.
 *
 * One exception (TASK-556): an existing `system/agent.md` whose content is
 * EXACTLY the placeholder bootstrap seeds for an identity-less agent is
 * rewritten when `composedIdentity` is non-empty. Without it, an agent seeded
 * before it authored its identity — or poisoned by a read blip before TASK-553
 * — kept the placeholder forever. Any other content is the agent's own and is
 * never touched.
 *
 * Returns the files actually created, and the ones repaired, for tests + logs.
 */
export async function bootstrapMemoryTree(
  input: BootstrapInput,
): Promise<{ created: string[]; repaired: string[] }> {
  const created: string[] = [];
  const repaired: string[] = [];
  const now = (input.nowFn ?? (() => new Date()))();
  const nowIso = now.toISOString();

  // `rules` is deliberately absent from this list: it is the HUMAN tier
  // (TASK-234), and bootstrap is an automatic writer. The guard below turns
  // that from a fact about this literal into a fact the process enforces.
  for (const name of SEEDED_SYSTEM_FILES) {
    const rel = systemFile(name);
    guardAutomaticWrite('bootstrap', rel);
    const abs = join(input.workspaceRoot, rel);

    await mkdir(dirname(abs), { recursive: true });

    const fm = systemFrontmatter(name, nowIso);
    const body = systemBody(name, input.composedIdentity);

    // Atomic create-if-not-exists. `wx` is `O_CREAT | O_EXCL` — exactly
    // one writer wins on a race; the rest get EEXIST. Prevents the
    // TOCTOU between a stat-then-write pattern, which would let two
    // concurrent bootstrapMemoryTree calls both pass the existence
    // check and stomp on each other.
    try {
      await writeFile(abs, buildMarkdownFile(fm, body), { encoding: 'utf8', flag: 'wx' });
      created.push(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another caller (or a previous chat) seeded this file. That's
      // the idempotent path — leave their content alone. The one exception
      // (TASK-556): an agent.md that still holds exactly the placeholder,
      // now that a real identity has been composed.
      if (
        name === 'agent' &&
        input.composedIdentity.trim().length > 0 &&
        isPlaceholderAgentFile(await readRegularFile(abs))
      ) {
        await replaceAtomically(abs, buildMarkdownFile(fm, body));
        repaired.push(rel);
      }
    }
  }

  // TASK-190: seed an empty `system/map.md` so the always-injected hierarchical
  // index file exists from the very first chat (inject reads it before any
  // consolidation pass has run). Same idempotent `wx` create-if-not-exists — a
  // later consolidation regenerates it with densified entries and won't be
  // clobbered by a re-bootstrap. mapFile() uses its own path (not a
  // SystemFileName), so it's seeded outside the loop above.
  {
    const rel = mapFile();
    guardAutomaticWrite('bootstrap', rel);
    const abs = join(input.workspaceRoot, rel);
    await mkdir(dirname(abs), { recursive: true });
    const fm: MemoryFrontmatter = {
      id: 'map',
      type: 'system/map',
      created: nowIso,
      confidence: 1.0,
      pinned: true,
      summary:
        'Hierarchical index of the agent\'s memory — one densified line per doc, regenerated each consolidation pass.',
      event_time: nowIso,
      recorded_at: nowIso,
    };
    const body = ['# Memory Map', '', '_No memory yet._', ''].join('\n');
    try {
      await writeFile(abs, buildMarkdownFile(fm, body), { encoding: 'utf8', flag: 'wx' });
      created.push(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  return { created, repaired };
}

const AGENT_PLACEHOLDER = '_The agent has not authored its identity yet._';

/**
 * Does this `system/agent.md` content hold exactly the placeholder bootstrap
 * seeds for an identity-less agent (TASK-556)? Compared on the body, with the
 * frontmatter stripped, so the seed's timestamp doesn't matter — but any other
 * change the agent made to the body makes it the agent's file, not ours.
 * `undefined` (absent or not a regular file) is never the placeholder.
 */
export function isPlaceholderAgentFile(text: string | undefined): boolean {
  if (text === undefined) return false;
  return stripFrontmatter(text) === `# Agent\n\n${AGENT_PLACEHOLDER}`;
}

/**
 * Read a file only if it is a regular file (TASK-556). Absent → undefined; a
 * symlink, directory or device → undefined too: the agent can write into its
 * own memory tree, and a symlinked agent.md is never ours to follow or repair.
 */
export async function readRegularFile(abs: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (!info.isFile()) return undefined;
  return readFile(abs, 'utf8');
}

/** Replace `abs` via a sibling temp file + rename: readers never see a torn
 *  file, and the rename swaps the directory entry rather than writing through
 *  whatever `abs` points at. */
async function replaceAtomically(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function systemFrontmatter(name: SeededSystemFileName, nowIso: string): MemoryFrontmatter {
  return {
    id: name,
    type: `system/${name}`,
    created: nowIso,
    confidence: 1.0,
    pinned: true,
    summary: SYSTEM_SUMMARIES[name],
    event_time: nowIso,
    recorded_at: nowIso,
  };
}

const SYSTEM_SUMMARIES: Record<SeededSystemFileName, string> = {
  agent: 'The agent identity (IDENTITY.md + SOUL.md) — always loaded into context.',
  user: 'Active user profile and durable preferences — always loaded into context.',
  session: 'Rolling summary of the current chat session — always loaded into context.',
};

function systemBody(name: SeededSystemFileName, composedIdentity: string): string {
  if (name === 'agent') {
    // The composed identity (IDENTITY.md + SOUL.md). Empty when the agent has
    // no identity files yet (still bootstrapping) — seed a placeholder so the
    // file exists. The seed is otherwise create-only, so the placeholder is
    // the one body bootstrap replaces: the first chat that composes a real
    // identity rewrites it (TASK-556, see `isPlaceholderAgentFile`).
    const body = composedIdentity.trim().length > 0 ? composedIdentity : AGENT_PLACEHOLDER;
    return `# Agent\n\n${body}\n`;
  }
  if (name === 'user') {
    return [
      '# User',
      '',
      '## Profile',
      '_Nothing recorded yet._',
      '',
      '## Preferences',
      '_Nothing recorded yet._',
      '',
    ].join('\n');
  }
  return [
    '# Session',
    '',
    '## Rolling Summary',
    '_The Observer compresses the in-progress conversation into this section._',
    '',
    '## Open Threads',
    '_None yet._',
    '',
  ].join('\n');
}
