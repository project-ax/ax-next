/**
 * Which directory listing a connector was saved from (TASK-1102; design
 * docs/plans/2026-11-09-mcp-directory-connectors-design.md, Decision 8).
 *
 * One row per connector id: the listing's id, the version the editor was
 * filled from, and whether the server address differs from the listing's.
 * `@ax/connectors` calls the two hooks after a connector write succeeded; this
 * plugin never reads a connector. Rows are keyed by connector id alone because
 * the `connectors:deleted` event names no owner, so a row goes only when no
 * live connector of any owner still carries the id.
 *
 * `directoryId` and `version` come from the admin's browser: untrusted. They
 * are bounded by the schema, checked with the sync's own rules, matched
 * against the mirror, written with bound parameters, and never logged.
 */
import { faultLogFields, PluginError, type AgentContext } from '@ax/core';
import type { Kysely } from 'kysely';
import {
  ProvenanceMarkEditedInputSchema,
  ProvenanceRecordInputSchema,
  type ProvenanceMarkEditedOutput,
  type ProvenanceRecordOutput,
} from './contract.js';
import type { ConnectorDirectoryDatabase } from './migrations.js';
import { isUsableVersion, SERVER_NAME } from './normalize.js';
import { PLUGIN_NAME } from './registry-client.js';

/** `@ax/connectors`' subscriber event (a mirrored name, no import). */
export const CONNECTORS_DELETED_EVENT = 'connectors:deleted';

export interface ProvenanceStore {
  /** The listing's server address; null = not in the mirror. */
  listingUrl(directoryId: string): Promise<string | null>;
  /** Insert, or replace all three fields of the connector's row. */
  upsert(row: {
    connectorId: string;
    directoryId: string;
    version: string;
    edited: boolean;
  }): Promise<void>;
  /** Resolves true iff a row matched. Never creates one. */
  markEdited(connectorId: string): Promise<boolean>;
  /** Rows deleted (0 or 1). */
  remove(connectorId: string): Promise<number>;
}

const ENTRIES = 'connector_directory_v1_entries';
const PROVENANCE = 'connector_directory_v1_provenance';

export function createProvenanceStore(db: Kysely<ConnectorDirectoryDatabase>): ProvenanceStore {
  return {
    async listingUrl(directoryId) {
      const row = await db
        .selectFrom(ENTRIES)
        .select('url')
        .where('id', '=', directoryId)
        .executeTakeFirst();
      return row?.url ?? null;
    },

    async upsert({ connectorId, directoryId, version, edited }) {
      await db
        .insertInto(PROVENANCE)
        .values({ connector_id: connectorId, directory_id: directoryId, version, edited })
        .onConflict((oc) =>
          oc.column('connector_id').doUpdateSet((eb) => ({
            directory_id: eb.ref('excluded.directory_id'),
            version: eb.ref('excluded.version'),
            edited: eb.ref('excluded.edited'),
          })),
        )
        .execute();
    },

    async markEdited(connectorId) {
      const r = await db
        .updateTable(PROVENANCE)
        .set({ edited: true })
        .where('connector_id', '=', connectorId)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },

    async remove(connectorId) {
      const r = await db
        .deleteFrom(PROVENANCE)
        .where('connector_id', '=', connectorId)
        .executeTakeFirst();
      return Number(r.numDeletedRows);
    },
  };
}

/** A refusal with fixed text: never the input that was refused. */
function invalid(): PluginError {
  return new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    message: 'invalid provenance input',
  });
}

/**
 * `connectors:directory-provenance-record`. The version is stored verbatim,
 * not compared with the mirror's: the mirror holds only the latest, and a
 * sync between prefill and save must not erase the version the admin saw.
 * `edited` is a raw compare with the listing's address: a respelling counts
 * as edited (a respelling over-claims). `edited: false` is best-effort, not
 * proof: an address changed while the directory was off, a failed
 * mark-edited call, or an edit racing the create can leave it false. A reader
 * that needs certainty re-compares the live connector's address.
 */
export async function recordProvenance(
  store: ProvenanceStore,
  ctx: AgentContext,
  input: unknown,
): Promise<ProvenanceRecordOutput> {
  const parsed = ProvenanceRecordInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const { connectorId, directoryId, version, serverUrl } = parsed.data;
  if (!isUsableVersion(version)) {
    ctx.logger.info('connector_directory_provenance_ignored', {
      connectorId,
      reason: 'unusable-version',
    });
    return { recorded: false };
  }
  // The mirror holds no id outside the sync's own name rule, so such an id is
  // a miss without a lookup, and a NUL (which Postgres text refuses outright)
  // never reaches the database.
  const listingUrl = SERVER_NAME.test(directoryId) ? await store.listingUrl(directoryId) : null;
  if (listingUrl === null) {
    ctx.logger.info('connector_directory_provenance_ignored', {
      connectorId,
      reason: 'unknown-listing',
    });
    return { recorded: false };
  }
  await store.upsert({ connectorId, directoryId, version, edited: serverUrl !== listingUrl });
  return { recorded: true };
}

/** `connectors:directory-provenance-mark-edited`. Never un-marks. */
export async function markProvenanceEdited(
  store: ProvenanceStore,
  input: unknown,
): Promise<ProvenanceMarkEditedOutput> {
  const parsed = ProvenanceMarkEditedInputSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  return { marked: await store.markEdited(parsed.data.connectorId) };
}

/**
 * The `connectors:deleted` subscriber, after `@ax/mcp-oauth`'s. Payload
 * (declared locally, no import): `{ connectorId, toolNamespaces, idStillLive }`;
 * only the first and last are read. Acts ONLY on an explicit
 * `idStillLive === false`: true, missing or anything else means some owner's
 * live connector still carries the id, so the row stays (keep data when
 * unsure). Never throws, never vetoes, never rewrites the payload.
 */
export function onConnectorDeleted(
  store: ProvenanceStore,
): (ctx: AgentContext, payload: unknown) => Promise<undefined> {
  return async (ctx, payload) => {
    const p = payload as { connectorId?: unknown; idStillLive?: unknown } | null | undefined;
    const connectorId = p?.connectorId;
    if (typeof connectorId !== 'string' || connectorId.length === 0) {
      ctx.logger.warn('connector_directory_provenance_delete_event_skipped', {
        reason: 'no-connector-id',
      });
      return undefined;
    }
    if (p?.idStillLive !== false) return undefined;
    try {
      if ((await store.remove(connectorId)) > 0) {
        ctx.logger.info('connector_directory_provenance_removed', { connectorId });
      }
    } catch (err) {
      ctx.logger.error('connector_directory_provenance_remove_failed', {
        connectorId,
        ...faultLogFields(err),
      });
    }
    return undefined;
  };
}
