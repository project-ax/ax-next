import { PluginError } from '@ax/core';
import { sql, type Kysely } from 'kysely';
import {
  CapabilitiesSchema,
  type Capabilities,
  type Connector,
  type ConnectorSummary,
  type KeyMode,
  type Visibility,
} from './types.js';
import type { ConnectorDatabase, ConnectorsRow } from './migrations.js';
import { scopedConnectors } from './scope.js';

const PLUGIN_NAME = '@ax/connectors';

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
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Row → domain mapping. `capabilities` re-validates on read (don't trust the
// DB). A corrupt / hand-edited row throws invalid-payload rather than returning
// an unvalidated shape.
// ---------------------------------------------------------------------------

function rowToConnector(row: ConnectorsRow): Connector {
  return {
    id: row.connector_id,
    name: row.name,
    description: row.description,
    usageNote: row.usage_note,
    keyMode: validateKeyMode(row.key_mode),
    visibility: validateVisibility(row.visibility),
    capabilities: validateCapabilities(row.capabilities),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToSummary(
  row: Omit<ConnectorsRow, 'capabilities'>,
): ConnectorSummary {
  return {
    id: row.connector_id,
    name: row.name,
    description: row.description,
    usageNote: row.usage_note,
    keyMode: validateKeyMode(row.key_mode),
    visibility: validateVisibility(row.visibility),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
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
}

export interface ConnectorStore {
  /** Metadata-only list for the owner, newest-updated first. */
  listForUser(userId: string): Promise<ConnectorSummary[]>;
  /** Full connector by id for the owner; null if absent / tombstoned. */
  getByIdNotDeleted(
    userId: string,
    connectorId: string,
  ): Promise<Connector | null>;
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
      const rows = await scopedConnectors(db, { userId })
        .orderBy('updated_at', 'desc')
        .execute();
      return rows.map((r) => rowToSummary(r as ConnectorsRow));
    },

    async getByIdNotDeleted(userId, connectorId) {
      const row = await db
        .selectFrom('connectors_v1_connectors')
        .selectAll()
        .where('owner_user_id', '=', userId)
        .where('connector_id', '=', connectorId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return row === undefined ? null : rowToConnector(row as ConnectorsRow);
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
          deleted_at: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['owner_user_id', 'connector_id']).doUpdateSet({
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
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return { connector: rowToConnector(row as ConnectorsRow), created };
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
