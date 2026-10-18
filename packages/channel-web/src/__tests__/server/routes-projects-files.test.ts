// @vitest-environment node
/**
 * W3b — a project's files over HTTP: the listing / preview routes and the
 * download route, driven against a real HookBus with stub
 * `projects:read-file` / `projects:download-file` services that behave like
 * `@ax/projects`: the actor is `ctx.userId`, an unknown project and one the
 * actor can't use are the same `not-found`, a preview is the first 1 MiB, a
 * download is ≤ 10 MiB or refused. The stubs add a `folderId` to everything
 * they return, so the "never in a response" checks have something to catch.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { makeProjectsHandlers } from '../../server/routes-projects.js';
import { FILE_BODY_MAX_BYTES, USER_FILES_ENTRIES_MAX, type DownloadRouteResponse } from '../../server/file-serving.js';
import type { RouteRequest } from '../../server/routes-chat.js';

const initCtx: AgentContext = makeAgentContext({ sessionId: 'init', agentId: '@ax/channel-web', userId: 'system' });
const enc = new TextEncoder();
const MiB = 1024 * 1024;
const SECRET = 'fld_secret_folder_id';

function mkReq(params: Record<string, string>): RouteRequest {
  return { headers: {}, body: Buffer.alloc(0), cookies: {}, query: {}, params, signedCookie: () => null };
}

interface Captured {
  statusCode: number;
  json: unknown;
  headers: Record<string, string>;
  bytes: Buffer | null;
}

function mkRes(): { res: DownloadRouteResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, json: undefined, headers: {}, bytes: null };
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
    body(buf: Buffer) {
      captured.bytes = Buffer.from(buf);
    },
    text() {},
    end() {},
  };
  return { res, captured };
}

const err = (code: string, hook: string) =>
  new PluginError({ code, plugin: 'stub', hookName: hook, message: `${hook}: ${code}` });

/** A node in the stub folder: a directory (its children are other keys) or a file of `size` bytes. */
type Node = { kind: 'dir' } | { kind: 'file'; bytes: Uint8Array; updatedAt?: string };

/** Alice and Bob use prj_1; Eve uses nothing. */
const USES: Record<string, string[]> = { 'u-alice': ['prj_1'], 'u-bob': ['prj_1'], 'u-eve': [] };

describe('project file routes (W3b)', () => {
  let bus: HookBus;
  let user: string | null;
  let folder: Map<string, Node>;
  let unavailable: boolean;
  let calls: Array<{ hook: string; userId: string; input: unknown }>;

  function children(dir: string): Array<{ name: string; kind: 'file' | 'dir'; size?: number; updatedAt?: string }> {
    const prefix = dir === '' ? '' : `${dir}/`;
    const out: Array<{ name: string; kind: 'file' | 'dir'; size?: number; updatedAt?: string }> = [];
    for (const [key, node] of folder) {
      if (!key.startsWith(prefix) || key === dir) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push(
        node.kind === 'dir'
          ? { name: rest, kind: 'dir' }
          : { name: rest, kind: 'file', size: node.bytes.length, ...(node.updatedAt ? { updatedAt: node.updatedAt } : {}) },
      );
    }
    return out;
  }

  function lookup(path: string): Node | undefined {
    return path === '' ? { kind: 'dir' } : folder.get(path);
  }

  function registerHooks(target: HookBus): void {
    target.registerService('projects:read-file', 'projects', async (ctx, input) => {
      calls.push({ hook: 'projects:read-file', userId: ctx.userId, input });
      const { projectId, path } = input as { projectId: string; path: string };
      if (!(USES[ctx.userId] ?? []).includes(projectId)) throw err('not-found', 'projects:read-file');
      if (unavailable) return { kind: 'unavailable', folderId: SECRET };
      const node = lookup(path);
      if (node === undefined) return { kind: 'absent', folderId: SECRET };
      if (node.kind === 'dir') {
        const entries = children(path).map((e) => ({ ...e, folderId: SECRET }));
        return { kind: 'dir', entries: entries.slice(0, 500), truncated: entries.length > 500, folderId: SECRET };
      }
      return {
        kind: 'file',
        contents: node.bytes.subarray(0, MiB),
        truncated: node.bytes.length > MiB,
        size: node.bytes.length,
        folderId: SECRET,
      };
    });
    target.registerService('projects:download-file', 'projects', async (ctx, input) => {
      calls.push({ hook: 'projects:download-file', userId: ctx.userId, input });
      const { projectId, path } = input as { projectId: string; path: string };
      if (!(USES[ctx.userId] ?? []).includes(projectId)) throw err('not-found', 'projects:download-file');
      if (unavailable) throw err('unavailable', 'projects:download-file');
      const node = lookup(path);
      if (node === undefined) throw err('not-found', 'projects:download-file');
      if (node.kind === 'dir') throw err('not-a-file', 'projects:download-file');
      if (node.bytes.length > 10 * MiB) throw err('too-large', 'projects:download-file');
      return { contents: node.bytes, size: node.bytes.length, folderId: SECRET };
    });
  }

  beforeEach(() => {
    bus = new HookBus();
    user = 'u-alice';
    unavailable = false;
    calls = [];
    folder = new Map<string, Node>([
      ['instructions.md', { kind: 'file', bytes: enc.encode('# Do the thing\n'), updatedAt: '2026-10-17T01:02:03.000Z' }],
      ['memory', { kind: 'dir' }],
      ['memory/status.md', { kind: 'file', bytes: enc.encode('on track') }],
      ['work', { kind: 'dir' }],
      ['work/a b.txt', { kind: 'file', bytes: enc.encode('spaced') }],
      ['work/blob.bin', { kind: 'file', bytes: new Uint8Array([0x89, 0x50, 0x00, 0x47]) }],
      ['work/long.md', { kind: 'file', bytes: enc.encode('x'.repeat(FILE_BODY_MAX_BYTES + 100)) }],
      ['work/huge.log', { kind: 'file', bytes: new Uint8Array(11 * MiB).fill(0x61) }],
      ['work/two-mib.txt', { kind: 'file', bytes: new Uint8Array(2 * MiB).fill(0x62) }],
      ['work/rlo‮gnp.exe', { kind: 'file', bytes: enc.encode('tricky') }],
    ]);
    bus.registerService('auth:require-user', 'auth', async () => {
      if (user === null) throw err('unauthenticated', 'auth:require-user');
      return { user: { id: user, isAdmin: false } };
    });
    registerHooks(bus);
  });

  const h = () => makeProjectsHandlers({ bus, initCtx });
  const list = async (projectId: string, splat?: string) => {
    const { res, captured } = mkRes();
    if (splat === undefined) await h().projectFiles(mkReq({ projectId }), res);
    else await h().projectFile(mkReq({ projectId, '*': splat }), res);
    return captured;
  };
  const download = async (projectId: string, splat: string) => {
    const { res, captured } = mkRes();
    await h().projectFileDownload(mkReq({ projectId, '*': splat }), res);
    return captured;
  };

  describe('authentication', () => {
    it.each([
      ['root', () => list('prj_1')],
      ['splat', () => list('prj_1', 'instructions.md')],
      ['download', () => download('prj_1', 'instructions.md')],
    ])('%s: 401 with no projects:* call', async (_n, run) => {
      user = null;
      const out = await run();
      expect(out.statusCode).toBe(401);
      expect(out.json).toEqual({ error: 'unauthenticated' });
      expect(calls).toEqual([]);
    });
  });

  describe('the listing and preview', () => {
    it('lists the folder root as the person, with sizes and times, in the user-files shape', async () => {
      const out = await list('prj_1');
      expect(out.statusCode).toBe(200);
      expect(out.json).toEqual({
        kind: 'dir',
        path: '',
        name: '',
        entries: [
          { path: 'instructions.md', name: 'instructions.md', kind: 'file', size: 15, updatedAt: '2026-10-17T01:02:03.000Z' },
          { path: 'memory', name: 'memory', kind: 'dir' },
          { path: 'work', name: 'work', kind: 'dir' },
        ],
        truncated: false,
      });
      expect(calls).toEqual([{ hook: 'projects:read-file', userId: 'u-alice', input: { projectId: 'prj_1', path: '' } }]);
    });

    it('lists a subfolder: keys joined raw, labels fenced', async () => {
      const out = await list('prj_1', 'work');
      expect(out.statusCode).toBe(200);
      const body = out.json as { path: string; name: string; entries: Array<{ path: string; name: string }> };
      expect(body.path).toBe('work');
      expect(body.name).toBe('work');
      const rlo = body.entries.find((e) => e.path === 'work/rlo‮gnp.exe');
      expect(rlo?.name).toBeDefined();
      expect(rlo?.name).not.toContain('\u202E');
    });

    it('decodes the splat exactly once (an encoded slash is a separator, a space is a space)', async () => {
      const out = await list('prj_1', encodeURIComponent('work/a b.txt'));
      expect(out.statusCode).toBe(200);
      expect(calls.at(-1)?.input).toEqual({ projectId: 'prj_1', path: 'work/a b.txt' });
      expect(out.json).toMatchObject({ kind: 'file', path: 'work/a b.txt', name: 'a b.txt', body: 'spaced' });
    });

    it('a text file: the whole body, its size, and that it can be downloaded', async () => {
      const out = await list('prj_1', 'instructions.md');
      expect(out.json).toEqual({
        kind: 'file',
        path: 'instructions.md',
        name: 'instructions.md',
        body: '# Do the thing\n',
        clipped: null,
        size: 15,
        downloadable: true,
      });
    });

    it('a binary file says so instead of decoding', async () => {
      const out = await list('prj_1', 'work/blob.bin');
      expect(out.json).toMatchObject({ kind: 'file', body: null, clipped: 'binary', size: 4, downloadable: true });
    });

    it('a long file is clipped at 128 KiB and says so', async () => {
      const out = await list('prj_1', 'work/long.md');
      const body = out.json as { body: string; clipped: string; size: number };
      expect(body.body).toHaveLength(FILE_BODY_MAX_BYTES);
      expect(body.clipped).toBe('too-large');
      expect(body.size).toBe(FILE_BODY_MAX_BYTES + 100);
    });

    it('a file the hook only previewed (truncated) is never presented as whole', async () => {
      const out = await list('prj_1', 'work/two-mib.txt');
      expect(out.json).toMatchObject({ clipped: 'too-large', size: 2 * MiB, downloadable: true });
    });

    it('over 10 MiB: the size, and not downloadable', async () => {
      const out = await list('prj_1', 'work/huge.log');
      expect(out.json).toMatchObject({ kind: 'file', size: 11 * MiB, downloadable: false, clipped: 'too-large' });
    });

    it('a listing over the entry cap says it is truncated', async () => {
      for (let i = 0; i < USER_FILES_ENTRIES_MAX + 5; i++) folder.set(`many/f${i}`, { kind: 'file', bytes: enc.encode('.') });
      folder.set('many', { kind: 'dir' });
      const out = await list('prj_1', 'many');
      const body = out.json as { entries: unknown[]; truncated: boolean };
      expect(body.entries).toHaveLength(USER_FILES_ENTRIES_MAX);
      expect(body.truncated).toBe(true);
    });

    it('a missing path is 404 file-not-found', async () => {
      const out = await list('prj_1', 'nope.md');
      expect(out).toMatchObject({ statusCode: 404, json: { error: 'file-not-found' } });
    });
  });

  describe('the download', () => {
    it('serves the bytes as an attachment: octet-stream, nosniff, a sanitized name', async () => {
      const out = await download('prj_1', encodeURIComponent('work/a b.txt'));
      expect(out.statusCode).toBe(200);
      expect(out.bytes?.toString('utf8')).toBe('spaced');
      expect(out.headers['content-type']).toBe('application/octet-stream');
      expect(out.headers['x-content-type-options']).toBe('nosniff');
      expect(out.headers['content-disposition']).toBe('attachment; filename="a b.txt"');
      expect(calls).toEqual([
        { hook: 'projects:download-file', userId: 'u-alice', input: { projectId: 'prj_1', path: 'work/a b.txt' } },
      ]);
    });

    it('an agent-chosen name cannot steer the header', async () => {
      folder.set('work/x"\r\nset-cookie: a=b.txt', { kind: 'file', bytes: enc.encode('!') });
      const out = await download('prj_1', encodeURIComponent('work/x"\r\nset-cookie: a=b.txt'));
      // `\r\n` is refused by the path check before any read — and if it weren't,
      // the sanitizer would strip it. Either way no header carries it.
      for (const v of Object.values(out.headers)) expect(v).not.toMatch(/[\r\n]/);
    });

    it('over 10 MiB is 413 file-too-large, no bytes', async () => {
      const out = await download('prj_1', 'work/huge.log');
      expect(out).toMatchObject({ statusCode: 413, json: { error: 'file-too-large' }, bytes: null });
    });

    it('a folder is 400 not-a-file', async () => {
      const out = await download('prj_1', 'work');
      expect(out).toMatchObject({ statusCode: 400, json: { error: 'not-a-file' } });
    });

    it('a missing file is 404 file-not-found', async () => {
      const out = await download('prj_1', 'gone.md');
      expect(out).toMatchObject({ statusCode: 404, json: { error: 'file-not-found' } });
    });

    it('no path (the root) is 400 invalid-path, with no call', async () => {
      const out = await download('prj_1', '');
      expect(out).toMatchObject({ statusCode: 400, json: { error: 'invalid-path' } });
      expect(calls).toEqual([]);
    });
  });

  describe('a project the person cannot use', () => {
    it('foreign and unknown answer the same 404 on every route', async () => {
      user = 'u-eve';
      const foreign = [await list('prj_1'), await list('prj_1', 'instructions.md'), await download('prj_1', 'instructions.md')];
      const unknown = [await list('prj_nope'), await list('prj_nope', 'instructions.md'), await download('prj_nope', 'instructions.md')];
      expect(foreign.map((c) => [c.statusCode, c.json])).toEqual(unknown.map((c) => [c.statusCode, c.json]));
      expect(foreign.map((c) => c.statusCode)).toEqual([404, 404, 404]);
      expect(foreign[0]!.json).toEqual({ error: 'project-not-found' });
      expect(foreign[2]!.json).toEqual({ error: 'file-not-found' });
      // A download can't tell "no such project" from "no such file" either.
      user = 'u-alice';
      expect((await download('prj_1', 'gone.md')).json).toEqual(foreign[2]!.json);
    });

    it('an id over the bound is a 404 with no call', async () => {
      const out = await list('p'.repeat(129));
      expect(out).toMatchObject({ statusCode: 404, json: { error: 'project-not-found' } });
      expect(calls).toEqual([]);
    });
  });

  describe('bad paths', () => {
    const BAD = [
      '..',
      '..%2Fsecret',
      'work%2F..%2F..%2Fetc%2Fpasswd',
      '%2e%2e%2fsecret',
      '%2Fetc%2Fpasswd',
      'work%2F%2Fa',
      'work%2F.%2Fa',
      'a%00b',
      '%E0%A4%A',
      'a'.repeat(4097),
    ];
    it.each(BAD)('%s: 400 invalid-path before any read, the same for a foreign project', async (splat) => {
      const own = await list('prj_1', splat);
      const dl = await download('prj_1', splat);
      user = 'u-eve';
      const foreign = await list('prj_nope', splat);
      for (const out of [own, dl, foreign]) expect(out).toMatchObject({ statusCode: 400, json: { error: 'invalid-path' } });
      expect(calls).toEqual([]);
    });

    it('a double-encoded traversal is decoded once: a literal name, not a path', async () => {
      const out = await list('prj_1', '%252e%252e%252fsecret');
      expect(out.statusCode).toBe(404);
      expect(calls.at(-1)?.input).toEqual({ projectId: 'prj_1', path: '%2e%2e%2fsecret' });
    });
  });

  describe('without the hooks, or without a reader', () => {
    it('no projects:read-file / projects:download-file: 503 projects-unavailable', async () => {
      const bare = new HookBus();
      bare.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
      const x = makeProjectsHandlers({ bus: bare, initCtx });
      for (const [fn, params] of [
        [x.projectFiles, { projectId: 'prj_1' }],
        [x.projectFile, { projectId: 'prj_1', '*': 'a.md' }],
        [x.projectFileDownload, { projectId: 'prj_1', '*': 'a.md' }],
      ] as const) {
        const { res, captured } = mkRes();
        await fn(mkReq(params), res);
        expect(captured).toMatchObject({ statusCode: 503, json: { error: 'projects-unavailable' } });
      }
    });

    it('the hook answers unavailable: 503 project-files-unavailable (never an empty listing)', async () => {
      unavailable = true;
      for (const out of [await list('prj_1'), await list('prj_1', 'instructions.md'), await download('prj_1', 'instructions.md')]) {
        expect(out).toMatchObject({ statusCode: 503, json: { error: 'project-files-unavailable' } });
      }
    });
  });

  describe('other refusals and faults', () => {
    function busWith(readErr: Error, downloadErr: Error): HookBus {
      const b = new HookBus();
      b.registerService('auth:require-user', 'auth', async () => ({ user: { id: 'u-alice', isAdmin: false } }));
      b.registerService('projects:read-file', 'projects', async () => {
        throw readErr;
      });
      b.registerService('projects:download-file', 'projects', async () => {
        throw downloadErr;
      });
      return b;
    }

    it.each([
      ['forbidden', 403, 'forbidden'],
      ['invalid-payload', 400, 'invalid-payload'],
    ])('%s maps to %i on both routes', async (code, status, error) => {
      const x = makeProjectsHandlers({ bus: busWith(err(code, 'projects:read-file'), err(code, 'projects:download-file')), initCtx });
      const a = mkRes();
      await x.projectFile(mkReq({ projectId: 'prj_1', '*': 'a.md' }), a.res);
      const b = mkRes();
      await x.projectFileDownload(mkReq({ projectId: 'prj_1', '*': 'a.md' }), b.res);
      expect(a.captured).toMatchObject({ statusCode: status, json: { error } });
      expect(b.captured).toMatchObject({ statusCode: status, json: { error } });
    });

    it('a real fault is not dressed up as a refusal', async () => {
      const x = makeProjectsHandlers({ bus: busWith(new Error('nfs down'), new Error('nfs down')), initCtx });
      await expect(x.projectFile(mkReq({ projectId: 'prj_1', '*': 'a.md' }), mkRes().res)).rejects.toThrow('nfs down');
      await expect(x.projectFileDownload(mkReq({ projectId: 'prj_1', '*': 'a.md' }), mkRes().res)).rejects.toThrow('nfs down');
    });
  });

  it('the folder id never appears in any response', async () => {
    const outs = [
      await list('prj_1'),
      await list('prj_1', 'work'),
      await list('prj_1', 'instructions.md'),
      await list('prj_1', 'nope'),
      await download('prj_1', 'instructions.md'),
      await download('prj_1', 'work/huge.log'),
    ];
    unavailable = true;
    outs.push(await list('prj_1'), await download('prj_1', 'instructions.md'));
    for (const out of outs) {
      expect(JSON.stringify(out.json ?? null)).not.toContain(SECRET);
      expect(JSON.stringify(out.headers)).not.toContain(SECRET);
      expect(out.bytes?.toString('utf8') ?? '').not.toContain(SECRET);
    }
  });
});
