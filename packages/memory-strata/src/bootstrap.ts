import { mkdir, stat, writeFile } from 'node:fs/promises';
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
    if (await fileExists(abs)) continue;

    await mkdir(dirname(abs), { recursive: true });

    const fm = systemFrontmatter(name, nowIso);
    const body = systemBody(name, input.agentSystemPrompt);
    await writeFile(abs, buildMarkdownFile(fm, body), 'utf8');
    created.push(rel);
  }

  return { created };
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
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
