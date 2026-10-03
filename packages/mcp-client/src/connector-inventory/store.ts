// ---------------------------------------------------------------------------
// Inventory cache table. @ax/mcp-client owns `mcp_client_v1_*`; no other
// plugin reads or writes it (invariant I4) — they go through
// `connectors:describe-tools`.
//
// One row per (user, agent, connector): the inventory depends on whose
// credential reached the server (a personal key may see different tools than
// a workspace key), and credential lookup walks user → agent → global scope,
// so all three are part of the key. `agent_id` is '' when the caller named no
// agent. There is deliberately no FK to connectors/agents: rows are a cache,
// expire by TTL at read time, and a stale row for a deleted connector is
// never reached because `connectors:resolve` refuses it first. An agent's
// rows are deleted when `agents:deleted` fires (TASK-718 guard).
// ---------------------------------------------------------------------------

import { sql, type Kysely } from 'kysely';
import type { InventoryStatus, InventoryTool } from './types.js';

export async function runMcpClientMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_client_v1_tool_inventory (
      user_id      TEXT NOT NULL,
      agent_id     TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      status       TEXT NOT NULL,
      tools        TEXT NOT NULL,
      fingerprint  TEXT NOT NULL,
      checked_at   TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (user_id, agent_id, connector_id)
    )`.execute(db);
}

interface ToolInventoryTable {
  user_id: string;
  agent_id: string;
  connector_id: string;
  status: string;
  tools: string;
  fingerprint: string;
  checked_at: Date;
}

export interface McpClientDatabase {
  mcp_client_v1_tool_inventory: ToolInventoryTable;
}

export interface InventoryKey {
  userId: string;
  agentId: string;
  connectorId: string;
}

export interface InventoryRow {
  status: InventoryStatus;
  tools: InventoryTool[];
  fingerprint: string;
  checkedAt: Date;
}

export interface InventoryStore {
  get(key: InventoryKey): Promise<InventoryRow | null>;
  put(key: InventoryKey, row: InventoryRow): Promise<void>;
  /** Drop every row cached under an agent (on `agents:deleted`). */
  deleteForAgent(agentId: string): Promise<{ deleted: number }>;
}

const STATUSES: ReadonlySet<string> = new Set(['ok', 'unreachable', 'needs-auth', 'unknown']);

export function createInventoryStore(db: Kysely<McpClientDatabase>): InventoryStore {
  return {
    async get(key) {
      const row = await db
        .selectFrom('mcp_client_v1_tool_inventory')
        .selectAll()
        .where('user_id', '=', key.userId)
        .where('agent_id', '=', key.agentId)
        .where('connector_id', '=', key.connectorId)
        .executeTakeFirst();
      if (row === undefined || !STATUSES.has(row.status)) return null;
      let tools: InventoryTool[];
      try {
        const parsed: unknown = JSON.parse(row.tools);
        if (!Array.isArray(parsed)) return null;
        tools = parsed as InventoryTool[];
      } catch {
        return null; // a corrupt cache row is a miss, not an error
      }
      return {
        status: row.status as InventoryStatus,
        tools,
        fingerprint: row.fingerprint,
        checkedAt: new Date(row.checked_at),
      };
    },
    async put(key, row) {
      const values = {
        user_id: key.userId,
        agent_id: key.agentId,
        connector_id: key.connectorId,
        status: row.status,
        tools: JSON.stringify(row.tools),
        fingerprint: row.fingerprint,
        checked_at: row.checkedAt,
      };
      await db
        .insertInto('mcp_client_v1_tool_inventory')
        .values(values)
        .onConflict((oc) =>
          oc.columns(['user_id', 'agent_id', 'connector_id']).doUpdateSet({
            status: values.status,
            tools: values.tools,
            fingerprint: values.fingerprint,
            checked_at: values.checked_at,
          }),
        )
        .execute();
    },
    async deleteForAgent(agentId) {
      const res = await db
        .deleteFrom('mcp_client_v1_tool_inventory')
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return { deleted: Number(res.numDeletedRows) };
    },
  };
}
