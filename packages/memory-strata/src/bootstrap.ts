import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildMarkdownFile } from './frontmatter.js';
import { systemFile, type SystemFileName } from './paths.js';
import type { MemoryFrontmatter } from './types.js';

export interface BootstrapInput {
  /**
   * Absolute path to the agent's workspace root. Memory files land
   * under `<workspaceRoot>/permanent/memory/`.
   */
  workspaceRoot: string;
  /**
   * The agent's persona / system prompt. Becomes the body of `agent.md`
   * so the agent can re-read its own purpose from disk on cold-start.
   */
  agentSystemPrompt: string;
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
  const now = new Date();
  const nowIso = now.toISOString();

  for (const name of ['agent', 'user', 'session'] as const) {
    const rel = systemFile(name);
    const abs = join(input.workspaceRoot, rel);

    await mkdir(dirname(abs), { recursive: true });

    const fm = systemFrontmatter(name, nowIso);
    const body = systemBody(name, input.agentSystemPrompt);

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
  agent: 'The agent persona and system prompt — always loaded into context.',
  user: 'Active user profile and durable preferences — always loaded into context.',
  session: 'Rolling summary of the current chat session — always loaded into context.',
};

function systemBody(name: SystemFileName, agentSystemPrompt: string): string {
  if (name === 'agent') {
    return `# Agent\n\n${agentSystemPrompt}\n`;
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
