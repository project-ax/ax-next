// I1 contract proof for @ax/workspace-git-http.
//
// The same `runWorkspaceContract` test suite that passes against
// @ax/workspace-git (in-process) MUST pass here against the HTTP host
// plugin -> HTTP -> server -> @ax/workspace-git-core path. If a single
// assertion fails, the abstraction is leaking somewhere.
//
// Each contract assertion gets a fresh server (per-test repoRoot) so version
// histories don't bleed across tests. The async plugin factory boots the
// server inside `init()`, which the harness awaits via bootstrap().
//
// Server cleanup: we deliberately do NOT close the spun-up servers between
// scenarios. The test process exits cleanly so the OS reclaims the sockets;
// adding a teardown hook on the plugin is deferred to a follow-up slice.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceContract } from '@ax/test-harness';
import { createWorkspaceGitServer } from '../server/index.js';
import { createWorkspaceGitHttpPluginAsync } from '../plugin.js';

runWorkspaceContract('@ax/workspace-git-http', () =>
  createWorkspaceGitHttpPluginAsync({
    boot: async () => {
      const server = await createWorkspaceGitServer({
        repoRoot: mkdtempSync(join(tmpdir(), 'ax-ws-http-')),
        host: '127.0.0.1',
        port: 0,
        token: 'secret',
      });
      return {
        baseUrl: `http://127.0.0.1:${server.port}`,
        token: 'secret',
      };
    },
  }),
);
