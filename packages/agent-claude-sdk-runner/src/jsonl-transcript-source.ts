import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  TranscriptSource,
  TranscriptWriteOutcome,
} from '@ax/agent-runner-core';

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

// Mirror of the SDK's project-dir-slug length cap. A realpath longer than this
// is truncated to SLUG_MAX chars + '-' + a stable hash of the FULL path, so two
// long paths sharing a prefix don't collide. Verified against the vendored SDK
// 0.2.119: `var P0=200`.
const SLUG_MAX = 200;

/**
 * Stable hash the SDK appends to an over-length slug. Byte-for-byte port of the
 * vendored SDK's `kB`/`gE` (a djb2-style 32-bit rolling hash, |0-truncated each
 * step, then `Math.abs(...).toString(36)`). Replicated exactly so a long
 * workspace path resolves to the SAME dir the SDK computes.
 */
function slugHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * The SDK derives the project-dir name from `realpath(cwd)` by replacing each
 * non-alphanumeric character with `-` (so `/agent` → `-agent`,
 * `/var/lib/ax` → `-var-lib-ax`), truncating to 200 chars + a hash suffix when
 * longer. We mirror that exact transform so the dir we WRITE on resume is the
 * same one the SDK READS when it opens `query({ resume })`. Verified against the
 * vendored SDK 0.2.119 (`replace(/[^a-zA-Z0-9]/g,"-")` + the P0=200 cap).
 */
export function encodeProjectSlug(cwdRealpath: string): string {
  const dashed = cwdRealpath.replace(/[^a-zA-Z0-9]/g, '-');
  if (dashed.length <= SLUG_MAX) return dashed;
  return `${dashed.slice(0, SLUG_MAX)}-${slugHash(cwdRealpath)}`;
}

/**
 * Write reconstructed transcript bytes to
 * `<workspaceRoot>/.claude/projects/<slug>/<sessionId>.jsonl` — the path the
 * SDK reads on `query({ resume })`. Computes the SDK's project-dir slug from
 * realpath(cwd); cwd === workspaceRoot (the runner passes it to
 * `query({ cwd })`). realpath resolves any symlink the SDK would also
 * resolve.
 */
/**
 * Does this transcript announce that some OTHER runner wrote it?
 *
 * The premise this function exists to defend against used to be stated here as
 * fact: "any bytes the host store returns are, by construction, in the shape the
 * SDK reads back." That holds only while a conversation never changes runner.
 * Switch an agent from `aisdk` to `claude-sdk` mid-conversation and the host
 * store hands THIS source the aisdk runner's transcript — which we adopted,
 * handed to `query({ resume })`, and the SDK died on with "No conversation found
 * with session ID", exiting 1. Every later turn on that conversation crashed the
 * same way, so the conversation was permanently stuck. Found by the §8
 * acceptance walk; the SDK-direction twin of the check `transcript-codec.ts`
 * already does in the aisdk runner.
 *
 * The rule is deliberately narrow: reject ONLY a first line that is a JSON
 * object carrying a top-level `runner` string — the header every runner-native
 * serializer in this repo stamps (`{"v":1,"runner":"aisdk"}`; see
 * `TRANSCRIPT_RUNNER` in @ax/agent-aisdk-runner's transcript-codec.ts, re-checked
 * here rather than imported — invariant I2, no cross-plugin imports). The SDK's
 * own jsonl never carries that key: its first line is a record like
 * `{"type":"queue-operation",…,"sessionId":"…"}`. Anything we cannot positively
 * identify as foreign is still ACCEPTED, because a false "unusable" would
 * silently break resume for genuine SDK sessions — a worse failure than the one
 * being fixed.
 */
export function isForeignRunnerTranscript(bytes: Buffer): boolean {
  // Only the header line matters, and it is tiny. Cap the slice so a multi-MB
  // transcript is never fully decoded just to read its first line.
  const head = bytes.subarray(0, 4096).toString('utf8');
  const newline = head.indexOf('\n');
  const firstLine = (newline === -1 ? head : head.slice(0, newline)).trim();
  if (firstLine.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    // Unparseable is not positively foreign — leave it to the SDK, which is
    // the behaviour that shipped before this check existed.
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  return typeof (parsed as { runner?: unknown }).runner === 'string';
}

async function writeJsonl(
  workspaceRoot: string,
  sessionId: string,
  bytes: Buffer,
): Promise<TranscriptWriteOutcome> {
  // Refuse BEFORE writing: adopting the bytes and then reporting 'unusable'
  // would leave a foreign jsonl sitting at the path the SDK reads, so a later
  // boot could still find and choke on it.
  if (isForeignRunnerTranscript(bytes)) {
    process.stderr.write(
      `runner: cannot resume transcript for session ${sessionId}: ` +
        `it was written by another runner; starting fresh\n`,
    );
    return 'unusable';
  }
  let cwdReal: string;
  try {
    cwdReal = await realpath(workspaceRoot);
  } catch {
    cwdReal = workspaceRoot;
  }
  const slug = encodeProjectSlug(cwdReal);
  const dir = join(workspaceRoot, '.claude', 'projects', slug);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  await writeFile(jsonlPath, bytes);
  return 'accepted';
}

/**
 * The Claude Agent SDK writes `${CLAUDE_CONFIG_DIR}/projects/<cwd-slug>/<sid>.jsonl`.
 * We don't know the slug a priori (it's the SDK's encoding of realpath(cwd)),
 * so we readdir-walk the projects dir and pick the dir holding the file.
 */
export function createJsonlTranscriptSource(workspaceRoot: string): TranscriptSource {
  return {
    // The seam is BYTES, not a path (see TranscriptSource in
    // @ax/agent-runner-core): locate the jsonl, then read it. A missing file is
    // `null` — "nothing to ship this turn", not an error.
    read: async (sessionId: string) => {
      const jsonlPath = await locateJsonl(workspaceRoot, sessionId);
      if (jsonlPath === null) return null;
      return readFile(jsonlPath);
    },
    write: (sessionId: string, bytes: Buffer) => writeJsonl(workspaceRoot, sessionId, bytes),
  };
}
