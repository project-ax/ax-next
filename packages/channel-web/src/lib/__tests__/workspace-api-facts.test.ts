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
    ['a bad savedBy value', { statements: [{ ...goodStatement, savedBy: 'system' }], degraded: [] }],
    ['a non-string savedBy', { statements: [{ ...goodStatement, savedBy: 1 }], degraded: [] }],
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

  it('recallMemory accepts savedBy person/agent and the overridden closure', async () => {
    respondWith({
      statements: [
        { ...goodStatement, id: 'm1', savedBy: 'person' },
        { ...goodStatement, id: 'm2', savedBy: 'agent' },
        { ...goodStatement, id: 'm3', closure: 'overridden' },
      ],
      degraded: [],
    });
    const page = await workspaceApi.recallMemory('a1', {});
    expect(page.statements[0]?.savedBy).toBe('person');
    expect(page.statements[1]?.savedBy).toBe('agent');
    expect(page.statements[2]?.closure).toBe('overridden');
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

  it('recallMemory accepts the retracted closure', async () => {
    respondWith({
      statements: [{ ...goodStatement, closure: 'retracted', until: '2026-09-27T00:00:00.000Z' }],
      degraded: [],
    });
    const page = await workspaceApi.recallMemory('a1', { history: true });
    expect(page.statements[0]?.closure).toBe('retracted');
  });

  it('correctMemory posts id + reason and resolves only a nonblank id', async () => {
    const input = {
      id: 'm1',
      about: 'user',
      relation: 'lives_in',
      value: 'Denver',
      reason: 'never-right' as const,
    };
    const fetchMock = respondWith({ id: 'mem-new' });
    await expect(workspaceApi.correctMemory('a 1', input)).resolves.toEqual({ id: 'mem-new' });
    expect(fetchMock.mock.calls[0]?.[0] as string).toContain('/agents/a%201/memory/correct');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(input));

    for (const body of [{}, null, { id: '' }, { id: 7 }, []]) {
      respondWith(body);
      await expect(workspaceApi.correctMemory('a1', input)).rejects.toBeInstanceOf(
        WorkspaceShapeError,
      );
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

  it('unforgetMemory resolves only a { restored: string[] } body', async () => {
    respondWith({ restored: ['m1'] });
    await expect(workspaceApi.unforgetMemory('a1', ['m1'])).resolves.toEqual({
      restored: ['m1'],
    });
    respondWith({ restored: [] });
    await expect(workspaceApi.unforgetMemory('a1', ['m1'])).resolves.toEqual({ restored: [] });

    for (const body of [{}, null, { restored: 'm1' }, { restored: [7] }, { forgotten: true }, []]) {
      respondWith(body);
      await expect(workspaceApi.unforgetMemory('a1', ['m1'])).rejects.toBeInstanceOf(
        WorkspaceShapeError,
      );
    }
  });

  it('uncorrectMemory posts { id, restore } and resolves only a { undone: boolean } body', async () => {
    const fetchMock = respondWith({ undone: true });
    await expect(
      workspaceApi.uncorrectMemory('a 1', { id: 'm2', restore: 'm1' }),
    ).resolves.toEqual({ undone: true });
    expect(fetchMock.mock.calls[0]?.[0] as string).toContain('/agents/a%201/memory/uncorrect');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ id: 'm2', restore: 'm1' }));
    vi.restoreAllMocks();

    respondWith({ undone: false });
    await expect(
      workspaceApi.uncorrectMemory('a1', { id: 'm2', restore: 'm1' }),
    ).resolves.toEqual({ undone: false });

    for (const body of [{}, null, { undone: 'yes' }, { undone: 1 }, { restored: [] }, []]) {
      vi.restoreAllMocks();
      respondWith(body);
      await expect(
        workspaceApi.uncorrectMemory('a1', { id: 'm2', restore: 'm1' }),
      ).rejects.toBeInstanceOf(WorkspaceShapeError);
    }
  });
});
