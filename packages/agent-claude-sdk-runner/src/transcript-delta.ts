import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IpcClient } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// TASK-67 (out-of-git Part B / B2) — resume-transcript delta-ship + resume
// rebuild. Replaces the per-turn `commitTurnAndBundle` of the SDK jsonl: the
// transcript leaves git and lives as opaque rows in the host store. At the
// result boundary the runner ships the DELTA of new jsonl bytes; on resume it
// fetches the reconstructed bytes and writes them back to disk for the SDK.
//
// The transcript is "append-mostly" — the SDK can compact or update singleton
// entries (`last-prompt`) in place. So the delta carries an integrity check
// (`prefixHash` = sha256 of the bytes already shipped); a host mismatch →
// `resync-required` → re-ship the whole file. Single writer per session (this
// runner) means `(conversationId, seq)` is contention-free, NOT a git CAS.
// ---------------------------------------------------------------------------

/** The runner-local threaded state, advanced across turns like `parentVersion`. */
export interface TranscriptShipState {
  /** Byte offset into the jsonl already shipped to the host. */
  sentOffset: number;
  /** Number of jsonl lines already in the host store (= host max seq). */
  sentSeq: number;
}

export interface ShipDeltaResult extends TranscriptShipState {
  /** 'appended' | 'resynced' | 'noop' (nothing new) | 'no-jsonl' (file gone). */
  outcome: 'appended' | 'resynced' | 'noop' | 'no-jsonl';
}

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
 * Split a Buffer of jsonl bytes into COMPLETE lines (newline-terminated),
 * holding back any trailing partial line that has not yet been `\n`-terminated
 * (the SDK may still be flushing it). Returns the complete-line strings and the
 * byte length they occupy INCLUDING their trailing `\n` (so the caller advances
 * `sentOffset` to a clean line boundary). A buffer with no trailing `\n` yields
 * `{ lines: [...all but the last], consumed: bytesUpToLastNewline+1 }`.
 */
export function splitCompleteLines(buf: Buffer): {
  lines: string[];
  consumed: number;
} {
  const lastNl = buf.lastIndexOf(0x0a); // '\n'
  if (lastNl < 0) {
    // No complete line yet — hold everything back.
    return { lines: [], consumed: 0 };
  }
  // Everything up to and including the last '\n' is complete lines.
  const completeRegion = buf.subarray(0, lastNl + 1);
  const text = completeRegion.toString('utf8');
  // Drop the final empty segment produced by the trailing '\n'.
  const parts = text.split('\n');
  parts.pop();
  return { lines: parts, consumed: completeRegion.length };
}

/** sha256 (hex) of `buf` — the prefix-hash integrity check. */
export function hashBytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Ship the per-turn transcript delta. Reads the jsonl, slices past the threaded
 * `sentOffset`, splits complete lines, and calls `session.append-transcript`
 * with `prefixHash` = sha256 of the already-sent bytes `[0..sentOffset)`. On
 * `resync-required` (the SDK rewrote earlier bytes) re-ships the whole file via
 * `session.replace-transcript`. Returns the advanced state + an outcome.
 *
 * Best-effort caller-side: an IPC error PROPAGATES (the caller decides whether
 * a 4xx is terminal — mirrors the old commit path); a missing jsonl is a
 * `no-jsonl` noop (nothing to ship this turn).
 */
export async function shipTranscriptDelta(input: {
  client: IpcClient;
  workspaceRoot: string;
  sessionId: string;
  state: TranscriptShipState;
}): Promise<ShipDeltaResult> {
  const { client, workspaceRoot, sessionId, state } = input;
  const jsonlPath = await locateJsonl(workspaceRoot, sessionId);
  if (jsonlPath === null) {
    return { ...state, outcome: 'no-jsonl' };
  }
  const fileBuf = await readFile(jsonlPath);

  // The prefix already shipped is the raw file bytes [0..sentOffset). The host
  // hashes the stored lines + their trailing '\n' the same way (its sentOffset
  // sits after a complete line's terminator), so the two agree byte-for-byte.
  const prefixHash = hashBytes(fileBuf.subarray(0, state.sentOffset));

  // The tail past what we've already sent. Hold back any trailing partial line.
  const tail = fileBuf.subarray(state.sentOffset);
  const { lines, consumed } = splitCompleteLines(tail);

  // Ship the delta — INCLUDING the zero-new-lines case. The SDK can compact /
  // update an earlier line in place (e.g. `last-prompt`) so the already-sent
  // prefix changes with no new complete line past `sentOffset`. We do NOT treat
  // that as a silent noop: an empty-`lines` append is a PREFIX-INTEGRITY PROBE —
  // the host re-checks `prefixHash` against its stored bytes for `fromSeq` and
  // returns `resync-required` if they diverged (it inserts nothing on a match).
  // So every turn either confirms the prefix is intact or resyncs — never leaves
  // the host stale (B3 no-omission), regardless of whether the rewrite shrank,
  // grew, or kept the file length.
  //
  // The delta rides the RAW octet-stream channel (like the resync whole-file
  // ship below), NOT a JSON `call`: a single turn that Reads a large attachment
  // writes one jsonl line carrying base64 image/document blocks, so even the
  // per-turn delta can exceed the 4 MiB JSON `MAX_FRAME` — which the host
  // rejected as `body too large`, terminating the runner and killing the pod.
  // The lines are the body (`\n`-joined + terminated, byte-identical to the
  // on-disk bytes the host re-hashes); `fromSeq`/`prefixHash` ride the query.
  const body = Buffer.from(
    lines.length > 0 ? lines.join('\n') + '\n' : '',
    'utf8',
  );
  const resp = (await client.callBinaryUpload(
    'session.append-transcript',
    body,
    { fromSeq: String(state.sentSeq), prefixHash },
  )) as { outcome: 'appended' | 'resync-required'; maxSeq: number };

  if (resp.outcome === 'appended') {
    if (lines.length === 0) {
      // Prefix probe confirmed intact, nothing inserted — state unchanged.
      return { ...state, outcome: 'noop' };
    }
    return {
      sentOffset: state.sentOffset + consumed,
      sentSeq: resp.maxSeq,
      outcome: 'appended',
    };
  }

  // resync-required: the SDK rewrote earlier bytes (the host's prefix-hash for
  // `fromSeq` didn't match ours). Re-ship the WHOLE file once.
  return resyncWholeFile(client, fileBuf);
}

/**
 * Re-ship the whole jsonl (the resync path). Splits the file into complete
 * lines, re-joins them `\n`-terminated (byte-identical to the on-disk prefix +
 * matching the host's per-line `\n` hashing), and replaces the store wholesale.
 * Returns the threaded state: `sentSeq` = host max seq, `sentOffset` = the bytes
 * of complete lines shipped (NOT the raw file length — a trailing partial is
 * held back, so offset and seq always agree).
 */
async function resyncWholeFile(
  client: IpcClient,
  fileBuf: Buffer,
): Promise<ShipDeltaResult> {
  const whole = splitCompleteLines(fileBuf);
  const replaceResp = (await client.callBinaryUpload(
    'session.replace-transcript',
    Buffer.from(
      whole.lines.length > 0 ? whole.lines.join('\n') + '\n' : '',
      'utf8',
    ),
  )) as { maxSeq: number };
  return {
    sentOffset: whole.consumed,
    sentSeq: replaceResp.maxSeq,
    outcome: 'resynced',
  };
}

// ---------------------------------------------------------------------------
// Resume rebuild
// ---------------------------------------------------------------------------

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
 * non-alphanumeric character with `-` (so `/permanent` → `-permanent`,
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
 * Resume rebuild: fetch the reconstructed jsonl from the host store and write
 * it to `<workspaceRoot>/.claude/projects/<slug>/<sessionId>.jsonl` (the path
 * the SDK reads on `query({ resume })`). Returns the initial ship state for the
 * resumed session: `sentOffset` = the written byte length, `sentSeq` = the
 * host's max seq (the rows already durable). When the host has no transcript
 * (`maxSeq === 0`) NOTHING is written and `{ written: false }` is returned — the
 * caller demotes `resume` to a fresh start (the F2a guard).
 */
export async function restoreTranscriptForResume(input: {
  client: IpcClient;
  workspaceRoot: string;
  sessionId: string;
}): Promise<{ written: boolean; state: TranscriptShipState }> {
  const { client, workspaceRoot, sessionId } = input;
  const { path: tmpPath, bytes } = await client.callBinary(
    'session.get-transcript',
    {},
  );
  let buf: Buffer;
  try {
    buf = await readFile(tmpPath);
  } finally {
    // callBinary hands us a temp file we own; clean it up.
    const { unlink } = await import('node:fs/promises');
    await unlink(tmpPath).catch(() => {});
  }
  void bytes;

  if (buf.length === 0) {
    // No resumable transcript (F2a: max(seq) === 0).
    return { written: false, state: { sentOffset: 0, sentSeq: 0 } };
  }

  // Compute the SDK's project-dir slug from realpath(cwd). cwd === workspaceRoot
  // (the runner passes it to query({ cwd })). realpath resolves any symlink the
  // SDK would also resolve.
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
  await writeFile(jsonlPath, buf);

  // Thread the ship state from the COMPLETE lines only: `sentSeq` = the number
  // of complete `\n`-terminated lines (= host max seq), `sentOffset` = the bytes
  // those lines occupy. Using `consumed` (not raw `buf.length`) keeps offset and
  // seq internally consistent even if the host ever returned bytes whose final
  // line lacked a terminator — that trailing partial is held back and re-shipped
  // when it completes, exactly like a live tail. (The store emits a trailing
  // `\n` per line today, so `consumed === buf.length` in practice.)
  const { lines, consumed } = splitCompleteLines(buf);
  return {
    written: true,
    state: { sentOffset: consumed, sentSeq: lines.length },
  };
}
