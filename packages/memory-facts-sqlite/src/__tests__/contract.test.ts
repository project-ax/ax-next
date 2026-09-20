import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFactsContract, type FactsBackendFactory } from '@ax/memory-facts-contract';
import { createMemoryFactsSqlitePlugin } from '../plugin.js';

// NOTHING is registered at an embedder or reranker hook here, and nothing may
// be: contract cases 7 and 8 assert the no-producer degraded state
// (`['ranking', 'semantic']`), which is the DEFAULT deployment — TASK-434
// ships the seam, not a provider. The hash embedder that exercises the dense
// channel for real lives in this package's own `fusion-recall.test.ts`, where
// it cannot quietly satisfy a contract case that exists to observe its
// absence.
const factory: FactsBackendFactory = async (_bus) => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-facts-sqlite-'));
  const databasePath = join(dir, 'facts.db');
  const plugin = createMemoryFactsSqlitePlugin({ databasePath });
  return {
    plugin,
    // sqlite answers `query` with ranked retrieval as of TASK-434, so it is
    // held to the fusion half of the contract. Postgres stays at `false`
    // until TASK-457 flips this one boolean and inherits every case.
    capabilities: { fusionRecall: true },
    teardown: async () => {
      await plugin.shutdown?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
};

runFactsContract('@ax/memory-facts-sqlite', factory);
