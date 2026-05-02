import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import {
  WorkspaceMaterializeRequestSchema,
  WorkspaceMaterializeResponseSchema,
} from '@ax/ipc-protocol';
import {
  internalError,
  logInternalError,
  validationError,
} from '../errors.js';
import type { ActionHandler } from './types.js';

// ---------------------------------------------------------------------------
// POST /workspace.materialize
//
// Sandbox -> Host RPC fired ONCE at session start, before the SDK query
// loop opens. The handler produces a `git bundle` over the workspace's
// current state (or empty bytes for brand-new workspaces) and returns it
// base64-encoded. The runner unpacks into `/permanent` so the agent runs
// against a real git working tree from turn 1.
//
// Implementation strategy: SLOW PATH (per Phase 3 plan, Open Question Q6).
// The handler reconstructs the bundle by walking `workspace:list` and
// `workspace:read` rather than reaching into the workspace plugin's local
// mirror cache. That keeps Invariant I2 (no cross-plugin imports) clean —
// the handler talks to the workspace via the bus, not the plugin's
// internals. If profiling shows materialize is hot, a future
// `workspace:bundle` service hook can short-circuit; for Phase 3, the
// reconstruction is correct and the once-per-session cost is fine.
//
// Ordering: snapshot of the workspace at "now". `list` and `read` calls
// fan out to whichever workspace plugin is registered; the host serializes
// per-workspace writes elsewhere (Phase 2's per-workspace queue), so a
// concurrent `apply` cannot interleave between our `list` and `read` calls
// in a way that produces an inconsistent bundle. The bundle reflects a
// single point-in-time snapshot.
// ---------------------------------------------------------------------------

interface SpawnResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

// Locked-down git env for the host bundler — same shape as the storage-tier
// caller's gitEnv() (mirror-cache.ts), with author identity layered on for
// the synthetic baseline commit. PATH is fixed (rather than inheriting
// process.env.PATH) because the host pod's image is the trust root for
// binary lookup; a maliciously placed `git` in PATH would defeat the
// whole point of bundle-author verification.
const HOST_GIT_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/nonexistent',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'ax-runner',
  GIT_AUTHOR_EMAIL: 'ax-runner@example.com',
  GIT_COMMITTER_NAME: 'ax-runner',
  GIT_COMMITTER_EMAIL: 'ax-runner@example.com',
};

function runGit(
  args: readonly string[],
  opts: { cwd?: string; stdin?: Buffer } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      env: HOST_GIT_ENV,
      cwd: opts.cwd,
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    }
  });
}

async function expectOk(result: SpawnResult, label: string): Promise<void> {
  if (result.code !== 0) {
    throw new Error(`${label} failed (exit=${result.code}): ${result.stderr}`);
  }
}

/**
 * Build a single-commit `baseline` bundle from a snapshot of the workspace.
 * Returns base64 bytes, or `''` for an empty workspace.
 *
 * Pure helper, easy to test in isolation: pass it a list of paths + a read
 * function and it reconstructs the bundle.
 */
export async function buildBaselineBundle(input: {
  paths: readonly string[];
  read: (path: string) => Promise<Buffer | null>;
}): Promise<string> {
  // Drop paths that read returns null for (e.g., listed but deleted between
  // list and read — race-tolerant). If everything's gone, return empty.
  const entries: Array<{ path: string; bytes: Buffer }> = [];
  for (const p of input.paths) {
    const bytes = await input.read(p);
    if (bytes === null) continue;
    entries.push({ path: p, bytes });
  }
  if (entries.length === 0) return '';

  const tmp = await mkdtemp(join(tmpdir(), 'ax-mat-'));
  try {
    // Build a real working tree, commit, then bundle.
    // (Index-only construction with `git mktree` is faster but harder to
    // get right when paths contain nested directories; the working-tree
    // path is correctness-by-construction.)
    await expectOk(await runGit(['init', '-b', 'baseline', tmp]), 'git init');
    for (const { path, bytes } of entries) {
      const abs = join(tmp, path);
      const dir = abs.slice(0, abs.lastIndexOf('/'));
      if (dir.length > 0 && dir !== tmp) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(abs, bytes);
    }
    await expectOk(await runGit(['add', '-A'], { cwd: tmp }), 'git add');
    await expectOk(
      await runGit(['commit', '-m', 'baseline'], { cwd: tmp }),
      'git commit',
    );
    const bundle = await runGit(
      ['bundle', 'create', '-', 'baseline'],
      { cwd: tmp },
    );
    await expectOk(bundle, 'git bundle create');
    return bundle.stdout.toString('base64');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export const workspaceMaterializeHandler: ActionHandler = async (
  rawPayload,
  ctx,
  bus,
) => {
  const parsed = WorkspaceMaterializeRequestSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return validationError(`workspace.materialize: ${parsed.error.message}`);
  }

  // List the workspace at HEAD. Empty list => brand-new workspace; return
  // the empty bundle and let the runner do `git init`.
  const listed = await bus.call<WorkspaceListInput, WorkspaceListOutput>(
    'workspace:list',
    ctx,
    {},
  );

  let bundleBytes: string;
  try {
    bundleBytes = await buildBaselineBundle({
      paths: listed.paths,
      read: async (path) => {
        const r = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
          'workspace:read',
          ctx,
          { path },
        );
        if (!r.found) return null;
        return Buffer.from(r.bytes);
      },
    });
  } catch (err) {
    // Bundle construction failures are sanitized to 500 — the underlying
    // git stderr can echo a temp path or filename, neither of which the
    // sandbox should see in an error envelope. Real diagnostic goes to
    // the host log.
    logInternalError(ctx.logger, 'workspace.materialize', err);
    return internalError();
  }

  const body = { bundleBytes };
  const checked = WorkspaceMaterializeResponseSchema.safeParse(body);
  if (!checked.success) {
    logInternalError(
      ctx.logger,
      'workspace.materialize',
      new Error(`response shape drift: ${checked.error.message}`),
    );
    return internalError();
  }
  return { status: 200, body: checked.data };
};
