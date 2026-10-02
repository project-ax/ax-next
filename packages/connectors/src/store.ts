import { PluginError } from '@ax/core';
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  CapabilitiesSchema,
  type Capabilities,
  type CapabilitySlot,
  type Connector,
  type ConnectorSummary,
  type KeyMode,
  type Visibility,
} from './types.js';
import type { ConnectorDatabase, ConnectorsRow } from './migrations.js';
import { availableConnectors, scopedConnectors } from './scope.js';

const PLUGIN_NAME = '@ax/connectors';
type StoredConnectorRow = Selectable<ConnectorsRow>;

// ---------------------------------------------------------------------------
// Validation helpers — caller-supplied values are bounded BEFORE INSERT. The
// DB has CHECKs on key_mode / visibility; everything else (lengths, the JSONB
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

export function validateVisibility(value: unknown): Visibility {
  if (value !== 'private' && value !== 'shared') {
    throw invalid("visibility must be 'private' or 'shared'");
  }
  return value;
}

/**
 * Parse the mechanism-agnostic capability spec against the canonical schema
 * (single source of truth in @ax/skills-parser, re-declared as zod locally per
 * I2). Used at every store ingress AND egress — we never trust the JSONB column
 * blindly (I5 / J2). The untrusted backing-mechanism vocabulary (transport /
 * command / url / mcpServers) lives ONLY inside this opaque spec; it is stored
 * verbatim and never interpreted by the store.
 */
export function validateCapabilities(value: unknown): Capabilities {
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
    if (!slot.server || !caps.mcpServers.some((server) => server.name === slot.server && server.transport === 'http')) {
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
    visibility: validateVisibility(row.visibility),
    capabilities: validateCapabilities(row.capabilities),
    // Coerce to a real boolean — a NULL from a row written before the column
    // existed (greenfield, so unlikely, but cheap defense) reads as false.
    defaultAttached: row.default_attached === true,
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
    visibility: validateVisibility(row.visibility),
    // TASK-110 — surface the workspace-default flag on the summary so the user
    // list can badge an admin default-on connector as "Catalog". Same NULL-safe
    // coercion as rowToConnector (a pre-column NULL reads as false).
    defaultAttached: row.default_attached === true,
    requiresAttachment: row.requires_attachment === true,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Prefer the caller's definition. Ambiguous shared ids fail closed. */
function selectAvailableRow(rows: StoredConnectorRow[], userId: string): StoredConnectorRow | null {
  return rows.find((row) => row.owner_user_id === userId) ??
    (rows.length === 1 ? rows[0]! : null);
}

export interface AvailableConnector {
  connector: Connector;
  /** Internal only: used to authorize workspace credentials against their owner. */
  ownerUserId: string;
}

// ---------------------------------------------------------------------------
// Store.
// ---------------------------------------------------------------------------

export interface UpsertArgs {
  userId: string;
  connectorId: string;
  name: string;
  description: string;
  usageNote: string;
  keyMode: KeyMode;
  visibility: Visibility;
  capabilities: Capabilities;
  /**
   * TASK-97 — workspace-default flag. `undefined` ⟹ PRESERVE the existing row's
   * flag on update (and default to false on insert). A caller that means to
   * clear it passes `false` explicitly. This keeps a plain content re-upsert
   * from silently un-defaulting a connector an admin flagged.
   */
  defaultAttached?: boolean;
}

export interface ConnectorStore {
  /** Owned and unambiguous shared definitions, newest-updated first. */
  listForUser(userId: string): Promise<ConnectorSummary[]>;
  /**
   * TASK-97 — the owner's DEFAULT-attached connectors, FULL (capabilities
   * included), sorted by id ascending (stable, matches skills:list-defaults).
   * The orchestrator unions these into every agent's effective connector set.
   */
  listDefaults(userId: string): Promise<Connector[]>;
  /** Full connector by id for the owner; null if absent / tombstoned. */
  getByIdNotDeleted(
    userId: string,
    connectorId: string,
  ): Promise<Connector | null>;
  /** Read-only lookup: own definition first, otherwise an unambiguous shared one. */
  getAvailableById(userId: string, connectorId: string): Promise<AvailableConnector | null>;
  /** Idempotent create-or-update keyed (owner, connectorId). */
  upsert(args: UpsertArgs): Promise<{ connector: Connector; created: boolean }>;
  /** Soft-delete; true iff a live row was tombstoned. */
  softDelete(userId: string, connectorId: string): Promise<boolean>;
}

export function createConnectorStore(
  db: Kysely<ConnectorDatabase>,
): ConnectorStore {
  return {
    async listForUser(userId) {
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
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .map((row) => ({ ...rowToSummary(row), canEdit: row.owner_user_id === userId }));
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
      const created = existing === undefined;

      // JSONB is written via an explicit `::jsonb` cast of the canonical
      // JSON so the opaque spec round-trips byte-faithfully (mirrors the
      // conversations append-event JSONB write).
      const capabilitiesJson = sql<unknown>`${JSON.stringify(
        args.capabilities,
      )}::jsonb`;

      // On UPDATE, only set default_attached when the caller passed it
      // explicitly — otherwise PRESERVE the stored flag (a content re-upsert
      // must not silently un-default a connector an admin flagged). On INSERT
      // the absent flag defaults to false (a fresh connector is not a default).
      const updateSet = {
        name: args.name,
        description: args.description,
        usage_note: args.usageNote,
        key_mode: args.keyMode,
        visibility: args.visibility,
        capabilities: capabilitiesJson,
        // Resurrect a tombstoned row on upsert — re-creating a deleted
        // connector under the same id is allowed.
        deleted_at: null,
        updated_at: now,
        ...(created ? { requires_attachment: true, default_attached: args.defaultAttached ?? false } : {}),
        ...(args.defaultAttached !== undefined
          ? { default_attached: args.defaultAttached }
          : {}),
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
          visibility: args.visibility,
          capabilities: capabilitiesJson,
          default_attached: args.defaultAttached ?? false,
          requires_attachment: true,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['owner_user_id', 'connector_id']).doUpdateSet(updateSet),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return { connector: rowToConnector(row), created };
    },

    async listDefaults(userId) {
      // Scoped to the owner + non-tombstoned (the scope helper bakes both in),
      // then narrowed to default-flagged rows. Sorted by connector_id ascending
      // so the union order is stable (matches skills:list-defaults' compareById).
      const rows = await scopedConnectors(db, { userId })
        .where('default_attached', '=', true)
        .orderBy('connector_id', 'asc')
        .execute();
      return rows.map((r) => rowToConnector(r));
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
