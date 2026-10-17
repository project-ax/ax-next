/**
 * W3a — the client half of the project routes: each `workspaceApi` method hits
 * the right path and verb, sends the CSRF header on writes, and `sendMessage`
 * carries `projectId` only when it is given.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi } from '../lib/workspace-api';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

function mockJson(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function lastCall(): { url: string; method: string; headers: Record<string, string>; body: unknown } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    method: init.method ?? 'GET',
    headers: (init.headers ?? {}) as Record<string, string>,
    body: init.body === undefined ? undefined : JSON.parse(init.body as string),
  };
}

describe('workspaceApi — projects', () => {
  it('listProjects / getProject / listProjectConversations / ownerCandidates are GETs', async () => {
    mockJson(200, { projects: [] });
    await workspaceApi.listProjects();
    expect(lastCall()).toMatchObject({ url: '/api/workspace/projects', method: 'GET' });

    mockJson(200, { projectId: 'prj/1' });
    await workspaceApi.getProject('prj/1');
    expect(lastCall().url).toBe('/api/workspace/projects/prj%2F1');

    mockJson(200, { conversations: [] });
    await workspaceApi.listProjectConversations('prj_1');
    expect(lastCall().url).toBe('/api/workspace/projects/prj_1/conversations');

    mockJson(200, { agents: [] });
    await workspaceApi.ownerCandidates();
    expect(lastCall().url).toBe('/api/workspace/projects/owner-candidates');
  });

  it('createProject POSTs the body with the CSRF header', async () => {
    mockJson(201, { projectId: 'prj_new' });
    const out = await workspaceApi.createProject({ name: 'Q4', ownerAgentId: 'a1' });
    expect(out).toEqual({ projectId: 'prj_new' });
    const c = lastCall();
    expect(c).toMatchObject({ url: '/api/workspace/projects', method: 'POST', body: { name: 'Q4', ownerAgentId: 'a1' } });
    expect(c.headers['x-requested-with']).toBe('ax-admin');
  });

  it('updateProject PATCHes; deleteProject DELETEs and accepts a bodiless 204', async () => {
    mockJson(200, { projectId: 'prj_1', name: 'N', description: null, updatedAt: 'x' });
    await workspaceApi.updateProject('prj_1', { description: null });
    expect(lastCall()).toMatchObject({ url: '/api/workspace/projects/prj_1', method: 'PATCH', body: { description: null } });

    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => { throw new Error('no body'); } } as unknown as Response);
    await expect(workspaceApi.deleteProject('prj_1')).resolves.toBeUndefined();
    const d = lastCall();
    expect(d).toMatchObject({ url: '/api/workspace/projects/prj_1', method: 'DELETE' });
    expect(d.headers['x-requested-with']).toBe('ax-admin');
  });

  it('deleteProject throws with the status on a refusal', async () => {
    mockJson(403, { error: 'forbidden' });
    await expect(workspaceApi.deleteProject('prj_1')).rejects.toMatchObject({ status: 403 });
  });

  it('sendMessage carries projectId only when given', async () => {
    mockJson(200, { reqId: 'r', conversationId: 'c' });
    await workspaceApi.sendMessage({ agentId: 'a1', conversationId: null, text: 'hi', projectId: 'prj_1' });
    expect((lastCall().body as { projectId?: string }).projectId).toBe('prj_1');

    mockJson(200, { reqId: 'r', conversationId: 'c' });
    await workspaceApi.sendMessage({ agentId: 'a1', conversationId: null, text: 'hi' });
    expect(Object.keys(lastCall().body as object)).not.toContain('projectId');
  });

  it('projectFiles GETs the folder root, or one path encoded whole', async () => {
    mockJson(200, { kind: 'dir', path: '', name: '', entries: [], truncated: false });
    await workspaceApi.projectFiles('prj/1', '');
    expect(lastCall()).toMatchObject({ url: '/api/workspace/projects/prj%2F1/files', method: 'GET' });

    mockJson(200, { kind: 'file', path: 'work/a b.md', name: 'a b.md', body: 'x', clipped: null, size: 1, downloadable: true });
    const out = await workspaceApi.projectFiles('prj_1', 'work/a b.md');
    expect(lastCall().url).toBe('/api/workspace/projects/prj_1/files/work%2Fa%20b.md');
    expect(out).toMatchObject({ kind: 'file', size: 1, downloadable: true });
  });

  it('downloadProjectFile GETs the bytes and reads the filename from the header', async () => {
    const blob = new Blob(['hi']);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: async () => blob,
      headers: new Headers({ 'content-disposition': 'attachment; filename="a b.md"' }),
    } as unknown as Response);
    const out = await workspaceApi.downloadProjectFile('prj_1', 'work/a b.md');
    expect(lastCall()).toMatchObject({ url: '/api/workspace/projects/prj_1/download/work%2Fa%20b.md', method: 'GET' });
    expect(out).toEqual({ blob, filename: 'a b.md' });
  });

  it('downloadProjectFile throws with the status on a refusal (413 too big)', async () => {
    mockJson(413, { error: 'file-too-large' });
    await expect(workspaceApi.downloadProjectFile('prj_1', 'huge.log')).rejects.toMatchObject({ status: 413 });
  });
});
