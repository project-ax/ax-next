import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildMarkdownFile } from './frontmatter.js';
import { systemFile, mapFile, type SystemFileName } from './paths.js';
import type { MemoryFrontmatter } from './types.js';

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
 * Returns the list of files actually created, mostly for tests + logs.
 */
export async function bootstrapMemoryTree(
  input: BootstrapInput,
): Promise<{ created: string[] }> {
  const created: string[] = [];
  const now = (input.nowFn ?? (() => new Date()))();
  const nowIso = now.toISOString();

  for (const name of ['agent', 'user', 'session'] as const) {
    const rel = systemFile(name);
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
      // the idempotent path — leave their content alone.
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

  return { created };
}

function systemFrontmatter(name: SystemFileName, nowIso: string): MemoryFrontmatter {
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

const SYSTEM_SUMMARIES: Record<SystemFileName, string> = {
  agent: 'The agent identity (IDENTITY.md + SOUL.md) — always loaded into context.',
  user: 'Active user profile and durable preferences — always loaded into context.',
  session: 'Rolling summary of the current chat session — always loaded into context.',
};

function systemBody(name: SystemFileName, composedIdentity: string): string {
  if (name === 'agent') {
    // The composed identity (IDENTITY.md + SOUL.md). Empty when the agent has
    // no identity files yet (still bootstrapping) — seed a placeholder so the
    // file exists and gets filled in once the agent authors its identity. (The
    // seed is idempotent: a later bootstrap with a real identity won't
    // overwrite this file, but a real identity is seeded on the FIRST chat that
    // resolves one — the placeholder only persists for a never-identified
    // agent.)
    const body = composedIdentity.trim().length > 0
      ? composedIdentity
      : '_The agent has not authored its identity yet._';
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
