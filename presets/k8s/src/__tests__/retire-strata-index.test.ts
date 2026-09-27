import { describe, expect, it } from 'vitest';
import { HookBus, bootstrap, type Plugin } from '@ax/core';
import {
  createRetireStrataIndexPlugin,
  RETIRED_STRATA_INDEX_TABLES,
  RETIRE_STRATA_INDEX_PLUGIN_NAME,
} from '../retire-strata-index.js';
import { createK8sPlugins, type K8sPresetConfig } from '../index.js';

// TASK-608. Strata's postgres index kept a copy of each agent's old memory
// text. Its owning plugin is deleted, so the preset drops the tables at init.
// The real-postgres half of this is in prod-bootstrap.test.ts; here we pin the
// exact statements against a recording stand-in for the shared Kysely.

function recordingDatabase(opts: { failOn?: string } = {}): {
  plugin: Plugin;
  statements: string[];
} {
  const statements: string[] = [];
  const db = {
    schema: {
      dropTable(name: string) {
        return {
          ifExists() {
            return {
              async execute() {
                if (name === opts.failOn) throw new Error(`drop ${name} refused`);
                statements.push(`DROP TABLE IF EXISTS ${name}`);
              },
            };
          },
        };
      },
    },
  };
  const plugin: Plugin = {
    manifest: {
      name: 'test/database',
      version: '0.0.0',
      registers: ['database:get-instance'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService('database:get-instance', 'test/database', async () => ({ db }));
    },
  };
  return { plugin, statements };
}

describe('retire-strata-index plugin (TASK-608)', () => {
  it('drops both Strata index tables, IF EXISTS, at init', async () => {
    const { plugin, statements } = recordingDatabase();
    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [plugin, createRetireStrataIndexPlugin()],
      config: {},
    });
    await handle.shutdown();
    expect(statements).toEqual([
      'DROP TABLE IF EXISTS memory_strata_index_v2_docs',
      'DROP TABLE IF EXISTS memory_strata_index_v1_docs',
    ]);
    expect([...RETIRED_STRATA_INDEX_TABLES]).toEqual([
      'memory_strata_index_v2_docs',
      'memory_strata_index_v1_docs',
    ]);
  });

  it('fails the boot loudly when the drop fails', async () => {
    const { plugin } = recordingDatabase({ failOn: 'memory_strata_index_v2_docs' });
    await expect(
      bootstrap({
        bus: new HookBus(),
        plugins: [plugin, createRetireStrataIndexPlugin()],
        config: {},
      }),
    ).rejects.toThrow(/memory_strata_index_v2_docs/);
  });

  it('registers nothing and hard-calls only database:get-instance', () => {
    const m = createRetireStrataIndexPlugin().manifest;
    expect(m.name).toBe(RETIRE_STRATA_INDEX_PLUGIN_NAME);
    expect(m.registers).toEqual([]);
    expect(m.calls).toEqual(['database:get-instance']);
  });

  it('is loaded by the k8s preset exactly once, with or without hostLlmTools', () => {
    const cfg: K8sPresetConfig = {
      database: { connectionString: 'postgres://stub:5432/stub' },
      eventbus: { connectionString: 'postgres://stub:5432/stub' },
      session: { connectionString: 'postgres://stub:5432/stub' },
      workspace: { backend: 'local', repoRoot: '/tmp/preset-k8s-stub' },
      sandbox: { namespace: 'ax-next', image: 'ax-next/agent:stub' },
      ipc: { hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80' },
      http: {
        host: '127.0.0.1',
        port: 0,
        cookieKey: '0'.repeat(64),
        allowedOrigins: [],
      },
    };
    for (const hostLlmTools of [false, true]) {
      const names = createK8sPlugins({ ...cfg, hostLlmTools }).map((p) => p.manifest.name);
      expect(names.filter((n) => n === RETIRE_STRATA_INDEX_PLUGIN_NAME)).toHaveLength(1);
    }
  });
});
