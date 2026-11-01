// @vitest-environment node
/**
 * The DOWNLOAD route (TASK-355; the git-backed `/download/files/*` sibling was
 * removed in TASK-995).
 *
 * The Files tab could always show you a file and never hand it to you: the
 * read route answers with TEXT, so a PDF an agent made rendered as the word
 * "binary" and a long file rendered as its first 128 KiB. These routes are the
 * bytes.
 *
 * They serve caller-named paths out of a store written entirely by an
 * untrusted agent, which puts most of this file on the security half rather
 * than the happy path. The three things it is really pinning:
 *
 *   1. THE ORDER. authenticate → ACL → validate path → read. Every
 *      step is asserted separately, and the 2-before-3 pair has its own test,
 *      because swapping them turns the error code into an oracle over another
 *      tenant's paths.
 *   2. THE BYTES ARE THE BYTES. A download that quietly served a prefix would
 *      be a corrupt file that looks like a whole one — worse than a refusal,
 *      because the person finds out when they open it. So: whole file or an
 *      honest 413, never a fragment.
 *   3. THE HEADERS ARE OURS. Content-Type is a constant, never sniffed and
 *      never caller-supplied; the filename is sanitized before it reaches a
 *      header a newline can end.
 *
 * The direct-handler part calls the handlers directly. The socket part goes
 * over a real socket, because the splat (`req.params['*']`) only exists for a route declared with a bare
 * trailing `*` and a direct-handler test writes `params` itself — it would
 * keep passing over a route pattern that matches nothing.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import {
  FILE_BODY_MAX_BYTES,
  makeWorkspaceHandlers,
  registerWorkspaceRoutes,
  type DownloadRouteResponse,
} from '../../server/routes-workspace.js';
import type { RouteRequest } from '../../server/routes-chat.js';

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

const enc = new TextEncoder();

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

interface CapturedDownload {
  statusCode: number;
  json: unknown;
  headers: Record<string, string>;
  bytes: Buffer | null;
  bodyContentType: string | undefined;
}

/**
 * The response adapter a download needs — `header` and `body` on top of the
 * JSON one every other route test builds. Header names are lowercased because
 * `@ax/http-server` lowercases them, so a test that asserted on `Content-Type`
 * would be asserting about a spelling the real server never uses.
 */
function mkRes(): { res: DownloadRouteResponse; captured: CapturedDownload } {
  const captured: CapturedDownload = {
    statusCode: 0,
    json: undefined,
    headers: {},
    bytes: null,
    bodyContentType: undefined,
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
    json(v: unknown) {
      captured.json = v;
    },
    body(buf: Buffer, contentType?: string) {
      captured.bytes = Buffer.from(buf);
      captured.bodyContentType = contentType;
    },
    text() {
      /* unused */
    },
    end() {
      /* unused */
    },
  };
  return { res, captured };
}

// ---------------------------------------------------------------------------
// The direct-handler part.
// ---------------------------------------------------------------------------
describe('the download route', () => {
  let bus: HookBus;
  /** path → whatever `sandbox:read-user-files` answers. */
  let tier: Map<string, unknown>;
  let tierReads: Array<{
    agentId: string;
    userId: string;
    ownerAgentId: string;
    relPath: string | undefined;
  }>;

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

  function registerReader(): void {
    bus.registerService('sandbox:read-user-files', 'sandbox', async (ctx, i: unknown) => {
      const { owner, relPath } = i as {
        owner: { agentId: string };
        relPath?: string;
      };
      tierReads.push({
        agentId: ctx.agentId,
        userId: ctx.userId ?? '',
        ownerAgentId: owner.agentId,
        relPath,
      });
      return tier.get(relPath ?? '') ?? { kind: 'absent' };
    });
  }

  function handlers() {
    return makeWorkspaceHandlers({ bus, initCtx });
  }

  beforeEach(() => {
    bus = new HookBus();
    tier = new Map();
    tierReads = [];
  });

  /** A whole (not truncated) file answer, as the reader gives it. */
  function whole(bytes: Uint8Array): unknown {
    return { kind: 'file', contents: bytes, truncated: false };
  }

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
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('x.md', whole(enc.encode('secret')));

    const d = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'someone-elses', '*': 'x.md' }),
      d.res,
    );
    expect(d.captured.statusCode).toBe(404);
    expect(d.captured.bytes).toBeNull();

    // Not "it read and found nothing" — it never read at all.
    expect(tierReads).toEqual([]);
  });

  it('runs the ACL BEFORE path validation, so a bad path on a foreign agent still 404s', async () => {
    /*
      If the path were validated first, a caller probing somebody else's agent
      would get 400 for `../x` and 404 for `x.md` — and that difference tells
      them which of the other tenant's paths are well-formed. Both are 404.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();

    const d = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'someone-elses', '*': '..%2F..%2Fetc%2Fpasswd' }),
      d.res,
    );
    expect(d.captured.statusCode).toBe(404);
    expect(tierReads).toEqual([]);
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
      registerAuth({ id: 'u1', isAdmin: false });
      registerAgents();
      registerReader();
      const { res, captured } = mkRes();
      await handlers().agentUserFileDownload(
        mkReq({ agentId: 'a1', '*': splat }),
        res,
      );
      expect(captured.statusCode).toBe(400);
      expect(captured.bytes).toBeNull();
      expect(tierReads).toEqual([]);
    });
  }

  it('400s a request with no path at all, rather than reading the root', async () => {
    // `/download/user-files/` with nothing after it. `workspaceFilePath('')` is
    // `null`, so the route answers the same 400 a malformed path gets — there
    // is no "download everything" here, and a root read that silently became a
    // directory listing would be a different route's answer arriving under this
    // one's headers.
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();

    const d = mkRes();
    await handlers().agentUserFileDownload(mkReq({ agentId: 'a1' }), d.res);
    expect(d.captured.statusCode).toBe(400);
    expect(tierReads).toEqual([]);
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
      it as a traversal and NOT to decode again. A validator that decodes twice
      can be walked past by encoding three times, so what is pinned here is the
      exact string the reader was asked for.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    const d = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': '%252e%252e%252fsecret' }),
      d.res,
    );
    expect(d.captured.statusCode).toBe(404);
    expect(tierReads.map((c) => c.relPath)).toEqual(['%2e%2e%2fsecret']);
  });

  it('hides nothing by name', async () => {
    // On the agent's own file area `memory/` is just a folder somebody named
    // `memory`, and `.ax/` and `.claude/` are plain names too (the git-backed
    // tier that hid them was removed in TASK-995). Hiding any of them would be
    // a lie about their own files.
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('memory/notes.md', whole(enc.encode('mine')));
    tier.set('.ax/SOUL.md', whole(enc.encode('also mine')));
    const a = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'memory%2Fnotes.md' }),
      a.res,
    );
    expect(a.captured.statusCode).toBe(200);
    expect(a.captured.bytes?.toString('utf-8')).toBe('mine');
    const b = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': '.ax%2FSOUL.md' }),
      b.res,
    );
    expect(b.captured.statusCode).toBe(200);
    expect(b.captured.bytes?.toString('utf-8')).toBe('also mine');
  });

  // --- no backend ----------------------------------------------------------

  it('503s when no sandbox provider can read the files', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    const d = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'x.md' }),
      d.res,
    );
    expect(d.captured.statusCode).toBe(503);
    expect(d.captured.json).toEqual({ error: 'user-files-unavailable' });
  });

  // --- the bytes -----------------------------------------------------------

  it('serves a text file WHOLE, with the headers that make it a download', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('notes/plan.md', whole(enc.encode('# Plan\n\nShip it.')));
    const { res, captured } = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'notes%2Fplan.md' }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.bytes?.toString('utf-8')).toBe('# Plan\n\nShip it.');
    expect(captured.headers['content-disposition']).toBe(
      'attachment; filename="plan.md"',
    );
    expect(captured.headers['x-content-type-options']).toBe('nosniff');
    // Content-Length is `@ax/http-server`'s to set — it pins it from the
    // buffer it writes. The over-the-wire test below is where it is checked,
    // because that is the only place the real value exists.
  });

  it('serves a BINARY file byte for byte — the case the preview calls "binary"', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    // A PNG header, NUL included. The read route answers `body: null,
    // clipped: 'binary'` for this — which is the whole reason this route
    // exists — so the assertion is that the bytes arrive untouched.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x1a]);
    tier.set('chart.png', whole(png));
    const { res, captured } = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'chart.png' }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect(Array.from(captured.bytes ?? [])).toEqual(Array.from(png));
  });

  it('serves a file the PREVIEW would clip, whole', async () => {
    /*
      The preview stops at FILE_BODY_MAX_BYTES and says `clipped: 'too-large'`.
      That bound is the JSON envelope's, not the file's, and applying it here
      would make the download a longer-winded version of the same clipped read.
      A download that serves 128 KiB of a 132 KiB file is a broken file.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('log.txt', whole(enc.encode('x'.repeat(FILE_BODY_MAX_BYTES + 4096))));
    const { res, captured } = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'log.txt' }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.bytes?.byteLength).toBe(FILE_BODY_MAX_BYTES + 4096);
  });

  // --- the content type ----------------------------------------------------

  it('never lets the FILE decide its own content type', async () => {
    /*
      The bytes here are a whole HTML document with a script in it, and the
      name ends in `.html`. Serving that as `text/html` on our own origin is
      stored XSS written by an agent. The answer is the same constant it is for
      every other file, plus nosniff, plus `attachment` — the boring trio that
      means "save this, do not run it".
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('page.html', whole(enc.encode('<script>alert(1)</script>')));
    const { res, captured } = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'page.html' }),
      res,
    );
    expect(captured.headers['content-type']).toBe('application/octet-stream');
    expect(captured.headers['x-content-type-options']).toBe('nosniff');
    expect(captured.headers['content-disposition']).toMatch(/^attachment; /);
    // Said ONCE, through the header. `body()` takes a content type too, and
    // passing it there as well would be two places to change it and one place
    // to forget.
    expect(captured.bodyContentType).toBeUndefined();
  });

  it('SANITIZES the filename before it reaches the header', async () => {
    /*
      A filename is agent-authored and `Content-Disposition` is a header a
      newline ends. This name carries a quote (which would close the filename
      early), a semicolon (which would start a new parameter) and a CRLF (which
      would start a new HEADER — response splitting). None of them may survive.

      Note what this name does NOT contain: a colon. `workspaceFilePath` would
      have rejected the whole path for one, which is the outer layer of this
      defense — but it lets a quote and a bare CR through, because it is
      answering a different question (is this a path we will read?) than the
      header is (is this a filename we will print?). Two layers, and this test
      is about the inner one, so the name is built to reach it.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    const nasty = 'in"voice;\r\nX-Injected- yes.md';
    tier.set(nasty, whole(enc.encode('ok')));
    const { res, captured } = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': encodeURIComponent(nasty) }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    const disp = captured.headers['content-disposition'] ?? '';
    expect(disp).toBe('attachment; filename="in_voice___X-Injected- yes.md"');
    expect(disp).not.toContain('\r');
    expect(disp).not.toContain('\n');
    // Exactly two quotes — the pair we wrote. A third would mean the name
    // closed the parameter and whatever followed became header syntax.
    expect(disp.split('"')).toHaveLength(3);
  });

  // --- truncation ----------------------------------------------------------

  it('REFUSES a truncated file rather than serving a fragment', async () => {
    /*
      `sandbox:read-user-files` bounds one read at 1 MiB and answers with a
      PREFIX — correct for a preview that says "showing the beginning", and a
      disaster here: a truncated PDF is a corrupt PDF that looks exactly like a
      whole one, and the person finds out when they open it rather than when
      they click. So we refuse, and the client turns the 413 into a sentence
      that says we can only reach the beginning of it.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('huge.csv', {
      kind: 'file',
      contents: enc.encode('only the beginning'),
      truncated: true,
    });
    const { res, captured } = mkRes();
    await handlers().agentUserFileDownload(mkReq({ agentId: 'a1', '*': 'huge.csv' }), res);
    expect(captured.statusCode).toBe(413);
    expect(captured.json).toEqual({ error: 'file-too-large' });
    // Nothing partial goes out with the refusal.
    expect(captured.bytes).toBeNull();
  });

  it('refuses when the reader did not SAY whether the file was whole', async () => {
    /*
      A realization that predates `truncated` answers `undefined`, and
      `undefined` is not `false` — it is "we do not know". We cannot hand
      somebody a file on a maybe, so unknown fails the same way truncated does.
      This is the branch a `=== true` check would sail straight past.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('unknown.bin', { kind: 'file', contents: enc.encode('who knows') });
    const { res, captured } = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'unknown.bin' }),
      res,
    );
    expect(captured.statusCode).toBe(413);
    expect(captured.bytes).toBeNull();
  });

  // --- the other answers ---------------------------------------------------

  it('400s a directory — a folder is not a download', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('reports', { kind: 'dir', entries: [{ name: 'x.md', kind: 'file' }] });
    const { res, captured } = mkRes();
    await handlers().agentUserFileDownload(mkReq({ agentId: 'a1', '*': 'reports' }), res);
    expect(captured.statusCode).toBe(400);
    expect(captured.json).toEqual({ error: 'not-a-file' });
  });

  it('404s an absent path', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    const d = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'gone.md' }),
      d.res,
    );
    expect(d.captured.statusCode).toBe(404);
  });

  it('503s the download when this deployment keeps no files', async () => {
    /*
      TASK-403. `unavailable` is "there is no file area for this agent here",
      and it used to arrive as `absent` — a 404 the reader would read as "that
      file is gone". It is decided before the path is looked at, so answering
      it differently cannot be used to probe which paths exist.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    bus.registerService('sandbox:read-user-files', 'sandbox', async () => ({
      kind: 'unavailable',
    }));
    const d = mkRes();
    await handlers().agentUserFileDownload(
      mkReq({ agentId: 'a1', '*': 'report.md' }),
      d.res,
    );
    expect(d.captured.statusCode).toBe(503);
    expect(d.captured.bytes).toBeNull();
  });

  it('REGRESSION: a download whose read THREW hands over no bytes', async () => {
    /*
      A failed read must not become an empty or a missing file on the way to
      somebody's disk. The handler does not catch, so the rejection becomes a
      500 — and nothing at all is written.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    bus.registerService('sandbox:read-user-files', 'sandbox', async () => {
      throw new PluginError({
        code: 'userfiles-read-failed',
        plugin: 'sandbox',
        message: 'the export would not answer',
      });
    });
    const d = mkRes();
    await expect(
      handlers().agentUserFileDownload(
        mkReq({ agentId: 'a1', '*': 'report.md' }),
        d.res,
      ),
    ).rejects.toThrow();
    expect(d.captured.bytes).toBeNull();
    expect(d.captured.statusCode).not.toBe(404);
    expect(d.captured.statusCode).not.toBe(200);
  });

  // --- routing -------------------------------------------------------------

  it('reads on the AGENT’s own context and owner, never the plugin’s', async () => {
    /*
      It is what keeps a download from crossing into another agent's tree: the
      reader joins `owner.agentId` onto the export root. The plugin's own
      initCtx (`@ax/channel-web` / `system`) would land in the wrong subtree,
      or in every subtree.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('x.md', whole(enc.encode('d')));

    const d = mkRes();
    await handlers().agentUserFileDownload(mkReq({ agentId: 'a1', '*': 'x.md' }), d.res);
    expect(tierReads[0]?.agentId).toBe('a1');
    expect(tierReads[0]?.userId).toBe('u1');
    expect(tierReads[0]?.ownerAgentId).toBe('a1');
  });
});

// ---------------------------------------------------------------------------
// The socket part — one round trip through a real router.
// ---------------------------------------------------------------------------
describe('the download route over a real socket', () => {
  const COOKIE_KEY = randomBytes(32);
  let harness: TestHarness | null = null;

  async function boot(): Promise<{ harness: TestHarness; port: number }> {
    const http: HttpServerPlugin = createHttpServerPlugin({
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
        'sandbox:read-user-files': async (_ctx: unknown, input: unknown) => {
          const { relPath } = input as { relPath?: string };
          if (relPath === 'notes/plan.bin') {
            return {
              kind: 'file',
              contents: Uint8Array.from([0x00, 0x01, 0xff, 0x0a]),
              truncated: false,
            };
          }
          if (relPath === 'reports/summary.md') {
            return {
              kind: 'file',
              contents: enc.encode('# Summary'),
              truncated: false,
            };
          }
          if (relPath === 'huge.csv') {
            return { kind: 'file', contents: enc.encode('start'), truncated: true };
          }
          return { kind: 'absent' };
        },
      },
      plugins: [http],
    });
    await registerWorkspaceRoutes(booted.bus, initCtx);
    return { harness: booted, port: http.boundPort() };
  }

  afterEach(async () => {
    if (harness !== null) {
      await harness.close({ onError: () => {} });
      harness = null;
    }
  });

  it('serves bytes through the splat, path encoded whole', async () => {
    const b = await boot();
    harness = b.harness;
    // `encodeURIComponent('notes/plan.bin')` — exactly what the client sends.
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/download/user-files/notes%2Fplan.bin`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-disposition')).toBe(
      'attachment; filename="plan.bin"',
    );
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    // The framework pins Content-Length from the buffer it writes; this is the
    // only place the real value exists, so it is the only place to check it.
    expect(r.headers.get('content-length')).toBe('4');
    // Bytes, not text: a NUL and a 0xFF survive the whole trip.
    expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual([
      0x00, 0x01, 0xff, 0x0a,
    ]);
  });

  it('serves bytes when the path arrives as real slashes too', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/download/user-files/reports/summary.md`,
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('# Summary');
  });

  it('413s a truncated file over the wire', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/download/user-files/huge.csv`,
    );
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'file-too-large' });
  });

  it('400s an encoded traversal over the wire', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/download/user-files/%2e%2e%2fsecret`,
    );
    expect(r.status).toBe(400);
  });

  it('404s another agent’s download over the wire', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a2/download/user-files/notes%2Fplan.bin`,
    );
    expect(r.status).toBe(404);
  });

  it('serves no git workspace download route', async () => {
    // `/download/files/*` read `workspace:read` and was removed with the git
    // tier (TASK-995). It answers 404, as for any unknown route.
    const b = await boot();
    harness = b.harness;
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
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/user-files/reports%2Fsummary.md`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
  });
});
