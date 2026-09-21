import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi, WorkspaceShapeError } from '../workspace-api';

function respondWith(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

const goodStatement = {
  id: 'm1',
  about: 'user',
  relation: 'lives_in',
  value: 'Boston',
  when: '2026-09-01T00:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

describe('workspaceApi facts memory boundary', () => {
  it('recallMemory posts the query and returns a validated page', async () => {
    const fetchMock = respondWith({ statements: [goodStatement], degraded: [] });
    const page = await workspaceApi.recallMemory('a 1', { query: 'boston', history: true });
    expect(page.statements[0]?.value).toBe('Boston');
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/agents/a%201/memory/recall');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ query: 'boston', history: true }),
    );
  });

  it.each([
    ['a raw array page', []],
    ['a statement array entry', { statements: [['x']], degraded: [] }],
    ['a statement missing a field', { statements: [{ id: 'm1' }], degraded: [] }],
    ['a non-string degraded flag', { statements: [], degraded: [42] }],
    ['a bad closure value', { statements: [{ ...goodStatement, closure: 'hidden' }], degraded: [] }],
    ['a non-string aboutText', { statements: [{ ...goodStatement, aboutText: 9 }], degraded: [] }],
    ['a non-enum page visibility type', { statements: [], degraded: [], visibility: 3 }],
    ['a missing degraded', { statements: [] }],
    ['an invalid page visibility', { statements: [], degraded: [], visibility: 'world' }],
  ])('recallMemory rejects %s instead of coercing it empty', async (_n, body) => {
    respondWith(body);
    await expect(workspaceApi.recallMemory('a1', {})).rejects.toBeInstanceOf(
      WorkspaceShapeError,
    );
  });

  it('recallMemory passes through a validated page visibility', async () => {
    respondWith({ statements: [goodStatement], degraded: [], visibility: 'team' });
    const page = await workspaceApi.recallMemory('a1', {});
    expect(page.visibility).toBe('team');
  });

  it('rememberMemory resolves only a body carrying a nonblank id', async () => {
    respondWith({ id: 'mem-new' });
    await expect(
      workspaceApi.rememberMemory('a1', { about: 'u', relation: 'r', value: 'v' }),
    ).resolves.toEqual({ id: 'mem-new' });

    for (const body of [{}, null, { id: '' }, { id: 7 }, []]) {
      respondWith(body);
      await expect(
        workspaceApi.rememberMemory('a1', { about: 'u', relation: 'r', value: 'v' }),
      ).rejects.toBeInstanceOf(WorkspaceShapeError);
    }
  });

  it('forgetMemory resolves only { forgotten: true }', async () => {
    respondWith({ forgotten: true });
    await expect(workspaceApi.forgetMemory('a1', ['m1'])).resolves.toEqual({
      forgotten: true,
    });

    for (const body of [{}, null, { forgotten: false }, 'ok', []]) {
      respondWith(body);
      await expect(workspaceApi.forgetMemory('a1', ['m1'])).rejects.toBeInstanceOf(
        WorkspaceShapeError,
      );
    }
  });
});
