import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConnector,
  deleteConnector,
  getConnector,
  isConnectorGone,
  listConnectors,
  patchConnector,
  type ConnectorRouteBase,
  type ConnectorWriteBase,
  type ConnectorUpsertInput,
} from '../connectors';

// TASK-714 — the connector client has NO default route bundle. It used to
// default to `/admin/connectors`, which is admin-only server-side (403 for a
// signed-in non-admin, TASK-698): any new caller a non-admin could reach that
// forgot to pass a base silently walked into a 403. Two such callers had already
// shipped (a since-deleted connect dialog, and SkillEditor). The fix is to make the base
// required so the mistake fails at compile time instead of in production.

const input: ConnectorUpsertInput = {
  connectorId: 'gdrive',
  name: 'Google Drive',
  keyMode: 'personal',
  visibility: 'private',
  capabilities: {
    allowedHosts: [],
    credentials: [],
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(
      JSON.stringify({ connectors: [], connector: { id: 'gdrive' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe('connector client route base (TASK-714)', () => {
  it('requires a base at compile time — no call silently targets the admin bundle', () => {
    // Each call below must be a TYPE ERROR. If `base` regains a default, the
    // expect-error directives become unused and `tsc` (which covers channel-web
    // test files) fails the build. The calls never run.
    const typeOnly = () => {
      // @ts-expect-error — base is required
      void listConnectors();
      // @ts-expect-error — base is required
      void getConnector('gdrive');
      // @ts-expect-error — base is required
      void createConnector(input);
      // @ts-expect-error — base is required
      void patchConnector('gdrive', { name: 'x' });
      // @ts-expect-error — base is required
      void deleteConnector('gdrive');
    };
    expect(typeof typeOnly).toBe('function');
  });

  it('a caller that omits the base at runtime never reaches /admin/connectors', async () => {
    // A JS caller (or a cast) that skips the base must not fall back to the
    // admin-only bundle. With the old `= '/admin/connectors'` default this hit
    // `/admin/connectors` for every call.
    const missing = undefined as unknown as ConnectorWriteBase;
    await listConnectors(missing).catch(() => undefined);
    await getConnector('gdrive', missing).catch(() => undefined);
    await createConnector(input, missing).catch(() => undefined);
    await patchConnector('gdrive', { name: 'x' }, missing).catch(() => undefined);
    await deleteConnector('gdrive', missing).catch(() => undefined);

    expect(requestedUrls().filter((u) => u.startsWith('/admin/'))).toEqual([]);
  });

  it.each<ConnectorRouteBase>(['/settings/connectors', '/admin/connectors'])(
    'reads target exactly the base the caller names (%s)',
    async (base) => {
      await listConnectors(base);
      await getConnector('gdrive', base);

      expect(requestedUrls()).toEqual([base, `${base}/gdrive`]);
    },
  );

  it('writes target the admin bundle, and cannot be pointed at the read bundle (slice 2a)', async () => {
    const base = '/admin/connectors';
    await createConnector(input, base);
    await patchConnector('gdrive', { name: 'x' }, base);
    await deleteConnector('gdrive', base);
    expect(requestedUrls()).toEqual([base, `${base}/gdrive`, `${base}/gdrive`]);

    // The `/settings/connectors` bundle has no write routes; each call below
    // must be a TYPE ERROR (tsc covers channel-web test files). Never run.
    const typeOnly = () => {
      // @ts-expect-error — writes are admin-only
      void createConnector(input, '/settings/connectors');
      // @ts-expect-error — writes are admin-only
      void patchConnector('gdrive', { name: 'x' }, '/settings/connectors');
      // @ts-expect-error — writes are admin-only
      void deleteConnector('gdrive', '/settings/connectors');
    };
    expect(typeof typeOnly).toBe('function');
  });

  it('a 404 on delete means someone already removed it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const err = await deleteConnector('gdrive', '/admin/connectors').catch((e: unknown) => e);
    expect(isConnectorGone(err)).toBe(true);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const other = await deleteConnector('gdrive', '/admin/connectors').catch((e: unknown) => e);
    expect(isConnectorGone(other)).toBe(false);
  });
});
