import { PluginError } from '@ax/core';
import { sql, type Kysely } from 'kysely';
import type { AgentsDatabase } from '../migrations.js';
import {
  IDENTITY_SECTIONS,
  type AgentIdentityRecord,
  type BootstrapState,
  type IdentityCompleteBootstrapOutput,
  type IdentitySection,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-989 — the only queries on `agents_v1_identity` (eslint
// `local/no-bare-tenant-tables` keeps tenant-table queries in store files).
//
// Plain storage: no ACL, no scan, no normalisation, no announcement — the
// service (service.ts) does those before it gets here. Rows are lazy (see the
// migration): an agent with no row reads as EMPTY_IDENTITY.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/agents';

/** What an agent with no identity row reads as. Frozen; `get` returns copies. */
export const EMPTY_IDENTITY: Readonly<AgentIdentityRecord> = Object.freeze({
  identity: '',
  soul: '',
  instructions: '',
  bootstrap: 'none',
  revision: 0,
});

export interface IdentityStoreSetArgs {
  agentId: string;
  /** Already normalised and checked by the service. At least one section. */
  patch: Partial<Record<IdentitySection, string>>;
  expectedRevision: number;
}

export interface IdentityStoreSetResult {
  kind: 'saved' | 'unchanged' | 'conflict';
  record: AgentIdentityRecord;
}

export interface IdentityStoreCompleteResult {
  kind: IdentityCompleteBootstrapOutput['outcome'];
  record: AgentIdentityRecord;
}

export interface IdentityStore {
  /** The agent's identity row, or a copy of EMPTY_IDENTITY when it has none. */
  get(agentId: string): Promise<AgentIdentityRecord>;
  /**
   * Compare-and-set the patched sections. ONE transaction: the agent row is
   * held (KEY SHARE) so a concurrent delete cannot leave an orphan row, the
   * identity row is created if absent and locked FOR UPDATE, then
   * `conflict` (stale `expectedRevision`), `unchanged` (every patched section
   * already says that) or `saved` (revision + 1). Throws `not-found` when the
   * agent row is gone.
   */
  set(args: IdentityStoreSetArgs): Promise<IdentityStoreSetResult>;
  /**
   * `pending → done`, only when the identity and the soul are both non-empty.
   * ONE conditional UPDATE: of concurrent callers exactly one matches;
   * Postgres re-checks the WHERE for the others after the winner commits, so
   * they see `done`. A miss is classified from a fresh read.
   */
  completeBootstrap(agentId: string): Promise<IdentityStoreCompleteResult>;
}

const COLUMNS = ['identity', 'soul', 'instructions', 'bootstrap', 'revision'] as const;

interface IdentityColumns {
  identity: string;
  soul: string;
  instructions: string;
  bootstrap: string;
  revision: number;
}

const BOOTSTRAP_STATES: readonly BootstrapState[] = ['none', 'pending', 'done'];

function isBootstrapState(value: string): value is BootstrapState {
  return (BOOTSTRAP_STATES as readonly string[]).includes(value);
}

/**
 * Narrow a row. The CHECK constraints make a bad value impossible through this
 * plugin; refusing one here keeps a hand-edited row from flowing out as a
 * different onboarding state than the one stored.
 */
function toRecord(agentId: string, row: IdentityColumns): AgentIdentityRecord {
  if (!isBootstrapState(row.bootstrap) || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new PluginError({
      code: 'invalid-return',
      plugin: PLUGIN_NAME,
      message: `agents_v1_identity row for '${agentId}' is malformed`,
    });
  }
  return {
    identity: row.identity,
    soul: row.soul,
    instructions: row.instructions,
    bootstrap: row.bootstrap,
    revision: row.revision,
  };
}

export function createIdentityStore(db: Kysely<AgentsDatabase>): IdentityStore {
  async function get(agentId: string): Promise<AgentIdentityRecord> {
    const row = await db
      .selectFrom('agents_v1_identity')
      .select(COLUMNS)
      .where('agent_id', '=', agentId)
      .executeTakeFirst();
    return row === undefined ? { ...EMPTY_IDENTITY } : toRecord(agentId, row);
  }

  return {
    get,

    async set({ agentId, patch, expectedRevision }) {
      return db.transaction().execute(async (trx) => {
        // KEY SHARE is the lock a foreign-key check takes: it conflicts only
        // with deleteById's FOR UPDATE, so a delete either finishes first (and
        // this finds no agent) or waits for this write (and then purges it).
        const agent = await trx
          .selectFrom('agents_v1_agents')
          .select('agent_id')
          .where('agent_id', '=', agentId)
          .forKeyShare()
          .executeTakeFirst();
        if (agent === undefined) {
          throw new PluginError({
            code: 'not-found',
            plugin: PLUGIN_NAME,
            message: `agent '${agentId}' not found`,
          });
        }
        await trx
          .insertInto('agents_v1_identity')
          .values({ agent_id: agentId })
          .onConflict((oc) => oc.column('agent_id').doNothing())
          .execute();
        const current = toRecord(
          agentId,
          await trx
            .selectFrom('agents_v1_identity')
            .select(COLUMNS)
            .where('agent_id', '=', agentId)
            .forUpdate()
            .executeTakeFirstOrThrow(),
        );
        if (current.revision !== expectedRevision) {
          return { kind: 'conflict', record: current };
        }
        const changes: Partial<Record<IdentitySection, string>> = {};
        for (const section of IDENTITY_SECTIONS) {
          const next = patch[section];
          if (next !== undefined && next !== current[section]) changes[section] = next;
        }
        if (Object.keys(changes).length === 0) {
          return { kind: 'unchanged', record: current };
        }
        const updated = await trx
          .updateTable('agents_v1_identity')
          .set({
            ...changes,
            revision: sql<number>`revision + 1`,
            updated_at: sql<Date>`now()`,
          })
          .where('agent_id', '=', agentId)
          .returning(COLUMNS)
          .executeTakeFirstOrThrow();
        return { kind: 'saved', record: toRecord(agentId, updated) };
      });
    },

    async completeBootstrap(agentId) {
      const completed = await db
        .updateTable('agents_v1_identity')
        .set({
          bootstrap: 'done',
          revision: sql<number>`revision + 1`,
          updated_at: sql<Date>`now()`,
        })
        .where('agent_id', '=', agentId)
        .where('bootstrap', '=', 'pending')
        // Stored text is trailing-trimmed at write, so whitespace-only is ''.
        .where('identity', '<>', '')
        .where('soul', '<>', '')
        .returning(COLUMNS)
        .executeTakeFirst();
      if (completed !== undefined) {
        return { kind: 'completed', record: toRecord(agentId, completed) };
      }
      const current = await get(agentId);
      const kind: IdentityStoreCompleteResult['kind'] =
        current.bootstrap === 'done'
          ? 'already-done'
          : current.bootstrap === 'none'
            ? 'not-pending'
            : 'needs-identity-and-soul';
      return { kind, record: current };
    },
  };
}
