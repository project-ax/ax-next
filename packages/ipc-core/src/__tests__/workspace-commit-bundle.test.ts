import * as http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { reject } from '@ax/core';
import { WORKSPACE_COMMIT_BUNDLE_MAX_BYTES } from '@ax/ipc-protocol';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import {
  DISPATCHER_PATHS,
  MAX_BLOB_BODY_BYTES,
  checkContentType,
  dispatch,
} from '../dispatcher.js';
import { writeJsonError } from '../response.js';

// ---------------------------------------------------------------------------
// POST /workspace.commit-bundle — TASK-720.
//
// The end-of-turn save used to ride `workspace.commit-notify`, a JSON action
// whose base64 bundle had to fit the 4 MiB frame: about 3 MiB of compressed
// objects per save. Over it the save failed, the runner kept its baseline, and
// every later save re-carried the same blob — persistence wedged for good.
// The binary action carries the raw bundle as the body (100 MiB budget, the
// same channel as blob.put and the transcript actions), with `reason` and
// `parentVersion` in the query.
//
// Over a real HTTP server (unix socket) running the SOURCE `checkContentType`
// gate + `dispatch`, the same two calls the transports make. Not the
// @ax/ipc-server listener: it imports @ax/ipc-core's built dist, where the
// bundler mocks below cannot reach. The listener's auth gate is covered by
// dispatcher.test.ts; what matters here is routing, the body cap, the query
// and the answer. The bundler pipeline is mocked (as in the handler tests) so
// the handler reaches pre-apply and apply with arbitrary bytes; the bundler
// has its own unit tests, and the real-git path is the large-bundle e2e.
// ---------------------------------------------------------------------------

const {
  prepareScratchRepoMock,
  verifyBundleAuthorMock,
  walkBundleChangesMock,
} = vi.hoisted(() => ({
  prepareScratchRepoMock: vi.fn(),
  verifyBundleAuthorMock: vi.fn(),
  walkBundleChangesMock: vi.fn(),
}));

vi.mock('../bundler/scratch.js', () => ({
  prepareScratchRepo: prepareScratchRepoMock,
}));
vi.mock('../bundler/verify.js', () => ({
  verifyBundleAuthor: verifyBundleAuthorMock,
}));
vi.mock('../bundler/walk.js', () => ({
  walkBundleChanges: walkBundleChangesMock,
}));

interface Setup {
  socketPath: string;
  harness: TestHarness;
  server: http.Server;
  tempDir: string;
}

interface Seen {
  exportInput?: unknown;
  applyInput?: Record<string, unknown>;
  preApply?: { sizeBytes?: unknown; parent?: unknown; reason?: unknown } | undefined;
}

const setups: Setup[] = [];

afterEach(async () => {
  for (const s of setups) {
    await new Promise<void>((r) => s.server.close(() => r()));
    await fsp.rm(s.tempDir, { recursive: true, force: true }).catch(() => {});
  }
  setups.length = 0;
});

beforeEach(() => {
  prepareScratchRepoMock.mockReset();
  verifyBundleAuthorMock.mockReset();
  walkBundleChangesMock.mockReset();
  prepareScratchRepoMock.mockResolvedValue({
    repoPath: '/tmp/scratch-commit-bundle',
    baselineCommit: 'aaaa0000',
    dispose: vi.fn().mockResolvedValue(undefined),
  });
  verifyBundleAuthorMock.mockResolvedValue(undefined);
  walkBundleChangesMock.mockResolvedValue([]);
});

async function setup(opts: {
  seen: Seen;
  veto?: Parameters<typeof reject>[0];
}): Promise<Setup> {
  const { seen } = opts;
  const harness = await createTestHarness({
    services: {
      'workspace:export-baseline-bundle': async (_ctx, input) => {
        seen.exportInput = input;
        return { bundleBytes: 'UEFDSwAAAAA=' };
      },
      'workspace:apply-bundle': async (_ctx, input) => {
        seen.applyInput = input as Record<string, unknown>;
        return {
          version: 'v-applied',
          delta: { before: null, after: 'v-applied', changes: [] },
        };
      },
    },
  });
  harness.bus.subscribe(
    'workspace:pre-apply',
    '@ax/test-commit-bundle-pre-apply',
    (async (_ctx: unknown, payload: Seen['preApply']) => {
      seen.preApply = payload;
      return opts.veto !== undefined ? reject(opts.veto) : undefined;
    }) as never,
  );
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-cb-'));
  const socketPath = path.join(tempDir, 'ipc.sock');
  const ctx = harness.ctx();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://ipc.local');
    const ct = checkContentType(req.method, url.pathname, req.headers['content-type'] ?? '');
    if (!ct.ok) {
      req.resume();
      writeJsonError(res, 415, 'VALIDATION', ct.message);
      return;
    }
    void dispatch(req, res, ctx, harness.bus);
  });
  await new Promise<void>((r) => server.listen(socketPath, () => r()));
  const s = { socketPath, harness, server, tempDir };
  setups.push(s);
  return s;
}

function upload(
  s: Setup,
  pathWithQuery: string,
  body: Buffer,
  contentType = 'application/octet-stream',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, rejectP) => {
    const req = http.request(
      {
        socketPath: s.socketPath,
        path: pathWithQuery,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(body.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', rejectP);
    req.on('socket', (sock) => sock.on('error', () => {}));
    req.write(body);
    req.end();
  });
}

const BUNDLE = Buffer.from('PACK-not-really-a-bundle\x00\x01\x02');

describe('POST /workspace.commit-bundle', () => {
  it('is a binary action (raw body), and the JSON action stays routed for older sandboxes', () => {
    expect(DISPATCHER_PATHS.binaryActions).toContain('/workspace.commit-bundle');
    expect(DISPATCHER_PATHS.actions).toContain('/workspace.commit-notify');
  });

  it('the protocol cap the runner pre-checks against fits the host body budget', () => {
    expect(WORKSPACE_COMMIT_BUNDLE_MAX_BYTES).toBeLessThanOrEqual(MAX_BLOB_BODY_BYTES);
  });

  it('reads the raw body, takes reason + parentVersion from the query, and lands the save', async () => {
    const seen: Seen = {};
    const s = await setup({ seen });
    const res = await upload(s, '/workspace.commit-bundle?reason=turn&parentVersion=v-1', BUNDLE);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ accepted: true, version: 'v-applied', delta: null });
    expect(seen.exportInput).toEqual({ version: 'v-1' });
    // The core still speaks base64 internally: the raw body is re-encoded once.
    expect(prepareScratchRepoMock).toHaveBeenCalledWith(
      expect.objectContaining({ bundleBytes: BUNDLE.toString('base64') }),
    );
    expect(seen.applyInput).toMatchObject({
      bundleBytes: BUNDLE.toString('base64'),
      parent: 'v-1',
      reason: 'turn',
    });
    expect(seen.preApply).toMatchObject({ sizeBytes: BUNDLE.length, parent: 'v-1', reason: 'turn' });
  });

  it('an ABSENT parentVersion means null (the first save of a new workspace)', async () => {
    const seen: Seen = {};
    const s = await setup({ seen });
    const res = await upload(s, '/workspace.commit-bundle?reason=turn', BUNDLE);
    expect(res.status).toBe(200);
    expect(seen.exportInput).toEqual({ version: null });
    expect(seen.applyInput).toMatchObject({ parent: null });
  });

  it('wrong content-type → 415 (the gate keys on the path)', async () => {
    const s = await setup({ seen: {} });
    const res = await upload(
      s,
      '/workspace.commit-bundle?reason=turn',
      Buffer.from('{}'),
      'application/json',
    );
    expect(res.status).toBe(415);
  });

  it.each([
    ['missing reason', '/workspace.commit-bundle?parentVersion=v-1'],
    ['empty reason', '/workspace.commit-bundle?reason='],
    ['over-long reason', `/workspace.commit-bundle?reason=${'r'.repeat(201)}`],
    ['empty parentVersion', '/workspace.commit-bundle?reason=turn&parentVersion='],
    ['over-long parentVersion', `/workspace.commit-bundle?reason=turn&parentVersion=${'v'.repeat(513)}`],
  ])('%s → 400 VALIDATION, nothing applied', async (_label, url) => {
    const seen: Seen = {};
    const s = await setup({ seen });
    const res = await upload(s, url, BUNDLE);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(seen.exportInput).toBeUndefined();
    expect(seen.applyInput).toBeUndefined();
  });

  it('an empty body is an empty turn: accepted at the sent parentVersion, nothing applied', async () => {
    const seen: Seen = {};
    const s = await setup({ seen });
    const res = await upload(s, '/workspace.commit-bundle?reason=turn&parentVersion=v-7', Buffer.alloc(0));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ accepted: true, version: 'v-7', delta: null });
    expect(seen.exportInput).toBeUndefined();
    expect(seen.applyInput).toBeUndefined();
    expect(prepareScratchRepoMock).not.toHaveBeenCalled();
  });

  it('admits a bundle bigger than the 4 MiB JSON frame (the bug: ~3 MiB was the most one save could carry)', async () => {
    const seen: Seen = {};
    const s = await setup({ seen });
    // 6 MiB: over the JSON frame, and its base64 (8 MiB) is past the size at
    // which the JSON schema's base64 regex overflows the stack — so this also
    // pins that the binary path never runs that regex.
    const big = Buffer.alloc(6 * 1024 * 1024, 0x5a);
    const res = await upload(s, '/workspace.commit-bundle?reason=turn&parentVersion=v-1', big);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ accepted: true, version: 'v-applied' });
    // The whole body reached the handler: the size the quota sees is the
    // real byte count, derived host-side.
    expect(seen.preApply?.sizeBytes).toBe(big.length);
  });

  it("forwards the veto's machine code on the refusal", async () => {
    const seen: Seen = {};
    const s = await setup({
      seen,
      veto: { reason: 'Storage for this workspace is full.', code: 'storage-full' },
    });
    const res = await upload(s, '/workspace.commit-bundle?reason=turn&parentVersion=v-1', BUNDLE);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      accepted: false,
      reason: 'Storage for this workspace is full.',
      recoverable: false,
      code: 'storage-full',
    });
    expect(seen.applyInput).toBeUndefined();
  });

  it('a veto with no code answers with no code key at all', async () => {
    const s = await setup({ seen: {}, veto: { reason: 'sdk-config veto: illegal key' } });
    const res = await upload(s, '/workspace.commit-bundle?reason=turn&parentVersion=v-1', BUNDLE);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({ accepted: false, recoverable: false });
    expect('code' in body).toBe(false);
  });
});
