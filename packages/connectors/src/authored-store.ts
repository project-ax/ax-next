/**
 * @ax/connectors authored-connector draft store (TASK-94).
 *
 * The single source of truth for AGENT-AUTHORED connector drafts — the
 * model-generated proposals an agent submits via `install_authored_connector`.
 * Operates on `connectors_v1_authored`, scoped `(owner_user_id, agent_id,
 * connector_id)` — the per-(user, agent) draft namespace, mirroring
 * `skills_v1_authored` vs the live skill stores.
 *
 * A draft always lands `status: 'pending'` (zero reach — it never reaches
 * `connectors:resolve`, which reads only the LIVE `connectors_v1_connectors`
 * table). A human approval at the capability wall flips it `active` via
 * {@link AuthoredConnectorsStore.activate}. The declared, UNAPPROVED capability
 * surface rides the opaque `capability_proposal` JSONB; it is validated against
 * the canonical schema on read (don't-trust-the-DB) and never interpreted.
 */
import { PluginError } from '@ax/core';
import { sql, type Kysely } from 'kysely';
import type { Capabilities, KeyMode } from './types.js';
import { CapabilitiesSchema } from './types.js';
import { validateKeyMode } from './store.js';
import { scopedAuthoredConnectors } from './scope.js';
import type { ConnectorDatabase, ConnectorsAuthoredRow } from './migrations.js';

const PLUGIN_NAME = '@ax/connectors';

/** A draft's lifecycle verdict. `pending` = awaiting human approval (zero
 *  reach); `active` = approved (reach projects via the activated connector). */
export type AuthoredConnectorStatus = 'pending' | 'active';

/** A model-authored connector draft, as read for the card + grant flows. */
export interface AuthoredConnectorDraft {
  connectorId: string;
  name: string;
  usageNote: string;
  keyMode: KeyMode;
  status: AuthoredConnectorStatus;
  /** The declared, mechanism-agnostic UNAPPROVED capability surface. */
  proposal: Capabilities;
  updatedAt: string;
}

export interface UpsertAuthoredConnectorInput {
  ownerUserId: string;
  agentId: string;
  connectorId: string;
  name: string;
  usageNote: string;
  keyMode: KeyMode;
  proposal: Capabilities;
}

export interface AuthoredConnectorsStore {
  /** Insert or replace one draft (last-write-wins per (owner, agent,
   *  connector)). Always lands `status: 'pending'` — a re-propose re-opens the
   *  gate. Returns whether THIS call created the row (vs. replaced it). */
  upsert(input: UpsertAuthoredConnectorInput): Promise<{ created: boolean }>;
  /** List the agent's authored connector drafts (any status), sorted by
   *  connector_id — the card source + grant re-resolution. */
  list(ownerUserId: string, agentId: string): Promise<AuthoredConnectorDraft[]>;
  /** Flip a `pending` draft to `active` (on approval). Status-guarded: only a
   *  `pending` row transitions, so the call is idempotent + race-safe (a
   *  concurrent duplicate approval flips zero rows the second time). Returns
   *  whether THIS call flipped a row. */
  activate(input: {
    ownerUserId: string;
    agentId: string;
    connectorId: string;
  }): Promise<{ activated: boolean }>;
  /** Delete a draft (reject / clear). Returns whether a row was removed. */
  clear(input: {
    ownerUserId: string;
    agentId: string;
    connectorId: string;
  }): Promise<{ cleared: boolean }>;
}

function rowToDraft(row: ConnectorsAuthoredRow): AuthoredConnectorDraft {
  const parsed = CapabilitiesSchema.safeParse(row.capability_proposal);
  if (!parsed.success) {
    // A corrupt / hand-edited proposal must not silently project — fail loud,
    // same posture as the live store's rowToConnector.
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `authored connector '${row.connector_id}' has a malformed capability_proposal`,
    });
  }
  return {
    connectorId: row.connector_id,
    name: row.name,
    usageNote: row.usage_note,
    keyMode: validateKeyMode(row.key_mode),
    status: row.status as AuthoredConnectorStatus,
    proposal: parsed.data,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function createAuthoredConnectorsStore(
  db: Kysely<ConnectorDatabase>,
): AuthoredConnectorsStore {
  return {
    async upsert(input) {
      const now = new Date();
      // JSONB written via an explicit `::jsonb` cast of the canonical JSON so
      // the opaque proposal round-trips byte-faithfully (mirrors the live
      // store's capabilities write).
      const proposalJson = sql<unknown>`${JSON.stringify(input.proposal)}::jsonb`;

      const existing = await scopedAuthoredConnectors(db, {
        ownerUserId: input.ownerUserId,
        agentId: input.agentId,
      })
        .where('connector_id', '=', input.connectorId)
        .executeTakeFirst();
      const created = existing === undefined;

      await db
        .insertInto('connectors_v1_authored')
        .values({
          owner_user_id: input.ownerUserId,
          agent_id: input.agentId,
          connector_id: input.connectorId,
          name: input.name,
          usage_note: input.usageNote,
          key_mode: input.keyMode,
          capability_proposal: proposalJson,
          // A re-propose always re-opens the gate: status resets to pending.
          status: 'pending',
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc
            .columns(['owner_user_id', 'agent_id', 'connector_id'])
            .doUpdateSet({
              name: input.name,
              usage_note: input.usageNote,
              key_mode: input.keyMode,
              capability_proposal: proposalJson,
              status: 'pending',
              updated_at: now,
            }),
        )
        .execute();
      return { created };
    },

    async list(ownerUserId, agentId) {
      const rows = await scopedAuthoredConnectors(db, { ownerUserId, agentId })
        .orderBy('connector_id', 'asc')
        .execute();
      return rows.map((r) => rowToDraft(r as ConnectorsAuthoredRow));
    },

    async activate({ ownerUserId, agentId, connectorId }) {
      const res = await db
        .updateTable('connectors_v1_authored')
        .set({ status: 'active', updated_at: new Date() })
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('connector_id', '=', connectorId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      return { activated: Number(res.numUpdatedRows ?? 0n) > 0 };
    },

    async clear({ ownerUserId, agentId, connectorId }) {
      const res = await db
        .deleteFrom('connectors_v1_authored')
        .where('owner_user_id', '=', ownerUserId)
        .where('agent_id', '=', agentId)
        .where('connector_id', '=', connectorId)
        .executeTakeFirst();
      return { cleared: Number(res.numDeletedRows ?? 0n) > 0 };
    },
  };
}
