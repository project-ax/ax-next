import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createArtifactPublishExecutor } from '../artifact-publish-executor.js';

let permanent: string;

beforeEach(async () => {
  permanent = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-artifact-'));
});

async function writeFile(rel: string, bytes: Buffer | string): Promise<string> {
  const abs = path.join(permanent, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

function executor() {
  return createArtifactPublishExecutor({ workspaceRoot: permanent });
}

describe('artifact_publish executor', () => {
  it('publishes a file under workspace/, returning the design shape', async () => {
    await writeFile('workspace/reports/Q4.pdf', Buffer.from('hello pdf'));
    const out = await executor()({
      id: 'toolu_1',
      name: 'artifact_publish',
      input: { path: '/permanent/workspace/reports/Q4.pdf' },
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
      input: { path: '/permanent/workspace/data.bin', displayName: 'Friendly Name.bin' },
    });
    const parsed = typeof out === 'string' ? JSON.parse(out) : out;
    expect(parsed.displayName).toBe('Friendly Name.bin');
  });

  it('falls back to application/octet-stream for unknown extensions', async () => {
    await writeFile('workspace/blob.xyzzy', Buffer.from('x'));
    const out = await executor()({
      id: 'toolu_3',
      name: 'artifact_publish',
      input: { path: '/permanent/workspace/blob.xyzzy' },
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
        input: { path: '/permanent/.ax/sessions/sess1.jsonl' },
      }),
    ).rejects.toThrow(/artifact-path-not-publishable/);
  });

  it('rejects symlinks', async () => {
    const real = await writeFile('workspace/real.txt', 'r');
    const linkAbs = path.join(permanent, 'workspace/link.txt');
    await fs.symlink(real, linkAbs);
    await expect(
      executor()({
        id: 'toolu_5',
        name: 'artifact_publish',
        input: { path: '/permanent/workspace/link.txt' },
      }),
    ).rejects.toThrow(/symlink/i);
  });

  it('rejects directories', async () => {
    await fs.mkdir(path.join(permanent, 'workspace/dir'), { recursive: true });
    await expect(
      executor()({
        id: 'toolu_6',
        name: 'artifact_publish',
        input: { path: '/permanent/workspace/dir' },
      }),
    ).rejects.toThrow(/not a regular file/i);
  });

  it('rejects files larger than 100 MiB', async () => {
    const big = Buffer.alloc(100 * 1024 * 1024 + 1, 0);
    await writeFile('workspace/big.bin', big);
    await expect(
      executor()({
        id: 'toolu_7',
        name: 'artifact_publish',
        input: { path: '/permanent/workspace/big.bin' },
      }),
    ).rejects.toThrow(/100 MiB|too large/i);
  });

  it('rejects missing files', async () => {
    await expect(
      executor()({
        id: 'toolu_8',
        name: 'artifact_publish',
        input: { path: '/permanent/workspace/nope.txt' },
      }),
    ).rejects.toThrow(/not found|ENOENT/i);
  });

  it('rejects non-object / missing path input', async () => {
    await expect(
      executor()({ id: 'toolu_9', name: 'artifact_publish', input: {} }),
    ).rejects.toThrow(/path/);
  });
});
