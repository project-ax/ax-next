import type { Kysely } from 'kysely';
import type { ToolPolicyDatabase } from './migrations.js';
import type { OverrideOrigin, PolicyVerdict } from './types.js';
import { isPolicyVerdict } from './verdicts.js';

/**
 * Storage for per-tool verdicts (TASK-736). The single source of truth for
 * "what may this agent do with this tool" beyond the static rule table —
 * nothing else in the system stores a per-tool verdict (invariant 4).
 *
 * Validation of KEYS happens at the hook boundary (`plugin.ts`), which is the
 * only writer; this layer trusts its caller on shape and owns persistence.
 */

export interface StoredOverride {
  toolKey: string;
  verdict: PolicyVerdict;
  origin: OverrideOrigin;
}

export interface ConnectorDefaultWrite {
  toolNamespace: string;
  tool: string;
  verdict: PolicyVerdict | null;
}

export interface VerdictStore {
  /** Admin defaults for every tool under these namespaces, keyed by toolKey. */
  connectorDefaultsFor(toolNamespaces: readonly string[]): Promise<Map<string, PolicyVerdict>>;
  /** Same, restricted to rows filed under `connectorId` too. */
  listConnectorDefaults(
    connectorId: string,
    toolNamespaces: readonly string[],
  ): Promise<Array<{ toolKey: string; verdict: PolicyVerdict }>>;
  /** Upsert (verdict) or clear (null) each row, atomically. */
  setConnectorDefaults(
    connectorId: string,
    rows: readonly ConnectorDefaultWrite[],
    updatedBy: string,
  ): Promise<void>;
  overridesFor(agentId: string): Promise<StoredOverride[]>;
  /** A person's own choice (`origin: 'user'`); `null` clears the row. */
  setOverride(
    agentId: string,
    toolKey: string,
    verdict: PolicyVerdict | null,
    updatedBy: string,
  ): Promise<void>;
  /**
   * Copy verdicts in as `origin: 'snapshot'`. Overwrites an earlier snapshot
   * row, NEVER a `user` row — re-attaching a connector must not undo a choice
   * a person made. Returns how many rows were written.
   */
  snapshot(
    agentId: string,
    rows: ReadonlyArray<{ toolKey: string; verdict: PolicyVerdict }>,
    updatedBy: string,
  ): Promise<number>;
  purgeAgent(agentId: string): Promise<number>;
  /** Drop defaults under these namespaces AND every agent's overrides for them. */
  purgeNamespaces(toolNamespaces: readonly string[]): Promise<void>;
}

/** A stored verdict we cannot read is read as `deny` — it can only tighten. */
function narrowVerdict(v: string): PolicyVerdict {
  return isPolicyVerdict(v) ? v : 'deny';
}

function narrowOrigin(v: string): OverrideOrigin {
  return v === 'snapshot' ? 'snapshot' : 'user';
}

function toolKeyOf(toolNamespace: string, tool: string): string {
  return `mcp.${toolNamespace}.${tool}`;
}

/** `LIKE` prefix for one namespace's keys. The namespace is `c` + hex, so it has no `%`/`_` to escape. */
function nsPrefix(toolNamespace: string): string {
  return `mcp.${toolNamespace}.%`;
}

export function createDbVerdictStore(db: Kysely<ToolPolicyDatabase>): VerdictStore {
  return {
    async connectorDefaultsFor(toolNamespaces) {
      const out = new Map<string, PolicyVerdict>();
      if (toolNamespaces.length === 0) return out;
      const rows = await db
        .selectFrom('tool_policy_v1_connector_defaults')
        .select(['tool_namespace', 'tool_name', 'verdict'])
        .where('tool_namespace', 'in', [...toolNamespaces])
        .execute();
      for (const r of rows) out.set(toolKeyOf(r.tool_namespace, r.tool_name), narrowVerdict(r.verdict));
      return out;
    },

    async listConnectorDefaults(connectorId, toolNamespaces) {
      if (toolNamespaces.length === 0) return [];
      const rows = await db
        .selectFrom('tool_policy_v1_connector_defaults')
        .select(['tool_namespace', 'tool_name', 'verdict'])
        .where('connector_id', '=', connectorId)
        .where('tool_namespace', 'in', [...toolNamespaces])
        .orderBy('tool_namespace')
        .orderBy('tool_name')
        .execute();
      return rows.map((r) => ({
        toolKey: toolKeyOf(r.tool_namespace, r.tool_name),
        verdict: narrowVerdict(r.verdict),
      }));
    },

    async setConnectorDefaults(connectorId, rows, updatedBy) {
      if (rows.length === 0) return;
      await db.transaction().execute(async (trx) => {
        const now = new Date();
        for (const row of rows) {
          if (row.verdict === null) {
            await trx
              .deleteFrom('tool_policy_v1_connector_defaults')
              .where('tool_namespace', '=', row.toolNamespace)
              .where('tool_name', '=', row.tool)
              .execute();
            continue;
          }
          await trx
            .insertInto('tool_policy_v1_connector_defaults')
            .values({
              connector_id: connectorId,
              tool_namespace: row.toolNamespace,
              tool_name: row.tool,
              verdict: row.verdict,
              updated_by: updatedBy,
              updated_at: now,
            })
            .onConflict((oc) =>
              oc.columns(['tool_namespace', 'tool_name']).doUpdateSet({
                connector_id: connectorId,
                verdict: row.verdict as PolicyVerdict,
                updated_by: updatedBy,
                updated_at: now,
              }),
            )
            .execute();
        }
      });
    },

    async overridesFor(agentId) {
      const rows = await db
        .selectFrom('tool_policy_v1_agent_overrides')
        .select(['tool_key', 'verdict', 'origin'])
        .where('agent_id', '=', agentId)
        .orderBy('tool_key')
        .execute();
      return rows.map((r) => ({
        toolKey: r.tool_key,
        verdict: narrowVerdict(r.verdict),
        origin: narrowOrigin(r.origin),
      }));
    },

    async setOverride(agentId, toolKey, verdict, updatedBy) {
      if (verdict === null) {
        await db
          .deleteFrom('tool_policy_v1_agent_overrides')
          .where('agent_id', '=', agentId)
          .where('tool_key', '=', toolKey)
          .execute();
        return;
      }
      const now = new Date();
      await db
        .insertInto('tool_policy_v1_agent_overrides')
        .values({
          agent_id: agentId,
          tool_key: toolKey,
          verdict,
          origin: 'user',
          updated_by: updatedBy,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['agent_id', 'tool_key']).doUpdateSet({
            verdict,
            origin: 'user',
            updated_by: updatedBy,
            updated_at: now,
          }),
        )
        .execute();
    },

    async snapshot(agentId, rows, updatedBy) {
      if (rows.length === 0) return 0;
      let written = 0;
      await db.transaction().execute(async (trx) => {
        const now = new Date();
        for (const row of rows) {
          const res = await trx
            .insertInto('tool_policy_v1_agent_overrides')
            .values({
              agent_id: agentId,
              tool_key: row.toolKey,
              verdict: row.verdict,
              origin: 'snapshot',
              updated_by: updatedBy,
              updated_at: now,
            })
            .onConflict((oc) =>
              oc
                .columns(['agent_id', 'tool_key'])
                .doUpdateSet({ verdict: row.verdict, updated_by: updatedBy, updated_at: now })
                // A person's own choice survives a re-attach.
                .where('tool_policy_v1_agent_overrides.origin', '=', 'snapshot'),
            )
            .executeTakeFirst();
          written += Number(res.numInsertedOrUpdatedRows ?? 0n);
        }
      });
      return written;
    },

    async purgeAgent(agentId) {
      const res = await db
        .deleteFrom('tool_policy_v1_agent_overrides')
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return Number(res.numDeletedRows ?? 0n);
    },

    async purgeNamespaces(toolNamespaces) {
      if (toolNamespaces.length === 0) return;
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom('tool_policy_v1_connector_defaults')
          .where('tool_namespace', 'in', [...toolNamespaces])
          .execute();
        await trx
          .deleteFrom('tool_policy_v1_agent_overrides')
          .where((eb) => eb.or(toolNamespaces.map((ns) => eb('tool_key', 'like', nsPrefix(ns)))))
          .execute();
      });
    },
  };
}

/**
 * The store a deployment with no database gets. Verdicts last as long as the
 * process; after a restart every connector tool is back to its implicit `hold`
 * ceiling and every ability to its static rule — the safe direction for the
 * ceilings, the LOOSER direction for a person's own denies. That second half
 * is why production presets load a database; this exists for tests and for a
 * database-less dev host.
 */
export function createMemoryVerdictStore(): VerdictStore {
  // ns -> tool -> {connectorId, verdict}
  const defaults = new Map<string, Map<string, { connectorId: string; verdict: PolicyVerdict }>>();
  // agentId -> toolKey -> {verdict, origin}
  const overrides = new Map<string, Map<string, { verdict: PolicyVerdict; origin: OverrideOrigin }>>();

  const agentMap = (agentId: string) => {
    let m = overrides.get(agentId);
    if (m === undefined) {
      m = new Map();
      overrides.set(agentId, m);
    }
    return m;
  };

  return {
    async connectorDefaultsFor(toolNamespaces) {
      const out = new Map<string, PolicyVerdict>();
      for (const ns of toolNamespaces) {
        for (const [tool, v] of defaults.get(ns) ?? []) out.set(toolKeyOf(ns, tool), v.verdict);
      }
      return out;
    },

    async listConnectorDefaults(connectorId, toolNamespaces) {
      const out: Array<{ toolKey: string; verdict: PolicyVerdict }> = [];
      for (const ns of [...new Set(toolNamespaces)].sort()) {
        const tools = [...(defaults.get(ns) ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        for (const [tool, v] of tools) {
          if (v.connectorId !== connectorId) continue;
          out.push({ toolKey: toolKeyOf(ns, tool), verdict: v.verdict });
        }
      }
      return out;
    },

    async setConnectorDefaults(connectorId, rows) {
      for (const row of rows) {
        let tools = defaults.get(row.toolNamespace);
        if (row.verdict === null) {
          tools?.delete(row.tool);
          continue;
        }
        if (tools === undefined) {
          tools = new Map();
          defaults.set(row.toolNamespace, tools);
        }
        tools.set(row.tool, { connectorId, verdict: row.verdict });
      }
    },

    async overridesFor(agentId) {
      return [...(overrides.get(agentId) ?? [])]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([toolKey, v]) => ({ toolKey, verdict: v.verdict, origin: v.origin }));
    },

    async setOverride(agentId, toolKey, verdict) {
      if (verdict === null) {
        overrides.get(agentId)?.delete(toolKey);
        return;
      }
      agentMap(agentId).set(toolKey, { verdict, origin: 'user' });
    },

    async snapshot(agentId, rows) {
      const m = agentMap(agentId);
      let written = 0;
      for (const row of rows) {
        if (m.get(row.toolKey)?.origin === 'user') continue;
        m.set(row.toolKey, { verdict: row.verdict, origin: 'snapshot' });
        written += 1;
      }
      return written;
    },

    async purgeAgent(agentId) {
      const n = overrides.get(agentId)?.size ?? 0;
      overrides.delete(agentId);
      return n;
    },

    async purgeNamespaces(toolNamespaces) {
      for (const ns of toolNamespaces) {
        defaults.delete(ns);
        const prefix = `mcp.${ns}.`;
        for (const m of overrides.values()) {
          for (const key of [...m.keys()]) if (key.startsWith(prefix)) m.delete(key);
        }
      }
    },
  };
}
