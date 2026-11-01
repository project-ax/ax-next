// @vitest-environment node
/**
 * The chat file chip's download (TASK-1012).
 *
 * A file the agent makes in its home during a turn gets a chip that names the
 * file by its key there (an `agent_file` block). The chip downloads it live,
 * through `GET /api/workspace/conversations/:conversationId/download/user-files/*`,
 * from the file itself: there is no copy. The bytes half is the Files tab's own
 * (`sendUserFileDownload`, TASK-1014), and `routes-workspace-download.test.ts`
 * pins it in depth. This file pins what belongs to this route:
 *
 *   1. THE CHIP ACL. The conversation must be the caller's own
 *      (`conversations:get-metadata`), and its agent must still be within the
 *      caller's reach (`agents:resolve`). The agent comes from the
 *      conversation, never from anything the request says.
 *   2. THE ORDER. authenticate → conversation → agent → path → read. Both
 *      checks run before the path is validated, so a stranger cannot tell a
 *      malformed key from a well-formed one, and nothing is read until both
 *      have passed.
 *   3. ONE DECODE. The chip encodes the whole key once with
 *      `encodeURIComponent`; the route decodes it once (`workspaceFilePath`).
 *   4. THE HELPER'S ANSWERS PASS THROUGH, and a lookup or a read that fails is
 *      a 503, never a 500. The real HookBus hands over a provider's plain throw
 *      as `PluginError{code:'unknown'}`, so the failure tests throw plain
 *      errors through a real bus.
 *
 * The direct-handler part calls the handler with a response fake whose
 * `bodyStream` mirrors `@ax/http-server`'s contract. The socket part goes
 * through the real router, because the splat (`req.params['*']`) and the
 * once-decoded `:conversationId` only exist for a route registered there.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import type {
  ReadUserFileRangeInput,
  ReadUserFileRangeOutput,
  UserFileVersion,
} from '@ax/sandbox-mount-protocol';
import {
  makeWorkspaceHandlers,
  registerWorkspaceRoutes,
  type DownloadRouteResponse,
} from '../../server/routes-workspace.js';
import { USER_FILE_DOWNLOAD_MAX_BYTES } from '../../server/user-file-download.js';
import type { RouteRequest } from '../../server/routes-chat.js';

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

const RANGE_HOOK = 'sandbox:read-user-file-range';
const METADATA_HOOK = 'conversations:get-metadata';

/**
 * The key from the plan's Review Focus: a space, a `#`, brackets and a `%`,
 * each of which means something to a URL.
 */
const KEY = 'reports/Q3 plan #1 (50%).pdf';
/** `encodeURIComponent(KEY)`, which is exactly what the chip sends. */
const SPLAT = 'reports%2FQ3%20plan%20%231%20(50%25).pdf';
/** A PDF's first bytes, plus a NUL and a 0xFF: bytes, not text. */
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x0a]);

const v = (s: string): UserFileVersion => s as UserFileVersion;

/** One conversation row: whose it is, and which agent's. */
interface ConversationRow {
  userId: string;
  agentId: string;
}

/** A file the fake range service holds. `size` pretends a file is bigger. */
interface FakeFile {
  bytes: Uint8Array;
  version: string;
  size?: number;
}

/**
 * `conversations:get-metadata`'s answer for a row, in the hook's own shape.
 */
function metadataOf(conversationId: string, row: ConversationRow): Record<string, unknown> {
  return {
    conversationId,
    userId: row.userId,
    agentId: row.agentId,
    runnerType: null,
    runnerSessionId: null,
    title: null,
    lastActivityAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    origin: 'web',
    activeSessionId: null,
  };
}

/** What an honest range reader answers for `input`. */
function honestAnswer(
  files: ReadonlyMap<string, FakeFile>,
  dirs: ReadonlySet<string>,
  input: ReadUserFileRangeInput,
): ReadUserFileRangeOutput {
  if (dirs.has(input.relPath)) return { kind: 'dir' };
  const f = files.get(input.relPath);
  if (f === undefined) return { kind: 'absent' };
  const size = f.size ?? f.bytes.byteLength;
  const n = Math.min(input.length, Math.max(0, size - input.offset));
  return {
    kind: 'file',
    size,
    version: v(f.version),
    bytes: f.bytes.subarray(input.offset, input.offset + n),
  };
}

function mkReq(params: Record<string, string>, query: Record<string, string> = {}): RouteRequest {
  return {
    headers: {},
    body: Buffer.alloc(0),
    cookies: {},
    query,
    params,
    signedCookie: () => null,
  };
}

interface CapturedDownload {
  statusCode: number;
  json: unknown;
  headers: Record<string, string>;
  /** `bodyStream`'s `contentLength`, or null when no body was ever started. */
  contentLength: number | null;
  chunks: Uint8Array[];
  /** The source finished, and its chunks added up to `contentLength`. */
  complete: boolean;
}

/** What `bodyStream` rejects with: an Error with a `code` (and a `cause`). */
function bodyStreamError(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code });
}

/**
 * The response adapter a download needs, as in `routes-workspace-download
 * .test.ts`: `bodyStream` pulls the source to the end and rejects
 * `source-failed` or `length-mismatch` the way `@ax/http-server` does. Header
 * names are lowercased, as the real server does.
 */
function mkRes(): { res: DownloadRouteResponse; captured: CapturedDownload; body: () => Buffer } {
  const captured: CapturedDownload = {
    statusCode: 0,
    json: undefined,
    headers: {},
    contentLength: null,
    chunks: [],
    complete: false,
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
        for (;;) {
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
        await it.return?.();
        throw err;
      }
    },
  };
  return { res, captured, body: () => Buffer.concat(captured.chunks) };
}

// ---------------------------------------------------------------------------
// The direct-handler part.
// ---------------------------------------------------------------------------
describe('the chat file chip download route', () => {
  let bus: HookBus;
  /** conversationId → row. */
  let conversations: Map<string, ConversationRow>;
  /** When set, `conversations:get-metadata` throws this instead. */
  let metadataFails: unknown;
  /** Agents the signed-in caller can reach. Any other is `forbidden`. */
  let reachable: Set<string>;
  /** When set, `agents:resolve` throws this instead. */
  let resolveFails: unknown;
  /** relPath → file. */
  let files: Map<string, FakeFile>;
  /** relPaths that are folders. */
  let dirs: Set<string>;
  /** When set, every range read throws this. */
  let rangeFails: unknown;
  let metadataCalls: unknown[];
  let resolveCalls: unknown[];
  let rangeCalls: Array<{
    agentId: string;
    userId: string;
    ownerAgentId: string;
    relPath: string;
    offset: number;
    length: number;
  }>;

  function registerAuth(user: { id: string; isAdmin: boolean } | null): void {
    bus.registerService('auth:require-user', 'auth', async () => {
      if (user === null) {
        throw new PluginError({ code: 'unauthenticated', plugin: 'auth', message: 'no session' });
      }
      return { user };
    });
  }

  /**
   * `conversations:get-metadata` as @ax/conversations answers it: the row is
   * kept only if `input.userId` owns it, so a missing, a deleted and a foreign
   * conversation are all `not-found`.
   *
   * Unlike the real hook, this fake does not also check the conversation's
   * agent. That way the route's own agent check is tested on its own; the
   * real hook's `forbidden` has a test of its own below.
   */
  function registerMetadata(): void {
    bus.registerService(METADATA_HOOK, 'conversations', async (_ctx, raw: unknown) => {
      const input = raw as { conversationId: string; userId: string };
      metadataCalls.push(input);
      if (metadataFails !== undefined) throw metadataFails;
      const row = conversations.get(input.conversationId);
      if (row === undefined || row.userId !== input.userId) {
        throw new PluginError({
          code: 'not-found',
          plugin: 'conversations',
          hookName: METADATA_HOOK,
          message: `conversation '${input.conversationId}' not found`,
        });
      }
      return metadataOf(input.conversationId, row);
    });
  }

  function registerAgents(): void {
    bus.registerService('agents:resolve', 'agents', async (_ctx, raw: unknown) => {
      const input = raw as { agentId: string; userId: string };
      resolveCalls.push(input);
      if (resolveFails !== undefined) throw resolveFails;
      if (!reachable.has(input.agentId)) {
        throw new PluginError({ code: 'forbidden', plugin: 'agents', message: 'not yours' });
      }
      return { agent: { id: input.agentId, displayName: 'Inbox' } };
    });
  }

  /** A stand-in for whichever sandbox provider is loaded. */
  function registerRange(): void {
    bus.registerService<ReadUserFileRangeInput, ReadUserFileRangeOutput>(
      RANGE_HOOK,
      'sandbox',
      async (ctx, input) => {
        rangeCalls.push({
          agentId: ctx.agentId,
          userId: ctx.userId ?? '',
          ownerAgentId: input.owner.agentId,
          relPath: input.relPath,
          offset: input.offset,
          length: input.length,
        });
        if (rangeFails !== undefined) throw rangeFails;
        return honestAnswer(files, dirs, input);
      },
    );
  }

  /** The usual set-up: signed in as u1, every hook the route reads up. */
  function standardBus(): void {
    registerAuth({ id: 'u1', isAdmin: false });
    registerMetadata();
    registerAgents();
    registerRange();
  }

  async function download(
    params: Record<string, string>,
    query: Record<string, string> = {},
  ): Promise<ReturnType<typeof mkRes>> {
    const d = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).conversationAgentFileDownload(
      mkReq(params, query),
      d.res,
    );
    return d;
  }

  beforeEach(() => {
    bus = new HookBus();
    conversations = new Map([
      ['c1', { userId: 'u1', agentId: 'a1' }],
      // A teammate's conversation with a team agent the caller can ALSO reach:
      // reaching the agent is not owning the conversation.
      ['c-theirs', { userId: 'u2', agentId: 'a1' }],
    ]);
    metadataFails = undefined;
    // a2 is reachable too, so a route that took its agent from the request
    // instead of the conversation would read a2's files rather than be refused.
    reachable = new Set(['a1', 'a2']);
    resolveFails = undefined;
    files = new Map([[KEY, { bytes: PDF, version: 'v1' }]]);
    dirs = new Set();
    rangeFails = undefined;
    metadataCalls = [];
    resolveCalls = [];
    rangeCalls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- the happy path ------------------------------------------------------

  it('serves the owner the file the key names, decoded once, from the conversation’s own agent', async () => {
    standardBus();
    expect(encodeURIComponent(KEY)).toBe(SPLAT);

    // Everything in the request that could name an agent says a2. The
    // conversation says a1, and only the conversation decides.
    const d = await download({ conversationId: 'c1', agentId: 'a2', '*': SPLAT }, { agentid: 'a2' });

    expect(d.captured.statusCode).toBe(200);
    expect(d.captured.complete).toBe(true);
    expect(d.body().equals(Buffer.from(PDF))).toBe(true);
    expect(d.captured.contentLength).toBe(PDF.byteLength);
    // The Files tab's download headers, the filename from the key's last
    // segment (sanitized for the header).
    expect(d.captured.headers).toEqual({
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="Q3 plan _1 _50__.pdf"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });

    // Asked as the session's user, about the conversation in the URL...
    expect(metadataCalls).toEqual([{ conversationId: 'c1', userId: 'u1' }]);
    // ...then about the agent THAT conversation names...
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'u1' }]);
    // ...and every range is read on that agent's own ctx and owner.
    expect(rangeCalls.length).toBeGreaterThan(0);
    for (const call of rangeCalls) {
      expect(call).toMatchObject({ agentId: 'a1', userId: 'u1', ownerAgentId: 'a1', relPath: KEY });
    }
  });

  // --- who is asking -------------------------------------------------------

  it('401s without a session, and looks nothing up', async () => {
    registerAuth(null);
    registerMetadata();
    registerAgents();
    registerRange();
    const d = await download({ conversationId: 'c1', '*': SPLAT });
    expect(d.captured.statusCode).toBe(401);
    expect(metadataCalls).toEqual([]);
    expect(rangeCalls).toEqual([]);
  });

  it('400s a request with no conversation id, before any lookup', async () => {
    standardBus();
    const d = await download({ '*': SPLAT });
    expect(d.captured.statusCode).toBe(400);
    expect(d.captured.json).toEqual({ error: 'missing-conversation-id' });
    expect(metadataCalls).toEqual([]);
    expect(rangeCalls).toEqual([]);
  });

  // --- the conversation gate -----------------------------------------------

  it.each([
    { label: 'a conversation that does not exist', conversationId: 'c-none' },
    {
      label: 'a teammate’s conversation, though the caller can reach its agent',
      conversationId: 'c-theirs',
    },
  ])('404s $label, and never resolves the agent or reads', async ({ conversationId }) => {
    standardBus();
    const d = await download({ conversationId, '*': SPLAT });
    expect(d.captured.statusCode).toBe(404);
    expect(d.captured.json).toEqual({ error: 'file-not-found' });
    expect(d.captured.contentLength).toBeNull();
    expect(resolveCalls).toEqual([]);
    expect(rangeCalls).toEqual([]);
  });

  it('404s when the conversation hook says its agent is out of reach (forbidden)', async () => {
    // The real hook runs `agents:resolve` itself and passes a `forbidden` on.
    metadataFails = new PluginError({
      code: 'forbidden',
      plugin: 'conversations',
      hookName: METADATA_HOOK,
      message: "agent 'a1' not accessible",
    });
    standardBus();
    const d = await download({ conversationId: 'c1', '*': SPLAT });
    expect(d.captured.statusCode).toBe(404);
    expect(d.captured.json).toEqual({ error: 'file-not-found' });
    expect(rangeCalls).toEqual([]);
  });

  it('checks the conversation BEFORE the path: a malformed key on a teammate’s conversation is 404, not 400', async () => {
    /*
      If the path were validated first, a caller probing somebody else's
      conversation would get 400 for `..%2Fx` and 404 for a real-looking key,
      and the difference would tell them which keys are well-formed. On their
      own conversation the same key is the 400 it should be.
    */
    standardBus();
    const theirs = await download({ conversationId: 'c-theirs', '*': '..%2Fx' });
    expect(theirs.captured.statusCode).toBe(404);
    const own = await download({ conversationId: 'c1', '*': '..%2Fx' });
    expect(own.captured.statusCode).toBe(400);
    expect(rangeCalls).toEqual([]);
  });

  it('503s a conversation lookup that fails, logs it by conversation id, and never reads', async () => {
    // The store throws a plain error; the real bus hands it over as
    // `PluginError{code:'unknown'}`. "We could not check" is not "not yours".
    metadataFails = new Error('connection terminated unexpectedly');
    standardBus();
    const warn = vi.spyOn(initCtx.logger, 'warn').mockImplementation(() => undefined);

    // Resolves: the handler answers, it does not throw (a throw is a 500).
    const d = await download({ conversationId: 'c1', '*': SPLAT });

    expect(d.captured.statusCode).toBe(503);
    expect(d.captured.json).toEqual({ error: 'agent-unavailable' });
    expect(warn.mock.calls).toEqual([
      ['workspace_conversation_file_acl_failed', { conversationId: 'c1' }],
    ]);
    expect(resolveCalls).toEqual([]);
    expect(rangeCalls).toEqual([]);
    // The failure the route saw is the wrapped shape, not the plain error.
    await expect(
      bus.call(METADATA_HOOK, initCtx, { conversationId: 'c1', userId: 'u1' }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'unknown' });
  });

  it('503s when this deployment has no conversation metadata to check against, and never reads', async () => {
    // `conversations:get-metadata` is an optional call: no producer means no
    // way to know whose conversation this is. That is "unavailable", never a
    // 404 (it may well be theirs) and never a read. It is a fact about the
    // deployment (the manifest says so), not a failed lookup, so it is not
    // logged as one on every click.
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerRange();
    const warn = vi.spyOn(initCtx.logger, 'warn').mockImplementation(() => undefined);
    const d = await download({ conversationId: 'c1', '*': SPLAT });
    expect(d.captured.statusCode).toBe(503);
    expect(d.captured.json).toEqual({ error: 'agent-unavailable' });
    expect(warn).not.toHaveBeenCalled();
    expect(resolveCalls).toEqual([]);
    expect(rangeCalls).toEqual([]);
  });

  // --- the agent gate ------------------------------------------------------

  it('404s when the caller can no longer reach the conversation’s agent, and never reads', async () => {
    // Their own conversation, but the team agent was unshared since. The
    // answer is `resolveAgentOr404`'s, the Files tab's own; only an owner of
    // the conversation ever gets this far, so it tells a stranger nothing.
    reachable.delete('a1');
    standardBus();
    const d = await download({ conversationId: 'c1', '*': SPLAT });
    expect(d.captured.statusCode).toBe(404);
    expect(d.captured.json).toEqual({ error: 'agent-not-found' });
    expect(resolveCalls).toEqual([{ agentId: 'a1', userId: 'u1' }]);
    expect(rangeCalls).toEqual([]);
  });

  it('503s an agents:resolve outage, never a read or a 500', async () => {
    resolveFails = new Error('teams lookup timed out');
    standardBus();
    const d = await download({ conversationId: 'c1', '*': SPLAT });
    expect(d.captured.statusCode).toBe(503);
    expect(d.captured.json).toEqual({ error: 'agent-unavailable' });
    expect(rangeCalls).toEqual([]);
  });

  // --- the key -------------------------------------------------------------

  it.each([
    { label: 'an encoded ..', splat: '..%2Fx' },
    { label: 'an absolute path', splat: '%2Fetc%2Fpasswd' },
    { label: 'no key at all (the root is a folder)', splat: '' },
  ])('400s $label on the caller’s own conversation, without reading', async ({ splat }) => {
    standardBus();
    const d = await download({ conversationId: 'c1', '*': splat });
    expect(d.captured.statusCode).toBe(400);
    expect(d.captured.json).toEqual({ error: 'invalid-path' });
    expect(rangeCalls).toEqual([]);
  });

  it('decodes the key exactly once: a doubly-encoded `..` is a literal (missing) file name', async () => {
    // `%252e%252e%252fx` decodes ONCE to `%2e%2e%2fx`: no slash, no `..`, so
    // a valid (odd) name. Decoding it again would make it a traversal.
    standardBus();
    const d = await download({ conversationId: 'c1', '*': '%252e%252e%252fx' });
    expect(d.captured.statusCode).toBe(404);
    expect(d.captured.json).toEqual({ error: 'file-not-found' });
    expect(rangeCalls.map((c) => c.relPath)).toEqual(['%2e%2e%2fx']);
  });

  // --- the helper's answers pass through -----------------------------------

  it('404s a file that is gone (the reader says `absent`, as it does for a link)', async () => {
    standardBus();
    files.delete(KEY);
    const d = await download({ conversationId: 'c1', '*': SPLAT });
    expect(d.captured.statusCode).toBe(404);
    expect(d.captured.json).toEqual({ error: 'file-not-found' });
    expect(d.captured.contentLength).toBeNull();
  });

  it('400s a key that is a folder now: not-a-file', async () => {
    standardBus();
    dirs.add('reports');
    const d = await download({ conversationId: 'c1', '*': 'reports' });
    expect(d.captured.statusCode).toBe(400);
    expect(d.captured.json).toEqual({ error: 'not-a-file' });
    expect(d.captured.contentLength).toBeNull();
  });

  it('413s a file over the download ceiling after one read, with no body', async () => {
    standardBus();
    files.set('huge.bin', {
      bytes: new Uint8Array(16),
      size: USER_FILE_DOWNLOAD_MAX_BYTES + 1,
      version: 'v1',
    });
    const d = await download({ conversationId: 'c1', '*': 'huge.bin' });
    expect(d.captured.statusCode).toBe(413);
    expect(d.captured.json).toEqual({ error: 'file-too-large' });
    expect(d.captured.contentLength).toBeNull();
    expect(rangeCalls).toHaveLength(1);
  });

  it('503s a read that fails (a plain EIO, which the real bus wraps as unknown), never a 500', async () => {
    rangeFails = Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    standardBus();
    const d = await download({ conversationId: 'c1', '*': SPLAT });
    expect(d.captured.statusCode).toBe(503);
    expect(d.captured.json).toEqual({ error: 'file-read-failed' });
    expect(d.captured.contentLength).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The socket part: the real router and http-server.
// ---------------------------------------------------------------------------
describe('the chat file chip download route over a real socket', () => {
  const COOKIE_KEY = randomBytes(32);
  /** A conversation id the chip has to encode: a space and an `&`. */
  const CONVERSATION = 'c & 1';
  let harness: TestHarness | null = null;
  let savedAllowNoOrigins: string | undefined;
  let probe: { metadata: unknown[]; ranges: Array<{ ownerAgentId: string; relPath: string }> };

  beforeEach(() => {
    probe = { metadata: [], ranges: [] };
    savedAllowNoOrigins = process.env.AX_HTTP_ALLOW_NO_ORIGINS;
  });

  afterEach(async () => {
    if (harness !== null) {
      await harness.close({ onError: () => {} });
      harness = null;
    }
    if (savedAllowNoOrigins === undefined) delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
    else process.env.AX_HTTP_ALLOW_NO_ORIGINS = savedAllowNoOrigins;
  });

  async function boot(): Promise<number> {
    const plugin: HttpServerPlugin = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY,
      allowedOrigins: [],
    });
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
    const rows = new Map<string, ConversationRow>([
      [CONVERSATION, { userId: 'u1', agentId: 'a1' }],
      ['c-theirs', { userId: 'u2', agentId: 'a1' }],
    ]);
    const files = new Map<string, FakeFile>([[KEY, { bytes: PDF, version: 'v1' }]]);
    harness = await createTestHarness({
      services: {
        'auth:require-user': async () => ({ user: { id: 'u1', isAdmin: false } }),
        [METADATA_HOOK]: async (_ctx: unknown, raw: unknown) => {
          const input = raw as { conversationId: string; userId: string };
          probe.metadata.push(input);
          const row = rows.get(input.conversationId);
          if (row === undefined || row.userId !== input.userId) {
            throw new PluginError({ code: 'not-found', plugin: 'mock-conversations', message: 'nope' });
          }
          return metadataOf(input.conversationId, row);
        },
        'agents:resolve': async (_ctx: unknown, raw: unknown) => {
          const { agentId } = raw as { agentId: string };
          if (agentId !== 'a1') {
            throw new PluginError({ code: 'not-found', plugin: 'mock-agents', message: 'nope' });
          }
          return { agent: { id: 'a1', displayName: 'Inbox' } };
        },
        [RANGE_HOOK]: async (_ctx: unknown, raw: unknown) => {
          const input = raw as ReadUserFileRangeInput;
          probe.ranges.push({ ownerAgentId: input.owner.agentId, relPath: input.relPath });
          return honestAnswer(files, new Set(), input);
        },
      },
      plugins: [plugin],
    });
    await registerWorkspaceRoutes(harness.bus, initCtx);
    return plugin.boundPort();
  }

  const url = (port: number, conversationId: string, splat: string): string =>
    `http://127.0.0.1:${port}/api/workspace/conversations/${encodeURIComponent(conversationId)}/download/user-files/${splat}`;

  it('serves the owner the bytes, the id and the key each decoded once', async () => {
    const port = await boot();
    // Exactly what the chip will send: both parts encoded whole, once.
    const r = await fetch(url(port, CONVERSATION, encodeURIComponent(KEY)));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="Q3 plan _1 _50__.pdf"');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('content-length')).toBe(String(PDF.byteLength));
    expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual(Array.from(PDF));
    expect(probe.metadata).toEqual([{ conversationId: CONVERSATION, userId: 'u1' }]);
    expect(probe.ranges.every((c) => c.ownerAgentId === 'a1' && c.relPath === KEY)).toBe(true);
    expect(probe.ranges.length).toBeGreaterThan(0);
  });

  it('404s a teammate’s conversation over the wire, without reading', async () => {
    const port = await boot();
    const r = await fetch(url(port, 'c-theirs', encodeURIComponent(KEY)));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'file-not-found' });
    expect(probe.ranges).toEqual([]);
  });

  it('400s an encoded traversal over the wire, without reading', async () => {
    const port = await boot();
    const r = await fetch(url(port, CONVERSATION, '..%2F..%2Fetc%2Fpasswd'));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid-path' });
    expect(probe.ranges).toEqual([]);
  });
});
