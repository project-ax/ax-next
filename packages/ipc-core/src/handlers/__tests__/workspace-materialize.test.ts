import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type FileChange,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
} from '@ax/core';
import { createMockWorkspacePlugin } from '@ax/test-harness';
import {
  buildBaselineBundle,
  workspaceMaterializeHandler,
} from '../workspace-materialize.js';

// ---------------------------------------------------------------------------
// workspace.materialize handler — direct unit tests
//
// Same shape as workspace-commit-notify.test.ts: bypass listener/dispatcher,
// drive the handler with a real HookBus + MockWorkspace plugin. Spawns real
// `git` in a tempdir to verify the bundle bytes are valid.
// ---------------------------------------------------------------------------

interface Env {
  bus: HookBus;
  ctx: AgentContext;
}

async function makeEnv(): Promise<Env> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createMockWorkspacePlugin()],
    config: {},
  });
  const ctx = makeAgentContext({
    sessionId: 'wm-test',
    agentId: 'wm-agent',
    userId: 'wm-user',
  });
  return { bus, ctx };
}

const enc = new TextEncoder();

/** Run git, capture stdout/stderr. Test helper — env not locked down here. */
async function git(
  args: readonly string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Decode a base64 bundle, write it to a tempdir, clone from it, and return
 * the resulting working tree's contents.
 */
async function unpackBundle(
  bundleB64: string,
): Promise<{ files: Record<string, string>; ref: string }> {
  const tmp = await mkdtemp(join(tmpdir(), 'ax-mat-test-'));
  try {
    const bundlePath = join(tmp, 'b.bundle');
    await writeFile(bundlePath, Buffer.from(bundleB64, 'base64'));
    const wt = join(tmp, 'wt');
    const clone = await git(['clone', '--branch', 'baseline', bundlePath, wt], tmp);
    if (clone.code !== 0) {
      throw new Error(`git clone failed: ${clone.stderr}`);
    }
    // Walk all files (other than .git) into a {path: content} map.
    const files: Record<string, string> = {};
    async function walk(dir: string, rel: string): Promise<void> {
      const { readdir, stat } = await import('node:fs/promises');
      const entries = await readdir(dir);
      for (const e of entries) {
        if (e === '.git') continue;
        const abs = join(dir, e);
        const r = rel.length === 0 ? e : `${rel}/${e}`;
        const st = await stat(abs);
        if (st.isDirectory()) {
          await walk(abs, r);
        } else {
          files[r] = await readFile(abs, 'utf8');
        }
      }
    }
    await walk(wt, '');
    const ref = await git(['rev-parse', 'refs/heads/baseline'], wt);
    return { files, ref: ref.stdout.trim() };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

describe('buildBaselineBundle (pure helper)', () => {
  it('returns empty string when paths is empty', async () => {
    const r = await buildBaselineBundle({ paths: [], read: async () => null });
    expect(r).toBe('');
  });

  it('returns empty string when every read returns null', async () => {
    // Race tolerance: list said the path exists, read said no — drop and
    // bundle the rest. If the rest is also empty, return empty.
    const r = await buildBaselineBundle({
      paths: ['gone.txt'],
      read: async () => null,
    });
    expect(r).toBe('');
  });

  it('produces a clonable bundle for a single file', async () => {
    const r = await buildBaselineBundle({
      paths: ['hello.txt'],
      read: async (p) => (p === 'hello.txt' ? Buffer.from('world') : null),
    });
    expect(r.length).toBeGreaterThan(0);
    const unpacked = await unpackBundle(r);
    expect(unpacked.files).toEqual({ 'hello.txt': 'world' });
    // Ref reachable: clone resolved refs/heads/baseline.
    expect(unpacked.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('produces a clonable bundle with nested directories', async () => {
    const files: Record<string, string> = {
      '.ax/CLAUDE.md': '# project memory',
      '.ax/skills/foo/SKILL.md': '---\nname: foo\n---\n',
      'src/main.ts': 'export {};\n',
    };
    const r = await buildBaselineBundle({
      paths: Object.keys(files),
      read: async (p) => (files[p] !== undefined ? Buffer.from(files[p]) : null),
    });
    const unpacked = await unpackBundle(r);
    expect(unpacked.files).toEqual(files);
  });

  it('preserves binary content faithfully', async () => {
    // A file containing a NUL byte and high-bit bytes round-trips through
    // the bundle without text-encoding corruption.
    const binary = Buffer.from([0x00, 0xff, 0x42, 0x00, 0x80]);
    const r = await buildBaselineBundle({
      paths: ['bin.dat'],
      read: async () => binary,
    });
    const tmp = await mkdtemp(join(tmpdir(), 'ax-bin-'));
    try {
      const bundlePath = join(tmp, 'b.bundle');
      await writeFile(bundlePath, Buffer.from(r, 'base64'));
      const wt = join(tmp, 'wt');
      const cl = await git(
        ['clone', '--branch', 'baseline', bundlePath, wt],
        tmp,
      );
      expect(cl.code).toBe(0);
      const content = await readFile(join(wt, 'bin.dat'));
      expect(Buffer.compare(content, binary)).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('workspace.materialize handler', () => {
  it('returns empty bundle when workspace has no current version', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await workspaceMaterializeHandler({}, ctx, bus);
    expect(result.status).toBe(200);
    expect((result.body as { bundleBytes: string }).bundleBytes).toBe('');
  });

  it('returns a clonable bundle reflecting the workspace HEAD', async () => {
    const { bus, ctx } = await makeEnv();

    // Seed the workspace with a couple of files via the bus.
    const fileBytes = (s: string): Uint8Array => enc.encode(s);
    const changes: FileChange[] = [
      { path: '.ax/CLAUDE.md', kind: 'put', content: fileBytes('# memory') },
      {
        path: '.ax/skills/foo/SKILL.md',
        kind: 'put',
        content: fileBytes('---\nname: foo\n---\n'),
      },
    ];
    await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx,
      { changes, parent: null, reason: 'seed' },
    );

    const result = await workspaceMaterializeHandler({}, ctx, bus);
    expect(result.status).toBe(200);
    const bundleBytes = (result.body as { bundleBytes: string }).bundleBytes;
    expect(bundleBytes.length).toBeGreaterThan(0);

    const unpacked = await unpackBundle(bundleBytes);
    expect(unpacked.files).toEqual({
      '.ax/CLAUDE.md': '# memory',
      '.ax/skills/foo/SKILL.md': '---\nname: foo\n---\n',
    });
    expect(unpacked.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('rejects extra request fields (.strict)', async () => {
    const { bus, ctx } = await makeEnv();
    const result = await workspaceMaterializeHandler(
      { workspaceId: 'someone-else' },
      ctx,
      bus,
    );
    expect(result.status).toBe(400);
    const errBody = result.body as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe('VALIDATION');
    expect(errBody.error.message).toContain('workspace.materialize');
  });
});
