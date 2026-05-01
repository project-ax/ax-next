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
// Server cleanup: we deliberately do NOT close the spun-up servers between
// scenarios — same shape the sibling test uses. The test process exits
// cleanly so the OS reclaims the sockets; the plugin's own `shutdown()`
// hook deletes the per-plugin mirror tempdir.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceContract } from '@ax/test-harness';
import { createWorkspaceGitServer } from '../server/index.js';
import { createTestOnlyGitServerPlugin } from '../client/plugin-test-only.js';

let scenarioCount = 0;

runWorkspaceContract('@ax/workspace-git-server', () =>
  createTestOnlyGitServerPlugin({
    boot: async () => {
      const server = await createWorkspaceGitServer({
        repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-server-contract-')),
        host: '127.0.0.1',
        port: 0,
        token: 'secret',
      });
      const workspaceId = `wstest${++scenarioCount}`;
      return {
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: 'secret',
        workspaceId,
      };
    },
  }),
);
