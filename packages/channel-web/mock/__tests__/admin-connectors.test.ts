import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Store } from '../store';
import { authMiddleware } from '../auth';
import {
  adminConnectorsMiddleware,
  settingsConnectorsMiddleware,
} from '../admin/connectors';
import { expectStatus } from './expect-status';

async function startServer(
  store: Store,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const auth = authMiddleware(store);
  const adminConnectors = adminConnectorsMiddleware(store);
  const server = createServer(async (req, res) => {
    if (await auth(req, res)) return;
    if (await adminConnectors(req, res)) return;
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const ALICE = 'mock-session=u2';
const ADMIN = 'mock-session=u1';
// A second admin, so owner-scoping on the ADMIN-ONLY `/admin/connectors` bundle
// can be exercised between two users who are both allowed through the gate.
const ADMIN2 = 'mock-session=u3';

function seedSecondAdmin(store: Store): void {
  store
    .collection<{ id: string; email: string; name: string; role: 'admin' | 'user' }>('users')
    .upsert({ id: 'u3', email: 'admin2@local', name: 'Admin Two', role: 'admin' });
}

function upsertBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectorId: 'gdrive',
    name: 'Google Drive',
    description: 'Files in my Drive',
    usageNote: 'Ask me about your documents.',
    keyMode: 'personal',
    visibility: 'private',
    capabilities: {
      allowedHosts: ['www.googleapis.com'],
      credentials: [{ slot: 'GDRIVE_API_KEY', kind: 'api-key' }],
      mcpServers: [],
      packages: { npm: [], pypi: [] },
    },
    ...over,
  };
}

describe('mock admin connectors', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-admin-connectors-'));
    store = new Store(dir);
    store.seed();
    seedSecondAdmin(store);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('GET /admin/connectors 401s without a session', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/admin/connectors`);
      await expectStatus(res, 401);
    } finally {
      await close();
    }
  });

  // TASK-790 — production 404s a path that only SHARES the bundle's prefix
  // (the router has no route for it; no auth gate runs). The mock used to claim
  // anything that `startsWith(base)` and answer 401/403 before route matching.
  it('404s prefix-only non-routes for every caller, like production (TASK-790)', async () => {
    const { url, close } = await startServer(store);
    try {
      const paths = [
        '/admin/connectorsx',
        '/admin/connectors-catalog',
        '/admin/connectors/',
        '/admin/connectors/a/b',
        '/admin/connectors/a/tool-permissions/extra',
      ];
      for (const cookie of [undefined, ALICE, ADMIN]) {
        for (const path of paths) {
          const res = await fetch(`${url}${path}`, {
            headers: cookie ? { cookie } : {},
          });
          expect({ cookie, path, status: res.status }).toEqual({ cookie, path, status: 404 });
        }
      }
      // The real routes are still gated: the shape check does not open them up.
      const real = await fetch(`${url}/admin/connectors/x/tool-permissions`, {
        headers: { cookie: ALICE },
      });
      await expectStatus(real, 403);
    } finally {
      await close();
    }
  });

  it('403s a signed-in non-admin on every /admin/connectors route and writes nothing (TASK-698 gate)', async () => {
    const { url, close } = await startServer(store);
    try {
      // An admin-owned shared connector a non-admin could otherwise read.
      const seeded = await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ connectorId: 'shared-conn', visibility: 'shared' })),
      });
      await expectStatus(seeded, 201);

      const json = { cookie: ALICE, 'content-type': 'application/json' };
      const attempts: Array<[string, string, RequestInit]> = [
        ['GET', '/admin/connectors', { headers: { cookie: ALICE } }],
        ['GET', '/admin/connectors/shared-conn', { headers: { cookie: ALICE } }],
        ['POST', '/admin/connectors', { headers: json, body: JSON.stringify(upsertBody()) }],
        ['PATCH', '/admin/connectors/shared-conn', { headers: json, body: JSON.stringify({ name: 'hijack' }) }],
        ['DELETE', '/admin/connectors/shared-conn', { headers: { cookie: ALICE } }],
        ['GET', '/admin/connectors/shared-conn/tool-permissions', { headers: { cookie: ALICE } }],
        [
          'PUT',
          '/admin/connectors/shared-conn/tool-permissions',
          { headers: json, body: JSON.stringify({ verdicts: [] }) },
        ],
      ];
      for (const [method, path, init] of attempts) {
        const res = await fetch(`${url}${path}`, { ...init, method });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
        expect(await res.json()).toEqual({ error: 'forbidden' });
      }

      // Nothing the non-admin sent landed: no Alice-owned row, the shared row is
      // unrenamed and still present.
      const list = await fetch(`${url}/admin/connectors`, { headers: { cookie: ADMIN } });
      const { connectors } = (await list.json()) as { connectors: { id: string; name: string }[] };
      expect(connectors.map((c) => [c.id, c.name])).toEqual([['shared-conn', 'Google Drive']]);
      const rows = store.collection<{ id: string; userId: string }>('connectors').list();
      expect(rows.map((r) => r.userId)).toEqual(['u1']);
    } finally {
      await close();
    }
  });

  it('GET /admin/connectors lists empty by default for an admin', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/admin/connectors`, { headers: { cookie: ADMIN2 } });
      await expectStatus(res, 200);
      const body = await res.json();
      expect(body).toEqual({ connectors: [] });
    } finally {
      await close();
    }
  });

  it('POST creates a connector (201) and the list + summary reflect it', async () => {
    const { url, close } = await startServer(store);
    try {
      const create = await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });
      await expectStatus(create, 201);
      const created = await create.json();
      expect(created.created).toBe(true);
      expect(created.connector.id).toBe('gdrive');
      expect(created.connector.createdAt).toEqual(expect.any(String));

      const listRes = await fetch(`${url}/admin/connectors`, { headers: { cookie: ADMIN2 } });
      const list = await listRes.json();
      expect(list.connectors).toHaveLength(1);
      // List is the metadata-only summary — no capabilities spec.
      expect(list.connectors[0]).not.toHaveProperty('capabilities');
      expect(list.connectors[0]).toMatchObject({ id: 'gdrive', name: 'Google Drive' });
    } finally {
      await close();
    }
  });

  it('GET /admin/connectors/:id round-trips the full connector', async () => {
    const { url, close } = await startServer(store);
    try {
      await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });
      const res = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ADMIN2 } });
      await expectStatus(res, 200);
      const body = await res.json();
      expect(body.connector).toMatchObject({
        id: 'gdrive',
        name: 'Google Drive',
        keyMode: 'personal',
        visibility: 'private',
      });
      expect(body.connector).not.toHaveProperty('defaultAttached');
      expect(body.connector.capabilities.allowedHosts).toEqual(['www.googleapis.com']);
    } finally {
      await close();
    }
  });

  it('GET unknown id 404s', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/admin/connectors/nope`, { headers: { cookie: ADMIN2 } });
      await expectStatus(res, 404);
    } finally {
      await close();
    }
  });

  it('POST with a bad slug or missing name 400s', async () => {
    const { url, close } = await startServer(store);
    try {
      const badSlug = await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ connectorId: 'Bad Slug!' })),
      });
      await expectStatus(badSlug, 400);

      const noName = await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ name: '' })),
      });
      await expectStatus(noName, 400);
    } finally {
      await close();
    }
  });

  it('PATCH merges fields and re-fetch reflects the change', async () => {
    const { url, close } = await startServer(store);
    try {
      await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });
      const patch = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'PATCH',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Drive (renamed)' }),
      });
      await expectStatus(patch, 200);
      const patched = await patch.json();
      expect(patched.created).toBe(false);
      expect(patched.connector.name).toBe('Drive (renamed)');
      // Untouched fields survive the merge.
      expect(patched.connector.keyMode).toBe('personal');

      const get = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ADMIN2 } });
      const body = await get.json();
      expect(body.connector.name).toBe('Drive (renamed)');
    } finally {
      await close();
    }
  });

  it('DELETE removes the connector (204), then re-DELETE 404s', async () => {
    const { url, close } = await startServer(store);
    try {
      await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });
      const del = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'DELETE',
        headers: { cookie: ADMIN2 },
      });
      await expectStatus(del, 204);

      const reget = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ADMIN2 } });
      await expectStatus(reget, 404);

      const redel = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'DELETE',
        headers: { cookie: ADMIN2 },
      });
      await expectStatus(redel, 404);
    } finally {
      await close();
    }
  });

  it('is owner-scoped: one user cannot see/get/patch/delete another user\'s connector', async () => {
    const { url, close } = await startServer(store);
    try {
      // A second admin (u3) creates a connector.
      await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });

      // Admin (a different user) does not see it in their list.
      const adminList = await fetch(`${url}/admin/connectors`, { headers: { cookie: ADMIN } });
      expect((await adminList.json()).connectors).toEqual([]);

      // Cross-tenant get/patch/delete all surface as 404 (not 403).
      const get = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ADMIN } });
      await expectStatus(get, 404);

      const patch = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'PATCH',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'hijack' }),
      });
      await expectStatus(patch, 404);

      const del = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'DELETE',
        headers: { cookie: ADMIN },
      });
      await expectStatus(del, 404);

      // The second admin's connector is untouched.
      const ownerGet = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ADMIN2 } });
      expect((await ownerGet.json()).connector.name).toBe('Google Drive');
    } finally {
      await close();
    }
  });

  it('forces userId from the session — a body-supplied userId cannot owner-hijack', async () => {
    const { url, close } = await startServer(store);
    try {
      // The second admin (u3) POSTs with a body claiming to own it as the admin user.
      const create = await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ userId: 'u1' })),
      });
      await expectStatus(create, 201);

      // It belongs to u3 (session), not the forged u1.
      const adminGet = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ADMIN } });
      await expectStatus(adminGet, 404);
      const ownerGet = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ADMIN2 } });
      await expectStatus(ownerGet, 200);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// User-authoring mock — /settings/connectors[/:id] (TASK-129). Same offline UI
// parity as the admin mock: shared reads, owner-only writes, and admin-only
// workspace keys/default attachment.
// ---------------------------------------------------------------------------

async function startUserServer(
  store: Store,
): Promise<{ url: string; close: () => Promise<void> }> {
  const auth = authMiddleware(store);
  const settingsConnectors = settingsConnectorsMiddleware(store);
  // Mount the admin mock too so a test can SEED a catalog/shared connector the
  // user route must treat as read-only for other users.
  const adminConnectors = adminConnectorsMiddleware(store);
  const server = createServer(async (req, res) => {
    if (await auth(req, res)) return;
    if (await settingsConnectors(req, res)) return;
    if (await adminConnectors(req, res)) return;
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('mock user connectors (/settings/connectors)', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-user-connectors-'));
    store = new Store(dir);
    store.seed();
    seedSecondAdmin(store);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('401s without a session', async () => {
    const { url, close } = await startUserServer(store);
    try {
      const res = await fetch(`${url}/settings/connectors`);
      await expectStatus(res, 401);
    } finally {
      await close();
    }
  });

  it('POST defaults a new connector to shared and requires an explicit attachment', async () => {
    const { url, close } = await startUserServer(store);
    try {
      const res = await fetch(`${url}/settings/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ visibility: undefined })),
      });
      await expectStatus(res, 201);
      const body = (await res.json()) as { connector: { visibility: string } };
      expect(body.connector.visibility).toBe('shared');
      expect(body.connector).toMatchObject({ requiresAttachment: true });
      expect(body.connector).not.toHaveProperty('defaultAttached');
    } finally {
      await close();
    }
  });

  it('POST permits a shared personal definition', async () => {
    const { url, close } = await startUserServer(store);
    try {
      const res = await fetch(`${url}/settings/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ visibility: 'shared' })),
      });
      await expectStatus(res, 201);
      const shown = await fetch(`${url}/settings/connectors/gdrive`, { headers: { cookie: ADMIN } });
      await expectStatus(shown, 200);
      expect(await shown.json()).toMatchObject({ connector: { canEdit: false, visibility: 'shared' } });
    } finally {
      await close();
    }
  });

  it.each([true, false])(
    'POST rejects a body carrying defaultAttached:%s with 400 on both bundles (the flag is retired)',
    async (value) => {
      const { url, close } = await startUserServer(store);
      try {
        for (const [path, cookie] of [
          ['/settings/connectors', ALICE],
          ['/admin/connectors', ADMIN2],
        ] as const) {
          const res = await fetch(`${url}${path}`, {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify(upsertBody({ defaultAttached: value })),
          });
          await expectStatus(res, 400);
          expect(await res.json()).toEqual({
            error: 'defaultAttached is no longer supported: add connectors to each agent instead',
          });
        }
        // Nothing was stored by either rejected write.
        const list = await fetch(`${url}/settings/connectors`, { headers: { cookie: ALICE } });
        expect(await list.json()).toEqual({ connectors: [] });
      } finally {
        await close();
      }
    },
  );

  it('PATCH rejects a body carrying defaultAttached with 400 and leaves the row alone', async () => {
    const { url, close } = await startServer(store);
    try {
      await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });
      const patch = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'PATCH',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed', defaultAttached: true }),
      });
      await expectStatus(patch, 400);
      const get = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ADMIN2 } });
      expect((await get.json()).connector.name).toBe('Google Drive');
    } finally {
      await close();
    }
  });

  it('full CRUD on an owned private connector', async () => {
    const { url, close } = await startUserServer(store);
    try {
      const create = await fetch(`${url}/settings/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });
      await expectStatus(create, 201);

      const patch = await fetch(`${url}/settings/connectors/gdrive`, {
        method: 'PATCH',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Drive' }),
      });
      await expectStatus(patch, 200);
      const patched = (await patch.json()) as {
        connector: { name: string; visibility: string };
      };
      expect(patched.connector.name).toBe('Renamed Drive');
      expect(patched.connector.visibility).toBe('private');

      const del = await fetch(`${url}/settings/connectors/gdrive`, {
        method: 'DELETE',
        headers: { cookie: ALICE },
      });
      await expectStatus(del, 204);
      const get = await fetch(`${url}/settings/connectors/gdrive`, {
        headers: { cookie: ALICE },
      });
      await expectStatus(get, 404);
    } finally {
      await close();
    }
  });

  it('PATCH / DELETE on a catalog (shared) connector is read-only — 403', async () => {
    const { url, close } = await startUserServer(store);
    try {
      // Seed a shared definition owned by the second admin; other users may read only.
      const seed = await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(
          upsertBody({ connectorId: 'shared-conn', visibility: 'shared' }),
        ),
      });
      await expectStatus(seed, 201);

      const patch = await fetch(`${url}/settings/connectors/shared-conn`, {
        method: 'PATCH',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'hijack' }),
      });
      await expectStatus(patch, 403);

      const del = await fetch(`${url}/settings/connectors/shared-conn`, {
        method: 'DELETE',
        headers: { cookie: ADMIN },
      });
      await expectStatus(del, 403);
    } finally {
      await close();
    }
  });

  it('POST cannot demote an existing catalog/shared connector to private (403)', async () => {
    const { url, close } = await startUserServer(store);
    try {
      // Seed a SHARED connector via the admin route.
      await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN2, 'content-type': 'application/json' },
        body: JSON.stringify(
          upsertBody({ connectorId: 'shared-conn', visibility: 'shared' }),
        ),
      });
      // A re-POST of the same id via the user route must 403, not demote it.
      const res = await fetch(`${url}/settings/connectors`, {
        method: 'POST',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ connectorId: 'shared-conn' })),
      });
      await expectStatus(res, 403);
      // Still shared.
      const get = await fetch(`${url}/admin/connectors/shared-conn`, {
        headers: { cookie: ADMIN2 },
      });
      const body = (await get.json()) as { connector: { visibility: string } };
      expect(body.connector.visibility).toBe('shared');
    } finally {
      await close();
    }
  });

  it('cross-tenant: user cannot edit another user’s private connector (404)', async () => {
    const { url, close } = await startUserServer(store);
    try {
      // Alice creates a private connector.
      await fetch(`${url}/settings/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ connectorId: 'alice-conn' })),
      });
      // The admin user (u1, a different session) cannot touch it.
      const patch = await fetch(`${url}/settings/connectors/alice-conn`, {
        method: 'PATCH',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'hijack' }),
      });
      await expectStatus(patch, 404);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tool permissions — <base>/:id/tool-permissions (TASK-737).
// ---------------------------------------------------------------------------

describe('mock connector tool permissions', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mock-tool-perms-'));
    store = new Store(dir);
    store.seed();
    seedSecondAdmin(store);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const remoteBody = () =>
    upsertBody({
      connectorId: 'linear',
      name: 'Linear',
      visibility: 'shared',
      capabilities: {
        allowedHosts: ['mcp.linear.app'],
        credentials: [],
        mcpServers: [
          {
            name: 'linear',
            transport: 'http',
            url: 'https://mcp.linear.app/mcp',
            allowedHosts: [],
            credentials: [],
          },
        ],
        packages: { npm: [], pypi: [] },
      },
    });

  async function create(url: string, base: string, cookie: string): Promise<void> {
    const res = await fetch(`${url}${base}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(remoteBody()),
    });
    await expectStatus(res, 201);
  }

  it('lists a Linear-like inventory, saves defaults, and clears one with null', async () => {
    const { url, close } = await startUserServer(store);
    try {
      await create(url, '/settings/connectors', ADMIN);
      const first = await fetch(`${url}/settings/connectors/linear/tool-permissions`, {
        headers: { cookie: ADMIN },
      });
      await expectStatus(first, 200);
      const inventory = (await first.json()) as {
        status: string;
        tools: { toolKey: string; readOnly: boolean; outward: boolean }[];
        defaults: unknown[];
      };
      expect(inventory.status).toBe('ok');
      expect(inventory.defaults).toEqual([]);
      expect(inventory.tools.filter((t) => t.readOnly).map((t) => t.toolKey)).toEqual([
        'mcp.linear.search_issues',
        'mcp.linear.get_issue',
        'mcp.linear.list_projects',
      ]);
      expect(inventory.tools.filter((t) => t.outward).map((t) => t.toolKey)).toEqual([
        'mcp.linear.create_issue',
        'mcp.linear.delete_issue',
      ]);

      const put = await fetch(`${url}/settings/connectors/linear/tool-permissions`, {
        method: 'PUT',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          verdicts: [
            { toolKey: 'mcp.linear.delete_issue', verdict: 'deny' },
            { toolKey: 'mcp.linear.search_issues', verdict: 'allow' },
          ],
        }),
      });
      await expectStatus(put, 200);
      expect(await put.json()).toEqual({ ok: true });

      // The admin bundle sees and edits the same defaults.
      const clear = await fetch(`${url}/admin/connectors/linear/tool-permissions`, {
        method: 'PUT',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          verdicts: [{ toolKey: 'mcp.linear.search_issues', verdict: null }],
        }),
      });
      await expectStatus(clear, 200);

      const after = await fetch(
        `${url}/settings/connectors/linear/tool-permissions?refresh=1`,
        { headers: { cookie: ADMIN } },
      );
      expect(((await after.json()) as { defaults: unknown[] }).defaults).toEqual([
        { toolKey: 'mcp.linear.delete_issue', verdict: 'deny' },
      ]);
    } finally {
      await close();
    }
  });

  it('rejects a bad verdict with the offending toolKey and keeps prior defaults', async () => {
    const { url, close } = await startUserServer(store);
    try {
      await create(url, '/settings/connectors', ALICE);
      const res = await fetch(`${url}/settings/connectors/linear/tool-permissions`, {
        method: 'PUT',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({
          verdicts: [
            { toolKey: 'mcp.linear.get_issue', verdict: 'allow' },
            { toolKey: 'mcp.linear.create_issue', verdict: 'maybe' },
          ],
        }),
      });
      await expectStatus(res, 400);
      expect(((await res.json()) as { toolKey: string }).toolKey).toBe(
        'mcp.linear.create_issue',
      );
      const after = await fetch(`${url}/settings/connectors/linear/tool-permissions`, {
        headers: { cookie: ALICE },
      });
      expect(((await after.json()) as { defaults: unknown[] }).defaults).toEqual([]);
    } finally {
      await close();
    }
  });

  it('403s someone who can read the connector but not edit it, and 404s an unknown one', async () => {
    const { url, close } = await startUserServer(store);
    try {
      await create(url, '/admin/connectors', ADMIN);
      const foreign = await fetch(`${url}/settings/connectors/linear/tool-permissions`, {
        headers: { cookie: ALICE },
      });
      await expectStatus(foreign, 403);
      const missing = await fetch(`${url}/settings/connectors/nope/tool-permissions`, {
        headers: { cookie: ALICE },
      });
      await expectStatus(missing, 404);
    } finally {
      await close();
    }
  });
});
