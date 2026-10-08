import { PluginError } from '@ax/core';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  CapabilitiesSchema,
  type Capabilities,
  type CapabilitySlot,
  type Connector,
  type ConnectorSummary,
  type KeyMode,
} from './types.js';
import type { ConnectorDatabase, ConnectorsRow } from './migrations.js';
import { availableConnectors } from './scope.js';

const PLUGIN_NAME = '@ax/connectors';
type StoredConnectorRow = Selectable<ConnectorsRow>;

// ---------------------------------------------------------------------------
// Validation helpers — caller-supplied values are bounded BEFORE INSERT. The
// DB has a CHECK on key_mode; everything else (lengths, the JSONB
// capabilities shape) is enforced here because length limits and structural
// shape don't translate cleanly to SQL, and we want a structured
// invalid-payload error close to the field rather than a raw pg error at write.
// ---------------------------------------------------------------------------

const ID_MAX = 128;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_MAX = 200;
export const DESCRIPTION_MAX = 2000;
export const USAGE_NOTE_MAX = 4000;

// Credential-slot grammar — SCREAMING_SNAKE, mirrors the skills-parser
// `SLOT_RE` (re-declared per I2; @ax/skills-parser is a type-only dep). A slot
// name flows into the credential namespace, so an authored (untrusted) draft
// declaring a malformed slot must be a LOUD reject, not a silent bad key
// (defense-in-depth on the credential boundary, I5 — same posture as TASK-87's
// admin-validator `invalid-slot`).
const SLOT_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function invalid(message: string): PluginError {
  return new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    message,
  });
}

/**
 * Ids a NEW connector may never take because a route path uses the same
 * segment: `/admin/connectors/authored` (slice 2c, the request queue) would
 * shadow `/admin/connectors/:id` for a connector with that id (exact match
 * wins). Checked on create paths only (`assertConnectorIdCreatable`), so a
 * connector that already had this id before slice 2c can still be read,
 * edited and deleted, and `connectors:live-ids` still answers for it.
 */
const RESERVED_CONNECTOR_IDS: ReadonlySet<string> = new Set(['authored']);

/** Refuse an id no NEW connector or request may take. Call on create paths
 *  only, after `validateConnectorId`. */
export function assertConnectorIdCreatable(connectorId: string): void {
  if (RESERVED_CONNECTOR_IDS.has(connectorId)) {
    throw invalid(`connectorId '${connectorId}' is reserved`);
  }
}

export function validateConnectorId(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalid('connectorId must be a string');
  }
  if (value.length === 0 || value.length > ID_MAX) {
    throw invalid(`connectorId must be 1-${ID_MAX} chars`);
  }
  if (!ID_RE.test(value)) {
    throw invalid(
      `connectorId must match ${ID_RE.source} (lowercase slug)`,
    );
  }
  return value;
}

export function validateName(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalid('name must be a string');
  }
  if (value.length === 0 || value.length > NAME_MAX) {
    throw invalid(`name must be 1-${NAME_MAX} chars`);
  }
  return value;
}

/** Optional free-text; defaults to '' when omitted. Bounded when present. */
export function validateOptionalText(
  value: unknown,
  field: string,
  max: number,
): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw invalid(`${field} must be a string if provided`);
  }
  if (value.length > max) {
    throw invalid(`${field} must be at most ${max} chars`);
  }
  return value;
}

export function validateKeyMode(value: unknown): KeyMode {
  if (value !== 'personal' && value !== 'workspace') {
    throw invalid("keyMode must be 'personal' or 'workspace'");
  }
  return value;
}

/**
 * Validate one authored credential-slot name against {@link SLOT_RE}. Used by
 * the `connectors:install-authored` handler before a model-authored slot is
 * folded into the capability proposal — an untrusted draft declaring a
 * malformed slot is rejected at the boundary rather than persisted as a bad key.
 */
export function validateSlotName(value: unknown): string {
  if (typeof value !== 'string' || !SLOT_RE.test(value)) {
    throw invalid(
      `credential slot must match ${SLOT_RE.source} (SCREAMING_SNAKE)`,
    );
  }
  return value;
}

/**
 * Parse the mechanism-agnostic capability spec against the canonical schema
 * (single source of truth in @ax/skills-parser, re-declared as zod locally per
 * I2). Used at every store ingress AND egress — we never trust the JSONB column
 * blindly (I5 / J2). The untrusted backing-mechanism vocabulary (transport /
 * url / mcpServers) lives ONLY inside this opaque spec; it is stored
 * verbatim and never interpreted by the store.
 */
export function validateCapabilities(value: unknown): Capabilities {
  const servers = (value as { mcpServers?: unknown } | null)?.mcpServers;
  if (Array.isArray(servers) && servers.some((s) => (s as { transport?: unknown } | null)?.transport === 'stdio')) {
    throw invalid('Local (stdio) MCP servers are no longer supported. Use a remote MCP server URL.');
  }
  const parsed = CapabilitiesSchema.safeParse(value);
  if (!parsed.success) {
    throw invalid(
      `capabilities must be a valid Capabilities object: ${parsed.error.message}`,
    );
  }
  const caps = parsed.data;
  const names = new Set<string>();
  const headerCounts = new Map<string, number>();
  for (const slot of caps.credentials as CapabilitySlot[]) {
    if (slot.kind !== 'api-key' || !slot.headerName) continue;
    if (!slot.server || !caps.mcpServers.some((server) => server.name === slot.server)) {
      throw invalid('A request header must name a remote MCP server.');
    }
    const key = `${slot.server}:${slot.headerName.toLowerCase()}`;
    if (names.has(key)) throw invalid('Request header names must be unique.');
    names.add(key);
    const count = (headerCounts.get(slot.server) ?? 0) + 1;
    headerCounts.set(slot.server, count);
    if (count > 4) throw invalid('At most four request headers per server are supported.');
    if (slot.headerName.toLowerCase() === 'authorization' && (caps.credentials as CapabilitySlot[]).some((candidate) => candidate.kind === 'oauth' && candidate.server === slot.server)) {
      throw invalid('Authorization is managed by OAuth for this server.');
    }
  }

  return caps;
}

// ---------------------------------------------------------------------------
// Row → domain mapping. `capabilities` re-validates on read (don't trust the
// DB). A corrupt / hand-edited row throws invalid-payload rather than returning
// an unvalidated shape.
// ---------------------------------------------------------------------------

function rowToConnector(row: StoredConnectorRow): Connector {
  return {
    id: row.connector_id,
    name: row.name,
    description: row.description,
    usageNote: row.usage_note,
    keyMode: validateKeyMode(row.key_mode),
    capabilities: validateCapabilities(row.capabilities),
    requiresAttachment: row.requires_attachment === true,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToSummary(
  row: Omit<StoredConnectorRow, 'capabilities'>,
): ConnectorSummary {
  return {
    id: row.connector_id,
    name: row.name,
    description: row.description,
    usageNote: row.usage_note,
    keyMode: validateKeyMode(row.key_mode),
    requiresAttachment: row.requires_attachment === true,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Prefer the caller's definition. An id with more than one live row (only a
 * legacy duplicate the SIGNINS-9 boot step did not resolve) fails closed.
 */
function selectAvailableRow(rows: StoredConnectorRow[], userId: string): StoredConnectorRow | null {
  return rows.find((row) => row.owner_user_id === userId) ??
    (rows.length === 1 ? rows[0]! : null);
}

/**
 * Every row `userId` can resolve (own first, otherwise an unambiguous one —
 * the same pick `getAvailableById` makes), newest-updated first. Shared
 * by `listForUser` and `listAvailable` so the two can never disagree about
 * which record a connector id means for this person.
 */
async function selectAvailableRows(
  db: Kysely<ConnectorDatabase>,
  userId: string,
): Promise<StoredConnectorRow[]> {
  const rows = await availableConnectors(db, { userId })
    .orderBy('updated_at', 'desc')
    .execute();
  const grouped = new Map<string, StoredConnectorRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.connector_id) ?? [];
    group.push(row);
    grouped.set(row.connector_id, group);
  }
  return [...grouped.values()]
    .map((group) => selectAvailableRow(group, userId))
    .filter((row): row is StoredConnectorRow => row !== null)
    .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
}

export interface AvailableConnector {
  connector: Connector;
  /**
   * Internal only: the connector ROW's owner (not the requesting user). Used to
   * authorize workspace credentials against their owner and to derive the
   * connector's tool namespace, which identifies the record `(owner, id)`.
   */
  ownerUserId: string;
}

/** TASK-809 — one live connector row, any owner, for the boot reconcile. */
export interface LiveConnectorRow {
  ownerUserId: string;
  connectorId: string;
  capabilities: Capabilities;
}

// ---------------------------------------------------------------------------
// Store.
// ---------------------------------------------------------------------------

/** A row still carrying the retired default flag (TASK-808). */
export interface LegacyDefault {
  ownerUserId: string;
  connectorId: string;
}

export interface UpsertArgs {
  userId: string;
  connectorId: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: KeyMode;
  capabilities: Capabilities;
  /**
   * Opt-in. When true and no live row exists for (userId, connectorId), refuse
   * with `connector-id-taken` if ANY other owner holds a live row with this
   * id. Tombstones never block.
   */
  requireUniqueId?: boolean;
  /**
   * When true and a live (userId, connectorId) row already exists, refuse with
   * `connector-id-taken` instead of updating it. Atomic: the write itself only
   * updates a tombstoned row (resurrection), never a live one.
   */
  createOnly?: boolean;
  /**
   * When true, write only a LIVE (owner, id) row, atomically (an UPDATE guarded
   * on `deleted_at IS NULL`): no insert, no resurrection. Throws `not-found`
   * when no live row matched.
   */
  updateOnly?: boolean;
}

export interface ConnectorStore {
  /**
   * TASK-809 — every live (not soft-deleted) row across ALL owners. Internal:
   * no owner scoping, so it backs the boot reconcile only and is never reachable
   * from a hook. A row whose capabilities fail the read schema is skipped and
   * reported through `onSkip` rather than failing the whole listing.
   */
  listAllLive(onSkip: (connectorId: string, err: unknown) => void): Promise<LiveConnectorRow[]>;
  /** Owned and unambiguous live definitions, newest-updated first. */
  listForUser(userId: string): Promise<ConnectorSummary[]>;
  /**
   * TASK-808, TRANSITIONAL — every LIVE row still carrying the retired
   * `default_attached` flag, across ALL owners, ordered by (owner, connector id).
   * Identities only. Nothing but the `@ax/agents` boot conversion reads this.
   */
  listLegacyDefaults(): Promise<LegacyDefault[]>;
  /**
   * TASK-808, TRANSITIONAL — flip one (owner, connector) row's retired flag off.
   * True iff this call changed it (so a second call is false). Deliberately
   * leaves `updated_at` alone: it is bookkeeping, not a user edit.
   */
  clearLegacyDefault(ownerUserId: string, connectorId: string): Promise<boolean>;
  /** Full connector by id for the owner; null if absent / tombstoned. */
  getByIdNotDeleted(
    userId: string,
    connectorId: string,
  ): Promise<Connector | null>;
  /**
   * TASK-744 — the same set `listForUser` returns, FULL and with each row's
   * owner, so a caller can derive owner-keyed values (tool namespaces).
   */
  listAvailable(userId: string): Promise<AvailableConnector[]>;
  /** Read-only lookup: own definition first, otherwise an unambiguous live one. */
  getAvailableById(userId: string, connectorId: string): Promise<AvailableConnector | null>;
  /**
   * TASK-711, SIGNINS-9 — the connector `userId` resolves for this id, but ONLY
   * when it is the one live definition with that id (exactly one live row
   * exists, and it is the row `getAvailableById` picks). This is "the
   * connector every member of a team agent sees under this id": the only
   * connector a credential stored ON an agent can belong to. Null otherwise
   * (no live row, or two or more — a legacy duplicate).
   */
  getSoleLiveById(userId: string, connectorId: string): Promise<AvailableConnector | null>;
  /**
   * Slice 2b — does any LIVE row of ANY owner carry `connectorId`? Call after
   * a soft-delete to learn whether the id is still in use
   * (`connectors:deleted`'s `idStillLive`) and whether a surviving definition
   * still reads the id's agent-scope sign-ins. Internal: unscoped.
   */
  hasLiveById(connectorId: string): Promise<boolean>;
  /**
   * Slice 2b — the subset of `connectorIds` that at least one LIVE row (any
   * owner) carries, deduped, in the caller's order. Callers validate and cap
   * the list (`connectors:live-ids`). Internal: unscoped, answers only ids it
   * is given.
   */
  liveIds(connectorIds: readonly string[]): Promise<string[]>;
  /** Idempotent create-or-update keyed (owner, connectorId). */
  upsert(args: UpsertArgs): Promise<{ connector: Connector; created: boolean }>;
  /** Soft-delete; true iff a live row was tombstoned. */
  softDelete(userId: string, connectorId: string): Promise<boolean>;
}

export function createConnectorStore(
  db: Kysely<ConnectorDatabase>,
): ConnectorStore {
  return {
    async listAllLive(onSkip) {
      const rows = await db
        .selectFrom('connectors_v1_connectors')
        .select(['owner_user_id', 'connector_id', 'capabilities'])
        .where('deleted_at', 'is', null)
        .orderBy('owner_user_id', 'asc')
        .orderBy('connector_id', 'asc')
        .execute();
      const out: LiveConnectorRow[] = [];
      for (const row of rows) {
        try {
          out.push({
            ownerUserId: row.owner_user_id,
            connectorId: row.connector_id,
            capabilities: validateCapabilities(row.capabilities),
          });
        } catch (err) {
          onSkip(row.connector_id, err);
        }
      }
      return out;
    },

    async listForUser(userId) {
      return (await selectAvailableRows(db, userId))
        .map((row) => ({ ...rowToSummary(row), canEdit: row.owner_user_id === userId }));
    },

    async listAvailable(userId) {
      return (await selectAvailableRows(db, userId)).map((row) => ({
        connector: { ...rowToConnector(row), canEdit: row.owner_user_id === userId },
        ownerUserId: row.owner_user_id,
      }));
    },

    async getAvailableById(userId, connectorId) {
      const rows = await availableConnectors(db, { userId })
        .where('connector_id', '=', connectorId)
        .execute();
      const row = selectAvailableRow(rows, userId);
      return row === null ? null : {
        connector: { ...rowToConnector(row), canEdit: row.owner_user_id === userId },
        ownerUserId: row.owner_user_id,
      };
    },

    async getSoleLiveById(userId, connectorId) {
      const rows = await availableConnectors(db, { userId })
        .where('connector_id', '=', connectorId)
        .execute();
      // `availableConnectors` returns every live row (any owner), so this is
      // the complete set of live rows for the id.
      if (rows.length !== 1) return null;
      const picked = selectAvailableRow(rows, userId);
      if (picked === null || picked !== rows[0]) return null;
      return {
        connector: { ...rowToConnector(picked), canEdit: picked.owner_user_id === userId },
        ownerUserId: picked.owner_user_id,
      };
    },

    async hasLiveById(connectorId) {
      const row = await db
        .selectFrom('connectors_v1_connectors')
        .select('owner_user_id')
        .where('connector_id', '=', connectorId)
        .where('deleted_at', 'is', null)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async liveIds(connectorIds) {
      const wanted = [...new Set(connectorIds)];
      if (wanted.length === 0) return [];
      const rows = await db
        .selectFrom('connectors_v1_connectors')
        .select('connector_id')
        .distinct()
        .where('connector_id', 'in', wanted)
        .where('deleted_at', 'is', null)
        .execute();
      const live = new Set(rows.map((row) => row.connector_id));
      // In the caller's order, so the answer is deterministic.
      return wanted.filter((id) => live.has(id));
    },

    async getByIdNotDeleted(userId, connectorId) {
      const row = await db
        .selectFrom('connectors_v1_connectors')
        .selectAll()
        .where('owner_user_id', '=', userId)
        .where('connector_id', '=', connectorId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return row === undefined ? null : rowToConnector(row);
    },

    async upsert(args) {
      const now = new Date();
      if (args.updateOnly === true) {
        const updated = await db
          .updateTable('connectors_v1_connectors')
          .set({
            name: args.name,
            description: args.description,
            usage_note: args.usageNote,
            key_mode: args.keyMode,
            // SIGNINS-9 — vestigial column, never read; written 'shared' so a
            // rolled-back image never sees an edited row (e.g. one a failed boot
            // step left private) as private. Rollback safety only.
            visibility: 'shared',
            capabilities: sql<unknown>`${JSON.stringify(args.capabilities)}::jsonb`,
            updated_at: now,
          })
          .where('owner_user_id', '=', args.userId)
          .where('connector_id', '=', args.connectorId)
          .where('deleted_at', 'is', null)
          .returningAll()
          .executeTakeFirst();
        if (updated === undefined) {
          throw new PluginError({
            code: 'not-found',
            plugin: PLUGIN_NAME,
            hookName: 'connectors:upsert',
            message: `connector '${args.connectorId}' not found`,
          });
        }
        return { connector: rowToConnector(updated), created: false };
      }
      // `created` = "no LIVE row existed for this (owner, id)". A tombstoned row
      // is invisible to the owner (get/list filter deleted_at IS NULL), so
      // resurrecting one reports `created: true` — from the owner's view the
      // connector was gone, so re-connecting it IS a creation (matches the user
      // mental model). The owner predicate also makes a foreign row invisible,
      // so a cross-tenant id collision can't be observed or clobbered — each
      // owner has its own (owner_user_id, connector_id) keyspace.
      const existing = await db
        .selectFrom('connectors_v1_connectors')
        .select('connector_id')
        .where('owner_user_id', '=', args.userId)
        .where('connector_id', '=', args.connectorId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      // Under `createOnly` a successful write is always a creation (a fresh
      // insert or a resurrected tombstone): a live row makes the guarded write
      // below return nothing. That statement, not this read, is the check, so
      // a live row that appears in between is still refused.
      const created = args.createOnly === true || existing === undefined;
      if (created && args.requireUniqueId === true) {
        const taken = await db
          .selectFrom('connectors_v1_connectors')
          .select('owner_user_id')
          .where('connector_id', '=', args.connectorId)
          .where('owner_user_id', '<>', args.userId)
          .where('deleted_at', 'is', null)
          .limit(1)
          .executeTakeFirst();
        if (taken !== undefined) {
          throw new PluginError({
            code: 'connector-id-taken',
            plugin: PLUGIN_NAME,
            hookName: 'connectors:upsert',
            message: `connector id '${args.connectorId}' is already in use`,
          });
        }
      }

      // JSONB is written via an explicit `::jsonb` cast of the canonical
      // JSON so the opaque spec round-trips byte-faithfully (mirrors the
      // conversations append-event JSONB write).
      const capabilitiesJson = sql<unknown>`${JSON.stringify(
        args.capabilities,
      )}::jsonb`;

      // TASK-808 — the retired `default_attached` flag is never written from a
      // caller: an INSERT leaves it to the column default (false) and an edit of
      // a live row leaves it exactly as it was (the boot conversion still has to
      // see it). The one exception is `created`, which includes RESURRECTING a
      // tombstoned row: that is a brand-new connector from the owner's view, so a
      // stale flag from its previous life is reset rather than revived.
      const updateSet = {
        name: args.name,
        description: args.description,
        usage_note: args.usageNote,
        key_mode: args.keyMode,
        // SIGNINS-9 — vestigial column, never read; written 'shared' so a
        // revived private tombstone (the boot step skips tombstones) never
        // reads as private to a rolled-back image. Rollback safety only. A
        // fresh INSERT takes the column DEFAULT ('shared').
        visibility: 'shared',
        capabilities: capabilitiesJson,
        // Resurrect a tombstoned row on upsert — re-creating a deleted
        // connector under the same id is allowed.
        deleted_at: null,
        updated_at: now,
        ...(created ? { requires_attachment: true, default_attached: false } : {}),
      };

      const row = await db
        .insertInto('connectors_v1_connectors')
        .values({
          owner_user_id: args.userId,
          connector_id: args.connectorId,
          name: args.name,
          description: args.description,
          usage_note: args.usageNote,
          key_mode: args.keyMode,
          capabilities: capabilitiesJson,
          requires_attachment: true,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => {
          const update = oc.columns(['owner_user_id', 'connector_id']).doUpdateSet(updateSet);
          // A create may resurrect a tombstone but never overwrite a live row.
          // Guarded in the statement itself, so a live row written between the
          // pre-read above and this write still can't be clobbered.
          return args.createOnly === true
            ? update.where('connectors_v1_connectors.deleted_at', 'is not', null)
            : update;
        })
        .returningAll()
        .executeTakeFirst();
      if (row === undefined) {
        // Only reachable under `createOnly`: the conflict update's guard found
        // a LIVE row, so nothing was written.
        throw new PluginError({
          code: 'connector-id-taken',
          plugin: PLUGIN_NAME,
          hookName: 'connectors:upsert',
          message: `connector id '${args.connectorId}' is already in use`,
        });
      }
      return { connector: rowToConnector(row), created };
    },

    async listLegacyDefaults() {
      // Deliberately NOT owner-scoped: the conversion runs at boot with no
      // session user and must see every owner's flagged rows. Identities only —
      // no capabilities, no spec — so nothing here can be mistaken for reach.
      const rows = await db
        .selectFrom('connectors_v1_connectors')
        .select(['owner_user_id', 'connector_id'])
        .where('default_attached', '=', true)
        .where('deleted_at', 'is', null)
        .orderBy('owner_user_id', 'asc')
        .orderBy('connector_id', 'asc')
        .execute();
      return rows.map((r) => ({
        ownerUserId: r.owner_user_id,
        connectorId: r.connector_id,
      }));
    },

    async clearLegacyDefault(ownerUserId, connectorId) {
      const result = await db
        .updateTable('connectors_v1_connectors')
        .set({ default_attached: false })
        .where('owner_user_id', '=', ownerUserId)
        .where('connector_id', '=', connectorId)
        .where('default_attached', '=', true)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) > 0;
    },

    async softDelete(userId, connectorId) {
      const result = await db
        .updateTable('connectors_v1_connectors')
        .set({ deleted_at: new Date(), updated_at: new Date() })
        .where('owner_user_id', '=', userId)
        .where('connector_id', '=', connectorId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) > 0;
    },
  };
}
