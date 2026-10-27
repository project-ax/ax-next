import { describe, expect, it } from 'vitest';
import { sql, type KyselyPlugin, type QueryId } from 'kysely';
import { createRoutinesStore } from '../store.js';
import { fixture, defaultDefinition, now } from './store-fixture.js';

const f = fixture();
describe('default control and committed admission ordering (actual PostgreSQL)', () => {
  it.each(['override-disable', 'catalog-disable', 'catalog-edit', 'catalog-delete'] as const)(
    '%s waits for admission paused after effective-enabled read', async control => {
      const definition = { ...defaultDefinition(), name: 'concurrent-default', trigger: { kind: 'interval' as const, every: '60s' } };
      const { defaultRoutineId } = await f.store.upsertDefault(definition);
      await f.store.materializeMissing({ agents: [{ agentId: 'a', ownerUserId: 'owner' }], now });
      const row = (await f.store.list({ agentId: 'a' })).find(r => r.definitionId === defaultRoutineId)!;
      let ready!: () => void;
      let release!: () => void;
      const readDone = new Promise<void>(resolve => { ready = resolve; });
      const resume = new Promise<void>(resolve => { release = resolve; });
      const reads = new Set<QueryId>();
      // Test-only Kysely observer pauses AFTER the actual override SELECT returned,
      // before acceptance inserts/commits. No production seam or arbitrary race sleep.
      const plugin: KyselyPlugin = {
        transformQuery(args) {
          if (args.node.kind === 'SelectQueryNode' && JSON.stringify(args.node).includes('agent_default_routine_overrides_v1')) reads.add(args.queryId);
          return args.node;
        },
        async transformResult(args) {
          if (reads.delete(args.queryId)) { ready(); await resume; }
          return args.result;
        },
      };
      const admissionStore = createRoutinesStore(f.db.withPlugin(plugin));
      const input = { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, actorUserId: 'owner', source: 'tick' as const, requestId: 'paused-admission', now };
      const admission = admissionStore.acceptDispatch(input);
      await readDone;
      let completed = false;
      const mutation = (control === 'override-disable'
        ? f.store.setAgentDefaultEnabled({ agentId: 'a', defaultRoutineId, ownerUserId: 'owner', enabled: false })
        : control === 'catalog-delete' ? f.store.deleteDefault(defaultRoutineId)
        : f.store.upsertDefault({ ...definition, ...(control === 'catalog-disable' ? { enabled: false } : { promptBody: 'new catalog prompt' }) })
      ).then(async () => {
        completed = true;
        return (await sql<{ n: string }>`SELECT count(*)::text AS n FROM routines_v1_dispatches WHERE routine_id=${row.routineId}`.execute(f.db)).rows[0]!.n;
      });
      try {
        // Observe either the actual database fence wait or a premature completion.
        await expect.poll(async () => completed ? 'completed' : (await sql<{ n: string }>`SELECT count(*)::text AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted`.execute(f.db)).rows[0]!.n === '1' ? 'blocked' : 'running').not.toBe('running');
        expect(completed).toBe(false);
        expect((await sql`SELECT * FROM routines_v1_dispatches`.execute(f.db)).rows).toHaveLength(0);
      } finally {
        release();
        await admission;
        await mutation;
      }
      expect(await admission).not.toBeNull();
      expect(await mutation).toBe('1'); // admission was committed when control finished
      expect(await f.store.acceptDispatch({ ...input, requestId: 'later-admission' })).toBeNull();
      expect((await sql`SELECT * FROM routines_v1_dispatches`.execute(f.db)).rows).toHaveLength(1);
    },
  );
});
