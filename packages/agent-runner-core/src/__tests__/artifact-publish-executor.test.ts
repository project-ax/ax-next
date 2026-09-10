import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createArtifactPublishExecutor } from '../artifact-publish-executor.js';

// The executor validates against the session's REAL roots, so these tests use
// real temp directories as the roots and pass real absolute paths — the same
// thing the model does, since the operating notes hand it the real paths. The
// previous version of this file passed sandbox-absolute literals (`/agent/...`,
// `/ephemeral/...`) that the executor mapped back onto temp dirs, which is
// exactly the indirection that let the advertised paths and the real ones drift.

let files: string;
let ephemeral: string;

beforeEach(async () => {
  files = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-files-'));
  ephemeral = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-eph-'));
});

async function write(root: string, rel: string, bytes: Buffer | string): Promise<string> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

function executor() {
  return createArtifactPublishExecutor({ userFilesRoot: files, ephemeralRoot: ephemeral });
}

const call = (input: unknown) => ({ id: 'toolu_1', name: 'artifact_publish', input }) as never;

describe('artifact_publish executor', () => {
  // The case the old allowlist rejected: the agent's own working directory.
  it('publishes a file from the durable user-files tier', async () => {
    await write(files, 'reports/Q4.pdf', Buffer.from('hello pdf'));
    const out = await executor()(call({ path: path.join(files, 'reports/Q4.pdf') }));
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.path).toBe('reports/Q4.pdf');
    expect(parsed.displayName).toBe('Q4.pdf');
    expect(parsed.mediaType).toBe('application/pdf');
    expect(parsed.sizeBytes).toBe(9);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.artifactId).toBe(parsed.sha256.slice(0, 16));
    expect(parsed.downloadUrl).toBe(`ax://artifact/${parsed.artifactId}`);
  });

  it('publishes a file at the very root of the user-files tier', async () => {
    // A deliverable written to cwd with a bare relative path lands here.
    await write(files, 'summary.md', 'x');
    const out = await executor()(call({ path: path.join(files, 'summary.md') }));
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.path).toBe('summary.md');
    expect(parsed.mediaType).toBe('text/markdown');
  });

  it('publishes from the scratch artifacts/ namespace', async () => {
    await write(ephemeral, 'artifacts/draft.png', Buffer.from('img'));
    const out = await executor()(call({ path: path.join(ephemeral, 'artifacts/draft.png') }));
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.path).toBe('draft.png');
    expect(parsed.mediaType).toBe('image/png');
  });

  it('honours displayName when provided', async () => {
    await write(files, 'data.bin', Buffer.from('x'));
    const out = await executor()(
      call({ path: path.join(files, 'data.bin'), displayName: 'Friendly Name.bin' }),
    );
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.displayName).toBe('Friendly Name.bin');
  });

  it('rejects an over-long displayName', async () => {
    // Model output that gets stored and rendered — bounded rather than trusted.
    await write(files, 'data.bin', Buffer.from('x'));
    await expect(
      executor()(call({ path: path.join(files, 'data.bin'), displayName: 'a'.repeat(257) })),
    ).rejects.toThrow(/displayName too long/i);
  });

  it('falls back to application/octet-stream for unknown extensions', async () => {
    await write(files, 'blob.xyzzy', Buffer.from('x'));
    const out = await executor()(call({ path: path.join(files, 'blob.xyzzy') }));
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.mediaType).toBe('application/octet-stream');
  });

  it('rejects paths outside every publishable root', async () => {
    await expect(executor()(call({ path: '/etc/passwd' }))).rejects.toThrow(
      /artifact-path-not-publishable/,
    );
  });

  it('rejects the scratch tier outside artifacts/', async () => {
    await write(ephemeral, '.venv/pyvenv.cfg', 'x');
    await expect(
      executor()(call({ path: path.join(ephemeral, '.venv/pyvenv.cfg') })),
    ).rejects.toThrow(/artifact-path-not-publishable/);
  });

  it('rejects a symlinked final component', async () => {
    const real = await write(files, 'real.txt', 'r');
    await fs.symlink(real, path.join(files, 'link.txt'));
    await expect(executor()(call({ path: path.join(files, 'link.txt') }))).rejects.toThrow(
      /symlink/i,
    );
  });

  // The hole the security checklist surfaced while widening the tier. The
  // textual allowlist does no I/O, so it cannot see that a directory is a
  // symlink; `lstat` declines to follow only the FINAL component and traverses
  // symlinked directories on the way there. The agent writes every byte of its
  // own tier, so planting one is trivial — the executor's realpath containment
  // is what actually enforces "inside the tier".
  it('rejects a path that escapes through a symlinked INTERMEDIATE directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'not yours');
    await fs.symlink(outside, path.join(files, 'escape'));
    // Textually this is squarely inside the tier and contains no `..`.
    await expect(
      executor()(call({ path: path.join(files, 'escape/secret.txt') })),
    ).rejects.toThrow(/resolved outside the publishable tier/i);
  });

  it('still publishes through a symlinked directory that stays INSIDE the tier', async () => {
    // Containment, not a blanket symlink ban — an agent organising its own
    // files with a symlink has done nothing wrong.
    await write(files, 'real/deck.pdf', 'x');
    await fs.symlink(path.join(files, 'real'), path.join(files, 'alias'));
    const out = await executor()(call({ path: path.join(files, 'alias/deck.pdf') }));
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.mediaType).toBe('application/pdf');
  });

  it('rejects directories', async () => {
    await fs.mkdir(path.join(files, 'dir'), { recursive: true });
    await expect(executor()(call({ path: path.join(files, 'dir') }))).rejects.toThrow(
      /not a regular file/i,
    );
  });

  it('rejects files larger than 100 MiB', async () => {
    // fs.truncate grows the file to MAX+1 bytes as a sparse file on supported
    // filesystems — same size on disk as a real 100 MiB write, but no 100 MiB
    // allocation in the test process. The executor's lstat sees the full size
    // and rejects before any byte read, so we never materialize the body.
    const abs = await write(files, 'big.bin', Buffer.alloc(0));
    await fs.truncate(abs, 100 * 1024 * 1024 + 1);
    await expect(executor()(call({ path: abs }))).rejects.toThrow(/100 MiB|too large/i);
  });

  it('rejects missing files', async () => {
    await expect(executor()(call({ path: path.join(files, 'nope.txt') }))).rejects.toThrow(
      /not found|ENOENT/i,
    );
  });

  it('rejects non-object / missing path input', async () => {
    await expect(executor()(call({}))).rejects.toThrow(/path/);
  });

  describe('the governed tier is unreachable', () => {
    // `/agent/workspace/**` was the old carve-out and pointed at a directory
    // nothing creates. With the governed root no longer passed to the executor
    // at all, agent state is out of reach of a "publish your instructions"
    // injection by construction rather than by an allowlist entry.
    it('rejects agent state even when it exists on disk', async () => {
      const governed = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-agent-'));
      await fs.mkdir(path.join(governed, '.ax'), { recursive: true });
      await fs.writeFile(path.join(governed, '.ax/SOUL.md'), 'my soul');
      await fs.mkdir(path.join(governed, 'workspace'), { recursive: true });
      await fs.writeFile(path.join(governed, 'workspace/Q4.pdf'), 'x');

      for (const p of ['.ax/SOUL.md', 'workspace/Q4.pdf']) {
        await expect(executor()(call({ path: path.join(governed, p) }))).rejects.toThrow(
          /artifact-path-not-publishable/,
        );
      }
    });
  });

  describe('rejection messages', () => {
    it('name the real roots of this session, not literals from another shape', async () => {
      await expect(executor()(call({ path: '/etc/passwd' }))).rejects.toThrow(
        new RegExp(files.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    });

    it('say plainly when the deployment wires no publishable location', async () => {
      const bare = createArtifactPublishExecutor({});
      await expect(bare(call({ path: '/anything/at/all.pdf' }))).rejects.toThrow(
        /no publishable location wired/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// TASK-68: durable publish via blob.put + artifact.publish over IPC.
// ---------------------------------------------------------------------------
describe('artifact_publish executor — durable blob store path (TASK-68)', () => {
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
        return {
          artifactId: sha.slice(0, 16),
          downloadUrl: `ax://artifact/${sha.slice(0, 16)}`,
        };
      },
    };
    return { client, calls };
  }

  it('streams user-files bytes to blob.put then records artifact.publish', async () => {
    await write(files, 'reports/report.pdf', Buffer.from('durable pdf bytes'));
    const { client, calls } = mockClient();
    const exec = createArtifactPublishExecutor({
      userFilesRoot: files,
      ephemeralRoot: ephemeral,
      client,
      conversationId: 'conv-1',
    });
    const out = await exec(call({ path: path.join(files, 'reports/report.pdf') }));
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;

    // The bytes were streamed to blob.put...
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0]!.toString()).toBe('durable pdf bytes');
    // ...and the metadata row was recorded with the right scope + content hash.
    expect(calls.publish).toHaveLength(1);
    expect(calls.publish[0]).toMatchObject({
      conversationId: 'conv-1',
      path: 'reports/report.pdf',
      displayName: 'report.pdf',
      mediaType: 'application/pdf',
      size: 'durable pdf bytes'.length,
    });
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.downloadUrl).toBe(`ax://artifact/${parsed.artifactId}`);
    expect(parsed.path).toBe('reports/report.pdf');
  });

  it('streams scratch artifacts/ bytes the same way', async () => {
    await write(ephemeral, 'artifacts/report.pdf', Buffer.from('scratch bytes'));
    const { client, calls } = mockClient();
    const exec = createArtifactPublishExecutor({
      userFilesRoot: files,
      ephemeralRoot: ephemeral,
      client,
      conversationId: 'conv-1',
    });
    await exec(call({ path: path.join(ephemeral, 'artifacts/report.pdf') }));
    expect(calls.put[0]!.toString()).toBe('scratch bytes');
    expect(calls.publish[0]).toMatchObject({ path: 'report.pdf' });
  });

  it('rejects the scratch namespace when no scratch tier is wired', async () => {
    const { client } = mockClient();
    const exec = createArtifactPublishExecutor({
      userFilesRoot: files,
      client,
      conversationId: 'conv-1',
    });
    await expect(
      exec(call({ path: path.join(ephemeral, 'artifacts/x.pdf') })),
    ).rejects.toThrow(/artifact-path-not-publishable/);
  });

  it('rejects the durable tier when no durable mount is wired', async () => {
    const { client } = mockClient();
    const exec = createArtifactPublishExecutor({
      ephemeralRoot: ephemeral,
      client,
      conversationId: 'conv-1',
    });
    await expect(exec(call({ path: path.join(files, 'x.pdf') }))).rejects.toThrow(
      /artifact-path-not-publishable/,
    );
  });

  it('validates before any blob.put — a symlink never reaches the host', async () => {
    const real = await write(ephemeral, 'artifacts/real.txt', 'r');
    await fs.symlink(real, path.join(ephemeral, 'artifacts/link.txt'));
    const { client, calls } = mockClient();
    const exec = createArtifactPublishExecutor({
      userFilesRoot: files,
      ephemeralRoot: ephemeral,
      client,
      conversationId: 'conv-1',
    });
    await expect(
      exec(call({ path: path.join(ephemeral, 'artifacts/link.txt') })),
    ).rejects.toThrow(/symlink/i);
    expect(calls.put).toHaveLength(0);
  });

  it('validates containment before any blob.put — an escape never reaches the host', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'not yours');
    await fs.symlink(outside, path.join(files, 'escape'));
    const { client, calls } = mockClient();
    const exec = createArtifactPublishExecutor({
      userFilesRoot: files,
      ephemeralRoot: ephemeral,
      client,
      conversationId: 'conv-1',
    });
    await expect(
      exec(call({ path: path.join(files, 'escape/secret.txt') })),
    ).rejects.toThrow(/resolved outside the publishable tier/i);
    expect(calls.put).toHaveLength(0);
  });
});
