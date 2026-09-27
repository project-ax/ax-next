// TASK-576 — `workspace:purge` through the host plugin against a real
// in-process storage tier.
//
// The load-bearing client-side property is the mirror cache: a pinned read of
// an OLD version is answered from the local mirror WITHOUT a fetch (the
// TASK-554 fast path), so a purge that rewrote the storage tier but left the
// host mirror alone would keep serving the erased bytes. These tests warm the
// mirror with the pre-purge history first, so that failure mode is live.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PluginError,
  type AgentContext,
  type FileChange,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceListInput,
  type WorkspaceListOutput,
  type WorkspacePurgeInput,
  type WorkspacePurgeOutput,
  type WorkspaceReadInput,
  type WorkspaceReadOutput,
  type WorkspaceVersion,
} from '@ax/core';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createWorkspaceGitServer } from '../../server/index.js';
import { createWorkspaceGitServerPlugin } from '../plugin.js';
import { workspaceIdFor } from '../workspace-id.js';

const TOKEN = 'purge-client-test-token-do-not-leak';
const SELECTOR: WorkspacePurgeInput = {
  prefixes: ['memory/', 'permanent/memory/facts/'],
  keep: ['memory/system/rules.md'],
};
const enc = new TextEncoder();
const dec = new TextDecoder();

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function setup(baseUrlOverride?: string) {
  let baseUrl = baseUrlOverride;
  let repoRoot = '';
  if (baseUrl === undefined) {
    repoRoot = mkdtempSync(join(tmpdir(), 'ax-purge-client-repos-'));
    const server = await createWorkspaceGitServer({
      repoRoot,
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));
    cleanups.push(() => server.close());
  }
  const cacheRoot = mkdtempSync(join(tmpdir(), 'ax-purge-client-cache-'));
  cleanups.push(() => rm(cacheRoot, { recursive: true, force: true }));
  const h: TestHarness = await createTestHarness({
    plugins: [
      createWorkspaceGitServerPlugin({
        baseUrl,
        token: TOKEN,
        cacheRoot,
        retry: { attempts: 3, backoffBaseMs: 1 },
      }),
    ],
  });
  cleanups.push(() => h.close());
  const ctx = (agentId: string): AgentContext =>
    h.ctx({ userId: 'u1', agentId, sessionId: `s-${agentId}` });
  const apply = (c: AgentContext, changes: FileChange[], parent: WorkspaceVersion | null) =>
    h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', c, {
      changes,
      parent,
    });
  const read = (c: AgentContext, path: string, version?: WorkspaceVersion) =>
    h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      c,
      version === undefined ? { path } : { path, version },
    );
  const list = (c: AgentContext) =>
    h.bus.call<WorkspaceListInput, WorkspaceListOutput>('workspace:list', c, {});
  const purge = (c: AgentContext, input: WorkspacePurgeInput = SELECTOR) =>
    h.bus.call<WorkspacePurgeInput, WorkspacePurgeOutput>('workspace:purge', c, input);
  return { h, repoRoot, cacheRoot, ctx, apply, read, list, purge };
}

const put = (path: string, body: string): FileChange => ({
  path,
  kind: 'put',
  content: enc.encode(body),
});

async function seed(s: Awaited<ReturnType<typeof setup>>, c: AgentContext) {
  const v1 = await s.apply(
    c,
    [
      put('.ax/IDENTITY.md', 'identity\n'),
      put('memory/system/rules.md', 'rule\n'),
      put('notes/x.md', 'note\n'),
    ],
    null,
  );
  const v2 = await s.apply(
    c,
    [put('memory/docs/secret.md', 'SECRET\n'), put('permanent/memory/facts/p.md', 'FACT\n')],
    v1.version,
  );
  const v3 = await s.apply(c, [{ path: 'memory/docs/secret.md', kind: 'delete' }], v2.version);
  return { secretVersion: v2.version, head: v3.version };
}

describe('workspace:purge via @ax/workspace-git-server', () => {
  it('purges history on the storage tier and the host mirror stops serving pre-purge bytes', async () => {
    const s = await setup();
    const agent = s.ctx('agent-purge');
    const { secretVersion, head } = await seed(s, agent);

    // Warm the mirror: the old version is local now, so a pinned read would
    // be answered without a fetch.
    const warm = await s.read(agent, 'memory/docs/secret.md', secretVersion);
    expect(warm.found && dec.decode(warm.bytes)).toBe('SECRET\n');

    const out = await s.purge(agent);
    expect(out.pastVersionsChanged).toBe(true);
    expect(out.version).toMatch(/^[0-9a-f]{40}$/);
    expect(out.purged).toEqual(['memory/docs/secret.md', 'permanent/memory/facts/p.md']);

    expect(await s.read(agent, 'memory/docs/secret.md', secretVersion)).toEqual({ found: false });
    expect(await s.read(agent, 'notes/x.md', head)).toEqual({ found: false });
    expect((await s.list(agent)).paths).toEqual([
      '.ax/IDENTITY.md',
      'memory/system/rules.md',
      'notes/x.md',
    ]);

    // No mirror dir on the host still holds the pre-purge commits.
    for (const dir of readdirSync(s.cacheRoot)) {
      for (const oid of [secretVersion, head]) {
        const probe = spawnSync('git', ['--git-dir', join(s.cacheRoot, dir), 'cat-file', '-e', oid]);
        expect(probe.status, `${dir} still holds ${oid}`).not.toBe(0);
      }
    }

    // Writes continue from the returned version; the old one is stale.
    const stale = await s
      .apply(agent, [put('notes/y.md', 'late')], head)
      .then(() => null, (e: unknown) => e);
    expect((stale as PluginError).code).toBe('parent-mismatch');
    const next = await s.apply(agent, [put('notes/y.md', 'after')], out.version);
    const y = await s.read(agent, 'notes/y.md', next.version);
    expect(y.found && dec.decode(y.bytes)).toBe('after');

    // Second purge: nothing left under the selector.
    const again = await s.purge(agent);
    expect(again).toEqual({ purged: [], version: next.version, pastVersionsChanged: false });
  });

  it("leaves another agent's workspace alone", async () => {
    const s = await setup();
    const target = s.ctx('agent-target');
    const other = s.ctx('agent-other');
    await seed(s, target);
    const o = await seed(s, other);
    await s.purge(target);
    const r = await s.read(other, 'memory/docs/secret.md', o.secretVersion);
    expect(r.found && dec.decode(r.bytes)).toBe('SECRET\n');
  });

  it('a missing workspace answers version null and is not created', async () => {
    const s = await setup();
    const out = await s.purge(s.ctx('agent-never'));
    expect(out).toEqual({ purged: [], version: null, pastVersionsChanged: false });
    const id = workspaceIdFor({ agentId: 'agent-never' });
    expect(existsSync(join(s.repoRoot, `${id}.git`))).toBe(false);
  });

  it('rejects an invalid selector before any request', async () => {
    let hits = 0;
    const fake = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(500).end();
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => fake.close(() => r())));
    const port = (fake.address() as { port: number }).port;
    const s = await setup(`http://127.0.0.1:${port}`);
    const err = await s
      .purge(s.ctx('agent-x'), { prefixes: ['memory'] })
      .then(() => null, (e: unknown) => e);
    expect((err as PluginError).code).toBe('invalid-input');
    expect(hits).toBe(0);
  });

  it('does not retry a failed purge, and never leaks the token', async () => {
    let purgeHits = 0;
    const fake = http.createServer((req, res) => {
      if (req.method === 'POST' && /\/purge$/.test(req.url ?? '')) purgeHits += 1;
      req.resume();
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'purge_failed', message: 'purge failed: gc failed' }));
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => fake.close(() => r())));
    const port = (fake.address() as { port: number }).port;
    const s = await setup(`http://127.0.0.1:${port}`);
    const err = await s.purge(s.ctx('agent-x')).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).code).toBe('purge-failed');
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(purgeHits).toBe(1);
  });

  it('refuses an owner-less caller', async () => {
    const s = await setup();
    const err = await s
      .purge(s.h.ctx({ userId: 'u', agentId: '', sessionId: 's' }))
      .then(() => null, (e: unknown) => e);
    expect((err as PluginError).code).toBe('workspace-identity-required');
  });
});
