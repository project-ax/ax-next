/**
 * Handing a person one of an agent's files, WHOLE (TASK-1014).
 *
 * The bytes half of a download. The Files tab's route uses it, and TASK-1012's
 * chat file chips will too. It does NOT decide who may read what: its caller
 * has already authenticated the person, resolved the agent through its ACL
 * and validated the path. It decides only how the bytes travel, and that
 * nobody is handed a torn file that looks whole.
 *
 * HOW THE BYTES TRAVEL. One range at a time, through the host-internal
 * `sandbox:read-user-file-range`, into the http-server's `bodyStream()`:
 *
 *   - Memory stays bounded. A range is a megabyte, and `bodyStream()` asks for
 *     the next one only when the socket has room. A slow client costs us about
 *     a chunk or two, not the file.
 *   - Nothing stays open between ranges. Each call re-opens the file and
 *     re-confines the path on the provider's side, so a client that wanders
 *     off leaves no file handle behind.
 *
 * A FILE THAT CHANGES UNDER THE DOWNLOAD is the hard part, because the agent
 * may well still be writing it (a live log is the classic case). Every answer
 * has to be the same file as the first one: the same opaque `version`, the
 * same `size`, and exactly as many bytes as were asked for. After the last
 * range, one more call (`offset: size, length: 0`) asks again, which catches
 * a change made during the last read. `bodyStream()` holds the chunk that
 * completes the body until that call has answered. Any difference throws, and
 * a throw tears the connection down instead of ending it. The person's
 * browser then holds fewer bytes than Content-Length promised, and calls it
 * a failed download, which is the truth.
 *
 * WHAT THE STATUS CODES MEAN. Everything is decided before the first byte,
 * while we can still say no in words:
 *
 *   - no range service              → 503 user-files-unavailable
 *   - the read threw (any error)    → 503 file-read-failed, logged by its codes
 *   - an answer it cannot check     → 503 file-read-failed, logged
 *   - unavailable                   → 503 user-files-unavailable
 *   - absent                        → 404 file-not-found
 *   - a folder                      → 400 not-a-file
 *   - over the ceiling              → 413 file-too-large, nothing more read
 *   - a file                        → 200, streamed
 *
 * After the head has gone out there is nothing left to answer, so a failure
 * is logged (`workspace_user_file_download_incomplete`) and never rethrown.
 *
 * LOGS carry the agent id, a reason and error CODES. Never the path, the
 * filename, a byte, or an error's message: a message from `fs` quotes the
 * path, and the path is somebody's file name.
 *
 * Invariant 2: this module imports no other plugin. The response is the same
 * duck-typed mirror of `@ax/http-server`'s adapter the rest of this package
 * uses, and the hook's types are type-only imports from its contract package.
 */
import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import type {
  ReadUserFileRangeInput,
  ReadUserFileRangeOutput,
} from '@ax/sandbox-mount-protocol';
import { sanitizeContentDispositionFilename } from './content-disposition.js';

/**
 * How much one range read asks for: a megabyte, the same per-request memory
 * the capped read this replaced used to hold.
 */
export const USER_FILE_DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

/**
 * The biggest file we start a download of: a gigabyte.
 *
 * The Files tab holds a download in memory before it saves it, so this bounds
 * that, and it bounds how long one download can keep a range reader busy.
 * Checked against the first range's `size`; a bigger file gets a 413 before
 * any body, with nothing partial sent.
 */
export const USER_FILE_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;

// The hook name is written out as a literal at each call site below, not held
// in a constant: `manifest-declarations.test.ts` checks every literal against
// the manifest, and a computed name is one it cannot see.
const INCOMPLETE = 'workspace_user_file_download_incomplete';
const READ_FAILED = 'workspace_user_file_download_read_failed';

/**
 * THE content type of every download this surface serves.
 *
 * Not derived from the bytes, not read off the file's extension, and — most of
 * all — never taken from anything the caller sent. Every one of those is a way
 * for the file's own content to decide how a browser treats it, and the file
 * was written by an agent. `text/html` on an agent-authored file is stored XSS
 * on our origin; `image/svg+xml` is the same thing wearing a picture.
 *
 * `application/octet-stream` plus `nosniff` plus `Content-Disposition:
 * attachment` is the boring combination that means "save this, do not run it".
 * The cost is that a PNG will not preview in a tab. That is the intended
 * trade: this is a download affordance, and previewing is what the Files tab
 * already does, in a renderer we control.
 */
const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

/**
 * The response adapter a streamed download needs: a duck-typed subset of
 * `@ax/http-server`'s `HttpResponse` (invariant 2 — no cross-plugin import).
 *
 * `bodyStream` sends a body of exactly `contentLength` bytes pulled from
 * `source`, with backpressure. It resolves when the body is out. It rejects
 * with an Error whose `code` says why ('client-gone', 'source-failed' with the
 * source's error as `cause`, 'length-mismatch', or one of Node's own) after
 * tearing the connection down, so a short body never reads as a whole one.
 */
export interface StreamingDownloadResponse {
  status(n: number): StreamingDownloadResponse;
  header(name: string, value: string): StreamingDownloadResponse;
  json(v: unknown): void;
  bodyStream(source: AsyncIterable<Uint8Array>, opts: { contentLength: number }): Promise<void>;
}

export interface SendUserFileDownloadArgs {
  bus: HookBus;
  /**
   * The AGENT's ctx (the workspace surface's `agentWorkspaceCtx`), never the
   * plugin's own: the provider reads under it, and the logs go to it.
   */
  ctx: AgentContext;
  /** The session owner the provider keys the agent's mount on. */
  owner: ReadUserFileRangeInput['owner'];
  /** Already validated by the caller (`workspaceFilePath`). */
  relPath: string;
  /** The name to save it under, raw. Sanitized here for Content-Disposition. */
  downloadName: string;
  res: StreamingDownloadResponse;
}

type FileAnswer = Extract<ReadUserFileRangeOutput, { kind: 'file' }>;

/**
 * Send one file, whole, as a download.
 *
 * The caller has ALREADY authenticated the person, ACL-resolved the agent, and
 * validated `relPath`. Never rejects: every outcome is either a response or,
 * once the body has started, a log line.
 */
export async function sendUserFileDownload(args: SendUserFileDownloadArgs): Promise<void> {
  const { bus, ctx, owner, relPath, downloadName, res } = args;
  const agentId = owner.agentId;

  if (!bus.hasService('sandbox:read-user-file-range')) {
    // No provider can read a range here. Never a fallback to the preview read:
    // that one answers a capped prefix, and a prefix is not the file.
    res.status(503).json({ error: 'user-files-unavailable' });
    return;
  }

  const range = (offset: number, length: number): Promise<ReadUserFileRangeOutput> =>
    bus.call<ReadUserFileRangeInput, ReadUserFileRangeOutput>('sandbox:read-user-file-range', ctx, {
      owner,
      relPath,
      offset,
      length,
    });

  let first: ReadUserFileRangeOutput;
  try {
    first = await range(0, USER_FILE_DOWNLOAD_CHUNK_BYTES);
  } catch (err) {
    // EVERY thrown read, whatever its code. The bus wraps a plain throw (EACCES,
    // EIO) as `unknown`; a provider's own codes (no host mount, the pod
    // reader's failure) and the bus's `timeout` arrive as themselves. Each is
    // a read that did not happen, which is neither a missing file (404) nor a
    // crash (500).
    ctx.logger.warn(READ_FAILED, { agentId, ...errorCodes(err) });
    res.status(503).json({ error: 'file-read-failed' });
    return;
  }

  if (first.kind === 'unavailable') {
    // No file area for this agent anywhere in this deployment. Decided before
    // any path was looked at, so it says nothing about which paths exist.
    res.status(503).json({ error: 'user-files-unavailable' });
    return;
  }
  if (first.kind === 'absent') {
    // One answer for "never written", "since deleted" and "a link that would
    // have led somewhere else": the area is one export for every tenant.
    res.status(404).json({ error: 'file-not-found' });
    return;
  }
  if (first.kind === 'dir') {
    // A download is only ever offered on a file, so a folder arriving here
    // is a malformed request, not a listing request.
    res.status(400).json({ error: 'not-a-file' });
    return;
  }
  if (!isCheckable(first)) {
    // Every later range is held to this answer's version and size. Without
    // them those checks would compare nothing with nothing and pass, and a
    // changed file would go out as a whole one.
    ctx.logger.warn(READ_FAILED, { agentId, code: 'invalid-answer' });
    res.status(503).json({ error: 'file-read-failed' });
    return;
  }
  if (first.size > USER_FILE_DOWNLOAD_MAX_BYTES) {
    res.status(413).json({ error: 'file-too-large' });
    return;
  }

  res.status(200);
  // Stated, not defaulted. `bodyStream()` would fall back to the same value,
  // but a route that serves somebody else's bytes should say what it is
  // serving them as rather than inherit it.
  res.header('content-type', DOWNLOAD_CONTENT_TYPE);
  res.header(
    'content-disposition',
    `attachment; filename="${sanitizeContentDispositionFilename(downloadName)}"`,
  );
  res.header('x-content-type-options', 'nosniff');
  // Somebody's file: no shared cache keeps a copy, and no browser cache hands
  // back a version the file has since moved on from.
  res.header('cache-control', 'private, no-store');
  // No `content-length` here: `bodyStream()` sends `contentLength` as it,
  // because the framing on the wire and its byte count must be one number.

  try {
    await res.bodyStream(wholeFile(range, first), { contentLength: first.size });
  } catch (err) {
    const outcome = incompleteOutcome(err);
    // 'other' is a failure nobody planned for; the rest are what a download
    // in the real world runs into.
    if (outcome.reason === 'other') ctx.logger.warn(INCOMPLETE, { agentId, ...outcome });
    else ctx.logger.info(INCOMPLETE, { agentId, ...outcome });
  }
}

/**
 * The body, as `bodyStream()` pulls it: the first answer's bytes, then one
 * range per pull, then the validating call. Lazy on purpose: a range is read
 * only when the socket has room for it, and a client that leaves stops the
 * reads (`bodyStream()` `return()`s this generator).
 */
async function* wholeFile(
  range: (offset: number, length: number) => Promise<ReadUserFileRangeOutput>,
  first: FileAnswer,
): AsyncGenerator<Uint8Array, void, undefined> {
  let offset = 0;
  let answer: ReadUserFileRangeOutput = first;
  for (;;) {
    const bytes = sameFile(answer, first, offset, USER_FILE_DOWNLOAD_CHUNK_BYTES);
    if (bytes.byteLength > 0) yield bytes;
    // Every chunk is exactly `min(chunk, size - offset)` bytes, so this always
    // moves on while there is any of the file left.
    offset += bytes.byteLength;
    if (offset >= first.size) break;
    answer = await range(offset, USER_FILE_DOWNLOAD_CHUNK_BYTES);
  }
  // The last word: did the file change while its last range was being read?
  // No later chunk would notice, so this call is the one that does.
  sameFile(await range(first.size, 0), first, first.size, 0);
}

/**
 * `answer`'s bytes, if it is still the file `first` described and as many
 * bytes as `{offset, length}` should give. Otherwise the file changed under
 * the download (it was rewritten, replaced, grown, shrunk or deleted), and
 * this throws.
 */
function sameFile(
  answer: ReadUserFileRangeOutput,
  first: FileAnswer,
  offset: number,
  length: number,
): Uint8Array {
  if (
    answer.kind !== 'file' ||
    answer.version !== first.version ||
    answer.size !== first.size ||
    !(answer.bytes instanceof Uint8Array) ||
    answer.bytes.byteLength !== Math.min(length, Math.max(0, first.size - offset))
  ) {
    throw new FileChangedError();
  }
  return answer.bytes;
}

/** Is this an answer the later ranges can be held to? */
function isCheckable(answer: ReadUserFileRangeOutput): answer is FileAnswer {
  return (
    answer.kind === 'file' &&
    Number.isSafeInteger(answer.size) &&
    answer.size >= 0 &&
    typeof answer.version === 'string' &&
    answer.version.length > 0 &&
    answer.bytes instanceof Uint8Array
  );
}

/** The file is not the one the download started on. Only this module throws or reads it. */
class FileChangedError extends Error {
  constructor() {
    super('the file changed while it was being downloaded');
    this.name = 'FileChangedError';
  }
}

type IncompleteReason = 'client-gone' | 'changed' | 'read-failed' | 'length-mismatch' | 'other';

/** Why a started body did not finish, as log fields: a reason, plus codes. */
function incompleteOutcome(err: unknown): {
  reason: IncompleteReason;
  code?: string;
  causeCode?: string;
} {
  const code = codeOf(err);
  if (code === 'client-gone' || code === 'length-mismatch') return { reason: code };
  if (code === 'source-failed') {
    const cause = causeOf(err);
    if (cause instanceof FileChangedError) return { reason: 'changed' };
    // A range read that failed partway: the bus hands every one over as a
    // PluginError (a plain throw wrapped as `unknown`, its own `timeout`).
    if (cause instanceof PluginError) return { reason: 'read-failed', ...errorCodes(cause) };
  }
  // Anything else: one of Node's own errors, or a failure this module did not
  // plan for. Said by its code, so it can be found.
  return { reason: 'other', ...(code !== undefined ? { code } : {}) };
}

/** An error's `code` and its cause's, for a log line. Codes only. */
function errorCodes(err: unknown): { code?: string; causeCode?: string } {
  const code = codeOf(err);
  const causeCode = codeOf(causeOf(err));
  return {
    ...(code !== undefined ? { code } : {}),
    ...(causeCode !== undefined ? { causeCode } : {}),
  };
}

/**
 * What a code looks like: `EACCES`, `ERR_INVALID_CHAR`, `unknown`,
 * `user-files-download-unavailable`. A `code` that is anything else (a code is
 * just a string on an error) is left out of the log rather than trusted to be
 * free of a path.
 */
const CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && CODE_SHAPE.test(code) ? code : undefined;
}

function causeOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { cause?: unknown }).cause : undefined;
}
