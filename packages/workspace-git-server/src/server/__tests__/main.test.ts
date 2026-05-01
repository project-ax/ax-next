import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runServer } from '../main.js';

// Entrypoint smoke tests — exercise the importable `runServer(env)` factory
// directly, without spawning a child process. The CLI gate's SIGTERM/SIGINT
// handlers are intentionally NOT exercised here: registering them on the
// vitest process would tear down the test runner itself.

describe('git-server entrypoint', () => {
  // Each successful runServer() returns a handle we must close to release
  // the bound port; track the latest handle so afterEach cleans it up even
  // if an assertion mid-test throws.
  let toClose: { close(): Promise<void> } | null = null;
  afterEach(async () => {
    if (toClose !== null) {
      await toClose.close().catch(() => undefined);
      toClose = null;
    }
  });

  it('boots from env, serves /healthz, closes cleanly', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-main-'));
    const handle = await runServer({
      AX_GIT_SERVER_REPO_ROOT: repoRoot,
      AX_GIT_SERVER_PORT: '0',
      AX_GIT_SERVER_TOKEN: 'test-token',
      AX_GIT_SERVER_HOST: '127.0.0.1',
    });
    toClose = handle;
    expect(handle.host).toBe('127.0.0.1');
    expect(handle.port).toBeGreaterThan(0);
    const r = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(r.status).toBe(200);
  });

  it('refuses to start without AX_GIT_SERVER_TOKEN', async () => {
    await expect(
      runServer({ AX_GIT_SERVER_REPO_ROOT: '/tmp', AX_GIT_SERVER_PORT: '0' }),
    ).rejects.toThrow(/AX_GIT_SERVER_TOKEN/);
  });

  it('refuses to start without AX_GIT_SERVER_REPO_ROOT', async () => {
    await expect(
      runServer({ AX_GIT_SERVER_TOKEN: 'x', AX_GIT_SERVER_PORT: '0' }),
    ).rejects.toThrow(/AX_GIT_SERVER_REPO_ROOT/);
  });

  it('rejects non-numeric AX_GIT_SERVER_PORT', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-main-'));
    await expect(
      runServer({
        AX_GIT_SERVER_REPO_ROOT: repoRoot,
        AX_GIT_SERVER_TOKEN: 'x',
        AX_GIT_SERVER_PORT: 'abc',
      }),
    ).rejects.toThrow(/integer in 0\.\.65535/);
  });

  it('rejects out-of-range AX_GIT_SERVER_PORT', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-main-'));
    await expect(
      runServer({
        AX_GIT_SERVER_REPO_ROOT: repoRoot,
        AX_GIT_SERVER_TOKEN: 'x',
        AX_GIT_SERVER_PORT: '99999',
      }),
    ).rejects.toThrow(/integer in 0\.\.65535/);
  });

  it('boots with optional AX_GIT_SERVER_SHARD_INDEX and logs it', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-main-'));
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    try {
      const handle = await runServer({
        AX_GIT_SERVER_REPO_ROOT: repoRoot,
        AX_GIT_SERVER_TOKEN: 'x',
        AX_GIT_SERVER_PORT: '0',
        AX_GIT_SERVER_HOST: '127.0.0.1',
        AX_GIT_SERVER_SHARD_INDEX: '3',
      });
      toClose = handle;
    } finally {
      spy.mockRestore();
    }
    const combined = writes.join('');
    expect(combined).toContain('[ax/workspace-git-server]');
    expect(combined).toMatch(/shard 3/);
  });

  it('rejects negative AX_GIT_SERVER_SHARD_INDEX', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-main-'));
    await expect(
      runServer({
        AX_GIT_SERVER_REPO_ROOT: repoRoot,
        AX_GIT_SERVER_TOKEN: 'x',
        AX_GIT_SERVER_PORT: '0',
        AX_GIT_SERVER_SHARD_INDEX: '-1',
      }),
    ).rejects.toThrow(/AX_GIT_SERVER_SHARD_INDEX/);
  });

  it('rejects non-numeric AX_GIT_SERVER_SHARD_INDEX', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-wgs-main-'));
    await expect(
      runServer({
        AX_GIT_SERVER_REPO_ROOT: repoRoot,
        AX_GIT_SERVER_TOKEN: 'x',
        AX_GIT_SERVER_PORT: '0',
        AX_GIT_SERVER_SHARD_INDEX: 'abc',
      }),
    ).rejects.toThrow(/AX_GIT_SERVER_SHARD_INDEX/);
  });
});
