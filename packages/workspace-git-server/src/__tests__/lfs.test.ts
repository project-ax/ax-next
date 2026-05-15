import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../server/index.js';

const TEST_TOKEN = 'lfs-test-secret';

let server: WorkspaceGitServer;
let repoRoot: string;
let baseUrl: string;
const workspaceId = 'wslfstest';

beforeAll(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-lfs-test-'));
  server = await createWorkspaceGitServer({
    repoRoot,
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;

  const res = await fetch(`${baseUrl}/repos`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ workspaceId }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`create repo failed: ${res.status} ${await res.text()}`);
  }
});

afterAll(async () => {
  await server?.close();
  await rm(repoRoot, { recursive: true, force: true });
});

describe('LFS endpoints', () => {
  it('returns upload action URLs from POST /info/lfs/objects/batch (upload)', async () => {
    const blob = Buffer.from('hello LFS');
    const oid = createHash('sha256').update(blob).digest('hex');
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/objects/batch`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/vnd.git-lfs+json',
          accept: 'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({
          operation: 'upload',
          transfers: ['basic'],
          objects: [{ oid, size: blob.length }],
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/vnd.git-lfs+json');
    const body = await res.json();
    expect(body.transfer).toBe('basic');
    expect(body.objects).toHaveLength(1);
    expect(body.objects[0].actions.upload.href).toContain(
      `/${workspaceId}.git/info/lfs/storage/${oid}`,
    );
    expect(body.objects[0].actions.verify.href).toContain(
      `/${workspaceId}.git/info/lfs/verify`,
    );
  });

  it('rejects unauthenticated batch requests with 401', async () => {
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/objects/batch`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/vnd.git-lfs+json' },
        body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [] }),
      },
    );
    expect(res.status).toBe(401);
  });

  it('uploads + downloads a blob via PUT/GET storage endpoints', async () => {
    const blob = Buffer.from('round trip');
    const oid = createHash('sha256').update(blob).digest('hex');

    const uploadRes = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/storage/${oid}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        body: blob,
      },
    );
    expect(uploadRes.status).toBe(200);

    const downloadRes = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/storage/${oid}`,
      { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(downloadRes.status).toBe(200);
    const downloaded = Buffer.from(await downloadRes.arrayBuffer());
    expect(downloaded.equals(blob)).toBe(true);
  });

  it('returns 404 for missing OID on download', async () => {
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/storage/0000000000000000000000000000000000000000000000000000000000000000`,
      { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(res.status).toBe(404);
  });

  it('rejects OID that fails the regex on PUT', async () => {
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/storage/not-a-valid-oid`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        body: Buffer.from('x'),
      },
    );
    expect(res.status).toBe(400);
  });

  it('rejects OID/payload sha256 mismatch on PUT with 422', async () => {
    const blob = Buffer.from('legit content');
    const wrongOid = 'a'.repeat(64); // valid format, wrong content
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/storage/${wrongOid}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        body: blob,
      },
    );
    expect(res.status).toBe(422);
  });

  it('verify endpoint returns 200 for a present OID', async () => {
    const blob = Buffer.from('verify me');
    const oid = createHash('sha256').update(blob).digest('hex');
    await fetch(`${baseUrl}/${workspaceId}.git/info/lfs/storage/${oid}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      body: blob,
    });
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/verify`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({ oid, size: blob.length }),
      },
    );
    expect(res.status).toBe(200);
  });

  it('verify endpoint returns 404 for an absent OID', async () => {
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/verify`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({
          oid: 'a'.repeat(64),
          size: 1,
        }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('rejects unknown workspaceId with 400 on PUT storage', async () => {
    const oid = 'a'.repeat(64);
    const res = await fetch(
      `${baseUrl}/INVALID..ID/info/lfs/storage/${oid}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        body: Buffer.from('x'),
      },
    );
    expect(res.status).toBe(400);
  });

  it('rejects unknown workspaceId with 400 on POST batch', async () => {
    const res = await fetch(
      `${baseUrl}/INVALID..ID/info/lfs/objects/batch`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [] }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('rejects unknown workspaceId with 400 on POST verify', async () => {
    const res = await fetch(
      `${baseUrl}/INVALID..ID/info/lfs/verify`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({ oid: 'a'.repeat(64), size: 1 }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('rejects unknown workspaceId with 400 on GET storage', async () => {
    const oid = 'a'.repeat(64);
    const res = await fetch(
      `${baseUrl}/INVALID..ID/info/lfs/storage/${oid}`,
      { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(res.status).toBe(400);
  });

  it('honors X-Forwarded-Proto: https for the advertised batch hrefs', async () => {
    const blob = Buffer.from('https batch');
    const oid = createHash('sha256').update(blob).digest('hex');
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/objects/batch`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/vnd.git-lfs+json',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({
          operation: 'upload',
          transfers: ['basic'],
          objects: [{ oid, size: blob.length }],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.objects[0].actions.upload.href).toMatch(/^https:\/\//);
    expect(body.objects[0].actions.verify.href).toMatch(/^https:\/\//);
  });

  it('removes the .lfs object store when the repo is deleted', async () => {
    const blob = Buffer.from('to-be-deleted');
    const oid = createHash('sha256').update(blob).digest('hex');
    const delWorkspace = 'wsdel';
    await fetch(`${baseUrl}/repos`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workspaceId: delWorkspace }),
    });
    const uploadRes = await fetch(
      `${baseUrl}/${delWorkspace}.git/info/lfs/storage/${oid}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        body: blob,
      },
    );
    expect(uploadRes.status).toBe(200);

    const delRes = await fetch(`${baseUrl}/repos/${delWorkspace}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(delRes.status).toBe(204);

    // .lfs directory is gone, so a download for the previously-uploaded OID
    // now 404s.
    const downloadRes = await fetch(
      `${baseUrl}/${delWorkspace}.git/info/lfs/storage/${oid}`,
      { headers: { authorization: `Bearer ${TEST_TOKEN}` } },
    );
    expect(downloadRes.status).toBe(404);

    // And the on-disk .lfs directory is removed.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(repoRoot, `${delWorkspace}.lfs`))).toBe(false);
  });
});
