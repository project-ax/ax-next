import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscriptSource } from '@ax/agent-runner-core';

/**
 * Locate the runner-native jsonl for `sessionId`. The SDK writes to
 * `${HOME}/.claude/projects/<cwd-slug>/<sessionId>.jsonl`; we don't know the
 * slug a priori (it's the SDK's encoding of realpath(cwd)), so we readdir-walk
 * `<workspaceRoot>/.claude/projects` and pick the dir holding the file. Returns
 * null when no such file exists yet. (Same walk as `turn-end-uuid.ts`.)
 */
export async function locateJsonl(
  workspaceRoot: string,
  sessionId: string,
): Promise<string | null> {
  const projectsDir = join(workspaceRoot, '.claude', 'projects');
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const slug of entries) {
    const candidate = join(projectsDir, slug, `${sessionId}.jsonl`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The Claude Agent SDK writes `${CLAUDE_CONFIG_DIR}/projects/<cwd-slug>/<sid>.jsonl`.
 * We don't know the slug a priori (it's the SDK's encoding of realpath(cwd)),
 * so we readdir-walk the projects dir and pick the dir holding the file.
 */
export function createJsonlTranscriptSource(workspaceRoot: string): TranscriptSource {
  return {
    locate: (sessionId: string) => locateJsonl(workspaceRoot, sessionId),
  };
}
