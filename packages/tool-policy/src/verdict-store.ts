import { sql, type Kysely } from 'kysely';
import type { ToolPolicyDatabase } from './migrations.js';
import type { CeilingSource, OverrideOrigin, PolicyVerdict } from './types.js';
import { CONNECTOR_TOOL_NAMESPACE_RE, isPolicyVerdict, parseConnectorToolKey } from './verdicts.js';

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
  /**
   * The namespaces whose defaults this agent has copied (TASK-754). A tool
   * under one of them with no override row is held: see
   * {@link VerdictStore.copyConnectorDefaults}.
   */
  copiedNamespacesFor(agentId: string): Promise<string[]>;
  /** A person's own choice (`origin: 'user'`); `null` clears the row. */
  setOverride(
    agentId: string,
    toolKey: string,
    verdict: PolicyVerdict | null,
    updatedBy: string,
  ): Promise<void>;
  /**
   * "Copy on attach" (design decision 2), in ONE transaction: record each
   * namespace as copied for this agent, then copy `connectorId`'s defaults
   * under those namespaces in as `origin: 'snapshot'` rows. A tool with no
   * default gets no row — the copied-namespace record is what holds it.
   *
   * `onlyIfNotCopied: false` (an attach): copies every namespace, overwriting
   * an earlier snapshot row — NEVER a `user` row, so re-attaching a connector
   * cannot undo a choice a person made.
   *
   * `onlyIfNotCopied: true` (a default-on connector reaching a session): only
   * namespaces this call newly recorded are copied, and no existing row is
   * overwritten. The record is claimed atomically, so two sessions opening at
   * once copy once. THROWS, writing nothing, on a malformed namespace.
   * Returns how many override rows were written.
   */
  copyConnectorDefaults(
    agentId: string,
    connectorId: string,
    toolNamespaces: readonly string[],
    opts: { onlyIfNotCopied: boolean },
    updatedBy: string,
  ): Promise<number>;
  /**
   * TASK-809 — the subset of `toolNamespaces` whose ceiling source is `agent`
   * (a marker row exists). THROWS on a malformed namespace.
   */
  agentSourcedNamespaces(toolNamespaces: readonly string[]): Promise<Set<string>>;
  /**
   * TASK-809 — record each namespace's ceiling source, in ONE transaction.
   * `agent`: upsert the marker AND delete every connector default under that
   * namespace (the one-time cleanup of defaults nobody may set any more;
   * idempotent). `connector`: delete the marker. Agent overrides are never
   * touched. THROWS, writing nothing, on a malformed namespace.
   */
  setCeilingSources(
    connectorId: string,
    entries: ReadonlyArray<{ toolNamespace: string; source: CeilingSource }>,
    updatedBy: string,
  ): Promise<void>;
  /**
   * TASK-809 — write each row as `origin: 'snapshot'` ONLY where the agent has
   * no row for that key yet, of any origin. Returns how many were written.
   * THROWS, writing nothing, when a key is not a connector tool key.
   */
  seedOverrides(
    agentId: string,
    rows: ReadonlyArray<{ toolKey: string; verdict: PolicyVerdict }>,
    updatedBy: string,
  ): Promise<number>;
  purgeAgent(agentId: string): Promise<number>;
  /**
   * Drop defaults under these namespaces AND every agent's overrides and
   * copied-namespace records for them, AND their ceiling-source markers
   * (TASK-809).
   * THROWS, deleting nothing, when any entry is not a host-minted `c<10 hex>`
   * namespace (see {@link assertToolNamespaces}).
   */
  purgeNamespaces(toolNamespaces: readonly string[]): Promise<void>;
  /**
   * Move every default, every agent override and every copied-namespace
   * record from `from` to `to`, all
   * pairs in one write (TASK-752 — a connector's MCP server was renamed, so
   * its namespace changed). Rows already under `to` are replaced: they can
   * only be leftovers of an earlier server that held that name, while the
   * `from` rows are what the admin and the agents chose for the server that
   * exists now. THROWS, moving nothing, on a malformed namespace, on
   * `from === to`, or when the pairs overlap (a name used twice, or a `to`
   * that is also a `from` — a swap or a chain has no order-free meaning).
   *
   * Ceiling-source markers (TASK-809) do NOT move: the marker under each
   * `from` is DELETED and `to` is left as it was. Carrying it across could
   * un-cap a renamed server whose new endpoint is configured differently (no
   * longer agent-sourced); `@ax/connectors` re-sets the source of `to`
   * itself, and until it does the namespace is capped — the safe side.
   */
  renameNamespaces(pairs: ReadonlyArray<{ from: string; to: string }>): Promise<void>;
}

/**
 * The store-level keyspace guard (TASK-752). The overrides table is keyed by
 * the whole tool key, so a namespace delete or move is a `LIKE 'mcp.<ns>.%'`
 * match: a `%` or `_` in `<ns>`, or an empty one, would reach every agent's
 * rows for OTHER keys. The hook layer already filters, but it is not the only
 * conceivable caller of a store; this check is the one that sits next to the
 * `LIKE`. Throwing (rather than skipping the bad entry) makes a broken caller
 * loud and leaves every row in place.
 */
export function assertToolNamespaces(toolNamespaces: readonly unknown[], op: string): void {
  for (const ns of toolNamespaces) {
    if (typeof ns !== 'string' || !CONNECTOR_TOOL_NAMESPACE_RE.test(ns)) {
      throw new Error(`tool-policy verdict store: ${op} refused a malformed tool namespace`);
    }
  }
}

function assertRenamePairs(pairs: ReadonlyArray<{ from: string; to: string }>): void {
  const seen = new Set<string>();
  for (const p of pairs) {
    assertToolNamespaces([p?.from, p?.to], 'renameNamespaces');
    if (p.from === p.to || seen.has(p.from) || seen.has(p.to)) {
      throw new Error('tool-policy verdict store: renameNamespaces refused overlapping pairs');
    }
    seen.add(p.from);
    seen.add(p.to);
  }
}

function assertCeilingSources(
  entries: ReadonlyArray<{ toolNamespace: string; source: CeilingSource }>,
): void {
  assertToolNamespaces(
    entries.map((e) => e?.toolNamespace),
    'setCeilingSources',
  );
  for (const e of entries) {
    if (e.source !== 'agent' && e.source !== 'connector') {
      throw new Error('tool-policy verdict store: setCeilingSources refused a malformed source');
    }
  }
}

function assertSeedRows(rows: ReadonlyArray<{ toolKey: string; verdict: PolicyVerdict }>): void {
  for (const r of rows) {
    if (parseConnectorToolKey(r?.toolKey) === null || !isPolicyVerdict(r.verdict)) {
      throw new Error('tool-policy verdict store: seedOverrides refused a malformed row');
    }
  }
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

    async copiedNamespacesFor(agentId) {
      const rows = await db
        .selectFrom('tool_policy_v1_agent_copied_namespaces')
        .select('tool_namespace')
        .where('agent_id', '=', agentId)
        .orderBy('tool_namespace')
        .execute();
      return rows.map((r) => r.tool_namespace);
    },

    async copyConnectorDefaults(agentId, connectorId, toolNamespaces, opts, updatedBy) {
      assertToolNamespaces(toolNamespaces, 'copyConnectorDefaults');
      const namespaces = [...new Set(toolNamespaces)];
      if (namespaces.length === 0) return 0;
      return db.transaction().execute(async (trx) => {
        const now = new Date();
        // Claim the record first. ON CONFLICT DO NOTHING + RETURNING names
        // exactly the namespaces THIS call recorded; a concurrent claimer
        // waits on the row lock and then finds it taken.
        const claimed = await trx
          .insertInto('tool_policy_v1_agent_copied_namespaces')
          .values(
            namespaces.map((ns) => ({
              agent_id: agentId,
              tool_namespace: ns,
              copied_by: updatedBy,
              copied_at: now,
            })),
          )
          .onConflict((oc) => oc.columns(['agent_id', 'tool_namespace']).doNothing())
          .returning('tool_namespace')
          .execute();
        const targets = opts.onlyIfNotCopied ? claimed.map((r) => r.tool_namespace) : namespaces;
        if (targets.length === 0) return 0;
        const defaults = await trx
          .selectFrom('tool_policy_v1_connector_defaults')
          .select(['tool_namespace', 'tool_name', 'verdict'])
          .where('connector_id', '=', connectorId)
          .where('tool_namespace', 'in', targets)
          .orderBy('tool_namespace')
          .orderBy('tool_name')
          .execute();
        let written = 0;
        for (const d of defaults) {
          const verdict = narrowVerdict(d.verdict);
          const insert = trx.insertInto('tool_policy_v1_agent_overrides').values({
            agent_id: agentId,
            tool_key: toolKeyOf(d.tool_namespace, d.tool_name),
            verdict,
            origin: 'snapshot',
            updated_by: updatedBy,
            updated_at: now,
          });
          const res = await (opts.onlyIfNotCopied
            ? // A first-session copy never overwrites: a row already here was
              // written by an earlier attach or by a person.
              insert.onConflict((oc) => oc.columns(['agent_id', 'tool_key']).doNothing())
            : insert.onConflict((oc) =>
                oc
                  .columns(['agent_id', 'tool_key'])
                  .doUpdateSet({ verdict, updated_by: updatedBy, updated_at: now })
                  // A person's own choice survives a re-attach.
                  .where('tool_policy_v1_agent_overrides.origin', '=', 'snapshot'),
              )
          ).executeTakeFirst();
          written += Number(res.numInsertedOrUpdatedRows ?? 0n);
        }
        return written;
      });
    },

    async agentSourcedNamespaces(toolNamespaces) {
      assertToolNamespaces(toolNamespaces, 'agentSourcedNamespaces');
      if (toolNamespaces.length === 0) return new Set<string>();
      const rows = await db
        .selectFrom('tool_policy_v1_agent_sourced_namespaces')
        .select('tool_namespace')
        .where('tool_namespace', 'in', [...toolNamespaces])
        .execute();
      return new Set(rows.map((r) => r.tool_namespace));
    },

    async setCeilingSources(connectorId, entries, updatedBy) {
      assertCeilingSources(entries);
      if (entries.length === 0) return;
      const agent = [...new Set(entries.filter((e) => e.source === 'agent').map((e) => e.toolNamespace))];
      const connector = [
        ...new Set(entries.filter((e) => e.source === 'connector').map((e) => e.toolNamespace)),
      ];
      await db.transaction().execute(async (trx) => {
        const now = new Date();
        if (agent.length > 0) {
          await trx
            .insertInto('tool_policy_v1_agent_sourced_namespaces')
            .values(
              agent.map((ns) => ({
                tool_namespace: ns,
                connector_id: connectorId,
                updated_by: updatedBy,
                updated_at: now,
              })),
            )
            .onConflict((oc) =>
              oc.column('tool_namespace').doUpdateSet({
                connector_id: connectorId,
                updated_by: updatedBy,
                updated_at: now,
              }),
            )
            .execute();
          await trx
            .deleteFrom('tool_policy_v1_connector_defaults')
            .where('tool_namespace', 'in', agent)
            .execute();
        }
        if (connector.length > 0) {
          await trx
            .deleteFrom('tool_policy_v1_agent_sourced_namespaces')
            .where('tool_namespace', 'in', connector)
            .execute();
        }
      });
    },

    async seedOverrides(agentId, rows, updatedBy) {
      assertSeedRows(rows);
      if (rows.length === 0) return 0;
      return db.transaction().execute(async (trx) => {
        const now = new Date();
        let written = 0;
        for (const r of rows) {
          const res = await trx
            .insertInto('tool_policy_v1_agent_overrides')
            .values({
              agent_id: agentId,
              tool_key: r.toolKey,
              verdict: r.verdict,
              origin: 'snapshot',
              updated_by: updatedBy,
              updated_at: now,
            })
            .onConflict((oc) => oc.columns(['agent_id', 'tool_key']).doNothing())
            .executeTakeFirst();
          written += Number(res.numInsertedOrUpdatedRows ?? 0n);
        }
        return written;
      });
    },

    async purgeAgent(agentId) {
      return db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom('tool_policy_v1_agent_copied_namespaces')
          .where('agent_id', '=', agentId)
          .execute();
        const res = await trx
          .deleteFrom('tool_policy_v1_agent_overrides')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        return Number(res.numDeletedRows ?? 0n);
      });
    },

    async purgeNamespaces(toolNamespaces) {
      assertToolNamespaces(toolNamespaces, 'purgeNamespaces');
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
        await trx
          .deleteFrom('tool_policy_v1_agent_copied_namespaces')
          .where('tool_namespace', 'in', [...toolNamespaces])
          .execute();
        await trx
          .deleteFrom('tool_policy_v1_agent_sourced_namespaces')
          .where('tool_namespace', 'in', [...toolNamespaces])
          .execute();
      });
    },

    async renameNamespaces(pairs) {
      assertRenamePairs(pairs);
      if (pairs.length === 0) return;
      await db.transaction().execute(async (trx) => {
        const now = new Date();
        for (const { from, to } of pairs) {
          await trx
            .deleteFrom('tool_policy_v1_connector_defaults')
            .where('tool_namespace', '=', to)
            .execute();
          await trx
            .updateTable('tool_policy_v1_connector_defaults')
            .set({ tool_namespace: to, updated_at: now })
            .where('tool_namespace', '=', from)
            .execute();
          await trx
            .deleteFrom('tool_policy_v1_agent_overrides')
            .where('tool_key', 'like', nsPrefix(to))
            .execute();
          // `mcp.<from>.` and `mcp.<to>.` are the same length (both namespaces
          // are 11 chars), so the tool half starts at the same offset.
          const toolStart = `mcp.${from}.`.length + 1;
          await trx
            .updateTable('tool_policy_v1_agent_overrides')
            .set({
              tool_key: sql<string>`${`mcp.${to}.`} || substr(tool_key, ${toolStart})`,
              updated_at: now,
            })
            .where('tool_key', 'like', nsPrefix(from))
            .execute();
          await trx
            .deleteFrom('tool_policy_v1_agent_copied_namespaces')
            .where('tool_namespace', '=', to)
            .execute();
          await trx
            .updateTable('tool_policy_v1_agent_copied_namespaces')
            .set({ tool_namespace: to })
            .where('tool_namespace', '=', from)
            .execute();
          // Deleted, not moved — see the interface comment.
          await trx
            .deleteFrom('tool_policy_v1_agent_sourced_namespaces')
            .where('tool_namespace', '=', from)
            .execute();
        }
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
  // agentId -> copied namespaces
  const copied = new Map<string, Set<string>>();
  // agent-sourced namespaces (TASK-809)
  const agentSourced = new Set<string>();

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

    async copiedNamespacesFor(agentId) {
      return [...(copied.get(agentId) ?? [])].sort();
    },

    async copyConnectorDefaults(agentId, connectorId, toolNamespaces, opts) {
      assertToolNamespaces(toolNamespaces, 'copyConnectorDefaults');
      const namespaces = [...new Set(toolNamespaces)];
      let set = copied.get(agentId);
      if (set === undefined) {
        set = new Set();
        copied.set(agentId, set);
      }
      const already = set;
      const claimed = namespaces.filter((ns) => !already.has(ns));
      for (const ns of claimed) already.add(ns);
      const targets = opts.onlyIfNotCopied ? claimed : namespaces;
      const m = agentMap(agentId);
      let written = 0;
      for (const ns of [...targets].sort()) {
        const tools = [...(defaults.get(ns) ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        for (const [tool, v] of tools) {
          if (v.connectorId !== connectorId) continue;
          const key = toolKeyOf(ns, tool);
          const existing = m.get(key);
          if (existing?.origin === 'user') continue;
          if (opts.onlyIfNotCopied && existing !== undefined) continue;
          m.set(key, { verdict: v.verdict, origin: 'snapshot' });
          written += 1;
        }
      }
      return written;
    },

    async agentSourcedNamespaces(toolNamespaces) {
      assertToolNamespaces(toolNamespaces, 'agentSourcedNamespaces');
      return new Set(toolNamespaces.filter((ns) => agentSourced.has(ns)));
    },

    async setCeilingSources(_connectorId, entries) {
      assertCeilingSources(entries);
      for (const { toolNamespace, source } of entries) {
        if (source === 'agent') {
          agentSourced.add(toolNamespace);
          defaults.delete(toolNamespace);
        } else {
          agentSourced.delete(toolNamespace);
        }
      }
    },

    async seedOverrides(agentId, rows) {
      assertSeedRows(rows);
      const m = agentMap(agentId);
      let written = 0;
      for (const r of rows) {
        if (m.has(r.toolKey)) continue;
        m.set(r.toolKey, { verdict: r.verdict, origin: 'snapshot' });
        written += 1;
      }
      return written;
    },

    async purgeAgent(agentId) {
      const n = overrides.get(agentId)?.size ?? 0;
      overrides.delete(agentId);
      copied.delete(agentId);
      return n;
    },

    async purgeNamespaces(toolNamespaces) {
      assertToolNamespaces(toolNamespaces, 'purgeNamespaces');
      for (const ns of toolNamespaces) {
        defaults.delete(ns);
        const prefix = `mcp.${ns}.`;
        for (const m of overrides.values()) {
          for (const key of [...m.keys()]) if (key.startsWith(prefix)) m.delete(key);
        }
        for (const set of copied.values()) set.delete(ns);
        agentSourced.delete(ns);
      }
    },

    async renameNamespaces(pairs) {
      assertRenamePairs(pairs);
      for (const { from, to } of pairs) {
        const moved = defaults.get(from);
        defaults.delete(to);
        defaults.delete(from);
        if (moved !== undefined) defaults.set(to, moved);
        const fromPrefix = `mcp.${from}.`;
        const toPrefix = `mcp.${to}.`;
        for (const m of overrides.values()) {
          for (const key of [...m.keys()]) if (key.startsWith(toPrefix)) m.delete(key);
          for (const [key, v] of [...m]) {
            if (!key.startsWith(fromPrefix)) continue;
            m.delete(key);
            m.set(toPrefix + key.slice(fromPrefix.length), v);
          }
        }
        for (const set of copied.values()) {
          set.delete(to);
          if (set.delete(from)) set.add(to);
        }
        // Deleted, not moved — see the interface comment.
        agentSourced.delete(from);
      }
    },
  };
}
