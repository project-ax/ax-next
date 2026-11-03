/**
 * Handing a person one of an agent's files, WHOLE (TASK-1014).
 *
 * The bytes half of a download. Both download routes use it: the Files tab's
 * and the chat file chips' (TASK-1012). It does NOT decide who may read what:
 * its caller has already authenticated the person, resolved the agent through
 * its ACL and validated the path. It decides only how the bytes travel, and
 * that nobody is handed a torn file that looks whole.
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
 * a change made during the last read.
 *
 * What a difference does depends on whether the head has gone out. Before
 * it, the difference is a refusal with its own status: a short first range,
 * or a one-range file whose final check differs, is a 409 `file-changed` (a
 * 404 if the file is gone), said in words to a probe and with its words torn
 * to a real download (see below). A file that fits in one range has nothing
 * left to read after its first, so its final check runs before the head for
 * exactly this.
 * Once the head is out, a difference throws, and a throw tears the
 * connection down instead of ending it. `bodyStream()` holds the chunk that
 * completes the body until the final check has answered, so the last change
 * is caught too. The person's browser then holds fewer bytes than
 * Content-Length promised, and calls it a failed download, which is the
 * truth.
 *
 * WHAT THE STATUS CODES MEAN. Each is decided before the first byte, while we
 * can still say no. A probe hears the no in words. A real download gets the
 * same status with its words torn (TASK-1025): the browser's own download
 * receives it, not our page, and Safari saves a whole refusal as the file.
 * This module answers `status().json()` either way; the routes hand a real
 * download a response whose `json()` tears (`sendTornRefusal`). The reads that
 * can still say no are the first range and, for a file that fits in one
 * range, its final check:
 *
 *   - no range service              → 503 user-files-unavailable
 *   - no host mount (a thrown read) → 503 user-files-unavailable, logged
 *   - any other thrown read         → 503 file-read-failed, logged by its codes
 *   - an answer it cannot check     → 503 file-read-failed, logged
 *   - unavailable                   → 503 user-files-unavailable
 *   - absent                        → 404 file-not-found
 *   - a folder                      → 400 not-a-file
 *   - over the ceiling              → 413 file-too-large, nothing more read
 *   - changed before the head       → 409 file-changed
 *   - a file                        → 200, streamed
 *
 * A probe (`probe: true`, TASK-1022) gets the same answers up to the first
 * byte, then 200 { downloadable: true } instead of the bytes.
 *
 * None of those answers carries a download header. They are all made before
 * the first download `header()`, so the agent-authored filename and the
 * octet-stream type never land on an error. (A probe's `no-store`, set first,
 * is the one header a refusal can carry.)
 *
 * After the head has gone out there is nothing left to answer, so a failure
 * is logged (`workspace_user_file_download_incomplete`) and never rethrown.
 *
 * LOGS carry the agent id, a reason and error CODES. Never the path, the
 * filename, a byte, or an error's message: a message from `fs` quotes the
 * path, and the path is somebody's file name.
 *
 * A FILE'S STATUS (TASK-1017) lives here too, in `sendUserFileStatus`: the
 * same range read, asked for no bytes at all, so a chat file chip can say
 * "No longer available" before anyone clicks it.
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
 * It bounds how long one download can keep a range reader busy. The browser
 * saves a download to disk itself (TASK-1022), so no tab has to hold it.
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
 * with an Error whose `code` says why ('client-gone', 'client-stalled' when it
 * cut off a client that stopped reading, 'source-failed' with the source's
 * error as `cause`, 'length-mismatch', or one of Node's own) after tearing
 * the connection down, so a short body never reads as a whole one. It tears
 * down even a body that failed before its head, so whatever should be
 * answered in words is checked before it is called.
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
  /**
   * Ask, don't send (TASK-1022). Every read and check a download makes before
   * its head runs exactly as it would, and every refusal is the download's
   * own. Where the download would send its head, this answers
   * `200 { downloadable: true }` instead: none of the download's headers, and
   * `bodyStream()` is never called.
   *
   * It exists because the client hands the download itself to the browser,
   * which saves it straight to disk, and the browser's download bar can say
   * none of these answers: a 404, a 409 or a 413 there is just a failed
   * download. So the client asks first, and says a refusal in the page, in
   * words.
   */
  probe?: boolean;
  res: StreamingDownloadResponse;
}

type FileAnswer = Extract<ReadUserFileRangeOutput, { kind: 'file' }>;

/**
 * Send one file, whole, as a download. With `probe`, say whether it would,
 * and send none of it (TASK-1022).
 *
 * The caller has ALREADY authenticated the person, ACL-resolved the agent, and
 * validated `relPath`. Never rejects: every outcome is either a response or,
 * once the body has started, a log line.
 */
export async function sendUserFileDownload(args: SendUserFileDownloadArgs): Promise<void> {
  const { bus, ctx, owner, relPath, downloadName, probe, res } = args;
  const agentId = owner.agentId;
  // Every probe answer is no-store, its refusals included: an answer about
  // this moment must never come back from a cache, whoever the caller is.
  // (The routes set it too, before their ACL, for the answers made there.)
  if (probe === true) res.header('cache-control', 'private, no-store');

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

  // Everything up to `res.status(200)` can still be refused: in words to a
  // probe, and with the same status, its words torn, to a real download
  // (TASK-1025). So no download header is set before it (a probe's no-store is
  // the exception). A refusal carries none of the download's headers.
  const beforeHead: BeforeHead = { ctx, agentId, res };

  const first = await fileBeforeHead(range(0, USER_FILE_DOWNLOAD_CHUNK_BYTES), beforeHead);
  if (first === undefined) return;
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
  if (first.bytes.byteLength !== Math.min(USER_FILE_DOWNLOAD_CHUNK_BYTES, first.size)) {
    // Not the bytes its own size promised: the file changed between the
    // provider's look at it and its read. Busy, not broken, so the person is
    // told to try again rather than that the read failed.
    res.status(409).json({ error: 'file-changed' });
    return;
  }

  // A file that fits in one range has nothing left to read but its final
  // check, so that runs now, while a change it finds can still be answered.
  const oneRange = first.size <= USER_FILE_DOWNLOAD_CHUNK_BYTES;
  if (oneRange) {
    const last = await fileBeforeHead(range(first.size, 0), beforeHead);
    if (last === undefined) return;
    if (!isSameFile(last, first, first.size, 0)) {
      res.status(409).json({ error: 'file-changed' });
      return;
    }
  }

  if (probe === true) {
    // Every check a download makes before its head has passed, so a download
    // would start here. A probe says so and stops: no download header, no body.
    res.status(200).json({ downloadable: true });
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

  // A one-range file's bytes are in hand and already checked. A longer file
  // is read range by range, and a change found from here on tears it down.
  const body = oneRange ? bytesInHand(first.bytes) : wholeFile(range, first);
  try {
    await res.bodyStream(body, { contentLength: first.size });
  } catch (err) {
    const outcome = incompleteOutcome(err);
    // A storage failure, a length bug, or a failure nobody planned for
    // ('other') is worth a warning. A client that left, a client we cut off
    // for not reading, and a file changing under the download are what a
    // download in the real world runs into: ordinary life.
    if (
      outcome.reason === 'client-gone' ||
      outcome.reason === 'client-stalled' ||
      outcome.reason === 'changed'
    ) {
      ctx.logger.info(INCOMPLETE, { agentId, ...outcome });
    } else ctx.logger.warn(INCOMPLETE, { agentId, ...outcome });
  }
}

/** What a read made before the head needs, to answer for itself. */
interface BeforeHead {
  ctx: AgentContext;
  agentId: string;
  res: Pick<StreamingDownloadResponse, 'status' | 'json'>;
}

/**
 * One read made before the head: the first range, or a one-range file's
 * final check. Anything but a file is answered here, the same way for both,
 * and this returns undefined. A file comes back for the caller to check.
 */
async function fileBeforeHead(
  read: Promise<ReadUserFileRangeOutput>,
  { ctx, agentId, res }: BeforeHead,
): Promise<FileAnswer | undefined> {
  let answer: ReadUserFileRangeOutput;
  try {
    answer = await read;
  } catch (err) {
    // EVERY thrown read, whatever its code. The bus wraps a plain throw (EACCES,
    // EIO) as `unknown`; a provider's own codes (no host mount, the pod
    // reader's failure) and the bus's `timeout` arrive as themselves. Each is
    // a read that did not happen, which is neither a missing file (404) nor a
    // crash (500).
    ctx.logger.warn(READ_FAILED, { agentId, ...errorCodes(err) });
    // A deployment with no host read mount can never serve a download: say
    // that (the same answer as "no file area"), not "a read failed, retry".
    const deploymentFact = codeOf(err) === 'user-files-download-unavailable';
    res.status(503).json({ error: deploymentFact ? 'user-files-unavailable' : 'file-read-failed' });
    return undefined;
  }

  if (typeof answer !== 'object' || answer === null) {
    // A provider bug, not a 500: the same answer as any other unusable reply.
    ctx.logger.warn(READ_FAILED, { agentId, code: 'invalid-answer' });
    res.status(503).json({ error: 'file-read-failed' });
    return undefined;
  }
  if (answer.kind === 'file') return answer;
  if (answer.kind === 'unavailable') {
    // No file area for this agent anywhere in this deployment. Decided before
    // any path was looked at, so it says nothing about which paths exist.
    res.status(503).json({ error: 'user-files-unavailable' });
  } else if (answer.kind === 'absent') {
    // One answer for "never written", "since deleted" and "a link that would
    // have led somewhere else": the area is one export for every tenant.
    res.status(404).json({ error: 'file-not-found' });
  } else if (answer.kind === 'dir') {
    // A download is only ever offered on a file, so a folder arriving here
    // is a malformed request, not a listing request.
    res.status(400).json({ error: 'not-a-file' });
  } else {
    // A kind this module does not know: a provider bug, answered as one.
    ctx.logger.warn(READ_FAILED, { agentId, code: 'invalid-answer' });
    res.status(503).json({ error: 'file-read-failed' });
  }
  return undefined;
}

export interface SendUserFileStatusArgs {
  bus: HookBus;
  /** The AGENT's ctx, as for a download: the provider reads under it, and the logs go to it. */
  ctx: AgentContext;
  /** The session owner the provider keys the agent's mount on. */
  owner: ReadUserFileRangeInput['owner'];
  /** Already validated by the caller (`workspaceFilePath`). */
  relPath: string;
  /** A status is JSON and one header. Nothing here ever streams a body. */
  res: Pick<StreamingDownloadResponse, 'status' | 'header' | 'json'>;
}

/**
 * Say whether one file is still there, without reading a byte of it
 * (TASK-1017).
 *
 * A chat file chip asks when it mounts and again after each turn, so a file
 * the agent has since deleted reads "No longer available" before anyone
 * clicks. It is ONE `sandbox:read-user-file-range` call with `length: 0`: the
 * provider confines and walks the path exactly as for a download (no link
 * followed at any depth), fstats the file and reads none of it. On k8s that
 * call is the host mount's or nothing, so it starts no pod: without the mount
 * it throws `user-files-download-unavailable` and creates nothing.
 *
 * The answers are the download's, minus the body and the ceiling, and none
 * of them is cached (`private, no-store`):
 *
 *   - a file                       → 200 { available: true }
 *   - absent                       → 404 file-not-found
 *   - a folder                     → 400 not-a-file
 *   - unavailable, no range service,
 *     or no host mount             → 503 user-files-unavailable
 *   - any other throw, or an
 *     answer it cannot read        → 503 file-read-failed, logged by its codes
 *
 * No 413: a status says whether the file is there, not whether it is small
 * enough to download whole. A click on the chip still says that.
 *
 * What it LOGS differs from a download on purpose. A deployment with no file
 * area, no range service or no host mount is not logged at all: every chip
 * asks after every turn, so a warning per ask would repeat a fact about the
 * deployment, not report a read that failed. A read that did fail is logged
 * the way a download logs it, by its codes only.
 *
 * The caller has ALREADY authenticated the person, ACL-resolved the agent and
 * validated `relPath`. Never rejects.
 */
export async function sendUserFileStatus(args: SendUserFileStatusArgs): Promise<void> {
  const { bus, ctx, owner, relPath, res } = args;
  // Every answer is about this moment only: no cache may hand back a "there"
  // once the file is gone, nor a "gone" or "could not tell" once it is back.
  res.header('cache-control', 'private, no-store');

  if (!bus.hasService('sandbox:read-user-file-range')) {
    res.status(503).json({ error: 'user-files-unavailable' });
    return;
  }

  let answer: ReadUserFileRangeOutput;
  try {
    answer = await bus.call<ReadUserFileRangeInput, ReadUserFileRangeOutput>(
      'sandbox:read-user-file-range',
      ctx,
      // `length: 0` answers `size` and `version` without reading: only the
      // file's kind is wanted here.
      { owner, relPath, offset: 0, length: 0 },
    );
  } catch (err) {
    if (codeOf(err) === 'user-files-download-unavailable') {
      res.status(503).json({ error: 'user-files-unavailable' });
      return;
    }
    ctx.logger.warn(READ_FAILED, { agentId: owner.agentId, ...errorCodes(err) });
    res.status(503).json({ error: 'file-read-failed' });
    return;
  }

  const kind: unknown = typeof answer === 'object' && answer !== null ? answer.kind : undefined;
  switch (kind) {
    case 'file':
      res.status(200).json({ available: true });
      return;
    case 'absent':
      // "Never written", "since deleted" and "a link" are one answer, as for
      // a download.
      res.status(404).json({ error: 'file-not-found' });
      return;
    case 'dir':
      res.status(400).json({ error: 'not-a-file' });
      return;
    case 'unavailable':
      res.status(503).json({ error: 'user-files-unavailable' });
      return;
    default:
      // A provider bug. "We could not tell" is never "it is gone".
      ctx.logger.warn(READ_FAILED, { agentId: owner.agentId, code: 'invalid-answer' });
      res.status(503).json({ error: 'file-read-failed' });
  }
}

/**
 * Refuse a REAL download TORN (TASK-1025): `status` and a JSON content type,
 * a Content-Length for the whole of `body`'s JSON, all of that JSON except
 * its last byte, and then a cut connection.
 *
 * WHY. A real download is the browser's own (an `<a download>`, TASK-1022),
 * so its refusal reaches that download, never our page. Chromium and Firefox
 * fail a download that is not a 2xx, but Safari saves a WHOLE refusal as the
 * file (`<name>.pdf.json`). A body cut short of its Content-Length is a
 * failed download in every engine walked (macOS Safari 26.5, direct and
 * through `kubectl port-forward`; Playwright Chromium 147 and Firefox 148,
 * direct; iOS Safari was not walked), and a streaming proxy should pass it on
 * as one (reasoned from GCLB's documentation, not measured). A connection cut
 * before the head is no substitute: a proxy answers that with an error page
 * of its own (also reasoned), and Safari would save that page. The page has
 * already said the refusal in words, from the probe.
 *
 * HOW. Through `bodyStream()`'s documented failure path: a source that fails
 * after its first chunk leaves the head and that chunk on the wire, and the
 * connection is torn down. `body` is a refusal's `{ error }`, so its JSON is
 * never under 12 bytes and that first chunk is never empty.
 *
 * `bodyStream()` always rejects here, by design. Resolves once the connection
 * is cut: with `null` when it was cut the way it is meant to be (our own
 * source's failure), and otherwise with the failure's codes (a client that
 * left first, a write error), so the caller can say the refusal did not go
 * out as planned. Never rejects.
 */
export async function sendTornRefusal(
  res: Pick<StreamingDownloadResponse, 'status' | 'header' | 'bodyStream'>,
  status: number,
  body: unknown,
): Promise<{ code?: string; causeCode?: string } | null> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    res.status(status);
    res.header('content-type', 'application/json; charset=utf-8');
    await res.bodyStream(allButTheLastByte(bytes), { contentLength: bytes.byteLength });
  } catch (err) {
    // The planned cut: our source failed on purpose, after the head and all
    // but the last byte.
    if (codeOf(err) === 'source-failed' && causeOf(err) instanceof TornRefusal) return null;
    const codes = errorCodes(err);
    // A failure with no code of its own (a plain Error) is still said, never
    // reported as an empty reason.
    return codes.code === undefined && codes.causeCode === undefined ? { code: 'uncoded' } : codes;
  }
  // Unreachable while the source always fails; said rather than assumed.
  return { code: 'not-torn' };
}

/** The failure a torn refusal's source ends with: the planned cut. */
class TornRefusal extends Error {}

/** A torn refusal's body: all of `bytes` but the last one, then a failure. */
async function* allButTheLastByte(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes.subarray(0, bytes.byteLength - 1);
  // Node sends a response's first write on the NEXT tick. A connection cut in
  // the same microtask drain sends nothing at all: no status, which a proxy in
  // front of us answers with an error page of its own (and Safari saves THAT).
  // One turn of the event loop lets the head and these bytes go first.
  await new Promise<void>((resolve) => setImmediate(resolve));
  throw new TornRefusal('download refused');
}

/**
 * The body of a file of one range: the bytes in hand. They passed the final
 * check before the head went out, so there is nothing left to read.
 */
async function* bytesInHand(bytes: Uint8Array): AsyncGenerator<Uint8Array, void, undefined> {
  if (bytes.byteLength > 0) yield bytes;
}

/**
 * The body of a file of more than one range, as `bodyStream()` pulls it: the
 * first answer's bytes, then one range per pull, then the validating call.
 * Lazy on purpose: a range is read only when the socket has room for it, and
 * a client that leaves stops the reads (`bodyStream()` `return()`s this
 * generator).
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
 * Is `answer` still the file `first` described, with as many bytes as
 * `{offset, length}` should give? When it is not, the file changed under the
 * download: it was rewritten, replaced, grown, shrunk or deleted.
 */
function isSameFile(
  answer: ReadUserFileRangeOutput,
  first: FileAnswer,
  offset: number,
  length: number,
): answer is FileAnswer {
  return (
    answer.kind === 'file' &&
    answer.version === first.version &&
    answer.size === first.size &&
    answer.bytes instanceof Uint8Array &&
    answer.bytes.byteLength === Math.min(length, Math.max(0, first.size - offset))
  );
}

/** `answer`'s bytes when {@link isSameFile}. Otherwise this throws, which tears the body down. */
function sameFile(
  answer: ReadUserFileRangeOutput,
  first: FileAnswer,
  offset: number,
  length: number,
): Uint8Array {
  if (!isSameFile(answer, first, offset, length)) throw new FileChangedError();
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

type IncompleteReason =
  | 'client-gone'
  | 'client-stalled'
  | 'changed'
  | 'read-failed'
  | 'length-mismatch'
  | 'other';

/** Why a started body did not finish, as log fields: a reason, plus codes. */
function incompleteOutcome(err: unknown): {
  reason: IncompleteReason;
  code?: string;
  causeCode?: string;
} {
  const code = codeOf(err);
  // `client-stalled` is `bodyStream()` cutting off a client that stopped
  // reading. It reads the code as a string: invariant 2, no import of the
  // http-server's own type.
  if (code === 'client-gone' || code === 'client-stalled' || code === 'length-mismatch') {
    return { reason: code };
  }
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
export function errorCodes(err: unknown): { code?: string; causeCode?: string } {
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
