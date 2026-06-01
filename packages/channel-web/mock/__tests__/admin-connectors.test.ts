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
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('GET /admin/connectors 401s without a session', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/admin/connectors`);
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('GET /admin/connectors lists empty by default for an authenticated user', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/admin/connectors`, { headers: { cookie: ALICE } });
      expect(res.status).toBe(200);
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
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });
      expect(create.status).toBe(201);
      const created = await create.json();
      expect(created.created).toBe(true);
      expect(created.connector.id).toBe('gdrive');
      expect(created.connector.createdAt).toEqual(expect.any(String));

      const listRes = await fetch(`${url}/admin/connectors`, { headers: { cookie: ALICE } });
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
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });
      const res = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ALICE } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.connector).toMatchObject({
        id: 'gdrive',
        name: 'Google Drive',
        keyMode: 'personal',
        visibility: 'private',
        defaultAttached: false,
      });
      expect(body.connector.capabilities.allowedHosts).toEqual(['www.googleapis.com']);
    } finally {
      await close();
    }
  });

  it('GET unknown id 404s', async () => {
    const { url, close } = await startServer(store);
    try {
      const res = await fetch(`${url}/admin/connectors/nope`, { headers: { cookie: ALICE } });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('POST with a bad slug or missing name 400s', async () => {
    const { url, close } = await startServer(store);
    try {
      const badSlug = await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ connectorId: 'Bad Slug!' })),
      });
      expect(badSlug.status).toBe(400);

      const noName = await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ name: '' })),
      });
      expect(noName.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('PATCH merges fields and re-fetch reflects the change', async () => {
    const { url, close } = await startServer(store);
    try {
      await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });
      const patch = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'PATCH',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Drive (renamed)' }),
      });
      expect(patch.status).toBe(200);
      const patched = await patch.json();
      expect(patched.created).toBe(false);
      expect(patched.connector.name).toBe('Drive (renamed)');
      // Untouched fields survive the merge.
      expect(patched.connector.keyMode).toBe('personal');

      const get = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ALICE } });
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
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });
      const del = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'DELETE',
        headers: { cookie: ALICE },
      });
      expect(del.status).toBe(204);

      const reget = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ALICE } });
      expect(reget.status).toBe(404);

      const redel = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'DELETE',
        headers: { cookie: ALICE },
      });
      expect(redel.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('is owner-scoped: one user cannot see/get/patch/delete another user\'s connector', async () => {
    const { url, close } = await startServer(store);
    try {
      // Alice creates a connector.
      await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody()),
      });

      // Admin (a different user) does not see it in their list.
      const adminList = await fetch(`${url}/admin/connectors`, { headers: { cookie: ADMIN } });
      expect((await adminList.json()).connectors).toEqual([]);

      // Cross-tenant get/patch/delete all surface as 404 (not 403).
      const get = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ADMIN } });
      expect(get.status).toBe(404);

      const patch = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'PATCH',
        headers: { cookie: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'hijack' }),
      });
      expect(patch.status).toBe(404);

      const del = await fetch(`${url}/admin/connectors/gdrive`, {
        method: 'DELETE',
        headers: { cookie: ADMIN },
      });
      expect(del.status).toBe(404);

      // Alice's connector is untouched.
      const aliceGet = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ALICE } });
      expect((await aliceGet.json()).connector.name).toBe('Google Drive');
    } finally {
      await close();
    }
  });

  it('forces userId from the session — a body-supplied userId cannot owner-hijack', async () => {
    const { url, close } = await startServer(store);
    try {
      // Alice POSTs with a body claiming to own it as the admin user.
      const create = await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ userId: 'u1' })),
      });
      expect(create.status).toBe(201);

      // It belongs to Alice (session), not the forged u1.
      const adminGet = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ADMIN } });
      expect(adminGet.status).toBe(404);
      const aliceGet = await fetch(`${url}/admin/connectors/gdrive`, { headers: { cookie: ALICE } });
      expect(aliceGet.status).toBe(200);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// User-authoring mock — /settings/connectors[/:id] (TASK-129). Same offline UI
// parity as the admin mock, but the user-mode policy: forces private, rejects
// admin-only fields (400), and 403s on a catalog/shared connector.
// ---------------------------------------------------------------------------

async function startUserServer(
  store: Store,
): Promise<{ url: string; close: () => Promise<void> }> {
  const auth = authMiddleware(store);
  const settingsConnectors = settingsConnectorsMiddleware(store);
  // Mount the admin mock too so a test can SEED a catalog/shared connector the
  // user route must treat as read-only (the user route can't create one).
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
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('401s without a session', async () => {
    const { url, close } = await startUserServer(store);
    try {
      const res = await fetch(`${url}/settings/connectors`);
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('POST forces the connector private (a body with no visibility is fine)', async () => {
    const { url, close } = await startUserServer(store);
    try {
      const res = await fetch(`${url}/settings/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ visibility: undefined })),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { connector: { visibility: string } };
      expect(body.connector.visibility).toBe('private');
    } finally {
      await close();
    }
  });

  it('POST rejects visibility:shared (admin-only) with 400', async () => {
    const { url, close } = await startUserServer(store);
    try {
      const res = await fetch(`${url}/settings/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ visibility: 'shared' })),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/admin-only/);
    } finally {
      await close();
    }
  });

  it('POST rejects defaultAttached:true (admin-only) with 400', async () => {
    const { url, close } = await startUserServer(store);
    try {
      const res = await fetch(`${url}/settings/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ defaultAttached: true })),
      });
      expect(res.status).toBe(400);
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
      expect(create.status).toBe(201);

      const patch = await fetch(`${url}/settings/connectors/gdrive`, {
        method: 'PATCH',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Drive' }),
      });
      expect(patch.status).toBe(200);
      const patched = (await patch.json()) as {
        connector: { name: string; visibility: string };
      };
      expect(patched.connector.name).toBe('Renamed Drive');
      expect(patched.connector.visibility).toBe('private');

      const del = await fetch(`${url}/settings/connectors/gdrive`, {
        method: 'DELETE',
        headers: { cookie: ALICE },
      });
      expect(del.status).toBe(204);
      const get = await fetch(`${url}/settings/connectors/gdrive`, {
        headers: { cookie: ALICE },
      });
      expect(get.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('PATCH / DELETE on a catalog (shared) connector is read-only — 403', async () => {
    const { url, close } = await startUserServer(store);
    try {
      // Seed a SHARED connector via the admin route (the user route can't make one).
      const seed = await fetch(`${url}/admin/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(
          upsertBody({ connectorId: 'shared-conn', visibility: 'shared' }),
        ),
      });
      expect(seed.status).toBe(201);

      const patch = await fetch(`${url}/settings/connectors/shared-conn`, {
        method: 'PATCH',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'hijack' }),
      });
      expect(patch.status).toBe(403);

      const del = await fetch(`${url}/settings/connectors/shared-conn`, {
        method: 'DELETE',
        headers: { cookie: ALICE },
      });
      expect(del.status).toBe(403);
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
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(
          upsertBody({ connectorId: 'shared-conn', visibility: 'shared' }),
        ),
      });
      // A re-POST of the same id via the user route must 403, not demote it.
      const res = await fetch(`${url}/settings/connectors`, {
        method: 'POST',
        headers: { cookie: ALICE, 'content-type': 'application/json' },
        body: JSON.stringify(upsertBody({ connectorId: 'shared-conn' })),
      });
      expect(res.status).toBe(403);
      // Still shared.
      const get = await fetch(`${url}/admin/connectors/shared-conn`, {
        headers: { cookie: ALICE },
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
      expect(patch.status).toBe(404);
    } finally {
      await close();
    }
  });
});
