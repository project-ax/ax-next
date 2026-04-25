import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runServer } from '../main.js';

// Entrypoint smoke tests — exercise the importable `runServer(env)` factory
// directly, without spawning a child process. The CLI gate's SIGTERM/SIGINT
// handlers are intentionally NOT exercised here: registering them on the
// vitest process would tear down the test runner itself.

describe('git-server entrypoint', () => {
  it('boots from env, serves /healthz, closes cleanly', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-main-'));
    const handle = await runServer({
      AX_GIT_SERVER_REPO_ROOT: repoRoot,
      AX_GIT_SERVER_PORT: '0',
      AX_GIT_SERVER_TOKEN: 'test-token',
      AX_GIT_SERVER_HOST: '127.0.0.1',
    });
    try {
      const r = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      expect(r.status).toBe(200);
    } finally {
      await handle.close();
    }
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
});
