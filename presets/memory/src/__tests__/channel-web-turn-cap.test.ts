import { describe, expect, it, vi } from 'vitest';
import type { MemoryPresetConfig } from '../index.js';

// B1 — the memory preset is what production boots (AX_PRESET defaults to
// memory). It drops the k8s base's channel-web and re-adds its own, so the
// stream buffer's sizing hint must carry the chart's turn cap here too:
// without it, a reply quiet for longer than the default timeout + slack has
// its cursor shell reaped mid-turn and the client silently loses output.
const { captured } = vi.hoisted(() => ({
  captured: { webCfgs: [] as Array<Record<string, unknown>> },
}));

vi.mock('@ax/channel-web/server', async (importActual) => {
  const actual = await importActual<typeof import('@ax/channel-web/server')>();
  return {
    ...actual,
    createChannelWebServerPlugin: (cfg: Record<string, unknown>) => {
      captured.webCfgs.push(cfg);
      return actual.createChannelWebServerPlugin(cfg);
    },
  };
});

const { createMemoryPlugins } = await import('../index.js');

const config: MemoryPresetConfig = {
  database: { connectionString: 'postgres://stub:5432/stub' },
  eventbus: { connectionString: 'postgres://stub:5432/stub' },
  session: { connectionString: 'postgres://stub:5432/stub' },
  blob: { backend: 'fs', root: '/tmp/preset-memory-stub/ws/blobs' },
  ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
  chat: { runnerBinaries: { 'claude-sdk': '/tmp/stub-runner.js' } },
  http: { host: '127.0.0.1', port: 0, cookieKey: '0'.repeat(64), allowedOrigins: [] },
  factsDatabasePath: '/tmp/preset-memory-stub/facts/facts.db',
};

/** The channel-web the memory preset actually loads (the last one built). */
function loadedWebCfg(): Record<string, unknown> | undefined {
  return captured.webCfgs.at(-1);
}

describe('memory preset: channel-web carries the turn cap (B1)', () => {
  it('passes maxTurnMs when chat.maxTurnMinutes is set', () => {
    captured.webCfgs.length = 0;
    const plugins = createMemoryPlugins({ ...config, chat: { ...config.chat, maxTurnMinutes: 120 } });
    expect(plugins.filter((p) => p.manifest.name === '@ax/channel-web')).toHaveLength(1);
    expect(loadedWebCfg()).toEqual({ chatTimeoutMs: 10 * 60_000, maxTurnMs: 120 * 60_000 });
  });

  it('without a turn cap, channel-web gets only the chat timeout', () => {
    captured.webCfgs.length = 0;
    createMemoryPlugins(config);
    expect(loadedWebCfg()).toEqual({ chatTimeoutMs: 10 * 60_000 });
  });
});
