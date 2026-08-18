import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createArtifactPublishExecutor } from '../artifact-publish-executor.js';

let agent: string;

beforeEach(async () => {
  agent = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-artifact-'));
});

async function writeFile(rel: string, bytes: Buffer | string): Promise<string> {
  const abs = path.join(agent, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

function executor() {
  return createArtifactPublishExecutor({ workspaceRoot: agent });
}

describe('artifact_publish executor', () => {
  it('publishes a file under workspace/, returning the design shape', async () => {
    await writeFile('workspace/reports/Q4.pdf', Buffer.from('hello pdf'));
    const out = await executor()({
      id: 'toolu_1',
      name: 'artifact_publish',
      input: { path: '/agent/workspace/reports/Q4.pdf' },
    });
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.path).toBe('workspace/reports/Q4.pdf');
    expect(parsed.displayName).toBe('Q4.pdf');
    expect(parsed.mediaType).toBe('application/pdf');
    expect(parsed.sizeBytes).toBe(9);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.artifactId).toBe(parsed.sha256.slice(0, 16));
    expect(parsed.downloadUrl).toBe(`ax://artifact/${parsed.artifactId}`);
  });

  it('honours displayName when provided', async () => {
    await writeFile('workspace/data.bin', Buffer.from('x'));
    const out = await executor()({
      id: 'toolu_2',
      name: 'artifact_publish',
      input: { path: '/agent/workspace/data.bin', displayName: 'Friendly Name.bin' },
    });
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.displayName).toBe('Friendly Name.bin');
  });

  it('falls back to application/octet-stream for unknown extensions', async () => {
    await writeFile('workspace/blob.xyzzy', Buffer.from('x'));
    const out = await executor()({
      id: 'toolu_3',
      name: 'artifact_publish',
      input: { path: '/agent/workspace/blob.xyzzy' },
    });
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.mediaType).toBe('application/octet-stream');
  });

  it('rejects paths outside the allowlist with a tool_result is_error message', async () => {
    await writeFile('.ax/sessions/sess1.jsonl', 'x');
    await expect(
      executor()({
        id: 'toolu_4',
        name: 'artifact_publish',
        input: { path: '/agent/.ax/sessions/sess1.jsonl' },
      }),
    ).rejects.toThrow(/artifact-path-not-publishable/);
  });

  it('rejects symlinks', async () => {
    const real = await writeFile('workspace/real.txt', 'r');
    const linkAbs = path.join(agent, 'workspace/link.txt');
    await fs.symlink(real, linkAbs);
    await expect(
      executor()({
        id: 'toolu_5',
        name: 'artifact_publish',
        input: { path: '/agent/workspace/link.txt' },
      }),
    ).rejects.toThrow(/symlink/i);
  });

  it('rejects directories', async () => {
    await fs.mkdir(path.join(agent, 'workspace/dir'), { recursive: true });
    await expect(
      executor()({
        id: 'toolu_6',
        name: 'artifact_publish',
        input: { path: '/agent/workspace/dir' },
      }),
    ).rejects.toThrow(/not a regular file/i);
  });

  it('rejects files larger than 100 MiB', async () => {
    // fs.truncate grows the file to MAX+1 bytes as a sparse file on
    // supported filesystems — same size on disk as a real 100 MiB write,
    // but no 100 MiB allocation in the test process. The executor's lstat
    // sees the full size and rejects before any byte read happens, so we
    // never materialize the body. Keeps CI memory pressure flat.
    const absPath = await writeFile('workspace/big.bin', Buffer.alloc(0));
    await fs.truncate(absPath, 100 * 1024 * 1024 + 1);
    await expect(
      executor()({
        id: 'toolu_7',
        name: 'artifact_publish',
        input: { path: '/agent/workspace/big.bin' },
      }),
    ).rejects.toThrow(/100 MiB|too large/i);
  });

  it('rejects missing files', async () => {
    await expect(
      executor()({
        id: 'toolu_8',
        name: 'artifact_publish',
        input: { path: '/agent/workspace/nope.txt' },
      }),
    ).rejects.toThrow(/not found|ENOENT/i);
  });

  it('rejects non-object / missing path input', async () => {
    await expect(
      executor()({ id: 'toolu_9', name: 'artifact_publish', input: {} }),
    ).rejects.toThrow(/path/);
  });
});

// ---------------------------------------------------------------------------
// TASK-68: durable publish via blob.put + artifact.publish over IPC.
// ---------------------------------------------------------------------------
describe('artifact_publish executor — durable blob store path (TASK-68)', () => {
  let ephemeral: string;

  beforeEach(async () => {
    ephemeral = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-eph-'));
  });

  async function writeEphemeral(rel: string, bytes: Buffer | string): Promise<void> {
    const abs = path.join(ephemeral, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  }

  function mockClient() {
    const calls: { put: Buffer[]; publish: unknown[] } = { put: [], publish: [] };
    const client = {
      callBinaryUpload: async (_action: string, bytes: Buffer) => {
        calls.put.push(bytes);
        // Compute the real content hash so the executor's returned sha256 is
        // exercised end-to-end.
        const { createHash } = await import('node:crypto');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        return { sha256, size: bytes.length };
      },
      call: async (_action: string, payload: unknown) => {
        calls.publish.push(payload);
        const sha = (payload as { sha256: string }).sha256;
        return { artifactId: sha.slice(0, 16), downloadUrl: `ax://artifact/${sha.slice(0, 16)}` };
      },
    };
    return { client, calls };
  }

  it('streams /ephemeral/artifacts bytes to blob.put then records artifact.publish', async () => {
    await writeEphemeral('artifacts/report.pdf', Buffer.from('durable pdf bytes'));
    const { client, calls } = mockClient();
    const exec = createArtifactPublishExecutor({
      workspaceRoot: agent,
      ephemeralRoot: ephemeral,
      client,
      conversationId: 'conv-1',
    });
    const out = await exec({
      id: 't1',
      name: 'artifact_publish',
      input: { path: '/ephemeral/artifacts/report.pdf' },
    });
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;

    // The bytes were streamed to blob.put...
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0]!.toString()).toBe('durable pdf bytes');
    // ...and the metadata row was recorded with the right scope + content hash.
    expect(calls.publish).toHaveLength(1);
    expect(calls.publish[0]).toMatchObject({
      conversationId: 'conv-1',
      path: 'artifacts/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      size: 'durable pdf bytes'.length,
    });
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.downloadUrl).toBe(`ax://artifact/${parsed.artifactId}`);
    expect(parsed.path).toBe('artifacts/report.pdf');
  });

  it('rejects /ephemeral/artifacts when no ephemeral tier is wired', async () => {
    const { client } = mockClient();
    const exec = createArtifactPublishExecutor({
      workspaceRoot: agent,
      client,
      conversationId: 'conv-1',
    });
    await expect(
      exec({ id: 't2', name: 'artifact_publish', input: { path: '/ephemeral/artifacts/x.pdf' } }),
    ).rejects.toThrow(/ephemeral tier is not available/);
  });

  it('still validates (symlink reject) on the durable path before any blob.put', async () => {
    const real = path.join(ephemeral, 'artifacts/real.txt');
    await writeEphemeral('artifacts/real.txt', 'r');
    await fs.symlink(real, path.join(ephemeral, 'artifacts/link.txt'));
    const { client, calls } = mockClient();
    const exec = createArtifactPublishExecutor({
      workspaceRoot: agent,
      ephemeralRoot: ephemeral,
      client,
      conversationId: 'conv-1',
    });
    await expect(
      exec({ id: 't3', name: 'artifact_publish', input: { path: '/ephemeral/artifacts/link.txt' } }),
    ).rejects.toThrow(/symlink/i);
    // No bytes were streamed — validation fired before blob.put.
    expect(calls.put).toHaveLength(0);
  });
});
