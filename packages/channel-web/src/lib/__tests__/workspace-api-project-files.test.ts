/**
 * W3c — the client half of changing a project's files: `writeProjectFile`,
 * `deleteProjectFile`, `createProjectFolder`. Drives the REAL client against a
 * stubbed global `fetch`: the path is encoded whole, every change carries the
 * CSRF header, the preconditions become `If-Match` / `If-None-Match`, and a
 * refusal comes back as a `ProjectFileChangeError` naming it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectFileChangeError, workspaceApi } from '../workspace-api';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => {
  fetchMock.mockReset();
});

const HASH = 'b'.repeat(64);
const call = () => fetchMock.mock.calls[0] as [string, RequestInit];
const headers = () => call()[1].headers as Record<string, string>;

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('workspaceApi.writeProjectFile', () => {
  it('PUTs the raw content to the files splat, encoded whole, CSRF header on', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sha256: HASH }), { status: 200 }));
    const out = await workspaceApi.writeProjectFile('p1', 'work/a b.md', 'hello');
    expect(out).toEqual({ sha256: HASH });
    const [url, init] = call();
    expect(url).toBe('/api/workspace/projects/p1/files/work%2Fa%20b.md');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe('hello');
    expect(headers()['x-requested-with']).toBe('ax-admin');
    expect(headers()['content-type']).toBe('application/octet-stream');
    expect(headers()).not.toHaveProperty('if-match');
    expect(headers()).not.toHaveProperty('if-none-match');
  });

  it('a base hash is a quoted If-Match', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sha256: HASH }), { status: 200 }));
    await workspaceApi.writeProjectFile('p1', 'a.md', 'x', { baseHash: HASH });
    expect(headers()['if-match']).toBe(`"${HASH}"`);
    expect(headers()).not.toHaveProperty('if-none-match');
  });

  it('create-only is If-None-Match *', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sha256: HASH }), { status: 200 }));
    await workspaceApi.writeProjectFile('p1', 'a.md', 'x', { createOnly: true });
    expect(headers()['if-none-match']).toBe('*');
    expect(headers()).not.toHaveProperty('if-match');
  });

  it('a refusal names its code; an unknown code reads as undefined', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'conflict' }), { status: 409 }));
    const e = await failure(workspaceApi.writeProjectFile('p1', 'a.md', 'x', { baseHash: HASH }));
    expect(e).toBeInstanceOf(ProjectFileChangeError);
    expect((e as ProjectFileChangeError).status).toBe(409);
    expect((e as ProjectFileChangeError).code).toBe('conflict');

    fetchMock.mockResolvedValueOnce(new Response('<html>oops</html>', { status: 502 }));
    const f = await failure(workspaceApi.writeProjectFile('p1', 'a.md', 'x'));
    expect((f as ProjectFileChangeError).status).toBe(502);
    expect((f as ProjectFileChangeError).code).toBeUndefined();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: '<script>' }), { status: 403 }));
    const g = await failure(workspaceApi.writeProjectFile('p1', 'a.md', 'x'));
    expect((g as ProjectFileChangeError).code).toBeUndefined();
  });
});

describe('workspaceApi.deleteProjectFile / createProjectFolder', () => {
  it('DELETEs the files splat with the CSRF header', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await workspaceApi.deleteProjectFile('p1', 'work/old.md');
    const [url, init] = call();
    expect(url).toBe('/api/workspace/projects/p1/files/work%2Fold.md');
    expect(init.method).toBe('DELETE');
    expect(headers()['x-requested-with']).toBe('ax-admin');
  });

  it('POSTs the folders splat with the CSRF header', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await workspaceApi.createProjectFolder('p1', 'work/drafts');
    const [url, init] = call();
    expect(url).toBe('/api/workspace/projects/p1/folders/work%2Fdrafts');
    expect(init.method).toBe('POST');
    expect(headers()['x-requested-with']).toBe('ax-admin');
  });

  it('a refused delete names its code', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'protected-path' }), { status: 403 }));
    const e = await failure(workspaceApi.deleteProjectFile('p1', 'instructions.md'));
    expect((e as ProjectFileChangeError).code).toBe('protected-path');
  });
});

describe('W3d — workspaceApi.projectFileHistory / projectFileVersion / restoreProjectFileVersion', () => {
  it('GETs the history splat, encoded whole', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ versions: [], gaps: [] }), { status: 200 }));
    expect(await workspaceApi.projectFileHistory('p1', 'work/a b.md')).toEqual({ versions: [], gaps: [] });
    expect(call()[0]).toBe('/api/workspace/projects/p1/history/work%2Fa%20b.md');
  });

  it('GETs one version, its id encoded', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ body: 'x', clipped: null, size: 1 }), { status: 200 }));
    await workspaceApi.projectFileVersion('p1', 'v/1');
    expect(call()[0]).toBe('/api/workspace/projects/p1/versions/v%2F1');
  });

  it('POSTs a restore with the CSRF header and answers the hash', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sha256: HASH }), { status: 200 }));
    expect(await workspaceApi.restoreProjectFileVersion('p1', 'v1')).toEqual({ sha256: HASH });
    const [url, init] = call();
    expect(url).toBe('/api/workspace/projects/p1/versions/v1/restore');
    expect(init.method).toBe('POST');
    expect(headers()['x-requested-with']).toBe('ax-admin');
  });

  it('a refused restore names not-restorable', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not-restorable' }), { status: 409 }));
    const e = await failure(workspaceApi.restoreProjectFileVersion('p1', 'v1'));
    expect(e).toBeInstanceOf(ProjectFileChangeError);
    expect((e as ProjectFileChangeError).code).toBe('not-restorable');
  });
});
