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

function mkReq(params: Record<string, string> = {}): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query: {},
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
    expect(d.captured.contentLength).toBeNull();

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
      const { captured } = await download(splat);
      expect(captured.statusCode).toBe(400);
      expect(captured.contentLength).toBeNull();
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
    expect(d.captured.json).toEqual({ error: 'missing-agent-id' });
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
    const { captured } = await download('x.md');
    expect(captured.statusCode).toBe(503);
    expect(captured.json).toEqual({ error: 'user-files-unavailable' });
    expect(captured.contentLength).toBeNull();
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
      The Files tab holds a download in memory before it saves it, so there is
      a size past which we do not start. The first range says how big the file
      is; past the ceiling we refuse right there, before a header or a byte of
      the body, and read nothing more.
    */
    standardBus();
    files.set('huge.bin', {
      bytes: ONE_MIB,
      size: USER_FILE_DOWNLOAD_MAX_BYTES + 1,
      read: (_offset, n) => ONE_MIB.subarray(0, Math.min(n, MiB)),
      version: 'v1',
    });
    const { captured } = await download('huge.bin');
    expect(captured.statusCode).toBe(413);
    expect(captured.json).toEqual({ error: 'file-too-large' });
    expect(captured.contentLength).toBeNull();
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
    const { captured } = await download('reports');
    expect(captured.statusCode).toBe(400);
    expect(captured.json).toEqual({ error: 'not-a-file' });
    expect(captured.contentLength).toBeNull();
  });

  it('404s an absent path', async () => {
    standardBus();
    const { captured } = await download('gone.md');
    expect(captured.statusCode).toBe(404);
    expect(captured.json).toEqual({ error: 'file-not-found' });
    expect(captured.contentLength).toBeNull();
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
    const { captured } = await download('report.md');
    expect(captured.statusCode).toBe(503);
    expect(captured.json).toEqual({ error: 'user-files-unavailable' });
    expect(captured.contentLength).toBeNull();
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
    const { captured } = await download('reports%2Fq3.pdf');
    expect(captured.statusCode).toBe(503);
    expect(captured.json).toEqual({ error: 'file-read-failed' });
    expect(captured.contentLength).toBeNull();
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
    const { captured } = await download('report.md');
    expect(captured.statusCode).toBe(503);
    // No host mount is a fact about the deployment (retrying won't help), so it
    // gets the "no file area" answer, not the "a read failed" one.
    expect(captured.json).toEqual({ error });
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
    const { captured } = await download('report.md');
    expect(captured.statusCode).toBe(503);
    expect(captured.json).toEqual({ error: 'file-read-failed' });
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
    const { captured } = await download('report.md');
    expect(captured.statusCode).toBe(503);
    expect(captured.json).toEqual({ error: 'file-read-failed' });
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
    const { captured } = await download('report.md');
    expect(captured.statusCode).toBe(503);
    expect(captured.json).toEqual({ error: 'file-read-failed' });
    expect(captured.contentLength).toBeNull();
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
      label: 'a short FIRST chunk (it shrank between the size and the read)',
      tamper: (n, _i, honest) =>
        n === 1 ? asFile(honest, (f) => ({ ...f, bytes: f.bytes.subarray(0, 10) })) : honest,
      calls: 1,
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

  it('503s a read that throws over the wire, never a 500', async () => {
    tamper = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    const b = await boot();
    const r = await fetch(`http://127.0.0.1:${b.port}${DOWNLOAD}/notes%2Fplan.bin`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'file-read-failed' });
  });

  it('413s a file over the ceiling over the wire, after one read', async () => {
    const b = await boot();
    const r = await fetch(`http://127.0.0.1:${b.port}${DOWNLOAD}/huge.csv`);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'file-too-large' });
    expect(probe.calls).toHaveLength(1);
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
