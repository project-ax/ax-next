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
 * Wait until the runner-native jsonl for `sessionId` contains a line whose
 * `uuid` equals `targetUuid`. Returns true once present, false on timeout
 * (bounded by `timeoutMs`).
 *
 * Why this exists: the Anthropic Agent SDK writes the turn's FINAL assistant
 * jsonl line AFTER it yields the `result` message to the runner's Node loop.
 * The runner's per-turn commit (`commitTurnAndBundle`) runs in the `result`
 * handler, so without this wait it stages the workspace BEFORE the closing
 * line lands — the reply is missing from the committed bundle and only becomes
 * durable (readable via `conversations:get`) at the NEXT turn's commit or at
 * session-close. Under idle-keepalive that defers durability by the whole idle
 * window (minutes). Polling for the line and committing only after it lands
 * closes that gap.
 *
 * `targetUuid` is the uuid of the turn's LAST assistant message — captured
 * in-band from `SDKAssistantMessage.uuid` (the same id the SDK writes to the
 * jsonl line). We wait for THIS SPECIFIC line, NOT merely "any new assistant
 * line": a tool-using turn writes an INTERMEDIATE tool_use assistant line
 * DURING the turn, so a "wait for any new line" check short-circuits on it and
 * the per-turn commit drops the closing-text line that lands afterward
 * (TASK-11 — the persisted `[user, tool_use, tool_result]` shape). Targeting
 * the final message's uuid is robust to any number of intermediate lines.
 */
export async function waitForTranscriptUuid(
  workspaceRoot: string,
  sessionId: string,
  targetUuid: string,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await transcriptHasUuid(workspaceRoot, sessionId, targetUuid)) {
      return true;
    }
    if (Date.now() - start >= opts.timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
}

/**
 * True iff the jsonl for `sessionId` contains a line whose `uuid` equals
 * `targetUuid`. Scans every line (not just the tail) so an intermediate match
 * isn't masked by later lines; tolerates a truncated/garbage trailing line
 * (the target may be the very line still being flushed — keep polling).
 */
async function transcriptHasUuid(
  workspaceRoot: string,
  sessionId: string,
  targetUuid: string,
): Promise<boolean> {
  const jsonlPath = await locateJsonl(workspaceRoot, sessionId);
  if (jsonlPath === null) return false;
  let text: string;
  try {
    text = await readFile(jsonlPath, 'utf-8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const o = JSON.parse(trimmed) as { uuid?: string };
      if (o.uuid === targetUuid) return true;
    } catch {
      // Truncated/garbage line (possibly the target still being flushed) — skip.
      continue;
    }
  }
  return false;
}

/**
 * F2a: returns true iff the runner-native jsonl for `sessionId` contains at
 * least one parseable conversation message — a line whose `type` is `'user'`
 * or `'assistant'`. The SDK's `query({ resume: sessionId })` throws
 * `"No conversation found with session ID: <sessionId>"` — which crashes the
 * runner (`exit 1`) — when no such line exists (jsonl missing, empty,
 * metadata-only, or only truncated/garbage message lines). Confirmed against
 * the live SDK (0.2.119) on 2026-05-24.
 *
 * Callers gate `resume` on this so a bound session that has no resumable
 * transcript in the materialized workspace degrades to a fresh start instead
 * of a hard exit. Mirrors `locateJsonl`'s readdir-walk (the SDK encodes cwd
 * into the project dir name, which we don't know a priori).
 *
 * Unlike `readLastTurnUuid`, this does NOT fail closed on a malformed line: it
 * scans for ANY valid user/assistant message, so a truncated tail line must
 * not mask an earlier durable message.
 */
export async function hasResumableTranscript(
  workspaceRoot: string,
  sessionId: string,
): Promise<boolean> {
  const jsonlPath = await locateJsonl(workspaceRoot, sessionId);
  if (jsonlPath === null) return false;
  let text: string;
  try {
    text = await readFile(jsonlPath, 'utf-8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const o = JSON.parse(trimmed) as { type?: string };
      if (o.type === 'user' || o.type === 'assistant') return true;
    } catch {
      // Truncated/garbage line — doesn't count as a resumable message; skip.
      continue;
    }
  }
  return false;
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
