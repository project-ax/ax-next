import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type FileChange,
  type Plugin,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceExportBaselineBundleInput,
  type WorkspaceExportBaselineBundleOutput,
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
    const clone = await git(['clone', '--branch', 'main', bundlePath, wt], tmp);
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
    const ref = await git(['rev-parse', 'refs/heads/main'], wt);
    return { files, ref: ref.stdout.trim() };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

describe('buildBaselineBundle (pure helper)', () => {
  it('produces a non-empty bundle even when paths is empty (empty-tree commit)', async () => {
    // Phase 3 direct-apply: ALWAYS produce a bundle, even for empty
    // workspaces. The bundle has one commit on refs/heads/baseline
    // whose tree is git's well-known empty-tree OID. The runner clones
    // this and pins refs/heads/baseline; subsequent turn-end bundles
    // (`baseline..HEAD`) always have a valid prerequisite.
    const r = await buildBaselineBundle({ paths: [], read: async () => null });
    expect(r.length).toBeGreaterThan(0);
    const unpacked = await unpackBundle(r);
    expect(unpacked.files).toEqual({});
    expect(unpacked.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('produces a non-empty bundle when every read returns null (race tolerance)', async () => {
    // List said paths exist, read said no — drop them and commit the
    // rest. If the rest is also empty, we still get a baseline commit
    // (empty tree). Same shape as the empty-paths case above.
    const r = await buildBaselineBundle({
      paths: ['gone.txt'],
      read: async () => null,
    });
    expect(r.length).toBeGreaterThan(0);
    const unpacked = await unpackBundle(r);
    expect(unpacked.files).toEqual({});
  });

  it('produces a deterministic baseline OID across runs (load-bearing for direct-apply)', async () => {
    // The Phase 3 direct-apply path requires the materialize-time
    // baseline OID to match what the host reconstructs at commit-notify
    // time AND what the workspace plugin's mirror cache has at HEAD.
    // Two runs of the same construction MUST produce bit-identical
    // bundles → identical commit OIDs.
    const files = { 'a.txt': 'A', '.ax/CLAUDE.md': '# memory' };
    const read = async (p: string): Promise<Buffer | null> =>
      files[p as keyof typeof files] !== undefined
        ? Buffer.from(files[p as keyof typeof files])
        : null;
    const r1 = await buildBaselineBundle({ paths: Object.keys(files), read });
    const r2 = await buildBaselineBundle({ paths: Object.keys(files), read });
    // Bundles are byte-for-byte identical.
    expect(r1).toBe(r2);
    // OID match across both decoded bundles.
    const u1 = await unpackBundle(r1);
    const u2 = await unpackBundle(r2);
    expect(u1.ref).toBe(u2.ref);
  });

  it('produces the same baseline OID regardless of input path order', async () => {
    // Stable ordering invariant: the workspace:list call may return
    // paths in any order, but the bundle we produce must be the same.
    // Otherwise commit OIDs would diverge based on which workspace
    // plugin is registered.
    const read = async (p: string): Promise<Buffer | null> => {
      if (p === 'a.txt') return Buffer.from('A');
      if (p === '.ax/CLAUDE.md') return Buffer.from('# memory');
      return null;
    };
    const r1 = await buildBaselineBundle({
      paths: ['a.txt', '.ax/CLAUDE.md'],
      read,
    });
    const r2 = await buildBaselineBundle({
      paths: ['.ax/CLAUDE.md', 'a.txt'],
      read,
    });
    expect(r1).toBe(r2);
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
        ['clone', '--branch', 'main', bundlePath, wt],
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
  it('returns a non-empty empty-tree bundle when workspace has no current version', async () => {
    // Phase 3 always-bundle: even an empty workspace gets a baseline
    // commit. The runner clones unconditionally and pins
    // refs/heads/baseline so subsequent turn-end bundles work.
    const { bus, ctx } = await makeEnv();
    const result = await workspaceMaterializeHandler({}, ctx, bus);
    expect(result.status).toBe(200);
    const bundleBytes = (result.body as { bundleBytes: string }).bundleBytes;
    expect(bundleBytes.length).toBeGreaterThan(0);
    const unpacked = await unpackBundle(bundleBytes);
    expect(unpacked.files).toEqual({});
    expect(unpacked.ref).toMatch(/^[0-9a-f]{40}$/);
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

// ---------------------------------------------------------------------------
// workspace.materialize handler — bundle-aware backend integration
//
// When the registered workspace backend implements
// `workspace:export-baseline-bundle`, materialize MUST delegate to it
// instead of reconstructing a deterministic baseline from list+read.
//
// Why: the runner unpacks the bundle and pins refs/heads/baseline at
// the bundle's tip OID. That OID becomes the prereq for every thin
// bundle the runner ships back. Commit-notify reconstructs the same
// baseline by calling `workspace:export-baseline-bundle({version: parent})`.
// If the two OIDs disagree (deterministic-X vs workspace-actual-HEAD),
// commit-notify rejects every multi-turn write with "Repository lacks
// these prerequisite commits" — silently dropping the runner's commits.
//
// Bundle-aware backends register the hook; non-bundle backends don't.
// Materialize probes via `bus.hasService` and falls back to the
// deterministic reconstruction when absent.
// ---------------------------------------------------------------------------
describe('workspace.materialize handler — bundle-aware backend', () => {
  /**
   * Probe plugin that registers list/read returning ONE file ('a.txt'
   * = 'A') AND export-baseline-bundle returning a sentinel bundle.
   * The deterministic-reconstruction path would produce a real bundle
   * containing 'a.txt'; the export hook returns the sentinel. Test
   * verifies materialize emits the sentinel.
   */
  function createProbePlugin(opts: {
    sentinelBundleB64: string;
    onExport: (input: WorkspaceExportBaselineBundleInput) => void;
  }): Plugin {
    return {
      manifest: {
        name: '@ax/test-probe-bundle-backend',
        version: '0.0.0',
        registers: [
          'workspace:list',
          'workspace:read',
          'workspace:export-baseline-bundle',
        ],
        calls: [],
        subscribes: [],
      },
      init({ bus }) {
        bus.registerService('workspace:list', '@ax/test-probe-bundle-backend', async () => ({
          paths: ['a.txt'],
        }));
        bus.registerService('workspace:read', '@ax/test-probe-bundle-backend', async () => ({
          found: true,
          bytes: enc.encode('A'),
        }));
        bus.registerService<
          WorkspaceExportBaselineBundleInput,
          WorkspaceExportBaselineBundleOutput
        >(
          'workspace:export-baseline-bundle',
          '@ax/test-probe-bundle-backend',
          async (_ctx, input) => {
            opts.onExport(input);
            return { bundleBytes: opts.sentinelBundleB64 };
          },
        );
      },
    };
  }

  it("delegates to workspace:export-baseline-bundle when the hook is registered", async () => {
    // Build a real, valid sentinel bundle so we can verify materialize
    // returns its bytes verbatim. The contents don't matter; only that
    // they aren't what buildBaselineBundle would have produced.
    const sentinelBundleB64 = await buildBaselineBundle({
      paths: ['SENTINEL.txt'],
      read: async () => Buffer.from('sentinel-marker'),
    });

    let exportCalls = 0;
    let lastExportInput: WorkspaceExportBaselineBundleInput | undefined;
    const probe = createProbePlugin({
      sentinelBundleB64,
      onExport: (input) => {
        exportCalls++;
        lastExportInput = input;
      },
    });

    const bus = new HookBus();
    await bootstrap({ bus, plugins: [probe], config: {} });
    const ctx = makeAgentContext({
      sessionId: 'wm-bundle-test',
      agentId: 'wm-agent',
      userId: 'wm-user',
    });

    const result = await workspaceMaterializeHandler({}, ctx, bus);
    expect(result.status).toBe(200);
    const bundleBytes = (result.body as { bundleBytes: string }).bundleBytes;

    expect(exportCalls).toBe(1);
    // version: undefined → "current HEAD". Materialize doesn't know the
    // OID, so it leaves the field unset and lets the backend decide.
    expect(lastExportInput?.version).toBeUndefined();
    expect(bundleBytes).toBe(sentinelBundleB64);

    // The sentinel's tree should contain SENTINEL.txt — the
    // deterministic-reconstruction path (which would have produced a
    // bundle with 'a.txt') is NOT invoked.
    const unpacked = await unpackBundle(bundleBytes);
    expect(unpacked.files).toEqual({ 'SENTINEL.txt': 'sentinel-marker' });
  });

  it("falls back to deterministic reconstruction when export-baseline-bundle is NOT registered", async () => {
    // Vanilla MockWorkspace: only registers the four base hooks. The
    // existing 'returns a clonable bundle reflecting the workspace HEAD'
    // test already covers this path — this test pins the contract via a
    // direct hasService probe to guard against accidental regressions.
    const { bus, ctx } = await makeEnv();
    expect(bus.hasService('workspace:export-baseline-bundle')).toBe(false);
    const result = await workspaceMaterializeHandler({}, ctx, bus);
    expect(result.status).toBe(200);
    const bundleBytes = (result.body as { bundleBytes: string }).bundleBytes;
    // Empty MockWorkspace → empty deterministic baseline (clonable, no files).
    const unpacked = await unpackBundle(bundleBytes);
    expect(unpacked.files).toEqual({});
  });
});
