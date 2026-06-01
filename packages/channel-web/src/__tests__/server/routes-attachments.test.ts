// @vitest-environment node
import { randomBytes } from 'node:crypto';
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
  type TestHarness, stopPostgresContainer } from '@ax/test-harness';
import { registerAttachmentsRoutes } from '../../server/routes-attachments.js';

// TASK-68: @ax/attachments now calls blob:put/blob:get (not workspace:apply/
// read). A tiny in-memory content-addressed stub satisfies bootstrap verifyCalls
// without pulling in @ax/blob-store-fs (these POST-upload tests only hit
// store-temp, which never invokes blob:put — the stub just needs to register).
function blobStubPlugin(): Plugin {
  const blobs = new Map<string, Uint8Array>();
  return {
    manifest: {
      name: 'test-blob-stub',
      version: '0.0.0',
      registers: ['blob:put', 'blob:get'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('blob:put', 'test-blob-stub', async (_ctx, input) => {
        const bytes = (input as { bytes: Uint8Array }).bytes;
        // Cheap deterministic key — these tests never read back, so a length+first-
        // byte key is enough to register the hook; real hashing isn't needed.
        const sha256 = 'f'.repeat(64);
        blobs.set(sha256, bytes);
        return { sha256, size: bytes.length };
      });
      bus.registerService('blob:get', 'test-blob-stub', async (_ctx, input) => {
        const bytes = blobs.get((input as { sha256: string }).sha256);
        return bytes === undefined ? { found: false } : { bytes };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/attachments — multipart upload (Phase 3, Task 3).
//
// Same testcontainers-postgres harness shape as routes-chat.test.ts: real
// @ax/attachments + database-postgres + http-server; auth is mocked.
// Conversations is NOT booted (these tests exercise only store-temp, not
// commit/download). The workspace is mocked because @ax/attachments's
// manifest declares `workspace:apply` + `workspace:read` calls (bootstrap
// verifies registration at boot).
//
// Cases:
//   1. Anonymous → 401
//   2. Happy path → 200 + { attachmentId, sizeBytes, mediaType, displayName, expiresAt }
//   3. MIME not in allowlist → 415
//   4. Oversize (declared content-length) → 413
//   5. No file part → 400
//   6. Foreign Origin → 403 (CSRF gate)
//   7. Hook-level cap (route's own 413 substring branch) → 413
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
  user: { id: string; isAdmin: boolean } | null;
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

// @ax/attachments declares conversations:get as a call (used by
// attachments:download). Bootstrap verifies registration at boot, so we
// stub a minimal plugin that registers the hook. These tests only exercise
// POST /api/attachments → attachments:store-temp, which never invokes
// conversations:get; the stub exists purely to satisfy the manifest gate.
function conversationsGetMockPlugin(): Plugin {
  return {
    manifest: {
      name: 'mock-conversations',
      version: '0.0.0',
      registers: ['conversations:get'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService(
        'conversations:get',
        'mock-conversations',
        async () => {
          throw new PluginError({
            code: 'not-found',
            plugin: 'mock-conversations',
            message: 'unused in these tests',
          });
        },
      );
    },
  };
}

let container: StartedPostgreSqlContainer;
let connectionString: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

interface BootArgs {
  user: { id: string; isAdmin: boolean } | null;
  allowedOrigins?: readonly string[];
  attachmentsConfig?: Parameters<typeof createAttachmentsPlugin>[0];
}

interface BootResult {
  harness: TestHarness;
  port: number;
  http: HttpServerPlugin;
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
      // @ax/attachments declares blob:put + blob:get + conversations:get calls
      // (TASK-68: blob:* replaced the git workspace:apply/read path). Bootstrap
      // verifies registration at boot, so we stub all three even though POST
      // /api/attachments only hits store-temp (which never invokes any of them).
      blobStubPlugin(),
      conversationsGetMockPlugin(),
      createAttachmentsPlugin(args.attachmentsConfig ?? {}),
    ],
  });

  // Register the routes directly against the bus. Task 5 wires this into
  // the channel-web plugin's init(); for Task 3 we exercise the routes
  // through the same hook (http:register-route) the plugin will use.
  const initCtx = makeAgentContext({
    sessionId: 'test-init',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });
  await registerAttachmentsRoutes(harness.bus, initCtx);

  return { harness, port: http.boundPort(), http };
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
