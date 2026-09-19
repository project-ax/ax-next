import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFactsContract, type FactsBackendFactory } from '@ax/memory-facts-contract';
import { createMemoryFactsSqlitePlugin } from '../plugin.js';

const factory: FactsBackendFactory = async (_bus) => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-'));
  const databasePath = join(dir, 'facts.db');
  const plugin = createMemoryFactsSqlitePlugin({ databasePath });
  return {
    plugin,
    teardown: async () => {
      await plugin.shutdown?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
};

runFactsContract('@ax/memory-facts-sqlite', factory);
