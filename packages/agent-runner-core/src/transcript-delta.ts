import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IpcClient } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// TASK-67 (out-of-git Part B / B2) — resume-transcript delta-ship + resume
// rebuild. Replaces the per-turn `commitTurnAndBundle` of the SDK jsonl: the
// transcript leaves git and lives as opaque rows in the host store. At the
// result boundary the runner ships the DELTA of new transcript bytes; on resume
// it fetches the reconstructed bytes and hands them back to the runner's
// transcript source.
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
  /**
   * 'appended' | 'resynced' | 'noop' (nothing new) | 'no-transcript' (the
   * source has nothing for this session yet).
   */
  outcome: 'appended' | 'resynced' | 'noop' | 'no-transcript';
}

/**
 * What `TranscriptSource.write` did with the bytes it was handed.
 *
 *   - `'accepted'` — the source adopted them; the session can resume.
 *   - `'unusable'` — the source cannot represent these bytes and did NOT
 *     adopt them. The caller treats this exactly like "no stored transcript"
 *     and demotes to a fresh start (the F2a path). Deliberately neutral
 *     vocabulary: core must not learn WHY a source rejected a blob (a foreign
 *     serialization, an unreadable version marker, a corrupt tail); that is
 *     the source's private business.
 */
export type TranscriptWriteOutcome = 'accepted' | 'unusable';

/**
 * Where a runner's transcript bytes come from and go. The SDK runner hunts for
 * the SDK's jsonl (readdir-walking its private cwd-slug encoding — see
 * `createJsonlTranscriptSource` in `@ax/agent-claude-sdk-runner`); a runner
 * that owns its own messages holds them in memory and serializes on demand
 * (`createMemoryTranscriptSource` in `@ax/agent-aisdk-runner`). The
 * delta/prefixHash protocol below is identical either way.
 *
 * The seam is BYTES, not a path: an earlier shape returned a filesystem path,
 * which quietly assumed every runner's transcript is a file on disk. It isn't.
 */
export interface TranscriptSource {
  /** The transcript bytes for `sessionId`, or null when none exists yet. */
  read(sessionId: string): Promise<Buffer | null>;
  /**
   * Persist reconstructed transcript bytes for `sessionId` on resume. The
   * SDK source writes them where the SDK expects (`.claude/projects/<slug>/`,
   * creating the dir); a runner that owns its messages loads them into memory
   * and writes nothing. Core must never name the destination itself — that is
   * exactly the runner-private layout this seam exists to hide.
   */
  write(sessionId: string, bytes: Buffer): Promise<TranscriptWriteOutcome>;
  /**
   * Seed the source from the runner-neutral display log, after `write` answered
   * `'unusable'` — i.e. the stored transcript was written by a DIFFERENT runner
   * and this one is about to start blank while the user still has the whole
   * conversation on screen.
   *
   * OPTIONAL, and its absence is a real answer rather than a gap: a source
   * whose transcript is an SDK-owned file cannot be seeded with a synthetic
   * prior session without hand-forging that SDK's private format, which is
   * precisely the coupling this seam exists to prevent. Such a source simply
   * does not implement it and keeps the demote-to-fresh behaviour.
   *
   * `messages` are text-only user/assistant turns, already filtered and bounded
   * host-side (see `session.get-display-history`) — no tool calls to re-pair
   * and no signed reasoning to replay.
   *
   * Best-effort by contract: a throw here must not fail the turn, because a
   * partially-remembered conversation is strictly better than a dead one.
   */
  seedFromHistory?(input: {
    sessionId: string;
    messages: readonly { role: 'user' | 'assistant'; content: string }[];
    truncated: boolean;
  }): Promise<void>;
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
 * Ship the per-turn transcript delta. Reads the transcript bytes from the
 * source (a jsonl on disk for the SDK runner, an in-memory serialization for a
 * runner that owns its messages), slices past the threaded
 * `sentOffset`, splits complete lines, and calls `session.append-transcript`
 * with `prefixHash` = sha256 of the already-sent bytes `[0..sentOffset)`. On
 * `resync-required` (the SDK rewrote earlier bytes) re-ships the whole file via
 * `session.replace-transcript`. Returns the advanced state + an outcome.
 *
 * Best-effort caller-side: an IPC error PROPAGATES (the caller decides whether
 * a 4xx is terminal — mirrors the old commit path); a source with nothing for
 * this session is a `no-transcript` noop (nothing to ship this turn).
 */
export async function shipTranscriptDelta(input: {
  client: IpcClient;
  source: TranscriptSource;
  sessionId: string;
  state: TranscriptShipState;
}): Promise<ShipDeltaResult> {
  const { client, source, sessionId, state } = input;
  const fileBuf = await source.read(sessionId);
  if (fileBuf === null) {
    return { ...state, outcome: 'no-transcript' };
  }

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

/**
 * Resume rebuild: fetch the reconstructed transcript from the host store and
 * hand the bytes to `source.write` — where they land (a real path for the SDK
 * source, nothing on disk at all for a runner that owns its own messages) is
 * entirely the source's call; core never names a destination. A source that
 * answers `'unusable'` is treated exactly like an empty store. Returns the
 * initial ship state for the resumed session: `sentOffset` = the byte length
 * handed off, `sentSeq` = the host's max seq (the rows already durable). When
 * the host has no transcript (`maxSeq === 0`) `write` is never called and
 * `{ written: false }` is returned — the caller demotes `resume` to a fresh
 * start (the F2a guard).
 */
export async function restoreTranscriptForResume(input: {
  client: IpcClient;
  source: TranscriptSource;
  sessionId: string;
}): Promise<{ written: boolean; state: TranscriptShipState }> {
  const { client, source, sessionId } = input;
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

  const outcome = await source.write(sessionId, buf);
  if (outcome === 'unusable') {
    // The source could not adopt these bytes (e.g. they were serialized by a
    // different runner). Before demoting, give it the chance to rebuild what it
    // can from the runner-neutral display log — the user is still looking at
    // this conversation on screen, so starting blank is a worse answer than an
    // imperfect one. A source that cannot be seeded doesn't implement the hook.
    await seedFromDisplayHistory({ client, source, sessionId });
    // Either way, report "no resumable transcript" so the caller takes the SAME
    // demote-to-fresh path the F2a guard already implements — the seeded
    // messages are context, NOT a resumable transcript prefix, and must not be
    // treated as bytes we have already shipped to the host.
    return { written: false, state: { sentOffset: 0, sentSeq: 0 } };
  }

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


/**
 * Ask the host for the display log and hand it to the source.
 *
 * ENTIRELY BEST-EFFORT. Every failure mode here — the host is old and has no
 * such action, the session isn't conversation-scoped (409), the source can't be
 * seeded, the call throws — resolves to "carry on with a blank transcript",
 * which is exactly the behaviour that existed before this function. A courtesy
 * that can fail the turn is worse than no courtesy.
 */
async function seedFromDisplayHistory(input: {
  client: IpcClient;
  source: TranscriptSource;
  sessionId: string;
}): Promise<void> {
  const { client, source, sessionId } = input;
  if (source.seedFromHistory === undefined) return;
  try {
    const res = (await client.call('session.get-display-history', {})) as {
      messages?: readonly { role: 'user' | 'assistant'; content: string }[];
      truncated?: boolean;
    };
    const messages = res.messages ?? [];
    if (messages.length === 0) return;
    await source.seedFromHistory({
      sessionId,
      messages,
      truncated: res.truncated === true,
    });
    process.stderr.write(
      `runner: rebuilt ${messages.length} message(s) of context from the ` +
        `display history (the stored transcript was written by another runner)\n`,
    );
  } catch (err) {
    process.stderr.write(
      `runner: could not rebuild context from display history: ` +
        `${err instanceof Error ? err.message : String(err)}; starting fresh\n`,
    );
  }
}
