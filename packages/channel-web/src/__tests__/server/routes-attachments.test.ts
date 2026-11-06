// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  makeAgentContext,
  PluginError,
  type Plugin,
} from '@ax/core';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createHttpServerPlugin, type HttpServerPlugin } from '@ax/http-server';
import { createAttachmentsPlugin } from '@ax/attachments';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { registerAttachmentsRoutes } from '../../server/routes-attachments.js';
import { capturingLogger, expectLoggedRequireUserFault, storeFault, type CapturingLogger } from './require-user-fault.js';

// TASK-68: @ax/attachments calls blob:put/blob:get. A tiny in-memory
// content-addressed store stands in for @ax/blob-store-fs. It keys by the real
// sha256 because the GET /api/files cases commit several uploads and read each
// one back: a shared key would serve one file's bytes for another's id.
function blobStubPlugin(): Plugin {
  const blobs = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'test-blob-stub',
      version: '0.0.0',
      registers: ['blob:put', 'blob:get', 'blob:stat'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('blob:put', 'test-blob-stub', async (_ctx, input) => {
        const bytes = (input as { bytes: Uint8Array }).bytes;
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        blobs.set(sha256, bytes);
        return { sha256, size: bytes.length };
      });
      bus.registerService('blob:get', 'test-blob-stub', async (_ctx, input) => {
        const bytes = blobs.get((input as { sha256: string }).sha256);
        return bytes === undefined ? { found: false } : { bytes };
      });
      // @ax/attachments declares blob:stat (artifacts:publish checks the sha
      // exists); these tests never publish, the stub just has to register.
      bus.registerService('blob:stat', 'test-blob-stub', async (_ctx, input) => {
        const bytes = blobs.get((input as { sha256: string }).sha256);
        return bytes === undefined ? { found: false } : { size: bytes.length };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/attachments — multipart upload (Phase 3, Task 3), and
// GET /api/files — the download, by attachment id + conversation.
//
// Same testcontainers-postgres harness shape as routes-chat.test.ts: real
// @ax/attachments + database-postgres + http-server; auth is mocked.
// @ax/conversations is NOT booted: `conversations:get` (the owner gate inside
// attachments:download) is a double that answers from a fixed owner map, and
// `blob:*` is the in-memory store above.
//
// Upload cases:
//   1. Anonymous → 401
//   2. Happy path → 200 + { attachmentId, sizeBytes, mediaType, displayName, expiresAt }
//   3. MIME not in allowlist → 415
//   4. Oversize (declared content-length) → 413
//   5. No file part → 400
//   6. Foreign Origin → 403 (CSRF gate)
//   7. Hook-level cap (route's own 413 substring branch) → 413
// Download cases: see the GET describes at the bottom.
// ---------------------------------------------------------------------------

const COOKIE_KEY = randomBytes(32);
const ALLOWED_ORIGIN = 'https://app.example.com';
const PLUGIN_NAME = '@ax/channel-web-tests';

function makeMultipart(
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    body: Buffer | string;
  }>,
  boundary = '----test-boundary',
): { body: Buffer; headers: Record<string, string> } {
  const enc = (s: string) => Buffer.from(s, 'utf8');
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(enc(`--${boundary}\r\n`));
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) disp += `; filename="${p.filename}"`;
    chunks.push(enc(disp + '\r\n'));
    if (p.contentType !== undefined) {
      chunks.push(enc(`Content-Type: ${p.contentType}\r\n`));
    }
    chunks.push(enc('\r\n'));
    chunks.push(typeof p.body === 'string' ? enc(p.body) : p.body);
    chunks.push(enc('\r\n'));
  }
  chunks.push(enc(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      origin: ALLOWED_ORIGIN,
      'x-requested-with': 'ax-admin',
    },
  };
}

function authMockPlugin(args: {
  /** null → unauthenticated; 'fault' → the session store crashes (raw error). */
  user: { id: string; isAdmin: boolean } | null | 'fault';
}): Plugin {
  return {
    manifest: {
      name: 'mock-auth',
      version: '0.0.0',
      registers: ['auth:require-user'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('auth:require-user', 'mock-auth', async () => {
        if (args.user === 'fault') throw storeFault();
        if (args.user === null) {
          throw new PluginError({
            code: 'unauthenticated',
            plugin: 'mock-auth',
            message: 'no session',
          });
        }
        return { user: args.user };
      });
    },
  };
}

// `conversations:get` is the owner gate attachments:download (and commit's
// callers) rely on. This double answers from a fixed conversationId → owner
// map and, like the real plugin, refuses a missing AND a foreign conversation
// with the same `not-found` (no existence leak).
function conversationsGetMockPlugin(
  owners: Readonly<Record<string, string>>,
): Plugin {
  return {
    manifest: {
      name: 'mock-conversations',
      version: '0.0.0',
      // agents:resolve: @ax/attachments charges a published artifact to the
      // agent's owner. No case here publishes, so it only has to exist.
      registers: ['conversations:get', 'agents:resolve'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('agents:resolve', 'mock-conversations', async () => ({
        agent: { id: 'agent-1', ownerType: 'user', ownerId: 'user-1' },
      }));
      bus.registerService(
        'conversations:get',
        'mock-conversations',
        async (_ctx, input) => {
          const { conversationId, userId } = input as {
            conversationId: string;
            userId: string;
          };
          if (owners[conversationId] !== userId) {
            throw new PluginError({
              code: 'not-found',
              plugin: 'mock-conversations',
              message: `conversation '${conversationId}' not found`,
            });
          }
          return { conversation: { conversationId, userId, agentId: 'agent-1' }, turns: [] };
        },
      );
    },
  };
}

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

interface BootArgs {
  user: { id: string; isAdmin: boolean } | null | 'fault';
  allowedOrigins?: readonly string[];
  attachmentsConfig?: Parameters<typeof createAttachmentsPlugin>[0];
  /** conversationId → owning userId, for the `conversations:get` double. */
  conversationOwners?: Readonly<Record<string, string>>;
}

interface BootResult {
  harness: TestHarness;
  port: number;
  http: HttpServerPlugin;
  logger: CapturingLogger;
}

async function boot(args: BootArgs): Promise<BootResult> {
  process.env.AX_HTTP_ALLOW_NO_ORIGINS = '1';
  const http = createHttpServerPlugin({
    host: '127.0.0.1',
    port: 0,
    cookieKey: COOKIE_KEY,
    allowedOrigins: args.allowedOrigins ?? [ALLOWED_ORIGIN],
  });
  const harness = await createTestHarness({
    plugins: [
      http,
      createDatabasePostgresPlugin({ connectionString }),
      authMockPlugin({ user: args.user }),
      // @ax/attachments declares blob:* + conversations:get calls; bootstrap
      // verifies they are registered. The upload cases only reach store-temp
      // (which calls none of them); the download cases use all of them.
      blobStubPlugin(),
      conversationsGetMockPlugin(args.conversationOwners ?? {}),
      createAttachmentsPlugin(args.attachmentsConfig ?? {}),
    ],
  });

  // Register the routes directly against the bus. Task 5 wires this into
  // the channel-web plugin's init(); for Task 3 we exercise the routes
  // through the same hook (http:register-route) the plugin will use.
  const logger = capturingLogger();
  const initCtx = makeAgentContext({
    sessionId: 'test-init',
    agentId: PLUGIN_NAME,
    userId: 'system',
    logger,
  });
  await registerAttachmentsRoutes(harness.bus, initCtx);

  return { harness, port: http.boundPort(), http, logger };
}

const harnesses: TestHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // Drop tables so each test starts fresh.
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_temps');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_files');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_artifact_versions');
    await cleanup.query('DROP TABLE IF EXISTS attachments_v1_artifacts');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

async function post(
  port: number,
  body: Buffer | string,
  headers: Record<string, string>,
): Promise<Response> {
  // DOM lib's BodyInit doesn't include Uint8Array/Buffer, but undici (the
  // runtime fetch) accepts them. Cast through unknown so tsc doesn't gate
  // on the DOM type and the runtime takes the buffer as-is.
  const bodyForFetch: BodyInit =
    typeof body === 'string'
      ? body
      : (body as unknown as BodyInit);
  return fetch(`http://127.0.0.1:${port}/api/attachments`, {
    method: 'POST',
    headers,
    body: bodyForFetch,
  });
}

describe('@ax/channel-web POST /api/attachments', () => {
  it('1. rejects anonymous requests with 401', async () => {
    const booted = await boot({ user: null });
    harnesses.push(booted.harness);
    const { body, headers } = makeMultipart([
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', body: 'hi' },
    ]);
    const r = await post(booted.port, body, headers);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'unauthenticated' });
  });

  it('1b. a session-store fault is a logged 500, not a 401 (TASK-1030)', async () => {
    const booted = await boot({ user: 'fault' });
    harnesses.push(booted.harness);
    const { body, headers } = makeMultipart([
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', body: 'hi' },
    ]);
    const r = await post(booted.port, body, headers);
    expectLoggedRequireUserFault(booted.logger, 'attachments_require_user_failed', {
      status: r.status,
      body: await r.json(),
    });
  });

  it('2. returns 200 + attachmentId on the happy path', async () => {
    const booted = await boot({ user: { id: 'u1', isAdmin: false } });
    harnesses.push(booted.harness);
    const { body, headers } = makeMultipart([
      {
        name: 'file',
        filename: 'hi.txt',
        contentType: 'text/plain',
        body: 'hi there',
      },
    ]);
    const r = await post(booted.port, body, headers);
    expect(r.status).toBe(200);
    const json = (await r.json()) as {
      attachmentId: string;
      sizeBytes: number;
      mediaType: string;
      displayName: string;
      expiresAt: string;
    };
    expect(typeof json.attachmentId).toBe('string');
    expect(json.attachmentId.length).toBeGreaterThan(0);
    expect(json.sizeBytes).toBe(8);
    expect(json.mediaType).toBe('text/plain');
    expect(json.displayName).toBe('hi.txt');
    expect(typeof json.expiresAt).toBe('string');
    expect(new Date(json.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('3. rejects 415 when mediaType is not in allowlist', async () => {
    const booted = await boot({ user: { id: 'u1', isAdmin: false } });
    harnesses.push(booted.harness);
    const { body, headers } = makeMultipart([
      {
        name: 'file',
        filename: 'evil.exe',
        contentType: 'application/x-msdownload',
        body: '...',
      },
    ]);
    const r = await post(booted.port, body, headers);
    expect(r.status).toBe(415);
  });

  it('4. rejects 413 when body exceeds 25 MiB cap', async () => {
    const booted = await boot({ user: { id: 'u1', isAdmin: false } });
    harnesses.push(booted.harness);
    // The framework's 413 fires when Content-Length exceeds the route's
    // maxBodyBytes cap. We send a real 26 MiB payload so undici doesn't
    // refuse the request on length-mismatch; http-server short-circuits
    // on the Content-Length header before draining the body.
    const big = new Uint8Array(26 * 1024 * 1024);
    const r = await fetch(`http://127.0.0.1:${booted.port}/api/attachments`, {
      method: 'POST',
      // DOM-lib BodyInit doesn't include Uint8Array, but undici does.
      body: big as unknown as BodyInit,
      headers: {
        'content-type': 'multipart/form-data; boundary=anything',
        origin: ALLOWED_ORIGIN,
        'x-requested-with': 'ax-admin',
      },
    });
    expect(r.status).toBe(413);
  });

  it('5. rejects 400 when no file part is present', async () => {
    const booted = await boot({ user: { id: 'u1', isAdmin: false } });
    harnesses.push(booted.harness);
    const { body, headers } = makeMultipart([
      { name: 'other', body: 'wrong field name' },
    ]);
    const r = await post(booted.port, body, headers);
    expect(r.status).toBe(400);
  });

  it('6. rejects 403 on foreign Origin (CSRF gate)', async () => {
    const booted = await boot({ user: { id: 'u1', isAdmin: false } });
    harnesses.push(booted.harness);
    const { body, headers } = makeMultipart([
      { name: 'file', filename: 'a.txt', contentType: 'text/plain', body: 'hi' },
    ]);
    headers['origin'] = 'https://evil.example.com';
    delete (headers as Record<string, string>)['x-requested-with'];
    const r = await post(booted.port, body, headers);
    expect(r.status).toBe(403);
  });

  it('7. rejects 413 attachment-too-large when attachments:store-temp rejects on hook-level cap', async () => {
    // Configure the attachments plugin with a 1 KiB per-file cap. The
    // framework's per-route cap stays at 25 MiB (boot's default), so a
    // 2 KiB body sails through the framework and the route's own
    // substring-mapping branch is the one that fires.
    const booted = await boot({
      user: { id: 'u1', isAdmin: false },
      attachmentsConfig: { maxFileBytes: 1024 },
    });
    harnesses.push(booted.harness);
    const { body, headers } = makeMultipart([
      {
        name: 'file',
        filename: 'big.txt',
        contentType: 'text/plain',
        body: Buffer.alloc(2 * 1024, 0x41),
      },
    ]);
    const r = await post(booted.port, body, headers);
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: string }).error).toBe('payload-too-large');
  });
});

// ---------------------------------------------------------------------------
// GET /api/files?conversationId=<c>&id=<attachmentId> — the download.
//
// Addressed by the attachment's own id plus the conversation being read.
// `attachments:download` is the ACL (the caller owns the conversation; the
// row belongs to it and to them); the route turns every refusal into the same
// 404 with no bytes, and a request that does not name a well-formed id and a
// conversation into a 400.
// ---------------------------------------------------------------------------

/** Stage + commit an upload the way the chat route does, as `userId`. */
async function commitUpload(
  harness: TestHarness,
  userId: string,
  conversationId: string,
  file: { name: string; type: string; body: string },
): Promise<string> {
  const ctx = makeAgentContext({ sessionId: 'test-upload', agentId: PLUGIN_NAME, userId });
  const staged = await harness.bus.call<unknown, { attachmentId: string }>(
    'attachments:store-temp',
    ctx,
    { bytes: Buffer.from(file.body), displayName: file.name, mediaType: file.type },
  );
  const committed = await harness.bus.call<unknown, { attachmentId: string }>(
    'attachments:commit',
    ctx,
    { attachmentId: staged.attachmentId, conversationId },
  );
  return committed.attachmentId;
}

function getFile(port: number, query: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/files?${query}`);
}

describe('@ax/channel-web GET /api/files', () => {
  it('streams an upload, addressed by conversation and id, as a download', async () => {
    const booted = await boot({
      user: { id: 'u1', isAdmin: false },
      conversationOwners: { c1: 'u1' },
    });
    harnesses.push(booted.harness);
    const id = await commitUpload(booted.harness, 'u1', 'c1', {
      name: 'hi.txt',
      type: 'text/plain',
      body: 'hi there',
    });

    const r = await getFile(booted.port, `conversationId=c1&id=${id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="hi.txt"');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await r.text()).toBe('hi there');
  });

  it('answers 404 with no bytes for an attachment from another conversation', async () => {
    const booted = await boot({
      user: { id: 'u1', isAdmin: false },
      conversationOwners: { c1: 'u1', c2: 'u1' },
    });
    harnesses.push(booted.harness);
    const id = await commitUpload(booted.harness, 'u1', 'c2', {
      name: 'payroll.csv',
      type: 'text/csv',
      body: 'TOP-SECRET-BYTES',
    });

    // The person owns both conversations, but the file was sent in c2. A chip
    // naming c1 with that id (forged, or carried over) reaches nothing.
    const r = await getFile(booted.port, `conversationId=c1&id=${id}`);
    expect(r.status).toBe(404);
    const body = await r.text();
    expect(JSON.parse(body)).toEqual({ error: 'not-found' });
    expect(body).not.toContain('TOP-SECRET-BYTES');
    expect(r.headers.get('content-disposition')).toBeNull();

    // Control: the same id in its own conversation is served, so the 404 above
    // is the conversation check and not a broken fixture.
    const own = await getFile(booted.port, `conversationId=c2&id=${id}`);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('TOP-SECRET-BYTES');
  });

  it('answers 404 with no bytes for a conversation the caller does not own', async () => {
    // The auth double hands back this object, so the signed-in person can be
    // switched mid-test for the control below.
    const signedIn = { id: 'u1', isAdmin: false };
    const booted = await boot({
      user: signedIn,
      conversationOwners: { c3: 'u2' },
    });
    harnesses.push(booted.harness);
    // u2 sends a file in u2's own conversation; u1 asks for it by its id.
    const id = await commitUpload(booted.harness, 'u2', 'c3', {
      name: 'theirs.txt',
      type: 'text/plain',
      body: 'NOT-YOURS-BYTES',
    });

    const r = await getFile(booted.port, `conversationId=c3&id=${id}`);
    expect(r.status).toBe(404);
    const body = await r.text();
    expect(JSON.parse(body)).toEqual({ error: 'not-found' });
    expect(body).not.toContain('NOT-YOURS-BYTES');

    // Control: the owner's identical request is served, so the 404 above is
    // the ownership check and not a request that could never succeed.
    signedIn.id = 'u2';
    const theirs = await getFile(booted.port, `conversationId=c3&id=${id}`);
    expect(theirs.status).toBe(200);
    expect(await theirs.text()).toBe('NOT-YOURS-BYTES');
  });

  it('takes the caller from the session, never from a userId in the query', async () => {
    const booted = await boot({
      user: { id: 'u1', isAdmin: false },
      conversationOwners: { c1: 'u1', c3: 'u2' },
    });
    harnesses.push(booted.harness);
    const theirs = await commitUpload(booted.harness, 'u2', 'c3', {
      name: 'theirs.txt',
      type: 'text/plain',
      body: 'NOT-YOURS-BYTES',
    });
    const mine = await commitUpload(booted.harness, 'u1', 'c1', {
      name: 'mine.txt',
      type: 'text/plain',
      body: 'MY-BYTES',
    });

    // Signed in as u1, claiming to be u2: still u1, so u2's file stays shut...
    const forged = await getFile(booted.port, `conversationId=c3&id=${theirs}&userId=u2`);
    expect(forged.status).toBe(404);
    expect(await forged.text()).not.toContain('NOT-YOURS-BYTES');
    // ...and u1's own file is still served, so the query did not make the
    // request u2's (nor break it).
    const own = await getFile(booted.port, `conversationId=c1&id=${mine}&userId=u2`);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('MY-BYTES');
  });

  it('sanitizes a name carrying a quote and CRLF in the Content-Disposition header', async () => {
    const booted = await boot({
      user: { id: 'u1', isAdmin: false },
      conversationOwners: { c1: 'u1' },
    });
    harnesses.push(booted.harness);
    const id = await commitUpload(booted.harness, 'u1', 'c1', {
      name: 'a"b\r\nX-Injected: 1;c.txt',
      type: 'text/plain',
      body: 'hi',
    });

    const r = await getFile(booted.port, `conversationId=c1&id=${id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="a_b__X-Injected_ 1_c.txt"');
    expect(r.headers.get('x-injected')).toBeNull();
    expect(await r.text()).toBe('hi');
  });

  it('answers 400 when the request does not name a well-formed id and a conversation', async () => {
    const booted = await boot({
      user: { id: 'u1', isAdmin: false },
      conversationOwners: { c1: 'u1' },
    });
    harnesses.push(booted.harness);
    for (const query of [
      'conversationId=c1',
      // The retired path-addressed form names a location, not a file.
      'conversationId=c1&path=.ax%2Fuploads%2Fc1%2Ft1%2Fhi.txt',
      'conversationId=c1&id=',
      'conversationId=c1&id=..%2Fhi.txt',
      'id=0123456789abcdef',
    ]) {
      const r = await getFile(booted.port, query);
      expect(r.status, query).toBe(400);
      expect(await r.json(), query).toEqual({ error: 'invalid-payload' });
    }
  });
});

describe('@ax/channel-web GET /api/files — refusals from attachments:download', () => {
  // The real hook answers `not-found` for every refusal; the route also folds a
  // `forbidden` from any other implementation into the same 404, because a 403
  // would tell a stranger the file exists.
  it.each(['not-found', 'forbidden'])('maps a %s refusal to a 404 with no bytes', async (code) => {
    const seen: unknown[] = [];
    const http = createHttpServerPlugin({
      host: '127.0.0.1',
      port: 0,
      cookieKey: COOKIE_KEY,
      allowedOrigins: [ALLOWED_ORIGIN],
    });
    const harness = await createTestHarness({
      plugins: [
        http,
        authMockPlugin({ user: { id: 'u1', isAdmin: false } }),
        {
          manifest: {
            name: 'test-download-refuses',
            version: '0.0.0',
            registers: ['attachments:download'],
            calls: [],
            subscribes: [],
          },
          init({ bus }) {
            bus.registerService('attachments:download', 'test-download-refuses', async (_ctx, input) => {
              seen.push(input);
              throw new PluginError({ code, plugin: 'test-download-refuses', message: code });
            });
          },
        },
      ],
    });
    harnesses.push(harness);
    await registerAttachmentsRoutes(
      harness.bus,
      makeAgentContext({ sessionId: 'test-init', agentId: PLUGIN_NAME, userId: 'system' }),
    );

    const r = await getFile(http.boundPort(), 'conversationId=c1&id=att-1');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not-found' });
    // The route asks by id and conversation, as the signed-in person.
    expect(seen).toStrictEqual([{ attachmentId: 'att-1', conversationId: 'c1', userId: 'u1' }]);
  });
});
