import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read the runner-native jsonl transcript for the given sessionId and return
 * the uuid of the LAST line whose `type` matches the requested role. Used by
 * event.turn-end emission to surface the just-written turn's uuid so
 * subscribers can refer back (e.g., conversations:drop-turn).
 *
 * The Claude SDK writes to `${HOME}/.claude/projects/<cwd-slug>/<sessionId>.jsonl`.
 * We don't know the slug a priori (the SDK encodes the cwd as a directory
 * name and the slug is not surfaced on the wire), so we readdir-walk
 * `${workspaceRoot}/.claude/projects` and pick the first directory that
 * contains a file named `${sessionId}.jsonl`.
 *
 * Returns undefined on missing file, parse error, or no matching line —
 * non-fatal. The caller (event.turn-end emitter) emits without turnId in
 * that case and downstream subscribers fall through to their old behavior.
 */
export async function readLastTurnUuid(
  workspaceRoot: string,
  sessionId: string,
  type: 'assistant' | 'user' | 'tool',
): Promise<string | undefined> {
  const jsonlPath = await locateJsonl(workspaceRoot, sessionId);
  if (jsonlPath === null) return undefined;
  let text: string;
  try {
    text = await readFile(jsonlPath, 'utf-8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      const o = JSON.parse(line) as { type?: string; uuid?: string };
      if (o.type === type && typeof o.uuid === 'string') {
        return o.uuid;
      }
    } catch {
      // Fail closed: a malformed line we encounter before finding a
      // match could be the very turn we're looking for (e.g., the SDK
      // wrote a partial line at the tail). Returning an older UUID
      // from further back would target the WRONG turn for drop-turn.
      return undefined;
    }
  }
  return undefined;
}

async function locateJsonl(
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
      await readFile(candidate, 'utf-8');
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
