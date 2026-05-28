import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  HookBus,
  PluginError,
  bootstrap,
  makeAgentContext,
  type AgentContext,
  type Plugin,
} from '@ax/core';
import type {
  WorkspaceExportBaselineBundleInput,
  WorkspaceExportBaselineBundleOutput,
} from '@ax/workspace-bundle-protocol';
import { createMockWorkspacePlugin } from '@ax/test-harness';
import { buildBaselineBundle } from '../workspace-materialize.js';
import { workspaceExportBaselineBundleHandler } from '../workspace-export-baseline-bundle.js';

// ---------------------------------------------------------------------------
// workspace.export-baseline-bundle handler — direct unit tests
//
// Mirror of workspace-materialize.test.ts: this is the SECOND binary action and
// it shares materialize's shape (decode the backend's base64 bundle at the wire
// edge, stream the raw bytes as application/octet-stream). The handler exists so
// the commit-notify re-sync path can ship the baseline bundle OUT-OF-BAND
// instead of inlining it in the JSON response — inlining blew the runner's
// 4 MiB MAX_RESPONSE_BYTES cap on aged workspaces (same bug class as materialize
// BUG-W3). These tests drive the handler with a real HookBus and spawn real
// `git` to verify the streamed bytes are a valid, clonable bundle at `version`.
// ---------------------------------------------------------------------------

interface Env {
  bus: HookBus;
  ctx: AgentContext;
}

function makeCtx(): AgentContext {
  return makeAgentContext({
    sessionId: 'web-test',
    agentId: 'web-agent',
    userId: 'web-user',
  });
}

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

/** Write raw bundle bytes to a tempdir, clone, return the working tree files. */
async function unpackBundleBuffer(
  bundle: Buffer,
): Promise<{ files: Record<string, string>; ref: string }> {
  const tmp = await mkdtemp(join(tmpdir(), 'ax-ebb-test-'));
  try {
    const bundlePath = join(tmp, 'b.bundle');
    await writeFile(bundlePath, bundle);
    const wt = join(tmp, 'wt');
    const clone = await git(['clone', '--branch', 'main', bundlePath, wt], tmp);
    if (clone.code !== 0) throw new Error(`git clone failed: ${clone.stderr}`);
    const files: Record<string, string> = {};
    async function walk(dir: string, rel: string): Promise<void> {
      const { readdir, stat } = await import('node:fs/promises');
      for (const e of await readdir(dir)) {
        if (e === '.git') continue;
        const abs = join(dir, e);
        const r = rel.length === 0 ? e : `${rel}/${e}`;
        const st = await stat(abs);
        if (st.isDirectory()) await walk(abs, r);
        else files[r] = await readFile(abs, 'utf8');
      }
    }
    await walk(wt, '');
    const ref = await git(['rev-parse', 'refs/heads/main'], wt);
    return { files, ref: ref.stdout.trim() };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Probe plugin registering export-baseline-bundle. `onExport` lets a test see
 * the `version` the handler forwarded; the hook returns the supplied bundle, or
 * throws a parent-mismatch PluginError when `throwParentMismatch` is set.
 */
function createProbePlugin(opts: {
  bundleB64?: string;
  onExport?: (input: WorkspaceExportBaselineBundleInput) => void;
  throwParentMismatch?: boolean;
}): Plugin {
  return {
    manifest: {
      name: '@ax/test-probe-ebb-backend',
      version: '0.0.0',
      registers: ['workspace:export-baseline-bundle'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<
        WorkspaceExportBaselineBundleInput,
        WorkspaceExportBaselineBundleOutput
      >(
        'workspace:export-baseline-bundle',
        '@ax/test-probe-ebb-backend',
        async (_ctx, input) => {
          opts.onExport?.(input);
          if (opts.throwParentMismatch) {
            throw new PluginError({
              code: 'parent-mismatch',
              plugin: '@ax/test-probe-ebb-backend',
              message: 'mirror advanced past requested version',
              cause: { actualParent: 'evenfresherhead' },
            });
          }
          return { bundleBytes: opts.bundleB64 ?? '' };
        },
      );
    },
  };
}

async function makeEnvWith(plugin: Plugin): Promise<Env> {
  const bus = new HookBus();
  await bootstrap({ bus, plugins: [plugin], config: {} });
  return { bus, ctx: makeCtx() };
}

describe('workspace.export-baseline-bundle handler', () => {
  it('streams the backend bundle for `version` as raw octet-stream bytes', async () => {
    // Build a real, valid bundle the backend will hand back; the handler must
    // decode its base64 at the wire edge and stream the verbatim raw bytes.
    const bundleB64 = await buildBaselineBundle({
      paths: ['.ax/CLAUDE.md'],
      read: async () => Buffer.from('# memory at the advanced head'),
    });

    let lastInput: WorkspaceExportBaselineBundleInput | undefined;
    const { bus, ctx } = await makeEnvWith(
      createProbePlugin({
        bundleB64,
        onExport: (input) => {
          lastInput = input;
        },
      }),
    );

    const result = await workspaceExportBaselineBundleHandler(
      { version: 'newhead' },
      ctx,
      bus,
    );

    expect(result.status).toBe(200);
    const binary = (result as { binary: Buffer }).binary;
    expect((result as { contentType: string }).contentType).toBe(
      'application/octet-stream',
    );
    // The runner's actualParent reached the backend's export verbatim.
    expect(lastInput?.version).toBe('newhead');
    // Streamed bytes equal the decoded base64 (no 33% tax, no JSON frame).
    expect(binary.equals(Buffer.from(bundleB64, 'base64'))).toBe(true);
    // And it's a real, clonable bundle.
    const unpacked = await unpackBundleBuffer(binary);
    expect(unpacked.files).toEqual({
      '.ax/CLAUDE.md': '# memory at the advanced head',
    });
  });

  it('does NOT base64-inflate a large bundle on the JSON wire (the response-too-large fix)', async () => {
    // The whole point of this action: a baseline bundle that, base64-encoded,
    // would exceed the runner's 4 MiB JSON MAX_RESPONSE_BYTES cap rides the
    // octet-stream body instead. Here we make a >4 MiB *raw* bundle (its base64
    // would be ~5.5 MiB — comfortably over the cap) and assert the handler
    // returns it as raw bytes, NOT a JSON body whose base64 string blows the cap.
    const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    // Cryptographically-random content so git's zlib pack can't shrink it — the
    // packed bundle stays >4 MiB and its base64 form stays well over the cap
    // (a deterministic byte pattern would compress away and defeat the test).
    const { randomBytes } = await import('node:crypto');
    const big = randomBytes(5 * 1024 * 1024);
    const bundleB64 = await buildBaselineBundle({
      paths: ['big.bin'],
      read: async () => big,
    });
    // Sanity: the base64 form is over the JSON cap (this is what used to break).
    expect(bundleB64.length).toBeGreaterThan(MAX_RESPONSE_BYTES);

    const { bus, ctx } = await makeEnvWith(createProbePlugin({ bundleB64 }));
    const result = await workspaceExportBaselineBundleHandler(
      { version: 'newhead' },
      ctx,
      bus,
    );

    expect(result.status).toBe(200);
    // It's a HandlerBinary (raw bytes), not a JSON body — so the dispatcher
    // streams it uncapped. The raw bundle is smaller than its base64 (no tax).
    expect('binary' in result).toBe(true);
    const binary = (result as { binary: Buffer }).binary;
    expect(binary.length).toBeLessThan(bundleB64.length);
    // The streamed raw bytes are a faithful, clonable bundle.
    const unpacked = await unpackBundleBuffer(binary);
    expect(Object.keys(unpacked.files)).toEqual(['big.bin']);
  });

  it('rejects extra request fields (.strict)', async () => {
    const { bus, ctx } = await makeEnvWith(createProbePlugin({ bundleB64: '' }));
    const result = await workspaceExportBaselineBundleHandler(
      { version: 'newhead', workspaceId: 'someone-else' },
      ctx,
      bus,
    );
    expect(result.status).toBe(400);
    const errBody = result.body as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe('VALIDATION');
    expect(errBody.error.message).toContain('workspace.export-baseline-bundle');
  });

  it('rejects a missing/empty version (the re-sync path always has a concrete head)', async () => {
    const { bus, ctx } = await makeEnvWith(createProbePlugin({ bundleB64: '' }));
    const empty = await workspaceExportBaselineBundleHandler({ version: '' }, ctx, bus);
    expect(empty.status).toBe(400);
    const missing = await workspaceExportBaselineBundleHandler({}, ctx, bus);
    expect(missing.status).toBe(400);
  });

  it('returns a sanitized 500 when no bundle backend is registered', async () => {
    // The MockWorkspace registers the neutral hooks but NOT
    // export-baseline-bundle — reaching this action on such a backend is a
    // host-config bug (the re-sync path only fires on a bundle backend).
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [createMockWorkspacePlugin()], config: {} });
    expect(bus.hasService('workspace:export-baseline-bundle')).toBe(false);
    const ctx = makeCtx();
    const result = await workspaceExportBaselineBundleHandler(
      { version: 'newhead' },
      ctx,
      bus,
    );
    expect(result.status).toBe(500);
  });

  it('sanitizes a backend parent-mismatch to 500 (does not chase the head)', async () => {
    // Yet another concurrent writer advanced past `version` before this fetch
    // landed. The handler must NOT leak the fresher head or git stderr — it
    // returns a sanitized 500 and the runner re-syncs from a fresh materialize.
    const { bus, ctx } = await makeEnvWith(
      createProbePlugin({ throwParentMismatch: true }),
    );
    const result = await workspaceExportBaselineBundleHandler(
      { version: 'newhead' },
      ctx,
      bus,
    );
    expect(result.status).toBe(500);
    const errBody = result.body as { error: { code: string; message: string } };
    expect(errBody.error.message).not.toContain('evenfresherhead');
  });
});
