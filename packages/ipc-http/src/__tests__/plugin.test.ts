import * as net from 'node:net';
import { describe, it, expect } from 'vitest';
import type { Plugin } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createIpcHttpPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Plugin tests for @ax/ipc-http.
//
// Validates:
//   1. Listener actually binds at init() (real fetch against /healthz).
//   2. Manifest declares no service-hook registrations.
//   3. Manifest declares the dispatcher-required `calls` (mirrors
//      @ax/ipc-server, since both share @ax/ipc-core's dispatcher).
//
// `verifyCalls` (in @ax/core/bootstrap) is unconditional — it asserts every
// declared `calls` entry is registered by SOME plugin. The harness only
// auto-loads @ax/session-inmemory (covers session:resolve-token and
// session:claim-work), so we hand-roll a tiny stub plugin to register
// `llm:call` and `tool:list`. The stub never gets called by these tests
// (we only hit /healthz pre-auth) — its sole job is to satisfy verifyCalls.
// ---------------------------------------------------------------------------

const stubLlmAndTools: Plugin = {
  manifest: {
    name: '@ax/test-stub-llm-tools',
    version: '0.0.0',
    registers: ['llm:call', 'tool:list'],
    calls: [],
    subscribes: [],
  },
  init({ bus }) {
    bus.registerService('llm:call', '@ax/test-stub-llm-tools', async () => ({}));
    bus.registerService('tool:list', '@ax/test-stub-llm-tools', async () => ({
      tools: [],
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
      plugins: [createSessionInmemoryPlugin(), stubLlmAndTools, plugin],
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

  it('manifest declares the dispatcher-required calls', () => {
    const plugin = createIpcHttpPlugin({ host: '127.0.0.1', port: 0 });
    // Mirrors @ax/ipc-server's manifest.calls — same dispatcher backs both.
    expect(plugin.manifest.calls).toEqual(
      expect.arrayContaining([
        'session:resolve-token',
        'session:claim-work',
        'llm:call',
        'tool:list',
      ]),
    );
  });
});
