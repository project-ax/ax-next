// Empty-repo materialize: open question Q#7 acceptance.
//
// `POST /repos` creates a fully empty bare repo with NO `refs/heads/main`
// and NO initial commit. The first `git push` from a host creates `main`
// atomically. This integration test proves end-to-end that:
//
//   1. POST /repos succeeds for a fresh workspaceId.
//   2. GET /repos/<id> returns {exists: true, headOid: null}.
//   3. `git ls-remote` against the same URL returns empty output (no refs).
//   4. A plugin instance pointed at the empty repo lands its first apply
//      with parent: null successfully.
//   5. GET /repos/<id> now returns {exists: true, headOid: <oid>}.
//   6. A second plugin instance (fresh mirror tempdir) fetches and reads
//      the new commit successfully.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, HookBus, makeAgentContext } from '@ax/core';
import type {
  Plugin,
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../../server/index.js';
import { createTestOnlyGitServerPlugin } from '../../client/plugin-test-only.js';
import { createRepoLifecycleClient } from '../../client/repo-lifecycle.js';

const TOKEN = 'secret';
const enc = new TextEncoder();

interface BootedPlugin {
  plugin: Plugin;
  bus: HookBus;
}

async function bootPlugin(
  baseUrl: string,
  workspaceId: string,
): Promise<BootedPlugin> {
  const plugin = createTestOnlyGitServerPlugin({
    boot: async () => ({ baseUrl, token: TOKEN, workspaceId }),
  });
  const bus = new HookBus();
  await bootstrap({ bus, plugins: [plugin], config: {} });
  return { plugin, bus };
}

async function shutdown(p: BootedPlugin): Promise<void> {
  if (typeof p.plugin.shutdown === 'function') {
    await p.plugin.shutdown();
  }
}

function ctx() {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'test-user',
  });
}

describe('empty-repo materialize', () => {
  let server: WorkspaceGitServer;
  let repoRoot: string;
  const workspaceId = 'empty1';

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-server-empty-'));
    server = await createWorkspaceGitServer({
      repoRoot,
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('first-time materialize: empty repo -> first push creates main', async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const lifecycle = createRepoLifecycleClient({ baseUrl, token: TOKEN });

    // 1. POST /repos for the empty workspace.
    await lifecycle.createRepo(workspaceId);

    // 2. GET /repos/<id> -> {exists: true, headOid: null}.
    const meta1 = await lifecycle.getRepo(workspaceId);
    expect(meta1).not.toBeNull();
    expect(meta1!.exists).toBe(true);
    expect(meta1!.headOid).toBeNull();

    // 3. Direct `git ls-remote` against the URL returns empty output. The
    // server gates on bearer auth; pass it via http.extraHeader.
    const remote = `${baseUrl}/${workspaceId}.git`;
    const ls = await runGitCapture([
      '-c',
      `http.extraHeader=Authorization: Bearer ${TOKEN}`,
      'ls-remote',
      remote,
    ]);
    expect(ls.code).toBe(0);
    expect(ls.stdout.trim()).toBe('');

    // 4. Boot a plugin instance and apply with parent: null.
    const plug = await bootPlugin(baseUrl, workspaceId);
    const apply = await plug.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx(),
      {
        changes: [
          { path: 'first.md', kind: 'put', content: enc.encode('hello') },
        ],
        parent: null,
        reason: 'initial',
      },
    );
    expect(typeof apply.version).toBe('string');
    expect(apply.delta.before).toBeNull();
    expect(apply.delta.changes).toHaveLength(1);
    expect(apply.delta.changes[0]).toMatchObject({
      path: 'first.md',
      kind: 'added',
    });

    // 5. GET /repos/<id> now reports the new headOid.
    const meta2 = await lifecycle.getRepo(workspaceId);
    expect(meta2).not.toBeNull();
    expect(meta2!.exists).toBe(true);
    expect(meta2!.headOid).toBe(apply.version);

    // 6. Second plugin instance (fresh mirror) — fetches and reads.
    const plug2 = await bootPlugin(baseUrl, workspaceId);
    const read = await plug2.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      ctx(),
      { path: 'first.md' },
    );
    expect(read.found).toBe(true);
    if (read.found) {
      expect(new TextDecoder().decode(read.bytes)).toBe('hello');
    }

    await shutdown(plug);
    await shutdown(plug2);
  });
});

// --- Helpers --------------------------------------------------------------

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGitCapture(args: readonly string[]): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      // Inherit env so the developer's git config is honored for ls-remote;
      // the bearer header is passed explicitly via -c http.extraHeader.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });
}
