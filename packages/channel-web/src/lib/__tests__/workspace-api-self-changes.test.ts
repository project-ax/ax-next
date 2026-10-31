/**
 * `workspaceApi.selfChanges()` reads `GET /api/workspace/self-changes` (TASK-990).
 *
 * The guard exists so a malformed body is never mistaken for "nothing changed":
 * a row the client cannot read fails the whole read, which the hook turns into
 * "draw nothing and warn" rather than a half-drawn section.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceApi, WorkspaceShapeError } from '../workspace-api';

function respondWith(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => vi.restoreAllMocks());

const row = { agentId: 'a-quill', section: 'soul', changedAt: '2026-10-30T10:00:00.000Z' };

describe('workspaceApi.selfChanges', () => {
  it('returns a valid body as it is', async () => {
    const spy = respondWith({ changes: [row, { ...row, agentId: 'a2', section: 'identity' }] });
    const out = await workspaceApi.selfChanges();
    expect(out.changes).toHaveLength(2);
    expect(out.changes[0]).toEqual(row);
    expect(String(spy.mock.calls[0]?.[0])).toContain('/api/workspace/self-changes');
  });

  it('accepts an empty list', async () => {
    respondWith({ changes: [] });
    await expect(workspaceApi.selfChanges()).resolves.toEqual({ changes: [] });
  });

  it.each([
    ['a body with no changes array', {}],
    ['a section this build has never heard of', { changes: [{ ...row, section: 'instructions' }] }],
    ['a row with no agentId', { changes: [{ section: 'soul', changedAt: row.changedAt }] }],
    ['a changedAt that is a number', { changes: [{ ...row, changedAt: 1761818400000 }] }],
  ])('rejects %s with a WorkspaceShapeError', async (_name, body) => {
    respondWith(body);
    await expect(workspaceApi.selfChanges()).rejects.toBeInstanceOf(WorkspaceShapeError);
  });
});
