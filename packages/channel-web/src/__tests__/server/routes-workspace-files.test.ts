// @vitest-environment node
/**
 * The Files tab's two routes (TASK-233 / plan task AW-12).
 *
 * These are written in two tiers, and the split is not decorative.
 *
 * TIER A calls the handlers directly, the way `routes-workspace.test.ts` does.
 * It can assert everything about ordering, exclusion and fencing.
 *
 * TIER B goes over a real socket through a genuinely booted `@ax/http-server`,
 * because a tier-A test CANNOT exercise the thing most likely to be wrong
 * here: the splat. `req.params['*']` is produced by the router, is passed
 * through UNDECODED, and is only populated for a route declared with a bare
 * trailing `*` — a pattern written `/files/*path` compiles `*path` to a
 * LITERAL segment and matches nothing anyone would ever request, while every
 * direct-handler test keeps passing because the test writes `params` itself.
 * That is the same class of bug as the `?agentId=` lowercasing trap, and it
 * gets the same treatment: one honest round trip.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import {
  FILE_BODY_MAX_BYTES,
  UNREADABLE_FILE_NAME,
  WORKSPACE_FILES_MAX,
  decodeFileBody,
  fenceBody,
  isServableWorkspaceFile,
  makeWorkspaceHandlers,
  registerWorkspaceRoutes,
  USER_FILES_ENTRIES_MAX,
  type AgentFileResponse,
  type AgentFilesResponse,
  type AgentUserFilesResponse,
} from '../../server/routes-workspace.js';
import { workspaceFilePath } from '../../server/safe-path.js';
import type { RouteRequest, RouteResponse } from '../../server/routes-chat.js';

const initCtx: AgentContext = makeAgentContext({
  sessionId: 'init',
  agentId: '@ax/channel-web',
  userId: 'system',
});

/** A NUL, never written as a raw byte in this file. */
const NUL = '\u0000';

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

interface CapturedRes {
  statusCode: number;
  body: unknown;
}
function mkRes(): { res: RouteResponse; captured: CapturedRes } {
  const captured: CapturedRes = { statusCode: 0, body: undefined };
  const res: RouteResponse = {
    status(n: number) {
      captured.statusCode = n;
      return res;
    },
    json(v: unknown) {
      captured.body = v;
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

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// The path validator, on its own. `safePath` is a port; these are the cases
// the port has to answer for at THIS surface, where a hostile segment is
// rejected rather than rewritten.
// ---------------------------------------------------------------------------
describe('workspaceFilePath', () => {
  it('passes an ordinary relative path through unchanged', () => {
    expect(workspaceFilePath('notes/plan.md')).toBe('notes/plan.md');
    expect(workspaceFilePath('README.md')).toBe('README.md');
  });

  it('passes a dotfile through — a leading dot is a name, not a traversal', () => {
    expect(workspaceFilePath('.gitignore')).toBe('.gitignore');
  });

  it('decodes the splat exactly once', () => {
    // The router hands the splat over verbatim, so this is what the client's
    // `encodeURIComponent(path)` actually looks like on arrival.
    expect(workspaceFilePath('notes%2Fplan.md')).toBe('notes/plan.md');
    expect(workspaceFilePath('a%20b.md')).toBe('a b.md');
  });

  it('rejects a traversal', () => {
    expect(workspaceFilePath('../../etc/passwd')).toBeNull();
    expect(workspaceFilePath('notes/../../../etc/passwd')).toBeNull();
  });

  it('rejects an encoded traversal', () => {
    expect(workspaceFilePath('%2e%2e%2fsecret')).toBeNull();
    expect(workspaceFilePath('%2E%2E/secret')).toBeNull();
  });

  it('does NOT double-decode — a double-encoded traversal stays a filename', () => {
    // `%252e%252e%252f` decodes ONCE to `%2e%2e%2f`, which contains no slash
    // and no `..`, so it is a (weird) filename and not a traversal. If this
    // ever returns null, something is decoding twice, and a validator that
    // decodes twice can be walked past by encoding three times.
    expect(workspaceFilePath('%252e%252e%252fsecret')).toBe('%2e%2e%2fsecret');
  });

  it('rejects an absolute path', () => {
    expect(workspaceFilePath('/etc/passwd')).toBeNull();
    expect(workspaceFilePath('%2Fetc%2Fpasswd')).toBeNull();
  });

  it('rejects a NUL byte', () => {
    expect(workspaceFilePath(`notes${NUL}.md`)).toBeNull();
    expect(workspaceFilePath('notes%00.md')).toBeNull();
  });

  it('rejects a malformed percent escape rather than guessing', () => {
    expect(workspaceFilePath('a%2')).toBeNull();
    expect(workspaceFilePath('%zz')).toBeNull();
  });

  it('rejects an empty path, an empty segment and a dot segment', () => {
    expect(workspaceFilePath('')).toBeNull();
    expect(workspaceFilePath('a//b.md')).toBeNull();
    expect(workspaceFilePath('a/./b.md')).toBeNull();
    expect(workspaceFilePath('notes/')).toBeNull();
  });

  it('rejects a backslash — it is a separator on the platform that matters', () => {
    expect(workspaceFilePath('..%5C..%5Cwindows')).toBeNull();
  });

  it('rejects an over-long segment rather than silently truncating it', () => {
    expect(workspaceFilePath(`${'a'.repeat(300)}.md`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('isServableWorkspaceFile', () => {
  it('serves the agent’s own files', () => {
    expect(isServableWorkspaceFile('report.md')).toBe(true);
    expect(isServableWorkspaceFile('notes/2026/q3.md')).toBe(true);
    expect(isServableWorkspaceFile('.gitignore')).toBe(true);
  });

  it('hides our machinery and the Memory tab’s tier', () => {
    expect(isServableWorkspaceFile('.ax/routines/x.md')).toBe(false);
    expect(isServableWorkspaceFile('.ax/IDENTITY.md')).toBe(false);
    expect(isServableWorkspaceFile('.claude/projects/s.jsonl')).toBe(false);
    // The tier path the workspace listing actually reports…
    expect(isServableWorkspaceFile('memory/system/rules.md')).toBe(false);
    // …and the host-scratch layout of the same tier.
    expect(isServableWorkspaceFile('permanent/memory/system/rules.md')).toBe(false);
  });

  it('does not hide a file that merely starts with the same letters', () => {
    expect(isServableWorkspaceFile('memories.md')).toBe(true);
    expect(isServableWorkspaceFile('.axolotl.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('fenceBody', () => {
  it('keeps the structure of a document', () => {
    expect(fenceBody('# Title\n\n- a\n\tb\r\n')).toBe('# Title\n\n- a\n\tb\r\n');
  });

  it('removes the characters that rewrite the surface', () => {
    // A bidi override in front of a filename inside a document is the same
    // Trojan-source trick the feed fences; a body is just a bigger target.
    expect(fenceBody('rm \u202Egnp.txt')).toBe('rm gnp.txt');
    expect(fenceBody('a\u200Bb\uFEFFc\u2066d\u2069')).toBe('abcd');
    expect(fenceBody(`a${NUL}b`)).toBe('ab');
  });
});

// ---------------------------------------------------------------------------
describe('decodeFileBody', () => {
  it('returns the whole file when it fits, and says so', () => {
    expect(decodeFileBody(enc.encode('hello'))).toEqual({
      body: 'hello',
      clipped: null,
    });
  });

  it('calls a file with a NUL in it binary rather than showing mojibake', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]);
    expect(decodeFileBody(bytes)).toEqual({ body: null, clipped: 'binary' });
  });

  it('clips an oversized file and says which', () => {
    const out = decodeFileBody(enc.encode('a'.repeat(FILE_BODY_MAX_BYTES + 10)));
    expect(out.clipped).toBe('too-large');
    expect(out.body).toHaveLength(FILE_BODY_MAX_BYTES);
  });

  it('fences the body it returns', () => {
    expect(decodeFileBody(enc.encode('a\u202Eb')).body).toBe('ab');
  });
});

// ---------------------------------------------------------------------------
// Tier A — the handlers.
// ---------------------------------------------------------------------------
describe('the Files routes', () => {
  let bus: HookBus;
  let paths: string[];
  let blobs: Map<string, Uint8Array>;
  let listCalls: Array<{ agentId: string; userId: string }>;
  let readCalls: Array<{ agentId: string; userId: string; path: string }>;
  let listThrows: Error | null;

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

  function registerWorkspace(): void {
    bus.registerService('workspace:list', 'workspace', async (ctx) => {
      listCalls.push({ agentId: ctx.agentId, userId: ctx.userId ?? '' });
      if (listThrows !== null) throw listThrows;
      return { paths };
    });
    bus.registerService('workspace:read', 'workspace', async (ctx, i: unknown) => {
      const { path } = i as { path: string };
      readCalls.push({
        agentId: ctx.agentId,
        userId: ctx.userId ?? '',
        path,
      });
      const bytes = blobs.get(path);
      return bytes === undefined ? { found: false } : { found: true, bytes };
    });
  }

  beforeEach(() => {
    bus = new HookBus();
    paths = [];
    blobs = new Map();
    listCalls = [];
    readCalls = [];
    listThrows = null;
  });

  // --- auth + ACL ---------------------------------------------------------

  it('401s the listing without a session', async () => {
    registerAuth(null);
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    expect(captured.statusCode).toBe(401);
  });

  it('401s the file read without a session', async () => {
    registerAuth(null);
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFile(
      mkReq({ agentId: 'a1', '*': 'x.md' }),
      res,
    );
    expect(captured.statusCode).toBe(401);
  });

  it('404s a foreign agent’s listing without touching the workspace', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFiles(
      mkReq({ agentId: 'someone-elses' }),
      res,
    );
    expect(captured.statusCode).toBe(404);
    expect(listCalls).toEqual([]);
  });

  it('runs the ACL BEFORE path validation, so a bad path on a foreign agent still 404s', async () => {
    /*
      The whole point of the ordering. If the path were validated first, a
      caller would get 400 for `../x` and 404 for `x.md` on an agent that is
      not theirs — and the difference between those two answers is an oracle
      for "does that path exist over there". Both must be 404.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    const h = makeWorkspaceHandlers({ bus, initCtx });

    const bad = mkRes();
    await h.agentFile(mkReq({ agentId: 'someone-elses', '*': '../../etc/passwd' }), bad.res);
    expect(bad.captured.statusCode).toBe(404);

    const good = mkRes();
    await h.agentFile(mkReq({ agentId: 'someone-elses', '*': 'x.md' }), good.res);
    expect(good.captured.statusCode).toBe(404);

    expect(readCalls).toEqual([]);
  });

  // --- path safety, through the route ------------------------------------

  it.each([
    ['a traversal', '../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['an encoded traversal', '%2e%2e%2fsecret'],
    ['a NUL byte', `x${NUL}.md`],
    ['an encoded NUL byte', 'x%00.md'],
    ['a malformed escape', 'x%2'],
    ['an empty path', ''],
  ])('400s %s, and never reaches the workspace', async (_label, splat) => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFile(
      mkReq({ agentId: 'a1', '*': splat }),
      res,
    );
    expect(captured.statusCode).toBe(400);
    expect(readCalls).toEqual([]);
  });

  it.each([
    ['.ax internals', '.ax/routines/x.md'],
    ['.claude internals', '.claude/projects/s.jsonl'],
    ['the memory tier', 'memory/system/rules.md'],
    ['the host-scratch memory tier', 'permanent/memory/system/rules.md'],
  ])('404s %s, and never reaches the workspace', async (_label, splat) => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    // Seed it so a pass would be a REAL leak rather than an accidental miss.
    blobs.set(splat, enc.encode('secret'));
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFile(
      mkReq({ agentId: 'a1', '*': splat }),
      res,
    );
    expect(captured.statusCode).toBe(404);
    expect(readCalls).toEqual([]);
  });

  // --- the listing --------------------------------------------------------

  it('lists the agent’s files and excludes the machinery', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    paths = [
      '.ax/IDENTITY.md',
      '.claude/projects/s.jsonl',
      'memory/system/rules.md',
      'permanent/memory/docs/general/x.md',
      'notes/plan.md',
      'report.md',
    ];
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    const body = captured.body as AgentFilesResponse;
    expect(body.files.map((f) => f.path)).toEqual(['notes/plan.md', 'report.md']);
    expect(body.truncated).toBe(false);
  });

  it('routes the listing on the AGENT’s own context, never the plugin’s', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    const { res } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    expect(listCalls).toEqual([{ agentId: 'a1', userId: 'u1' }]);
  });

  it('answers 503 — not an empty list — when nothing serves the workspace', async () => {
    /*
      "No workspace backend is loaded" and "this agent has written nothing"
      are different facts about different things, and only one of them is a
      claim about the agent. An empty 200 here would make the second claim on
      the strength of the first.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    expect(captured.statusCode).toBe(503);
  });

  it('lets a failed listing propagate — this tab has no honest way to swallow one', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    listThrows = new Error('workspace unreachable');
    const { res } = mkRes();
    await expect(
      makeWorkspaceHandlers({ bus, initCtx }).agentFiles(mkReq({ agentId: 'a1' }), res),
    ).rejects.toThrow('workspace unreachable');
  });

  it('caps the listing and says out loud that it did', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    paths = Array.from({ length: WORKSPACE_FILES_MAX + 3 }, (_, i) => `f${i}.md`);
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    const body = captured.body as AgentFilesResponse;
    expect(body.files).toHaveLength(WORKSPACE_FILES_MAX);
    expect(body.truncated).toBe(true);
  });

  // --- fencing ------------------------------------------------------------

  it('fences the filename LABEL and leaves the KEY raw', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    const hostile = 'inv\u202Eoice\u200B.md';
    paths = [hostile];
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    const [row] = (captured.body as AgentFilesResponse).files;
    // The label carries no bidi override and no zero-width joiner…
    expect(row?.name).not.toMatch(/[\u202A-\u202E\u200B-\u200F\u2066-\u2069]/);
    // …and the key is untouched, because it is what the client sends back to
    // open the file. Fencing it would make two distinct paths collide.
    expect(row?.path).toBe(hostile);
  });

  it('still gives a row to a file whose every character is unprintable', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    paths = ['\u200B\u202E'];
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    const [row] = (captured.body as AgentFilesResponse).files;
    // Dropping it would claim the agent wrote one file fewer than it did,
    // which is the bigger lie. Same call `fireToActivityEvent` makes.
    expect(row?.name).toBe(UNREADABLE_FILE_NAME);
  });

  // --- the read -----------------------------------------------------------

  it('reads a file on the agent’s own context and returns its text', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    blobs.set('notes/plan.md', enc.encode('# Plan\n\nShip it.'));
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFile(
      mkReq({ agentId: 'a1', '*': 'notes%2Fplan.md' }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      path: 'notes/plan.md',
      name: 'notes/plan.md',
      body: '# Plan\n\nShip it.',
      clipped: null,
    } satisfies AgentFileResponse);
    expect(readCalls).toEqual([
      { agentId: 'a1', userId: 'u1', path: 'notes/plan.md' },
    ]);
  });

  it('404s a file that is not there', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerWorkspace();
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFile(
      mkReq({ agentId: 'a1', '*': 'gone.md' }),
      res,
    );
    expect(captured.statusCode).toBe(404);
  });

  it('answers 503 when nothing serves the read', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentFile(
      mkReq({ agentId: 'a1', '*': 'x.md' }),
      res,
    );
    expect(captured.statusCode).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Tier B — one round trip through a real router.
// ---------------------------------------------------------------------------
describe('the Files routes over a real socket', () => {
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
        'workspace:list': async () => ({
          paths: ['notes/plan.md', '.ax/IDENTITY.md'],
        }),
        'workspace:read': async (_ctx: unknown, input: unknown) => {
          const { path } = input as { path: string };
          return path === 'notes/plan.md'
            ? { found: true, bytes: enc.encode('# Plan') }
            : { found: false };
        },
        // The DURABLE tier, stood up the way a sandbox provider would: the
        // root is a directory, `reports/summary.md` is a file, everything else
        // is absent.
        'sandbox:read-user-files': async (_ctx: unknown, input: unknown) => {
          const { relPath } = input as { relPath?: string };
          if (relPath === undefined) {
            return {
              kind: 'dir',
              entries: [{ name: 'reports', kind: 'dir' }],
            };
          }
          if (relPath === 'reports') {
            return {
              kind: 'dir',
              entries: [{ name: 'summary.md', kind: 'file' }],
            };
          }
          if (relPath === 'reports/summary.md') {
            return { kind: 'file', contents: enc.encode('# Summary') };
          }
          return { kind: 'absent' };
        },
      },
      plugins: [http],
    });
    await registerWorkspaceRoutes(booted.bus, initCtx, {
      agentWorkspacePreview: true,
    });
    return { harness: booted, port: http.boundPort() };
  }

  afterEach(async () => {
    if (harness !== null) {
      await harness.close({ onError: () => {} });
      harness = null;
    }
  });

  it('serves the listing at /files — the exact route wins over the splat', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(`http://127.0.0.1:${b.port}/api/workspace/agents/a1/files`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AgentFilesResponse;
    expect(body.files.map((f) => f.path)).toEqual(['notes/plan.md']);
  });

  it('serves one file through the splat, with the path encoded whole', async () => {
    const b = await boot();
    harness = b.harness;
    // `encodeURIComponent('notes/plan.md')` — exactly what the client sends.
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/files/notes%2Fplan.md`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as AgentFileResponse;
    expect(body.path).toBe('notes/plan.md');
    expect(body.body).toBe('# Plan');
  });

  it('serves a path that arrives as real slashes too', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/files/notes/plan.md`,
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as AgentFileResponse).path).toBe('notes/plan.md');
  });

  /*
    The durable tier over the same real router. The splat is the thing most
    likely to be silently wrong here — `req.params['*']` is only populated for
    a route declared with a BARE trailing `*` (a `/user-files/*path` segment
    compiles to a literal and matches nothing anyone would request), and every
    direct-handler test above keeps passing regardless because it writes
    `params` itself. So: one honest round trip per shape.
  */
  it('serves the durable tier root at /user-files — the exact route wins over the splat', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/user-files`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as AgentUserFilesResponse;
    if (body.kind !== 'dir') throw new Error('expected dir');
    expect(body.path).toBe('');
    expect(body.entries).toEqual([
      { path: 'reports', name: 'reports', kind: 'dir' },
    ]);
  });

  it('serves a durable-tier file through the splat, path encoded whole', async () => {
    const b = await boot();
    harness = b.harness;
    // `encodeURIComponent('reports/summary.md')` — exactly what the client sends.
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/user-files/reports%2Fsummary.md`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as AgentUserFilesResponse;
    if (body.kind !== 'file') throw new Error('expected file');
    expect(body.path).toBe('reports/summary.md');
    expect(body.body).toBe('# Summary');
  });

  it('serves a durable-tier directory that arrives as real slashes too', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/user-files/reports`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as AgentUserFilesResponse;
    if (body.kind !== 'dir') throw new Error('expected dir');
    expect(body.entries[0]?.path).toBe('reports/summary.md');
  });

  it('400s an encoded traversal on the durable splat over the wire', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/user-files/%2e%2e%2fsecret`,
    );
    expect(r.status).toBe(400);
  });

  it('404s a foreign agent’s durable tier over the wire', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/nope/user-files`,
    );
    expect(r.status).toBe(404);
  });

  it('400s an encoded traversal over the wire', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/files/%2e%2e%2fsecret`,
    );
    expect(r.status).toBe(400);
  });

  it('404s .ax internals over the wire', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a1/files/.ax%2FIDENTITY.md`,
    );
    expect(r.status).toBe(404);
  });

  it('404s another agent’s files over the wire', async () => {
    const b = await boot();
    harness = b.harness;
    const r = await fetch(
      `http://127.0.0.1:${b.port}/api/workspace/agents/a2/files`,
    );
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The DURABLE tier's routes — `/user-files` and `/user-files/*`.
//
// The tier that had no consumer at all until now: `sandbox:read-user-files` was
// registered by both sandbox providers and read by nothing, so the agent's cwd
// — where a deliverable lands by default — was invisible in the UI.
//
// A different backend from the routes above (`sandbox:read-user-files`, not
// `workspace:*`) and therefore a different set of things worth pinning:
//
//   - the ACL still runs BEFORE path validation, and for a sharper reason: the
//     backing mount is ONE export holding EVERY tenant's subtree, so a
//     400-vs-404 split under a foreign agent would map somebody else's files.
//   - `absent` is 404, and covers "no durable tier" and "no such path"
//     identically. That is deliberate; see the oracle note above.
//   - the raw key comes back joined onto its parent, and the label is fenced.
//   - the governed tier's `.ax`/`.claude`/`memory` exclusions do NOT apply
//     here: they are the OTHER tier's machinery, and hiding a folder the user
//     named `memory/` on their own file area would be a lie about their files.
// ---------------------------------------------------------------------------
describe('the durable user-files routes (direct handlers)', () => {
  let bus: HookBus;
  /** Calls seen by `sandbox:read-user-files`, in order. */
  let reads: Array<{ agentId: string; ownerAgentId: string; relPath: string | undefined }>;
  /** The tier's contents, keyed by relPath (`''` = the root). */
  let tier: Map<string, { kind: 'dir'; entries: Array<{ name: string; kind: 'file' | 'dir' }> } | { kind: 'file'; contents: Uint8Array }>;

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
        throw new PluginError({ code: 'not-found', plugin: 'agents', message: 'nope' });
      }
      return { agent: { id: 'a1', displayName: 'Inbox' } };
    });
  }

  /** A stand-in for whichever sandbox provider is loaded. */
  function registerReader(): void {
    bus.registerService(
      'sandbox:read-user-files',
      'sandbox',
      async (ctx, i: unknown) => {
        const input = i as {
          owner: { agentId: string };
          relPath?: string;
        };
        reads.push({
          agentId: ctx.agentId,
          ownerAgentId: input.owner.agentId,
          relPath: input.relPath,
        });
        return tier.get(input.relPath ?? '') ?? { kind: 'absent' };
      },
    );
  }

  beforeEach(() => {
    bus = new HookBus();
    reads = [];
    tier = new Map();
  });

  // --- auth + ACL ---------------------------------------------------------

  it('401s without a session', async () => {
    registerAuth(null);
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    expect(captured.statusCode).toBe(401);
  });

  it('400s a missing agent id', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFiles(mkReq({}), res);
    expect(captured.statusCode).toBe(400);
  });

  it('404s a foreign agent without touching the tier', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFiles(
      mkReq({ agentId: 'someone-elses' }),
      res,
    );
    expect(captured.statusCode).toBe(404);
    expect(reads).toEqual([]);
  });

  it('SECURITY: runs the ACL BEFORE path validation, so both answers are 404', async () => {
    /*
      Sharper here than on the governed routes. The durable tier is one NFS
      export holding every tenant's subtree, so a caller who could tell 400
      (malformed) from 404 (well-formed but absent) under someone else's agent
      would have a free way to map that agent's paths. Both must be 404, and
      neither may reach the reader.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    const h = makeWorkspaceHandlers({ bus, initCtx });

    const bad = mkRes();
    await h.agentUserFile(
      mkReq({ agentId: 'someone-elses', '*': '../../etc/passwd' }),
      bad.res,
    );
    expect(bad.captured.statusCode).toBe(404);

    const good = mkRes();
    await h.agentUserFile(mkReq({ agentId: 'someone-elses', '*': 'x.md' }), good.res);
    expect(good.captured.statusCode).toBe(404);

    expect(reads).toEqual([]);
  });

  // --- path safety --------------------------------------------------------

  it.each([
    ['a traversal', '../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['an encoded traversal', '%2e%2e%2fsecret'],
    ['a NUL byte', `x${NUL}.md`],
    ['an encoded NUL byte', 'x%00.md'],
    ['a malformed escape', 'x%2'],
  ])('400s %s, and never reaches the reader', async (_label, splat) => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFile(
      mkReq({ agentId: 'a1', '*': splat }),
      res,
    );
    expect(captured.statusCode).toBe(400);
    expect(reads).toEqual([]);
  });

  // --- availability -------------------------------------------------------

  it('503s when no sandbox provider can read the tier', async () => {
    // NOT an empty listing. "This agent has written nothing" is a claim about
    // the agent; the truth here is a fact about the deployment (H7).
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ error: 'user-files-unavailable' });
  });

  // --- listing ------------------------------------------------------------

  it('lists the tier root, keying entries off the empty parent', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('', {
      kind: 'dir',
      entries: [
        { name: 'reports', kind: 'dir' },
        { name: 'q3.csv', kind: 'file' },
      ],
    });
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    const body = captured.body as AgentUserFilesResponse;
    if (body.kind !== 'dir') throw new Error('expected dir');
    expect(body.path).toBe('');
    expect(body.entries).toEqual([
      { path: 'reports', name: 'reports', kind: 'dir' },
      { path: 'q3.csv', name: 'q3.csv', kind: 'file' },
    ]);
    expect(body.truncated).toBe(false);
    // The root asks for NO relPath rather than for `''` — the hook's own
    // default is "the mount root", and sending an empty string instead would
    // rely on every realization normalizing it the same way.
    expect(reads).toEqual([
      { agentId: 'a1', ownerAgentId: 'a1', relPath: undefined },
    ]);
  });

  it('joins a nested listing’s entries onto their parent key', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('reports/2026', {
      kind: 'dir',
      entries: [{ name: 'summary.md', kind: 'file' }],
    });
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFile(
      mkReq({ agentId: 'a1', '*': 'reports%2F2026' }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    const body = captured.body as AgentUserFilesResponse;
    if (body.kind !== 'dir') throw new Error('expected dir');
    // The client puts this key straight back on the wire, so it has to be the
    // whole path and not just the leaf.
    expect(body.entries[0]?.path).toBe('reports/2026/summary.md');
    expect(body.name).toBe('2026');
  });

  it('says out loud when a listing was cut short', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('', {
      kind: 'dir',
      entries: Array.from({ length: USER_FILES_ENTRIES_MAX + 3 }, (_v, i) => ({
        name: `f${String(i)}.txt`,
        kind: 'file' as const,
      })),
    });
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    const body = captured.body as AgentUserFilesResponse;
    if (body.kind !== 'dir') throw new Error('expected dir');
    expect(body.entries).toHaveLength(USER_FILES_ENTRIES_MAX);
    expect(body.truncated).toBe(true);
  });

  it('FENCES an entry name and keeps the raw key intact', async () => {
    // Nothing on this tier has been through a git commit, so a filename here
    // is as agent-authored as it gets — the Trojan-source surface
    // (CVE-2021-42574) with no intermediate review at all.
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    const raw = 'inv‮oice.md';
    tier.set('', { kind: 'dir', entries: [{ name: raw, kind: 'file' }] });
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    const body = captured.body as AgentUserFilesResponse;
    if (body.kind !== 'dir') throw new Error('expected dir');
    // The KEY keeps the override — it is what the read is addressed by, and
    // fencing a key collapses two distinct paths onto one row.
    expect(body.entries[0]?.path).toBe(raw);
    // The LABEL does not — that is the string that reaches a screen.
    expect(body.entries[0]?.name).not.toContain('‮');
  });

  it('does NOT apply the governed tier’s exclusions', async () => {
    /*
      `.ax/`, `.claude/` and `memory/` are hidden on the OTHER tier because
      they are AX's machinery there. On the durable tier they are just names,
      and `memory/` in particular is a perfectly ordinary thing for a person to
      call a folder. Hiding it would be a lie about their own files.
    */
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('memory/notes.md', { kind: 'file', contents: enc.encode('mine') });
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFile(
      mkReq({ agentId: 'a1', '*': 'memory%2Fnotes.md' }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect((captured.body as AgentUserFilesResponse & { body?: string }).body).toBe(
      'mine',
    );
  });

  // --- reading ------------------------------------------------------------

  it('serves a file body, decoded the same way the other tier is', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('reports/summary.md', {
      kind: 'file',
      contents: enc.encode('# Plan\n\nShip it.'),
    });
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFile(
      mkReq({ agentId: 'a1', '*': 'reports%2Fsummary.md' }),
      res,
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({
      kind: 'file',
      path: 'reports/summary.md',
      name: 'summary.md',
      body: '# Plan\n\nShip it.',
      clipped: null,
    } satisfies AgentUserFilesResponse);
  });

  it('says a binary body is binary rather than shipping mojibake', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('chart.png', {
      kind: 'file',
      contents: Uint8Array.from([0x89, 0x50, 0x00, 0x01]),
    });
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFile(
      mkReq({ agentId: 'a1', '*': 'chart.png' }),
      res,
    );
    const body = captured.body as AgentUserFilesResponse;
    if (body.kind !== 'file') throw new Error('expected file');
    expect(body.body).toBeNull();
    expect(body.clipped).toBe('binary');
  });

  it('clips a long body and SAYS it clipped it', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('log.txt', {
      kind: 'file',
      contents: enc.encode('x'.repeat(FILE_BODY_MAX_BYTES + 10)),
    });
    const { res, captured } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFile(
      mkReq({ agentId: 'a1', '*': 'log.txt' }),
      res,
    );
    const body = captured.body as AgentUserFilesResponse;
    if (body.kind !== 'file') throw new Error('expected file');
    expect(body.body).toHaveLength(FILE_BODY_MAX_BYTES);
    expect(body.clipped).toBe('too-large');
  });

  it('404s an absent path — the same answer as an absent tier', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    const h = makeWorkspaceHandlers({ bus, initCtx });

    // Nothing seeded: the reader answers `absent` for the root AND for a path.
    const root = mkRes();
    await h.agentUserFiles(mkReq({ agentId: 'a1' }), root.res);
    expect(root.captured.statusCode).toBe(404);

    const missing = mkRes();
    await h.agentUserFile(mkReq({ agentId: 'a1', '*': 'gone.md' }), missing.res);
    expect(missing.captured.statusCode).toBe(404);

    // Identical bodies too. A different error code for "no tier here" would
    // be readable from outside, and the tier is one export for every tenant.
    expect(root.captured.body).toEqual(missing.captured.body);
  });

  it('routes the read on the AGENT’s own context and owner, never the plugin’s', async () => {
    registerAuth({ id: 'u1', isAdmin: false });
    registerAgents();
    registerReader();
    tier.set('', { kind: 'dir', entries: [] });
    const { res } = mkRes();
    await makeWorkspaceHandlers({ bus, initCtx }).agentUserFiles(
      mkReq({ agentId: 'a1' }),
      res,
    );
    // The owner's agentId is what the provider joins onto the export root, so
    // if this were ever the plugin's own id the read would land in the wrong
    // subtree — or in none at all.
    expect(reads[0]?.ownerAgentId).toBe('a1');
    expect(reads[0]?.agentId).toBe('a1');
  });
});
