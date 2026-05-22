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

/**
 * Wait for the runner-native jsonl to gain a NEW assistant line, then return
 * its uuid. Bounded by `timeoutMs`; returns undefined on timeout.
 *
 * Why this exists: the Anthropic Agent SDK writes the assistant turn's jsonl
 * line AFTER it yields the `result` message to the runner's Node loop. The
 * runner's per-turn commit (`commitTurnAndBundle`) runs in the `result`
 * handler, so without this wait it stages the workspace BEFORE the assistant
 * line lands — the reply is missing from the committed bundle and only
 * becomes durable (readable via `conversations:get`) at the NEXT turn's
 * commit or at session-close. Under idle-keepalive that defers the assistant
 * reply's durability by the whole idle window (minutes). Polling the jsonl
 * for the new line and committing only after it lands closes that gap.
 *
 * `sinceUuid` is the last assistant uuid committed before this turn (undefined
 * when the transcript had no assistant line yet, e.g. a fresh session's first
 * turn). The poll resolves as soon as the last assistant uuid differs from it.
 */
export async function waitForTurnTranscript(
  workspaceRoot: string,
  sessionId: string,
  sinceUuid: string | undefined,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<string | undefined> {
  const start = Date.now();
  for (;;) {
    const uuid = await readLastTurnUuid(workspaceRoot, sessionId, 'assistant');
    if (uuid !== undefined && uuid !== sinceUuid) return uuid;
    if (Date.now() - start >= opts.timeoutMs) return undefined;
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
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
