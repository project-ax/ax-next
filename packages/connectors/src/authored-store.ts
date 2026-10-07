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
 * table). Since slice 2c a draft is a request in the workspace admins' queue:
 * an admin approves it by creating the connector, which clears every draft
 * with that id. Nothing flips a draft `active` any more; `active` rows are
 * left over from the removed in-chat approval and are never listed as
 * pending. The declared, UNAPPROVED capability
 * surface rides the opaque `capability_proposal` JSONB; it is validated against
 * the canonical schema on read (don't-trust-the-DB) and never interpreted.
 */
import { PluginError } from '@ax/core';
import { sql, type Kysely } from 'kysely';
import type { Capabilities, KeyMode } from './types.js';
import { CapabilitiesSchema } from './types.js';
import { validateKeyMode } from './store.js';
import {
  clearAuthoredConnectorsByIdForAdmins,
  pendingAuthoredConnectorsForAdmins,
  scopedAuthoredConnectors,
} from './scope.js';
import type { ConnectorDatabase, ConnectorsAuthoredRow } from './migrations.js';

const PLUGIN_NAME = '@ax/connectors';

/** A draft's lifecycle verdict. `pending` = awaiting an admin (zero reach);
 *  `active` = approved through the in-chat card that slice 2c removed. No code
 *  writes `active` now; the value is read only from older rows. */
export type AuthoredConnectorStatus = 'pending' | 'active';

/** A model-authored connector draft, as read back from the store. */
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

/** A pending draft listed ACROSS owners (slice 2c — the admin queue). Carries
 *  who proposed it and under which agent. */
export interface PendingAuthoredConnectorDraft extends AuthoredConnectorDraft {
  ownerUserId: string;
  agentId: string;
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
  /** Slice 2c — every owner's PENDING drafts, each carrying its owner and
   *  agent, sorted by connector_id, owner_user_id, agent_id for a stable order.
   *  A SYSTEM read: backs the admin proposal queue only. */
  listPendingAll(): Promise<PendingAuthoredConnectorDraft[]>;
  /**
   * Slice 2c — delete EVERY draft with this connector id, across owners and
   * agents, in any status. Called when a live connector with that id is created
   * (the proposals are resolved) and by the admin Dismiss. Throws on an empty
   * id BEFORE any statement runs. Returns how many rows were removed.
   */
  clearAllById(connectorId: string): Promise<{ cleared: number }>;
  /**
   * Delete EVERY draft keyed on `agentId`, for all owner users and connector
   * ids, in any status (TASK-718 — the `agents:deleted` purge). Keyed on
   * `agent_id` alone: a team agent has drafts for several owners, and scoping
   * by owner would strand the rest. Only this table is touched — the live
   * `connectors_v1_connectors` registry has no agent dimension (it is the
   * user's own connector, not the agent's data). Idempotent: an agent with no
   * drafts removes zero rows.
   *
   * Throws on an empty `agentId` BEFORE any statement runs: an empty key must
   * never reach a `DELETE`.
   */
  deleteAllForAgent(agentId: string): Promise<{ removed: number }>;
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

    async listPendingAll() {
      const rows = await pendingAuthoredConnectorsForAdmins(db)
        .orderBy('connector_id', 'asc')
        .orderBy('owner_user_id', 'asc')
        .orderBy('agent_id', 'asc')
        .execute();
      return rows.map((r) => {
        const row = r as ConnectorsAuthoredRow;
        return { ...rowToDraft(row), ownerUserId: row.owner_user_id, agentId: row.agent_id };
      });
    },

    async clearAllById(connectorId) {
      if (typeof connectorId !== 'string' || connectorId.length === 0) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          message: 'clearAllById requires a non-empty connectorId',
        });
      }
      return { cleared: await clearAuthoredConnectorsByIdForAdmins(db, connectorId) };
    },

    async deleteAllForAgent(agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          message: 'deleteAllForAgent requires a non-empty agentId',
        });
      }
      const res = await db
        .deleteFrom('connectors_v1_authored')
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return { removed: Number(res.numDeletedRows ?? 0n) };
    },
  };
}
