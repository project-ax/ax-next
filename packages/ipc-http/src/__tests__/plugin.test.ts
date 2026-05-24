import * as net from 'node:net';
import { describe, it, expect } from 'vitest';
import type { Plugin } from '@ax/core';
import { DISPATCHER_DEPENDENCIES } from '@ax/ipc-core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcHttpPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Plugin tests for @ax/ipc-http.
//
// Validates:
//   1. Listener actually binds at init() (real fetch against /healthz).
//   2. Manifest declares no service-hook registrations.
//   3. Manifest's `calls` / `optionalCalls` are spread verbatim from
//      @ax/ipc-core's DISPATCHER_DEPENDENCIES (the dispatcher is the source of
//      truth; both transports stamp the same set).
//
// `verifyCalls` (in @ax/core/bootstrap) is unconditional — it asserts every
// declared REQUIRED `calls` entry is registered by SOME plugin. The harness
// only auto-loads @ax/session-inmemory (covers session:resolve-token,
// session:claim-work, session:get-config), so we hand-roll a tiny stub plugin
// to register the remaining required producers (tool:list, workspace:read).
// The stub never gets called by these tests (we only hit /healthz pre-auth) —
// its sole job is to satisfy verifyCalls. optionalCalls (e.g.
// conversations:store-runner-session) never fail the boot, so they need no
// stub.
// ---------------------------------------------------------------------------

const stubProducers: Plugin = {
  manifest: {
    name: '@ax/test-stub-producers',
    version: '0.0.0',
    registers: ['tool:list', 'workspace:read'],
    calls: [],
    subscribes: [],
  },
  init({ bus }) {
    bus.registerService('tool:list', '@ax/test-stub-producers', async () => ({
      tools: [],
    }));
    bus.registerService('workspace:read', '@ax/test-stub-producers', async () => ({
      found: false,
    }));
  },
};

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => {
        if (typeof addr === 'object' && addr !== null) resolve(addr.port);
        else reject(new Error('failed to pick free port'));
      });
    });
  });
}

describe('createIpcHttpPlugin', () => {
  it('binds a listener at init() and serves /healthz', async () => {
    const port = await pickFreePort();
    const plugin = createIpcHttpPlugin({ host: '127.0.0.1', port });
    const harness = await createTestHarness({
      plugins: [createSessionInmemoryPlugin(), stubProducers, plugin],
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      // Drive teardown through the harness — it calls Plugin.shutdown on
      // each plugin, which closes the listener.
      await harness.close({ onError: () => {} });
    }
  });

  it('manifest registers no service hooks (registers is empty)', () => {
    const plugin = createIpcHttpPlugin({ host: '127.0.0.1', port: 0 });
    expect(plugin.manifest.registers).toEqual([]);
  });

  it('manifest.calls is spread verbatim from DISPATCHER_DEPENDENCIES.requiredCalls', () => {
    const plugin = createIpcHttpPlugin({ host: '127.0.0.1', port: 0 });
    expect(plugin.manifest.calls).toEqual([
      ...DISPATCHER_DEPENDENCIES.requiredCalls,
    ]);
  });

  it('manifest.optionalCalls is spread verbatim from DISPATCHER_DEPENDENCIES.optionalCalls', () => {
    const plugin = createIpcHttpPlugin({ host: '127.0.0.1', port: 0 });
    expect(plugin.manifest.optionalCalls).toEqual([
      ...DISPATCHER_DEPENDENCIES.optionalCalls,
    ]);
  });
});
