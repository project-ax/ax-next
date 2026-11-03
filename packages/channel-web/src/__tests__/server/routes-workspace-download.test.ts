// @vitest-environment node
/**
 * The DOWNLOAD route (TASK-355; the git-backed `/download/files/*` sibling was
 * removed in TASK-995; streamed whole since TASK-1014).
 *
 * The Files tab could always show you a file and never hand it to you: the
 * read route answers with TEXT, so a PDF an agent made rendered as the word
 * "binary" and a long file rendered as its first 128 KiB. This route is the
 * bytes, all of them, read one range at a time through
 * `sandbox:read-user-file-range` (`server/user-file-download.ts`).
 *
 * It serves caller-named paths out of a store written entirely by an
 * untrusted agent, which puts most of this file on the security half rather
 * than the happy path. The things it is really pinning:
 *
 *   1. THE ORDER. authenticate → ACL → validate path → read. Every
 *      step is asserted separately, and the 2-before-3 pair has its own test,
 *      because swapping them turns the error code into an oracle over another
 *      tenant's paths.
 *   2. THE BYTES ARE THE BYTES. Every range must come from the same, unchanged
 *      file (same version, same size, full length), checked once more after
 *      the last one. A file that changed under the download is never handed
 *      over as a complete one: a torn file that looks whole is worse than a
 *      refusal, because the person finds out when they open it.
 *   3. THE HEADERS ARE OURS. Content-Type is a constant, never sniffed and
 *      never caller-supplied; the filename is sanitized before it reaches a
 *      header a newline can end; nothing is cached.
 *   4. A FAILED READ IS A 503. The real HookBus wraps a plain throw (EACCES,
 *      EIO) as `PluginError{code:'unknown'}`, so the thrown-read tests throw
 *      through a real bus rather than a fake.
 *   5. A REAL DOWNLOAD'S REFUSAL IS TORN (TASK-1025). The browser's own
 *      download receives it, and Safari saves a whole refusal as the file. So
 *      every refusal of a real GET, the ACL's included, goes out as its status
 *      head and a JSON body cut a byte short (`expectTorn`), and a probe gets
 *      the same refusal whole, in words.
 *
 * The direct-handler part calls the handlers directly, with a response fake
 * whose `bodyStream` mirrors `@ax/http-server`'s contract. The socket part
 * goes over a real socket, because the splat (`req.params['*']`) only exists
 * for a route declared with a bare trailing `*`, and because backpressure, an
 * abort and a torn body only exist on a wire.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import type {
  ReadUserFileRangeInput,
  ReadUserFileRangeOutput,
  UserFileVersion,
} from '@ax/sandbox-mount-protocol';
import {
  FILE_BODY_MAX_BYTES,
  makeWorkspaceHandlers,
  registerWorkspaceRoutes,
  type DownloadRouteResponse,
} from '../../server/routes-workspace.js';
import {
  USER_FILE_DOWNLOAD_CHUNK_BYTES,
  USER_FILE_DOWNLOAD_MAX_BYTES,
  sendTornRefusal,
  sendUserFileDownload,
  type StreamingDownloadResponse,
} from '../../server/user-file-download.js';
import type { RouteRequest } from '../../server/routes-chat.js';

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

const enc = new TextEncoder();
const MiB = 1024 * 1024;
/** A shared megabyte of zeros, for files too big to hold in a test. */
const ONE_MIB = new Uint8Array(MiB);
const RANGE_HOOK = 'sandbox:read-user-file-range';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const v = (s: string): UserFileVersion => s as UserFileVersion;

function mkReq(params: Record<string, string> = {}, query: Record<string, string> = {}): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query,
    params,
    signedCookie: () => null,
  };
}

/** What `bodyStream` rejects with: an Error with a `code` (and a `cause`). */
function bodyStreamError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code });
}

interface CapturedDownload {
  statusCode: number;
  json: unknown;
  headers: Record<string, string>;
  /** `bodyStream`'s `contentLength`, or null when no body was ever started. */
  contentLength: number | null;
  /** Every chunk the source handed over, in order (views, not copies). */
  chunks: Uint8Array[];
  /** The source finished, and its chunks added up to `contentLength`. */
  complete: boolean;
  /** What `bodyStream` rejected with, when it did. */
  failure: unknown;
}

/**
 * The response adapter a download needs. `bodyStream` mirrors
 * `@ax/http-server`'s contract closely enough for the route to be tested
 * against it: it pulls the source to the end, rejects `source-failed` (with
 * the source's error as the cause) or `length-mismatch`, and `return()`s the
 * source on any failure. Header names are lowercased, as the real server does.
 *
 * `clientLeavesAfter` plays a client that goes away after that many chunks;
 * `failWith` plays a failure of the adapter's own (a Node error, say).
 */
function mkRes(opts: { clientLeavesAfter?: number; failWith?: Error } = {}): {
  res: DownloadRouteResponse;
  captured: CapturedDownload;
  body: () => Buffer;
} {
  const captured: CapturedDownload = {
    statusCode: 0,
    json: undefined,
    headers: {},
    contentLength: null,
    chunks: [],
    complete: false,
    failure: undefined,
  };
  const res: DownloadRouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    header(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return res;
    },
    json(value: unknown) {
      captured.json = value;
    },
    text() {
      /* unused */
    },
    end() {
      /* unused */
    },
    async bodyStream(source, { contentLength }) {
      captured.contentLength = contentLength;
      const it = source[Symbol.asyncIterator]();
      let total = 0;
      try {
        if (opts.failWith !== undefined) throw opts.failWith;
        for (;;) {
          if (
            opts.clientLeavesAfter !== undefined &&
            captured.chunks.length >= opts.clientLeavesAfter
          ) {
            throw bodyStreamError('client-gone');
          }
          let step: IteratorResult<Uint8Array>;
          try {
            step = await it.next();
          } catch (cause) {
            throw bodyStreamError('source-failed', cause);
          }
          if (step.done === true) break;
          total += step.value.byteLength;
          if (total > contentLength) throw bodyStreamError('length-mismatch');
          captured.chunks.push(step.value);
        }
        if (total !== contentLength) throw bodyStreamError('length-mismatch');
        captured.complete = true;
      } catch (err) {
        captured.failure = err;
        try {
          await it.return?.();
        } catch {
          // As the real adapter: the source's own cleanup does not change why.
        }
        throw err;
      }
    },
  };
  return { res, captured, body: () => Buffer.concat(captured.chunks) };
}

/**
 * A REAL download's refusal, as the fake saw it (TASK-1025). The browser's
 * own download receives it, not our page, and Safari saves a whole refusal as
 * the file. So it goes out torn: the refusal's status and a JSON type, a
 * Content-Length for the whole `{error}` JSON, all of that JSON but its last
 * byte, and then a body that fails. Never `json()`, and the JSON type is the
 * only header: no download header (the agent-authored filename,
 * octet-stream) ever lands on a refusal.
 */
function expectTorn(d: ReturnType<typeof mkRes>, status: number, error: string): void {
  const whole = JSON.stringify({ error });
  expect(d.captured.statusCode).toBe(status);
  expect(d.captured.json).toBeUndefined();
  expect(d.captured.headers).toEqual({ 'content-type': 'application/json; charset=utf-8' });
  expect(d.captured.contentLength).toBe(Buffer.byteLength(whole));
  expect(d.body().toString('utf-8')).toBe(whole.slice(0, -1));
  expect(d.captured.complete).toBe(false);
}

/** One log line, as the route wrote it on the ctx it read with. */
interface LogLine {
  level: 'warn' | 'info';
  msg: string;
  bindings: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// The direct-handler part.
// ---------------------------------------------------------------------------
describe('the download route', () => {
  let bus: HookBus;

  /** A file the fake range service holds. */
  interface FakeFile {
    bytes: Uint8Array;
    version: string;
    /** A pretend size, for a file too big to hold here; reads come from `read`. */
    size?: number;
    read?: (offset: number, n: number) => Uint8Array;
  }
  /** relPath → file. */
  let files: Map<string, FakeFile>;
  /** relPaths that are folders. */
  let dirs: Set<string>;
  let rangeCalls: Array<{
    agentId: string;
    userId: string;
    ownerAgentId: string;
    relPath: string;
    offset: number;
    length: number;
  }>;
  /** Lets one test change what the nth call (1-based) answers. */
  let tamper:
    | ((
        n: number,
        input: ReadUserFileRangeInput,
        honest: ReadUserFileRangeOutput,
      ) => ReadUserFileRangeOutput)
    | undefined;
  let logs: LogLine[];
  let watched: WeakSet<object>;

  /**
   * Record what the route logs on the ctx it reads with. The route makes that
   * ctx itself (the agent's, never the plugin's), so the reader is the one
   * place a test can reach it: it is handed exactly that object.
   */
  function watchLogger(ctx: AgentContext): void {
    if (watched.has(ctx.logger)) return;
    watched.add(ctx.logger);
    for (const level of ['warn', 'info'] as const) {
      vi.spyOn(ctx.logger, level).mockImplementation((msg, bindings) => {
        logs.push({ level, msg, bindings });
      });
    }
  }

  function registerAuth(user: { id: string; isAdmin: boolean } | null): void {
    bus.registerService('auth:require-user', 'auth', async () => {
      if (user === null) {
        throw new PluginError({
          code: 'unauthenticated',
          plugin: 'auth',
          message: 'no session',
        });
      }
      return { user };
    });
  }

  function registerAgents(): void {
    bus.registerService('agents:resolve', 'agents', async (_c, i: unknown) => {
      const { agentId } = i as { agentId: string };
      if (agentId !== 'a1') {
        throw new PluginError({
          code: 'not-found',
          plugin: 'agents',
          message: 'nope',
        });
      }
      return { agent: { id: 'a1', displayName: 'Inbox' } };
    });
  }

  /** What an honest provider answers for `input`, from `files` and `dirs`. */
  function honestAnswer(input: ReadUserFileRangeInput): ReadUserFileRangeOutput {
    if (dirs.has(input.relPath)) return { kind: 'dir' };
    const f = files.get(input.relPath);
    if (f === undefined) return { kind: 'absent' };
    const size = f.size ?? f.bytes.byteLength;
    const n = Math.min(input.length, Math.max(0, size - input.offset));
    return {
      kind: 'file',
      size,
      version: v(f.version),
      bytes:
        f.read !== undefined
          ? f.read(input.offset, n)
          : f.bytes.subarray(input.offset, input.offset + n),
    };
  }

  /** A stand-in for whichever sandbox provider is loaded. */
  function registerRange(): void {
    bus.registerService<ReadUserFileRangeInput, ReadUserFileRangeOutput>(
      RANGE_HOOK,
      'sandbox',
      async (ctx, input) => {
        watchLogger(ctx);
        rangeCalls.push({
          agentId: ctx.agentId,
          userId: ctx.userId ?? '',
          ownerAgentId: input.owner.agentId,
          relPath: input.relPath,
          offset: input.offset,
          length: input.length,
        });
        const honest = honestAnswer(input);
        return tamper === undefined ? honest : tamper(rangeCalls.length, input, honest);
      },
    );
  }

  /** A range service whose every call throws `err` (after noting the ctx). */
  function registerThrowingRange(err: unknown): void {
    bus.registerService(RANGE_HOOK, 'sandbox', async (ctx) => {
      watchLogger(ctx);
      rangeCalls.push({
        agentId: ctx.agentId,
        userId: ctx.userId ?? '',
        ownerAgentId: '',
        relPath: '',
        offset: -1,
        length: -1,
      });
      throw err;
    });
  }

  function handlers() {
    return makeWorkspaceHandlers({ bus, initCtx });
  }

  /** The usual set-up: signed in as u1, agent a1 visible, the range reader up. */
  function standardBus(): void {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerRange();
  }

  async function download(splat: string, d = mkRes()): Promise<ReturnType<typeof mkRes>> {
    await handlers().agentUserFileDownload(mkReq({ agentId: 'a1', '*': splat }), d.res);
    return d;
  }

  /** The same request asked with `?probe=1` (TASK-1022). */
  async function probeDownload(splat: string, d = mkRes()): Promise<ReturnType<typeof mkRes>> {
    await handlers().agentUserFileDownload(mkReq({ agentId: 'a1', '*': splat }, { probe: '1' }), d.res);
    return d;
  }

  beforeEach(() => {
    bus = new HookBus();
    files = new Map();
    dirs = new Set();
    rangeCalls = [];
    tamper = undefined;
    logs = [];
    watched = new WeakSet();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pins the chunk and the ceiling (TASK-1012 imports both)', () => {
    expect(USER_FILE_DOWNLOAD_CHUNK_BYTES).toBe(MiB);
    expect(USER_FILE_DOWNLOAD_MAX_BYTES).toBe(1024 * MiB);
  });

  // --- auth + ACL ---------------------------------------------------------

  it('401s the download without a session', async () => {
    registerAuth(null);
    const d = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'x.md' }),
      d.res,
    );
    expect(d.captured.statusCode).toBe(401);
  });

  it('404s a foreign agent without touching the files', async () => {
    standardBus();
    files.set('x.md', { bytes: enc.encode('secret'), version: 'v1' });

    const d = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'someone-elses', '*': 'x.md' }),
      d.res,
    );
    expect(d.captured.statusCode).toBe(404);
    expectTorn(d, 404, 'agent-not-found');

    // Not "it read and found nothing" — it never read at all.
    expect(rangeCalls).toEqual([]);
  });

  it('runs the ACL BEFORE path validation, so a bad path on a foreign agent still 404s', async () => {
    /*
      If the path were validated first, a caller probing somebody else's agent
      would get 400 for `../x` and 404 for `x.md` — and that difference tells
      them which of the other tenant's paths are well-formed. Both are 404.
    */
    standardBus();

    const d = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'someone-elses', '*': '..%2F..%2Fetc%2Fpasswd' }),
      d.res,
    );
    expect(d.captured.statusCode).toBe(404);
    expect(rangeCalls).toEqual([]);
  });

  // --- the path ------------------------------------------------------------

  const TRAVERSALS: Array<[string, string]> = [
    ['a literal ..', '../../etc/passwd'],
    ['a percent-encoded ..', '%2e%2e%2fsecret'],
    ['an absolute path', '%2Fetc%2Fpasswd'],
    ['a backslash separator', '..%5C..%5Cwindows'],
    ['a NUL byte', 'notes%00.md'],
  ];

  for (const [label, splat] of TRAVERSALS) {
    it(`400s ${label}, without reading`, async () => {
      standardBus();
      const d = await download(splat);
      const { captured } = d;
      expect(captured.statusCode).toBe(400);
      expectTorn(d, 400, 'invalid-path');
      expect(rangeCalls).toEqual([]);
    });
  }

  it('400s a request with no path at all, rather than reading the root', async () => {
    // `/download/user-files/` with nothing after it. `workspaceFilePath('')` is
    // `null`, so the route answers the same 400 a malformed path gets — there
    // is no "download everything" here.
    standardBus();

    const d = mkRes();
    await handlers().agentUserFileDownload(mkReq({ agentId: 'a1' }), d.res);
    expect(d.captured.statusCode).toBe(400);
    expect(rangeCalls).toEqual([]);
  });

  it('400s a request with no agent id', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    const d = mkRes();
    await handlers().agentUserFileDownload(mkReq({ '*': 'x.md' }), d.res);
    expect(d.captured.statusCode).toBe(400);
    expectTorn(d, 400, 'missing-agent-id');
  });

  it('does NOT double-decode: a doubly-encoded `..` stays a filename', async () => {
    /*
      `%252e%252e%252fsecret` decodes ONCE to `%2e%2e%2fsecret` — a string with
      no slash and no `..` in it, i.e. a (very odd) filename. The right answer
      is to look for a file by that literal name and not find it, NOT to reject
      it as a traversal and NOT to decode again. What is pinned here is the
      exact string the reader was asked for.
    */
    standardBus();
    const { captured } = await download('%252e%252e%252fsecret');
    expect(captured.statusCode).toBe(404);
    expect(rangeCalls.map((c) => c.relPath)).toEqual(['%2e%2e%2fsecret']);
  });

  it('hides nothing by name', async () => {
    // On the agent's own file area `memory/` is just a folder somebody named
    // `memory`, and `.ax/` and `.claude/` are plain names too. Hiding any of
    // them would be a lie about their own files.
    standardBus();
    files.set('memory/notes.md', { bytes: enc.encode('mine'), version: 'v1' });
    files.set('.ax/SOUL.md', { bytes: enc.encode('also mine'), version: 'v1' });
    const a = await download('memory%2Fnotes.md');
    expect(a.captured.statusCode).toBe(200);
    expect(a.body().toString('utf-8')).toBe('mine');
    const b = await download('.ax%2FSOUL.md');
    expect(b.captured.statusCode).toBe(200);
    expect(b.body().toString('utf-8')).toBe('also mine');
  });

  // --- no backend ----------------------------------------------------------

  it('503s when no sandbox provider can read a range, and never falls back to the capped preview read', async () => {
    /*
      `sandbox:read-user-files` is the PREVIEW read: a prefix of at most a
      megabyte. A download built on it was exactly the "first megabyte only"
      problem this route stopped having, so its presence must not turn into a
      quiet fallback.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    const previewReads: unknown[] = [];
    bus.registerService('sandbox:read-user-files', 'sandbox', async (_c, i: unknown) => {
      previewReads.push(i);
      return { kind: 'file', contents: enc.encode('the beginning'), truncated: false };
    });
    const d = await download('x.md');
    const { captured } = d;
    expect(captured.statusCode).toBe(503);
    expectTorn(d, 503, 'user-files-unavailable');
    expect(previewReads).toEqual([]);
  });

  // --- the bytes -----------------------------------------------------------

  it('serves a text file WHOLE, with the headers that make it a download', async () => {
    standardBus();
    files.set('notes/plan.md', { bytes: enc.encode('# Plan\n\nShip it.'), version: 'v1' });
    const d = await download('notes%2Fplan.md');
    expect(d.captured.statusCode).toBe(200);
    expect(d.body().toString('utf-8')).toBe('# Plan\n\nShip it.');
    expect(d.captured.complete).toBe(true);
    expect(d.captured.headers['content-disposition']).toBe('attachment; filename="plan.md"');
    expect(d.captured.headers['x-content-type-options']).toBe('nosniff');
    // Content-Length is `bodyStream`'s to send, from the size it is handed.
    expect(d.captured.contentLength).toBe(16);
  });

  it('sets cache-control private, no-store and the attachment headers, and nothing else', async () => {
    // A download is somebody's file: no shared cache keeps a copy, and no
    // browser cache serves it back after the file changed. Pinned as the
    // WHOLE set, so a header that sneaks in is a decision, not an accident.
    standardBus();
    files.set('plan.md', { bytes: enc.encode('x'), version: 'v1' });
    const d = await download('plan.md');
    expect(d.captured.headers).toEqual({
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="plan.md"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
  });

  it('serves a BINARY file byte for byte — the case the preview calls "binary"', async () => {
    standardBus();
    // A PNG header, NUL included. The read route answers `body: null,
    // clipped: 'binary'` for this — the reason this route exists.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x1a]);
    files.set('chart.png', { bytes: png, version: 'v1' });
    const d = await download('chart.png');
    expect(d.captured.statusCode).toBe(200);
    expect(Array.from(d.body())).toEqual(Array.from(png));
  });

  it('serves a file the PREVIEW would clip, whole', async () => {
    standardBus();
    files.set('log.txt', {
      bytes: enc.encode('x'.repeat(FILE_BODY_MAX_BYTES + 4096)),
      version: 'v1',
    });
    const d = await download('log.txt');
    expect(d.captured.statusCode).toBe(200);
    expect(d.body().byteLength).toBe(FILE_BODY_MAX_BYTES + 4096);
  });

  it('serves a file bigger than the old 1 MiB cap whole (3 MiB)', async () => {
    // It used to answer 413 here: the read it was built on stopped at a
    // megabyte. Now it reads every range, so a 3 MiB PDF arrives as a 3 MiB
    // PDF.
    standardBus();
    const file = randomBytes(3 * MiB);
    files.set('q3.pdf', { bytes: file, version: 'v1' });
    const d = await download('q3.pdf');
    expect(d.captured.statusCode).toBe(200);
    expect(d.captured.json).toBeUndefined();
    expect(d.captured.complete).toBe(true);
    expect(d.captured.contentLength).toBe(3 * MiB);
    expect(d.body().equals(file)).toBe(true);
  });

  it.each([
    { label: 'empty', size: 0 },
    { label: 'exactly one chunk', size: MiB },
    { label: 'exactly two chunks', size: 2 * MiB },
    { label: 'one chunk and a byte', size: MiB + 1 },
  ])(
    'boundary sizes are byte-identical with one validation call: $label',
    async ({ size }) => {
      standardBus();
      const file = randomBytes(size);
      files.set('f.bin', { bytes: file, version: 'v1' });
      const d = await download('f.bin');

      expect(d.captured.statusCode).toBe(200);
      expect(d.captured.contentLength).toBe(size);
      expect(d.captured.complete).toBe(true);
      expect(d.body().equals(file)).toBe(true);
      // Never more than a chunk per read: that is the host's memory bound.
      expect(rangeCalls.every((c) => c.length <= MiB)).toBe(true);
      // One read per chunk, in order, at least one even for an empty file...
      const dataCalls = rangeCalls.slice(0, -1);
      expect(dataCalls.map((c) => [c.offset, c.length])).toEqual(
        Array.from({ length: Math.max(1, Math.ceil(size / MiB)) }, (_, i) => [i * MiB, MiB]),
      );
      // ...and then the one that confirms the file did not change during the
      // last of them.
      expect(rangeCalls.at(-1)).toMatchObject({ offset: size, length: 0 });
    },
  );

  // --- the content type ----------------------------------------------------

  it('never lets the FILE decide its own content type', async () => {
    /*
      The bytes here are a whole HTML document with a script in it, and the
      name ends in `.html`. Serving that as `text/html` on our own origin is
      stored XSS written by an agent. The answer is the same constant it is for
      every other file, plus nosniff, plus `attachment` — the boring trio that
      means "save this, do not run it".
    */
    standardBus();
    files.set('page.html', { bytes: enc.encode('<script>alert(1)</script>'), version: 'v1' });
    const { captured } = await download('page.html');
    expect(captured.headers['content-type']).toBe('application/octet-stream');
    expect(captured.headers['x-content-type-options']).toBe('nosniff');
    expect(captured.headers['content-disposition']).toMatch(/^attachment; /);
  });

  it('SANITIZES the filename before it reaches the header', async () => {
    /*
      A filename is agent-authored and `Content-Disposition` is a header a
      newline ends. This name carries a quote (which would close the filename
      early), a semicolon (which would start a new parameter) and a CRLF (which
      would start a new HEADER — response splitting). None of them may survive.

      Note what this name does NOT contain: a colon. `workspaceFilePath` would
      have rejected the whole path for one, which is the outer layer of this
      defense — this test is about the inner one, so the name is built to
      reach it.
    */
    standardBus();
    const nasty = 'in"voice;\r\nX-Injected- yes.md';
    files.set(nasty, { bytes: enc.encode('ok'), version: 'v1' });
    const { captured } = await download(encodeURIComponent(nasty));
    expect(captured.statusCode).toBe(200);
    const disp = captured.headers['content-disposition'] ?? '';
    expect(disp).toBe('attachment; filename="in_voice___X-Injected- yes.md"');
    expect(disp).not.toContain('\r');
    expect(disp).not.toContain('\n');
    // Exactly two quotes — the pair we wrote.
    expect(disp.split('"')).toHaveLength(3);
  });

  // --- the ceiling ---------------------------------------------------------

  it('413s a file over USER_FILE_DOWNLOAD_MAX_BYTES with exactly one range call and no body', async () => {
    /*
      One download keeps a range reader busy for as long as its file takes,
      so there is a size past which we do not start. The first range says how
      big the file is; past the ceiling we refuse right there, before a header
      or a byte of the body, and read nothing more.
    */
    standardBus();
    files.set('huge.bin', {
      bytes: ONE_MIB,
      size: USER_FILE_DOWNLOAD_MAX_BYTES + 1,
      read: (_offset, n) => ONE_MIB.subarray(0, Math.min(n, MiB)),
      version: 'v1',
    });
    const d = await download('huge.bin');
    const { captured } = d;
    expect(captured.statusCode).toBe(413);
    expectTorn(d, 413, 'file-too-large');
    expect(captured.headers['content-disposition']).toBeUndefined();
    expect(rangeCalls).toHaveLength(1);
  });

  it('serves a file of exactly USER_FILE_DOWNLOAD_MAX_BYTES: the ceiling is inclusive', async () => {
    standardBus();
    files.set('max.bin', {
      bytes: ONE_MIB,
      size: USER_FILE_DOWNLOAD_MAX_BYTES,
      read: (_offset, n) => ONE_MIB.subarray(0, n),
      version: 'v1',
    });
    const { captured } = await download('max.bin');
    expect(captured.statusCode).toBe(200);
    expect(captured.contentLength).toBe(USER_FILE_DOWNLOAD_MAX_BYTES);
    expect(captured.complete).toBe(true);
    expect(rangeCalls).toHaveLength(USER_FILE_DOWNLOAD_MAX_BYTES / MiB + 1);
  });

  // --- the other answers ---------------------------------------------------

  it('400s a directory — a folder is not a download', async () => {
    standardBus();
    dirs.add('reports');
    const d = await download('reports');
    const { captured } = d;
    expect(captured.statusCode).toBe(400);
    expectTorn(d, 400, 'not-a-file');
  });

  it('404s an absent path', async () => {
    standardBus();
    const d = await download('gone.md');
    const { captured } = d;
    expect(captured.statusCode).toBe(404);
    expectTorn(d, 404, 'file-not-found');
  });

  it('says so when a refusal’s cut was not its own: warn for a write failure, info for a client that left first (TASK-1025)', async () => {
    standardBus();
    const warn = vi.spyOn(initCtx.logger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(initCtx.logger, 'info').mockImplementation(() => undefined);
    await download(
      'gone.md',
      mkRes({ failWith: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) }),
    );
    await download('gone.md', mkRes({ clientLeavesAfter: 0 }));
    await download('gone.md', mkRes({ failWith: bodyStreamError('client-stalled') }));
    // A torn refusal that went as planned says nothing more.
    await download('gone.md');
    const notTorn = 'workspace_user_file_download_refusal_not_torn';
    expect(warn.mock.calls).toEqual([
      [notTorn, { status: 404, reason: 'file-not-found', code: 'EPIPE' }],
    ]);
    expect(info.mock.calls.filter((c) => c[0] === notTorn)).toEqual([
      [notTorn, { status: 404, reason: 'file-not-found', code: 'client-gone' }],
      [notTorn, { status: 404, reason: 'file-not-found', code: 'client-stalled' }],
    ]);
    expect(info.mock.calls.filter((c) => c[0] === 'workspace_user_file_download_refused')).toHaveLength(4);
    warn.mockRestore();
    info.mockRestore();
  });

  it('503s the download when this deployment keeps no files', async () => {
    /*
      TASK-403. `unavailable` is "there is no file area for this agent here".
      It is decided before the path is looked at, so answering it differently
      cannot be used to probe which paths exist.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    bus.registerService(RANGE_HOOK, 'sandbox', async () => ({ kind: 'unavailable' }));
    const d = await download('report.md');
    const { captured } = d;
    expect(captured.statusCode).toBe(503);
    expectTorn(d, 503, 'user-files-unavailable');
  });

  // --- a read that fails before the body -----------------------------------

  it('REGRESSION: an EACCES read is a 503, not a 404 or a 500', async () => {
    /*
      It used to be a 500: the route did not catch, and @ax/http-server turned
      the rejection into one. A file the host is not allowed to read is a read
      that failed, which the tab can say honestly ("try again in a moment"),
      not a file that is not there (404) and not a crash (500).

      The provider throws a PLAIN error, as `fs` does, and the real bus wraps
      it as `PluginError{code:'unknown'}`; the route maps every thrown read.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerThrowingRange(
      Object.assign(new Error("EACCES: permission denied, open '/srv/files/a1/reports/q3.pdf'"), {
        code: 'EACCES',
      }),
    );
    const d = await download('reports%2Fq3.pdf');
    const { captured } = d;
    expect(captured.statusCode).toBe(503);
    expectTorn(d, 503, 'file-read-failed');
    expect(logs).toEqual([
      {
        level: 'warn',
        msg: 'workspace_user_file_download_read_failed',
        bindings: { agentId: 'a1', code: 'unknown', causeCode: 'EACCES' },
      },
    ]);
    // Codes only: never the path, the filename or the error's own message.
    expect(JSON.stringify(logs)).not.toMatch(/permission denied|q3\.pdf|reports|srv/);
  });

  it.each([
    {
      label: 'user-files-download-unavailable (k8s without its host mount)',
      code: 'user-files-download-unavailable',
      error: 'user-files-unavailable',
    },
    {
      label: 'userfiles-read-failed (the pod reader)',
      code: 'userfiles-read-failed',
      error: 'file-read-failed',
    },
  ])('503s a $label PluginError', async ({ code, error }) => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerThrowingRange(
      new PluginError({ code, plugin: 'sandbox', message: 'set sandbox.filestore.hostReadPath' }),
    );
    const d = await download('report.md');
    const { captured } = d;
    expect(captured.statusCode).toBe(503);
    // No host mount is a fact about the deployment (retrying won't help), so it
    // gets the "no file area" answer, not the "a read failed" one.
    expectTorn(d, 503, error);
    expect(logs).toEqual([
      { level: 'warn', msg: 'workspace_user_file_download_read_failed', bindings: { agentId: 'a1', code } },
    ]);
  });

  it('503s a provider answer that is not an object, instead of crashing', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    bus.registerService(RANGE_HOOK, 'sandbox', async (ctx) => {
      watchLogger(ctx);
      return null as never;
    });
    const d = await download('report.md');
    const { captured } = d;
    expect(captured.statusCode).toBe(503);
    expectTorn(d, 503, 'file-read-failed');
    expect(logs).toEqual([
      {
        level: 'warn',
        msg: 'workspace_user_file_download_read_failed',
        bindings: { agentId: 'a1', code: 'invalid-answer' },
      },
    ]);
  });

  it('503s a read that times out', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    bus.registerService(
      RANGE_HOOK,
      'sandbox',
      async (ctx) => {
        watchLogger(ctx);
        return new Promise<never>(() => undefined);
      },
      { timeoutMs: 20 },
    );
    const d = await download('report.md');
    const { captured } = d;
    expect(captured.statusCode).toBe(503);
    expectTorn(d, 503, 'file-read-failed');
    expect(logs).toEqual([
      {
        level: 'warn',
        msg: 'workspace_user_file_download_read_failed',
        bindings: { agentId: 'a1', code: 'timeout' },
      },
    ]);
  });

  it.each([
    { label: 'no version', answer: { kind: 'file', size: 3, bytes: enc.encode('abc') } },
    {
      label: 'an empty version',
      answer: { kind: 'file', size: 3, version: '', bytes: enc.encode('abc') },
    },
    {
      label: 'a size that is not a byte count',
      answer: { kind: 'file', size: 1.5, version: 'v1', bytes: enc.encode('a') },
    },
    {
      label: 'a negative size',
      answer: { kind: 'file', size: -1, version: 'v1', bytes: new Uint8Array(0) },
    },
    { label: 'bytes that are not bytes', answer: { kind: 'file', size: 3, version: 'v1', bytes: [1, 2, 3] } },
    { label: 'a kind it does not know', answer: { kind: 'symlink' } },
  ])('503s an answer it cannot check: $label', async ({ answer }) => {
    /*
      Every later range is checked against the FIRST answer's version and
      size. A first answer without them would make those checks compare
      nothing with nothing and pass, so it is refused before anything is sent.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    bus.registerService(RANGE_HOOK, 'sandbox', async (ctx) => {
      watchLogger(ctx);
      return answer;
    });
    const d = await download('report.md');
    const { captured } = d;
    expect(captured.statusCode).toBe(503);
    expectTorn(d, 503, 'file-read-failed');
    expect(logs).toEqual([
      {
        level: 'warn',
        msg: 'workspace_user_file_download_read_failed',
        bindings: { agentId: 'a1', code: 'invalid-answer' },
      },
    ]);
  });

  // --- a file that changes under the download -------------------------------

  type Tamper = NonNullable<typeof tamper>;
  const asFile = (
    honest: ReadUserFileRangeOutput,
    change: (f: Extract<ReadUserFileRangeOutput, { kind: 'file' }>) => ReadUserFileRangeOutput,
  ): ReadUserFileRangeOutput => (honest.kind === 'file' ? change(honest) : honest);

  const CHANGES: Array<{ label: string; tamper: Tamper; calls: number }> = [
    {
      label: 'a file deleted mid-download (absent on call 2)',
      tamper: (n, _i, honest) => (n >= 2 ? { kind: 'absent' } : honest),
      calls: 2,
    },
    {
      label: 'a file replaced by a folder',
      tamper: (n, _i, honest) => (n >= 2 ? { kind: 'dir' } : honest),
      calls: 2,
    },
    {
      label: 'a file area that went away',
      tamper: (n, _i, honest) => (n >= 2 ? { kind: 'unavailable' } : honest),
      calls: 2,
    },
    {
      label: 'a version change (rewritten in place)',
      tamper: (n, _i, honest) => (n === 2 ? asFile(honest, (f) => ({ ...f, version: v('v2') })) : honest),
      calls: 2,
    },
    {
      label: 'a size change (appended to)',
      tamper: (n, _i, honest) => (n === 2 ? asFile(honest, (f) => ({ ...f, size: f.size + 10 })) : honest),
      calls: 2,
    },
    {
      label: 'a short chunk',
      tamper: (n, _i, honest) =>
        n === 2 ? asFile(honest, (f) => ({ ...f, bytes: f.bytes.subarray(0, f.bytes.byteLength - 1) })) : honest,
      calls: 2,
    },
    {
      label: 'a chunk longer than asked for',
      tamper: (n, _i, honest) =>
        n === 2 ? asFile(honest, (f) => ({ ...f, bytes: new Uint8Array(f.bytes.byteLength + 1) })) : honest,
      calls: 2,
    },
    {
      label: 'a change caught only by the final validation',
      tamper: (_n, input, honest) =>
        input.offset === 3 * MiB && input.length === 0
          ? asFile(honest, (f) => ({ ...f, version: v('v2') }))
          : honest,
      calls: 4,
    },
  ];

  it.each(CHANGES)('$label aborts instead of completing', async ({ tamper: t, calls }) => {
    standardBus();
    files.set('live.log', { bytes: randomBytes(3 * MiB), version: 'v1' });
    tamper = t;
    const d = await download('live.log');

    // The head was already promised (200, Content-Length 3 MiB). What makes
    // that honest is that the body is torn down rather than ended.
    expect(d.captured.statusCode).toBe(200);
    expect(d.captured.contentLength).toBe(3 * MiB);
    expect(d.captured.complete).toBe(false);
    expect(d.captured.failure).toMatchObject({ code: 'source-failed' });
    // It stopped at the read that said so: nothing was read after it.
    expect(rangeCalls).toHaveLength(calls);
    expect(logs).toEqual([
      {
        level: 'info',
        msg: 'workspace_user_file_download_incomplete',
        bindings: { agentId: 'a1', reason: 'changed' },
      },
    ]);
  });

  // --- a change found before the head is answered, not torn down -----------
  //
  // Until the first `header()`, a refusal can still be answered: in words to a
  // probe, and with the same status, its words torn, to a real download
  // (TASK-1025). Two checks can be made by then: the first range's byte count,
  // and, for a file that fits in one range, the final check too. An answer
  // made here carries NONE of the download's headers. The filename in
  // Content-Disposition is agent-authored, and octet-stream is a download's
  // type, not an error's.

  /** How many range reads had been made each time `d`'s head was touched. */
  function readsAtHead(d: ReturnType<typeof mkRes>): number[] {
    const seen: number[] = [];
    const { status, header } = d.res;
    d.res.status = (n) => {
      seen.push(rangeCalls.length);
      return status(n);
    };
    d.res.header = (name, value) => {
      seen.push(rangeCalls.length);
      return header(name, value);
    };
    return seen;
  }

  it.each([
    { label: 'a file of several ranges', size: 3 * MiB },
    { label: 'a file of one range', size: 3 },
  ])(
    'a short FIRST range is answered 409 file-changed, with none of the download headers ($label)',
    async ({ size }) => {
      // It shrank between the size and the read: the provider stats the file,
      // then finds fewer bytes than that.
      standardBus();
      files.set('live.log', { bytes: randomBytes(size), version: 'v1' });
      tamper = (n, _i, honest) =>
        n === 1
          ? asFile(honest, (f) => ({ ...f, bytes: f.bytes.subarray(0, f.bytes.byteLength - 1) }))
          : honest;
      const d = await download('live.log');
      const { captured } = d;

      expect(captured.statusCode).toBe(409);
      // No content-disposition (the agent-authored filename), no octet-stream
      // content-type. No header but the refusal's own JSON type.
      expectTorn(d, 409, 'file-changed');
      expect(captured.headers['content-disposition']).toBeUndefined();
      // Nothing read after the range that said so, not even a one-range
      // file's final check. A file being written is ordinary life, and the
      // person is told, so nothing is logged.
      expect(rangeCalls).toHaveLength(1);
      expect(logs).toEqual([]);
    },
  );

  it.each<{
    label: string;
    last: (honest: ReadUserFileRangeOutput) => ReadUserFileRangeOutput;
    status: number;
    error: string;
    logged: LogLine[];
  }>([
    {
      label: 'a version change',
      last: (honest) => asFile(honest, (f) => ({ ...f, version: v('v2') })),
      status: 409,
      error: 'file-changed',
      logged: [],
    },
    {
      label: 'a size change',
      last: (honest) => asFile(honest, (f) => ({ ...f, size: f.size + 10 })),
      status: 409,
      error: 'file-changed',
      logged: [],
    },
    { label: 'a folder', last: () => ({ kind: 'dir' }), status: 400, error: 'not-a-file', logged: [] },
    { label: 'no file', last: () => ({ kind: 'absent' }), status: 404, error: 'file-not-found', logged: [] },
    {
      label: 'no file area',
      last: () => ({ kind: 'unavailable' }),
      status: 503,
      error: 'user-files-unavailable',
      logged: [],
    },
    {
      label: 'an answer it cannot read',
      last: () => null as never,
      status: 503,
      error: 'file-read-failed',
      logged: [
        {
          level: 'warn',
          msg: 'workspace_user_file_download_read_failed',
          bindings: { agentId: 'a1', code: 'invalid-answer' },
        },
      ],
    },
    {
      // A PLAIN throw, as `fs` does: the real bus wraps it as
      // `PluginError{code:'unknown'}` with the EIO as its cause.
      label: 'a read that throws',
      last: () => {
        throw Object.assign(new Error("EIO: i/o error, read '/srv/files/a1/small.txt'"), {
          code: 'EIO',
        });
      },
      status: 503,
      error: 'file-read-failed',
      logged: [
        {
          level: 'warn',
          msg: 'workspace_user_file_download_read_failed',
          bindings: { agentId: 'a1', code: 'unknown', causeCode: 'EIO' },
        },
      ],
    },
    {
      label: 'no host mount',
      last: () => {
        throw new PluginError({
          code: 'user-files-download-unavailable',
          plugin: 'sandbox',
          message: 'set sandbox.filestore.hostReadPath',
        });
      },
      status: 503,
      error: 'user-files-unavailable',
      logged: [
        {
          level: 'warn',
          msg: 'workspace_user_file_download_read_failed',
          bindings: { agentId: 'a1', code: 'user-files-download-unavailable' },
        },
      ],
    },
  ])(
    'a one-range file whose final check finds $label is answered $status before the head',
    async ({ last, status, error, logged }) => {
      standardBus();
      files.set('small.txt', { bytes: enc.encode('abc'), version: 'v1' });
      tamper = (_n, input, honest) =>
        input.offset === 3 && input.length === 0 ? last(honest) : honest;
      const d = await download('small.txt');
      const { captured } = d;

      expect(captured.statusCode).toBe(status);
      expectTorn(d, status, error);
      expect(captured.headers['content-disposition']).toBeUndefined();
      // The first range, then the final check, and nothing after it.
      expect(rangeCalls.map((c) => [c.offset, c.length])).toEqual([
        [0, MiB],
        [3, 0],
      ]);
      expect(logs).toEqual(logged);
      // Codes only: never the path, the filename or the error's own message.
      expect(JSON.stringify(logs)).not.toMatch(/i\/o error|small\.txt|srv/);
    },
  );

  it('serves a one-range file whole after its final check, which runs before the head', async () => {
    standardBus();
    const file = randomBytes(64 * 1024);
    files.set('small.bin', { bytes: file, version: 'v1' });
    const d = mkRes();
    const seen = readsAtHead(d);
    await download('small.bin', d);

    expect(d.captured.statusCode).toBe(200);
    // status(200) and every header came after BOTH reads: the first range and
    // the final check.
    expect([...new Set(seen)]).toEqual([2]);
    expect(rangeCalls.map((c) => [c.offset, c.length])).toEqual([
      [0, MiB],
      [file.byteLength, 0],
    ]);
    expect(d.captured.complete).toBe(true);
    expect(d.captured.contentLength).toBe(file.byteLength);
    expect(d.body().equals(file)).toBe(true);
    expect(logs).toEqual([]);
  });

  it('serves an empty file: its final check, then a zero-length body', async () => {
    standardBus();
    files.set('empty.txt', { bytes: new Uint8Array(0), version: 'v1' });
    const d = mkRes();
    const seen = readsAtHead(d);
    await download('empty.txt', d);

    expect(d.captured.statusCode).toBe(200);
    expect([...new Set(seen)]).toEqual([2]);
    expect(rangeCalls.map((c) => [c.offset, c.length])).toEqual([
      [0, MiB],
      [0, 0],
    ]);
    expect(d.captured.contentLength).toBe(0);
    expect(d.captured.complete).toBe(true);
    expect(d.body().byteLength).toBe(0);
    expect(d.captured.headers['content-disposition']).toBe('attachment; filename="empty.txt"');
  });

  it('a client cut off for stalling is logged as client-stalled, at info', async () => {
    // `bodyStream()` cuts a client that stops taking bytes. We ended it, but
    // a reader that wandered off is ordinary life, as one that left is.
    standardBus();
    files.set('live.log', { bytes: randomBytes(3 * MiB), version: 'v1' });
    const d = mkRes({ failWith: Object.assign(new Error('stalled'), { code: 'client-stalled' }) });
    await download('live.log', d);
    expect(logs).toEqual([
      {
        level: 'info',
        msg: 'workspace_user_file_download_incomplete',
        bindings: { agentId: 'a1', reason: 'client-stalled' },
      },
    ]);
  });

  it('a read that fails mid-download aborts, logged as read-failed with its codes', async () => {
    standardBus();
    files.set('big.bin', { bytes: randomBytes(3 * MiB), version: 'v1' });
    tamper = (n, _i, honest) => {
      if (n === 2) {
        throw Object.assign(new Error("EIO: i/o error, read '/srv/files/a1/big.bin'"), { code: 'EIO' });
      }
      return honest;
    };
    const d = await download('big.bin');
    expect(d.captured.complete).toBe(false);
    expect(rangeCalls).toHaveLength(2);
    expect(logs).toEqual([
      {
        // A storage failure mid-download is worth a warning, same as before the head.
        level: 'warn',
        msg: 'workspace_user_file_download_incomplete',
        bindings: { agentId: 'a1', reason: 'read-failed', code: 'unknown', causeCode: 'EIO' },
      },
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/i\/o error|big\.bin|srv/);
  });

  it('a client that leaves mid-download stops the reads, logged as client-gone', async () => {
    standardBus();
    files.set('big.bin', { bytes: randomBytes(5 * MiB), version: 'v1' });
    const d = mkRes({ clientLeavesAfter: 2 });
    await download('big.bin', d);
    expect(d.captured.complete).toBe(false);
    // Two chunks pulled, then nothing: no third read, and no validation read.
    expect(rangeCalls).toHaveLength(2);
    expect(logs).toEqual([
      {
        level: 'info',
        msg: 'workspace_user_file_download_incomplete',
        bindings: { agentId: 'a1', reason: 'client-gone' },
      },
    ]);
  });

  it('logs a body failure it did not expect by its code alone, and never rethrows it', async () => {
    // The adapter can also reject with an error of Node's own (a header it
    // refused, say). The head may already be out, so there is nothing left to
    // answer; what is left is to say so, in codes.
    standardBus();
    files.set('plan.md', { bytes: enc.encode('x'), version: 'v1' });
    const d = mkRes({
      failWith: Object.assign(new Error('Invalid character in header content ["x"]'), {
        code: 'ERR_INVALID_CHAR',
      }),
    });
    await expect(download('plan.md', d)).resolves.toBeDefined();
    expect(logs).toEqual([
      {
        level: 'warn',
        msg: 'workspace_user_file_download_incomplete',
        bindings: { agentId: 'a1', reason: 'other', code: 'ERR_INVALID_CHAR' },
      },
    ]);
  });

  // --- routing -------------------------------------------------------------

  it('reads on the AGENT’s own context and owner, never the plugin’s — every range of it', async () => {
    /*
      It is what keeps a download from crossing into another agent's tree: the
      provider joins `owner.agentId` onto the export root. The plugin's own
      initCtx (`@ax/channel-web` / `system`) would land in the wrong subtree,
      or in every subtree. Every call, the validating one included.
    */
    standardBus();
    files.set('x.bin', { bytes: randomBytes(2 * MiB), version: 'v1' });
    await download('x.bin');
    expect(rangeCalls).toHaveLength(3);
    for (const call of rangeCalls) {
      expect(call).toMatchObject({ agentId: 'a1', userId: 'u1', ownerAgentId: 'a1', relPath: 'x.bin' });
    }
  });

  // --- the probe (TASK-1022) ------------------------------------------------
  //
  // `?probe=1` asks what a download would answer, without the download. The
  // client asks first and then hands the route to the browser's own download,
  // whose bar can only say "Failed", so a refusal has to be said in the page
  // before that. A probe is the download's own code path, stopped where the
  // head would go out, so its answers cannot drift from the download's.

  it.each<{ label: string; arrange: () => void; splat: string; status: number; error: string }>([
    {
      label: 'an absent file’s 404',
      arrange: () => standardBus(),
      splat: 'gone.md',
      status: 404,
      error: 'file-not-found',
    },
    {
      label: 'a folder’s 400',
      arrange: () => {
        standardBus();
        dirs.add('reports');
      },
      splat: 'reports',
      status: 400,
      error: 'not-a-file',
    },
    {
      label: 'the ceiling’s 413',
      arrange: () => {
        standardBus();
        files.set('huge.bin', {
          bytes: ONE_MIB,
          size: USER_FILE_DOWNLOAD_MAX_BYTES + 1,
          read: (_offset, n) => ONE_MIB.subarray(0, Math.min(n, MiB)),
          version: 'v1',
        });
      },
      splat: 'huge.bin',
      status: 413,
      error: 'file-too-large',
    },
    {
      label: 'an unavailable file area’s 503',
      arrange: () => {
        standardBus();
        tamper = () => ({ kind: 'unavailable' });
      },
      splat: 'report.md',
      status: 503,
      error: 'user-files-unavailable',
    },
    {
      label: 'a thrown read’s 503',
      arrange: () => {
        standardBus();
        files.set('report.md', { bytes: enc.encode('x'), version: 'v1' });
        tamper = () => {
          throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        };
      },
      splat: 'report.md',
      status: 503,
      error: 'file-read-failed',
    },
    {
      label: 'a missing range service’s 503',
      arrange: () => {
        registerAuth({ id: 'u1', isAdmin: false });
        registerAgents();
      },
      splat: 'report.md',
      status: 503,
      error: 'user-files-unavailable',
    },
    {
      label: 'a short first range’s 409',
      arrange: () => {
        standardBus();
        files.set('live.log', { bytes: randomBytes(3 * MiB), version: 'v1' });
        tamper = (n, _i, honest) =>
          n === 1
            ? asFile(honest, (f) => ({ ...f, bytes: f.bytes.subarray(0, f.bytes.byteLength - 1) }))
            : honest;
      },
      splat: 'live.log',
      status: 409,
      error: 'file-changed',
    },
    {
      label: 'a one-range file’s 409 from its final check',
      arrange: () => {
        standardBus();
        files.set('small.txt', { bytes: enc.encode('abc'), version: 'v1' });
        tamper = (_n, input, honest) =>
          input.offset === 3 && input.length === 0
            ? asFile(honest, (f) => ({ ...f, version: v('v2') }))
            : honest;
      },
      splat: 'small.txt',
      status: 409,
      error: 'file-changed',
    },
  ])(
    'a probe answers $label in words, and the real download sends the same refusal torn',
    async ({ arrange, splat, status, error }) => {
      arrange();
      const info = vi.spyOn(initCtx.logger, 'info').mockImplementation(() => undefined);
      const asDownload = await download(splat);
      const downloadReads = rangeCalls.map((c) => [c.offset, c.length]);
      // Nobody reads a torn refusal's bytes, so this line is its one trace:
      // the status and the code, and nothing the caller sent.
      expect(info.mock.calls).toEqual([
        ['workspace_user_file_download_refused', { status, reason: error }],
      ]);
      info.mockClear();
      // A fresh count, so a `tamper` keyed on the nth read sees the probe's
      // reads exactly as it saw the download's.
      rangeCalls = [];
      const asProbe = mkRes();
      const bodyStream = vi.spyOn(asProbe.res, 'bodyStream');
      await probeDownload(splat, asProbe);

      // The browser's download gets the refusal's status, its words torn...
      expectTorn(asDownload, status, error);
      // ...and the page gets the same refusal in words, from the same reads.
      expect(asProbe.captured).toMatchObject({ statusCode: status, json: { error } });
      expect(rangeCalls.map((c) => [c.offset, c.length])).toEqual(downloadReads);
      // No body...
      expect(bodyStream).not.toHaveBeenCalled();
      expect(asProbe.captured.chunks).toEqual([]);
      // ...and none of the download's headers (no content-disposition, no
      // octet-stream). Only no-store, so no cache hands this answer back
      // after the file has moved on.
      expect(asProbe.captured.headers).toEqual({ 'cache-control': 'private, no-store' });
      // The page says a probe's refusal itself, so nothing is logged for it.
      expect(info).not.toHaveBeenCalled();
    },
  );

  it('a probe of a file that would download answers 200 { downloadable: true } and sends none of the download', async () => {
    standardBus();
    files.set('q3.pdf', { bytes: randomBytes(3 * MiB), version: 'v1' });
    files.set('tiny.bin', { bytes: Uint8Array.from([0x00, 0x01, 0xff, 0x0a]), version: 'v1' });

    // A file of several ranges: its first range is read, because the ceiling
    // and the byte count are checked on it, and nothing after that.
    const several = mkRes();
    const severalBody = vi.spyOn(several.res, 'bodyStream');
    await probeDownload('q3.pdf', several);
    expect(several.captured.statusCode).toBe(200);
    expect(several.captured.json).toEqual({ downloadable: true });
    // JSON, not a download: no attachment, no octet-stream, and the
    // agent-authored filename nowhere. The whole set is no-store alone.
    expect(several.captured.headers).toEqual({ 'cache-control': 'private, no-store' });
    expect(severalBody).not.toHaveBeenCalled();
    expect(several.captured.contentLength).toBeNull();
    expect(rangeCalls.map(({ offset, length }) => ({ offset, length }))).toEqual([
      { offset: 0, length: MiB },
    ]);

    // A file of one range: a download makes its final check before the
    // head, so the probe makes it too.
    rangeCalls = [];
    const one = mkRes();
    const oneBody = vi.spyOn(one.res, 'bodyStream');
    await probeDownload('tiny.bin', one);
    expect(one.captured.statusCode).toBe(200);
    expect(one.captured.json).toEqual({ downloadable: true });
    expect(one.captured.headers).toEqual({ 'cache-control': 'private, no-store' });
    expect(oneBody).not.toHaveBeenCalled();
    expect(rangeCalls.map(({ offset, length }) => ({ offset, length }))).toEqual([
      { offset: 0, length: MiB },
      { offset: 4, length: 0 },
    ]);
  });

  it('the helper makes its own probe answer no-store, whatever its caller set', async () => {
    // TASK-1022 review: both routes set no-store before their ACL, but the
    // helper must not depend on that. A third caller passing `probe: true`
    // gets a 200 no cache may keep, too.
    standardBus();
    files.set('tiny.bin', { bytes: Uint8Array.from([0x00, 0x01, 0xff, 0x0a]), version: 'v1' });
    const d = mkRes();
    await sendUserFileDownload({
      bus,
      ctx: initCtx,
      owner: { userId: 'u1', agentId: 'a1', agentConfig: { displayName: 'A1' } } as Parameters<
        typeof sendUserFileDownload
      >[0]['owner'],
      relPath: 'tiny.bin',
      downloadName: 'tiny.bin',
      probe: true,
      res: d.res,
    });
    expect(d.captured.statusCode).toBe(200);
    expect(d.captured.json).toEqual({ downloadable: true });
    expect(d.captured.headers).toEqual({ 'cache-control': 'private, no-store' });

    // Its refusals too, not only its yes.
    const gone = mkRes();
    await sendUserFileDownload({
      bus,
      ctx: initCtx,
      owner: { userId: 'u1', agentId: 'a1', agentConfig: { displayName: 'A1' } } as Parameters<
        typeof sendUserFileDownload
      >[0]['owner'],
      relPath: 'not-there.bin',
      downloadName: 'not-there.bin',
      probe: true,
      res: gone.res,
    });
    expect(gone.captured.statusCode).toBe(404);
    expect(gone.captured.headers).toEqual({ 'cache-control': 'private, no-store' });
  });

  it('a probe runs the ACL first: a foreign agent is a 404 with no read, and every probe answer is no-store', async () => {
    const TRAVERSAL = '..%2F..%2Fetc%2Fpasswd';

    // Signed out: a 401, and no cache keeps even that.
    registerAuth(null);
    registerAgents();
    registerRange();
    const info = vi.spyOn(initCtx.logger, 'info').mockImplementation(() => undefined);
    const signedOut = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'x.md' }, { probe: '1' }),
      signedOut.res,
    );
    expect(signedOut.captured.statusCode).toBe(401);
    expect(signedOut.captured.headers).toEqual({ 'cache-control': 'private, no-store' });
    expect(rangeCalls).toEqual([]);

    // The real download, signed out (Safari retrying an old failed download
    // after a sign-out, say): the ACL's own 401, torn too, so not even that
    // can be saved as the file. One log line: the probe above wrote none.
    const signedOutDownload = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'x.md' }),
      signedOutDownload.res,
    );
    expectTorn(signedOutDownload, 401, 'unauthenticated');
    expect(info.mock.calls).toEqual([
      ['workspace_user_file_download_refused', { status: 401, reason: 'unauthenticated' }],
    ]);
    expect(rangeCalls).toEqual([]);

    // Signed in, asking about somebody else's agent with a malformed path:
    // the download's own 404, not the path's 400, and not one read. A probe
    // is no oracle over another tenant's paths.
    bus = new HookBus();
    standardBus();
    const foreign = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'someone-elses', '*': TRAVERSAL }, { probe: '1' }),
      foreign.res,
    );
    const foreignDownload = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'someone-elses', '*': TRAVERSAL }),
      foreignDownload.res,
    );
    expect(foreign.captured.statusCode).toBe(404);
    expect(foreign.captured.json).toEqual({ error: 'agent-not-found' });
    // The real download's answer is the same 404, torn: still no oracle.
    expectTorn(foreignDownload, 404, 'agent-not-found');
    expect(foreign.captured.headers).toEqual({ 'cache-control': 'private, no-store' });
    expect(rangeCalls).toEqual([]);

    // The control: on the caller's own agent the same path is the 400 it
    // should be, so the 404 above was the ACL's, not the path's.
    const own = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': TRAVERSAL }, { probe: '1' }),
      own.res,
    );
    expect(own.captured.statusCode).toBe(400);
    expect(own.captured.json).toEqual({ error: 'invalid-path' });
    expect(own.captured.headers).toEqual({ 'cache-control': 'private, no-store' });
    expect(rangeCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The socket part — real round trips through a real router and http-server.
// ---------------------------------------------------------------------------
describe('the download route over a real socket', () => {
  const COOKIE_KEY = randomBytes(32);
  const SETTLE_DEADLINE_MS = 5_000;
  const DOWNLOAD = '/api/workspace/agents/a1/download/user-files';
  let harness: TestHarness | null = null;
  let agent: http.Agent | null = null;
  /**
   * 50 MiB of noise: more than the kernel's socket buffers can hide, so a
   * route that ignored backpressure would show up as reads it should not
   * have made.
   */
  let big: Buffer;
  /** What the fake range service saw. */
  let probe: { calls: Array<{ relPath: string; offset: number; length: number }>; inFlight: number };
  let tamper:
    | ((
        n: number,
        input: ReadUserFileRangeInput,
        honest: ReadUserFileRangeOutput,
      ) => ReadUserFileRangeOutput)
    | undefined;

  beforeAll(() => {
    big = randomBytes(50 * MiB);
  });

  afterAll(() => {
    big = Buffer.alloc(0);
  });

  beforeEach(() => {
    probe = { calls: [], inFlight: 0 };
    tamper = undefined;
  });

  afterEach(async () => {
    agent?.destroy();
    agent = null;
    if (harness !== null) {
      await harness.close({ onError: () => {} });
      harness = null;
    }
  });

  function fileAnswer(
    bytes: Uint8Array,
    offset: number,
    length: number,
    size = bytes.byteLength,
  ): ReadUserFileRangeOutput {
    const n = Math.min(length, Math.max(0, size - offset));
    return { kind: 'file', size, version: v('v1'), bytes: bytes.subarray(offset, offset + n) };
  }

  function honestAnswer(input: ReadUserFileRangeInput): ReadUserFileRangeOutput {
    const { relPath, offset, length } = input;
    if (relPath === 'notes/plan.bin') {
      return fileAnswer(Uint8Array.from([0x00, 0x01, 0xff, 0x0a]), offset, length);
    }
    if (relPath === 'reports/summary.md') return fileAnswer(enc.encode('# Summary'), offset, length);
    if (relPath === 'big.bin') return fileAnswer(big, offset, length);
    if (relPath === 'live.log') return fileAnswer(big.subarray(0, 3 * MiB), offset, length);
    if (relPath === 'huge.csv') {
      return fileAnswer(ONE_MIB, 0, Math.min(length, MiB), USER_FILE_DOWNLOAD_MAX_BYTES + 1);
    }
    return { kind: 'absent' };
  }

  async function boot(): Promise<{ harness: TestHarness; port: number }> {
    const plugin: HttpServerPlugin = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY,
      allowedOrigins: [],
    });
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
    const booted = await createTestHarness({
      services: {
        'auth:require-user': async () => ({ user: { id: 'u1', isAdmin: false } }),
        'agents:resolve': async (_ctx: unknown, input: unknown) => {
          const { agentId } = input as { agentId: string };
          if (agentId !== 'a1') {
            throw new PluginError({
              code: 'not-found',
              plugin: 'mock-agents',
              message: 'nope',
            });
          }
          return { agent: { id: 'a1', displayName: 'Inbox' } };
        },
        // The PREVIEW read, for the sibling route below.
        'sandbox:read-user-files': async (_ctx: unknown, input: unknown) => {
          const { relPath } = input as { relPath?: string };
          if (relPath === 'reports/summary.md') {
            return { kind: 'file', contents: enc.encode('# Summary'), truncated: false };
          }
          return { kind: 'absent' };
        },
        [RANGE_HOOK]: async (_ctx: unknown, raw: unknown) => {
          const input = raw as ReadUserFileRangeInput;
          probe.calls.push({ relPath: input.relPath, offset: input.offset, length: input.length });
          probe.inFlight += 1;
          try {
            // A real read is never synchronous, and "in flight" should mean something.
            await new Promise<void>((resolve) => setImmediate(resolve));
            const honest = honestAnswer(input);
            return tamper === undefined ? honest : tamper(probe.calls.length, input, honest);
          } finally {
            probe.inFlight -= 1;
          }
        },
      },
      plugins: [plugin],
    });
    await registerWorkspaceRoutes(booted.bus, initCtx);
    harness = booted;
    return { harness: booted, port: plugin.boundPort() };
  }

  interface RawResponse {
    /** Undefined when no response head ever arrived. */
    status: number | undefined;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
    /** Node's verdict that the whole Content-Length arrived. */
    complete: boolean;
    /** The client was still waiting at the deadline: the server ENDED a short body. */
    timedOut: boolean;
  }

  /**
   * A GET over a KEEP-ALIVE connection, so a body the server ENDED short
   * (parked the socket, still owing bytes) shows up as `timedOut` instead of
   * passing for a torn one. Settles on end, error or close.
   */
  function rawGet(
    port: number,
    path: string,
    opts: { onResponse?: (res: http.IncomingMessage) => void; deadlineMs?: number } = {},
  ): Promise<RawResponse> {
    agent ??= new http.Agent({ keepAlive: true });
    const via = agent;
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let response: http.IncomingMessage | undefined;
      let settled = false;
      const settle = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status: response?.statusCode,
          headers: response?.headers ?? {},
          body: Buffer.concat(chunks),
          complete: response?.complete ?? false,
          timedOut,
        });
        if (timedOut) req.destroy();
      };
      const timer = setTimeout(() => settle(true), opts.deadlineMs ?? SETTLE_DEADLINE_MS);
      const req = http.get({ host: '127.0.0.1', port, path, agent: via }, (res) => {
        response = res;
        opts.onResponse?.(res);
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => settle(false));
        res.on('error', () => settle(false));
        res.on('close', () => settle(false));
      });
      req.on('error', () => settle(false));
    });
  }

  /**
   * A REAL download's refusal on the wire (TASK-1025): the refusal's status
   * head, with its JSON type and a Content-Length for the whole `{error}`
   * JSON, then all of that JSON but its last byte, and a cut connection.
   *
   * `status` is what matters most. A connection cut before the head is a
   * reset, and a proxy in front of us answers a reset with an error page of
   * its own (reasoned, not measured), which Safari would save as the file. A
   * body cut short of its Content-Length was a failed download in every
   * engine walked (macOS Safari, Chromium, Firefox).
   */
  function expectTornOverTheWire(got: RawResponse, status: number, error: string): void {
    const whole = JSON.stringify({ error });
    expect(got).toMatchObject({ status, complete: false, timedOut: false });
    expect(got.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(got.headers['content-disposition']).toBeUndefined();
    expect(got.headers['content-length']).toBe(String(Buffer.byteLength(whole)));
    expect(got.body.toString('utf-8')).toBe(whole.slice(0, -1));
  }

  it('serves bytes through the splat, path encoded whole', async () => {
    const b = await boot();
    // `encodeURIComponent('notes/plan.bin')` — exactly what the client sends.
    const r = await fetch(`http://127.0.0.1:${b.port}${DOWNLOAD}/notes%2Fplan.bin`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="plan.bin"');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    // The size the range read reported, framed by the server.
    expect(r.headers.get('content-length')).toBe('4');
    // Bytes, not text: a NUL and a 0xFF survive the whole trip.
    expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual([0x00, 0x01, 0xff, 0x0a]);
  });

  it('serves bytes when the path arrives as real slashes too', async () => {
    const b = await boot();
    const r = await fetch(`http://127.0.0.1:${b.port}${DOWNLOAD}/reports/summary.md`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('# Summary');
  });

  it('50 MiB downloads byte-identical over the wire', async () => {
    const b = await boot();
    const r = await fetch(`http://127.0.0.1:${b.port}${DOWNLOAD}/big.bin`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe('52428800');
    const got = Buffer.from(await r.arrayBuffer());
    expect(sha256(got)).toBe(sha256(big));
    // A megabyte at a time, never more: 50 reads of the file, then the one
    // that confirms it did not change during the last of them.
    expect(Math.max(...probe.calls.map((c) => c.length))).toBeLessThanOrEqual(MiB);
    expect(probe.calls).toHaveLength(51);
    expect(probe.calls.at(-1)).toEqual({ relPath: 'big.bin', offset: 50 * MiB, length: 0 });
  }, 30_000);

  it('a paused client stops further reads', async () => {
    // A phone on bad Wi-Fi. The host must hold about a chunk for it, not read
    // the whole file into memory while it waits.
    const b = await boot();
    let paused: http.IncomingMessage | undefined;
    let firstData!: () => void;
    const first = new Promise<void>((resolve) => {
      firstData = resolve;
    });
    const done = rawGet(b.port, `${DOWNLOAD}/big.bin`, {
      onResponse: (res) => {
        res.once('data', () => {
          res.pause();
          paused = res;
          firstData();
        });
      },
      deadlineMs: 20_000,
    });
    await first;
    await sleep(300);
    // The socket and kernel buffers hold a few MiB; the file is not drained.
    expect(probe.calls.length).toBeLessThanOrEqual(16);

    paused!.resume();
    const got = await done;
    expect(got.timedOut).toBe(false);
    expect(got.complete).toBe(true);
    expect(sha256(got.body)).toBe(sha256(big));
  }, 30_000);

  it('client abort stops reading with nothing in flight', async () => {
    const b = await boot();
    const got = await rawGet(b.port, `${DOWNLOAD}/big.bin`, {
      onResponse: (res) => {
        res.once('data', () => res.destroy());
      },
    });
    expect(got.complete).toBe(false);
    // Let the server notice, then check it has stopped.
    await sleep(300);
    expect(probe.inFlight).toBe(0);
    const settled = probe.calls.length;
    expect(settled).toBeLessThan(51);
    await sleep(200);
    expect(probe.calls).toHaveLength(settled);
  });

  it('mid-stream deletion: the client never sees a complete 200', async () => {
    tamper = (n, _input, honest) => (n >= 3 ? { kind: 'absent' } : honest);
    const b = await boot();
    const got = await rawGet(b.port, `${DOWNLOAD}/big.bin`);
    expect(got.timedOut).toBe(false);
    expect(got.status).toBe(200);
    expect(got.headers['content-length']).toBe('52428800');
    expect(got.complete).toBe(false);
    // Only two chunks were ever read, so at most two could have been sent.
    expect(got.body.length).toBeLessThanOrEqual(2 * MiB);
    expect(probe.calls).toHaveLength(3);
  });

  it('a file still being appended to never arrives as a complete 200: the final check catches the last append', async () => {
    // A live log. Every chunk matched, and then the file grew during the
    // last read. The chunk that would complete the body is held until that
    // final check, so the client is left short instead of holding a torn file
    // that looks whole.
    tamper = (_n, input, honest) =>
      input.length === 0 && honest.kind === 'file'
        ? { ...honest, size: honest.size + 64, version: v('v2') }
        : honest;
    const b = await boot();
    const got = await rawGet(b.port, `${DOWNLOAD}/live.log`);
    expect(got.timedOut).toBe(false);
    expect(got.status).toBe(200);
    expect(got.headers['content-length']).toBe(String(3 * MiB));
    expect(got.complete).toBe(false);
    expect(got.body.length).toBeLessThanOrEqual(2 * MiB);
    expect(probe.calls).toHaveLength(4);
  });

  it('a one-range file that changes before its final check sends its 409 head over the wire, never a bare reset: torn to the real GET, whole to a probe', async () => {
    // The final check of a file that fits in one range runs before the head,
    // so a change it finds can still be answered with its own status. Run
    // inside the body, it was a connection torn down before any head: a
    // reset, which a proxy in front of us answers with a page of its own.
    tamper = (_n, input, honest) =>
      input.length === 0 && honest.kind === 'file' ? { ...honest, version: v('v2') } : honest;
    const b = await boot();
    const warn = vi.spyOn(initCtx.logger, 'warn');
    const info = vi.spyOn(initCtx.logger, 'info');
    const sent: Array<{ status: number; incomplete: boolean }> = [];
    b.harness.bus.subscribe('http:response-sent', 'response-sent-observer', async (_ctx, payload) => {
      const { status, incomplete } = payload as { status: number; incomplete: boolean };
      sent.push({ status, incomplete });
      return undefined;
    });
    expectTornOverTheWire(await rawGet(b.port, `${DOWNLOAD}/notes%2Fplan.bin`), 409, 'file-changed');
    expect(probe.calls).toEqual([
      { relPath: 'notes/plan.bin', offset: 0, length: MiB },
      { relPath: 'notes/plan.bin', offset: 4, length: 0 },
    ]);

    // The page asks first, and gets the same refusal whole, in words.
    const asked = await rawGet(b.port, `${DOWNLOAD}/notes%2Fplan.bin?probe=1`);
    expect(asked).toMatchObject({ status: 409, complete: true, timedOut: false });
    expect(asked.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(asked.body.toString('utf-8'))).toEqual({ error: 'file-changed' });

    // The handler waits for the cut before it returns, so the server's own
    // record says the real GET's 409 was cut short, and the probe's was not.
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { status: 409, incomplete: true },
      { status: 409, incomplete: false },
    ]);
    // The cut was our own, so nothing says the refusal went out wrong, at
    // either level.
    expect(warn.mock.calls.map((c) => c[0])).not.toContain('workspace_user_file_download_refusal_not_torn');
    expect(info.mock.calls.map((c) => c[0])).not.toContain('workspace_user_file_download_refusal_not_torn');
    expect(info.mock.calls.map((c) => c[0])).toContain('workspace_user_file_download_refused');
    warn.mockRestore();
    info.mockRestore();
  });

  it('503s a read that throws over the wire, never a 500: torn to the real GET, whole to a probe', async () => {
    tamper = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    const b = await boot();
    expectTornOverTheWire(
      await rawGet(b.port, `${DOWNLOAD}/notes%2Fplan.bin`),
      503,
      'file-read-failed',
    );

    const asked = await rawGet(b.port, `${DOWNLOAD}/notes%2Fplan.bin?probe=1`);
    expect(asked).toMatchObject({ status: 503, complete: true, timedOut: false });
    expect(JSON.parse(asked.body.toString('utf-8'))).toEqual({ error: 'file-read-failed' });
  });

  it('413s a file over the ceiling over the wire, after one read: torn to the real GET, whole to a probe', async () => {
    const b = await boot();
    expectTornOverTheWire(await rawGet(b.port, `${DOWNLOAD}/huge.csv`), 413, 'file-too-large');
    expect(probe.calls).toHaveLength(1);

    const asked = await rawGet(b.port, `${DOWNLOAD}/huge.csv?probe=1`);
    expect(asked).toMatchObject({ status: 413, complete: true, timedOut: false });
    expect(JSON.parse(asked.body.toString('utf-8'))).toEqual({ error: 'file-too-large' });
    // The probe's own one read.
    expect(probe.calls).toHaveLength(2);
  });

  it('400s an encoded traversal over the wire', async () => {
    const b = await boot();
    const r = await fetch(`http://127.0.0.1:${b.port}${DOWNLOAD}/%2e%2e%2fsecret`);
    expect(r.status).toBe(400);
    expect(probe.calls).toEqual([]);
  });

  it('404s another agent’s download over the wire', async () => {
    const b = await boot();
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a2/download/user-files/notes%2Fplan.bin`,
    );
    expect(r.status).toBe(404);
    expect(probe.calls).toEqual([]);
  });

  it('answers a probe over the wire: JSON, no download headers, the splat without the query', async () => {
    const b = await boot();
    const r = await fetch(`http://127.0.0.1:${b.port}${DOWNLOAD}/notes%2Fplan.bin?probe=1`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r.headers.get('content-disposition')).toBeNull();
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(await r.json()).toEqual({ downloadable: true });
    // The router matches the pathname alone, so the splat is the key with no
    // `?probe` on it. The reads are the ones a download makes before its head:
    // the first range, then a one-range file's final check.
    expect(probe.calls).toEqual([
      { relPath: 'notes/plan.bin', offset: 0, length: MiB },
      { relPath: 'notes/plan.bin', offset: 4, length: 0 },
    ]);

    // A bare `?probe` with no value probes too. A mistyped probe gets the
    // small JSON answer, never the file.
    const bare = await fetch(`http://127.0.0.1:${b.port}${DOWNLOAD}/notes%2Fplan.bin?probe`);
    expect(bare.status).toBe(200);
    expect(bare.headers.get('content-disposition')).toBeNull();
    expect(await bare.json()).toEqual({ downloadable: true });

    // A refusal over the wire is the download's own.
    const gone = await fetch(`http://127.0.0.1:${b.port}${DOWNLOAD}/gone.md?probe=1`);
    expect(gone.status).toBe(404);
    expect(gone.headers.get('cache-control')).toBe('private, no-store');
    expect(await gone.json()).toEqual({ error: 'file-not-found' });
  });

  it('serves no git workspace download route', async () => {
    // `/download/files/*` read `workspace:read` and was removed with the git
    // tier (TASK-995). It answers 404, as for any unknown route.
    const b = await boot();
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/download/files/notes%2Fplan.bin`,
    );
    expect(r.status).toBe(404);
  });

  it('does not swallow the sibling READ route — /user-files/* still answers JSON', async () => {
    // `download` sits where `user-files` sits, so the two patterns cannot
    // overlap. Pinned because a route table is exactly the kind of thing that
    // looks obviously fine and is occasionally not.
    const b = await boot();
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/user-files/reports%2Fsummary.md`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    // The preview never reads a range.
    expect(probe.calls).toEqual([]);
  });
});

describe('sendTornRefusal (TASK-1025)', () => {
  /** A response whose `bodyStream` drains the source, failing as `@ax/http-server`'s does. */
  function fakeRes(fail?: (cause: unknown) => unknown) {
    const seen: {
      status: number | undefined;
      headers: Record<string, string>;
      bytes: number[];
      contentLength: number | undefined;
    } = { status: undefined, headers: {}, bytes: [], contentLength: undefined };
    const res: Pick<StreamingDownloadResponse, 'status' | 'header' | 'bodyStream'> = {
      status(n) {
        seen.status = n;
        return res as StreamingDownloadResponse;
      },
      header(k, v) {
        seen.headers[k] = v;
        return res as StreamingDownloadResponse;
      },
      async bodyStream(source, opts) {
        seen.contentLength = opts?.contentLength;
        try {
          for await (const chunk of source) seen.bytes.push(...chunk);
        } catch (cause) {
          throw fail !== undefined
            ? fail(cause)
            : Object.assign(new Error('the body source failed', { cause }), { code: 'source-failed' });
        }
      },
    };
    return { seen, res };
  }

  it('answers null for its own planned cut: the status, the JSON type, and all but the last byte', async () => {
    const { res, seen } = fakeRes();
    await expect(sendTornRefusal(res, 409, { error: 'file-changed' })).resolves.toBeNull();
    const whole = JSON.stringify({ error: 'file-changed' });
    expect(seen.status).toBe(409);
    expect(seen.headers).toEqual({ 'content-type': 'application/json; charset=utf-8' });
    expect(seen.contentLength).toBe(Buffer.byteLength(whole));
    expect(Buffer.from(seen.bytes).toString('utf-8')).toBe(whole.slice(0, -1));
  });

  it('answers the codes when the cut was not its own (the client left first), and never rejects', async () => {
    const { res } = fakeRes(() => Object.assign(new Error('gone'), { code: 'client-gone' }));
    await expect(sendTornRefusal(res, 404, { error: 'file-not-found' })).resolves.toEqual({ code: 'client-gone' });
  });

  it('never rejects, even when the response throws before a byte is written, and says so by a code', async () => {
    const res: Pick<StreamingDownloadResponse, 'status' | 'header' | 'bodyStream'> = {
      status: () => {
        throw new Error('response already finished');
      },
      header: () => res as StreamingDownloadResponse,
      bodyStream: async () => undefined,
    };
    await expect(sendTornRefusal(res, 404, { error: 'file-not-found' })).resolves.toEqual({ code: 'uncoded' });
  });

  it('reports a body that was somehow not cut at all', async () => {
    const res: Pick<StreamingDownloadResponse, 'status' | 'header' | 'bodyStream'> = {
      status: () => res as StreamingDownloadResponse,
      header: () => res as StreamingDownloadResponse,
      // An adapter that "finished" without draining the failing source.
      bodyStream: async () => undefined,
    };
    await expect(sendTornRefusal(res, 409, { error: 'file-changed' })).resolves.toEqual({ code: 'not-torn' });
  });

  it('does not take any source failure for its own: a foreign cause is reported, by code', async () => {
    const { res } = fakeRes(() =>
      Object.assign(new Error('the body source failed', { cause: Object.assign(new Error('x'), { code: 'EPIPE' }) }), {
        code: 'source-failed',
      }),
    );
    await expect(sendTornRefusal(res, 404, { error: 'file-not-found' })).resolves.toEqual({
      code: 'source-failed',
      causeCode: 'EPIPE',
    });
  });
});
