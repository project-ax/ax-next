import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listSkills, getSkillOrNull, setSkillDefaultAttached } from '../lib/skills';
import { listCatalogRequests, decideCatalogRequest } from '../lib/catalog';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('skills wire client (catalog additions)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('listSkills surfaces the server-derived tier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        skills: [
          {
            id: 'gh',
            tier: 'bounded',
            capabilities: {
              allowedHosts: [],
              credentials: [],
              mcpServers: [],
              packages: { npm: [], pypi: [] },
            },
            defaultAttached: false,
            version: 1,
            scope: 'global',
            description: 'x',
            updatedAt: '2026-05-26T00:00:00.000Z',
          },
        ],
      }),
    );
    const skills = await listSkills();
    expect(skills[0]?.tier).toBe('bounded');
  });

  it('getSkillOrNull returns null on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
    expect(await getSkillOrNull('nope')).toBeNull();
  });

  it('setSkillDefaultAttached PATCHes with the CSRF header', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ skillId: 'gh', defaultAttached: true }));
    await setSkillDefaultAttached('gh', true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/skills/gh',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ 'x-requested-with': 'ax-admin' }),
        body: JSON.stringify({ defaultAttached: true }),
      }),
    );
  });
});

describe('catalog wire client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('listCatalogRequests unwraps the requests envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        requests: [
          {
            requestId: 'r1',
            kind: 'share',
            skillId: 'linear',
            requestedByUserId: 'u1',
            sourceOwnerUserId: 'u1',
            status: 'pending',
            description: 'd',
            createdAt: '2026-05-26T00:00:00.000Z',
            manifestYaml: 'name: linear\n',
            bodyMd: '# l\n',
            files: [],
          },
        ],
      }),
    );
    const reqs = await listCatalogRequests();
    expect(reqs[0]?.requestId).toBe('r1');
  });

  it('decideCatalogRequest POSTs the decision with the CSRF header', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ admitted: true, skillId: 'linear' }));
    const out = await decideCatalogRequest('r1', 'admit');
    expect(out.admitted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/catalog/requests/r1/decision',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-requested-with': 'ax-admin' }),
        body: JSON.stringify({ decision: 'admit' }),
      }),
    );
  });
});
