import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runIndexContract, type IndexBackendFactory } from '@ax/memory-strata-index-contract';
import { createMemoryStrataIndexSqlitePlugin } from '../plugin.js';

const factory: IndexBackendFactory = async (_bus) => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-strata-index-sqlite-'));
  const databasePath = join(dir, 'index.db');
  const plugin = createMemoryStrataIndexSqlitePlugin({ databasePath });
  return {
    plugin,
    teardown: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
};

runIndexContract('@ax/memory-strata-index-sqlite', factory);
