// I1 contract proof for @ax/workspace-git-server.
//
// The same `runWorkspaceContract` test suite that passes against
// @ax/workspace-git (in-process) and @ax/workspace-git-http MUST pass
// here against the test-only host-side plugin -> git protocol -> server
// path. If a single assertion fails, the abstraction is leaking somewhere
// in the new wire shape.
//
// Each contract scenario gets a fresh server (per-scenario repoRoot) AND a
// fresh workspaceId so version histories don't bleed across tests. The
// async plugin factory boots the server inside `init()`, which the harness
// awaits via bootstrap().
//
// Server cleanup: each scenario boots a server, we track it, and afterAll
// closes them all in parallel. Without this, watch-mode reruns leak sockets
// (per CodeRabbit Major at contract.test.ts:17).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { runWorkspaceContract } from '@ax/test-harness';
import {
  createWorkspaceGitServer,
  type WorkspaceGitServer,
} from '../server/index.js';
import { createTestOnlyGitServerPlugin } from '../client/plugin-test-only.js';

let scenarioCount = 0;
const bootedServers: WorkspaceGitServer[] = [];

afterAll(async () => {
  await Promise.allSettled(bootedServers.map((s) => s.close()));
  bootedServers.length = 0;
});

runWorkspaceContract('@ax/workspace-git-server', () =>
  createTestOnlyGitServerPlugin({
    boot: async () => {
      const server = await createWorkspaceGitServer({
        repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-server-contract-')),
        host: '127.0.0.1',
        port: 0,
        token: 'secret',
      });
      bootedServers.push(server);
      const workspaceId = `wstest${++scenarioCount}`;
      return {
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: 'secret',
        workspaceId,
      };
    },
  }),
);
