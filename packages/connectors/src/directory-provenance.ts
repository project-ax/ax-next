import { faultLogFields, type AgentContext, type HookBus } from '@ax/core';
import type { Capabilities, Connector } from './types.js';

// ---------------------------------------------------------------------------
// TASK-1102 — directory provenance: which directory listing a connector was
// set up from. Local mirrors of the two `connectors:directory-provenance-*`
// hook contracts (owned by @ax/connector-directory; Invariant 2: no import, so
// the names are copied here and the preset canary proves them in step). Both
// are OPTIONAL calls: without the directory, or with it turned off, a
// connector saves exactly as before and nothing is remembered.
//
// The admin create route gates the body's `fromDirectory`, strips it before
// `connectors:upsert` (it is never part of the connector) and, after a
// successful create, hands it to the record hook with the STORED connector's
// id and server address (never the body's). A PATCH that changes a server
// address calls the mark-edited hook. Neither call can fail or change a
// connector write, and neither logs the client's `directoryId` / `version`.
// ---------------------------------------------------------------------------

export const DIRECTORY_PROVENANCE_RECORD_HOOK = 'connectors:directory-provenance-record';
export const DIRECTORY_PROVENANCE_MARK_EDITED_HOOK = 'connectors:directory-provenance-mark-edited';

/**
 * UTF-16 code units per `fromDirectory` field: a coarse gate on a client
 * value. The directory hook owns the exact caps and refuses the rest.
 */
export const FROM_DIRECTORY_FIELD_MAX = 256;

/** The directory listing a create came from, as the editor sends it. Opaque here. */
export interface FromDirectory {
  directoryId: string;
  version: string;
}

interface ProvenanceRecordInputLike {
  connectorId: string;
  directoryId: string;
  version: string;
  /** The saved connector's single server address, or null (none or several). */
  serverUrl: string | null;
}
interface ProvenanceRecordOutputLike {
  recorded: boolean;
}
interface ProvenanceMarkEditedInputLike {
  connectorId: string;
}
interface ProvenanceMarkEditedOutputLike {
  marked: boolean;
}

function isGatedString(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= FROM_DIRECTORY_FIELD_MAX;
}

/**
 * Gate the body's `fromDirectory`. Absent → `undefined`. A plain object whose
 * own keys are exactly `directoryId` and `version`, each a string of 1..256
 * code units → a fresh `{ directoryId, version }`. Anything else →
 * `'malformed'`, which the route ignores: the connector still saves.
 */
export function parseFromDirectory(value: unknown): FromDirectory | 'malformed' | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'malformed';
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('directoryId') || !keys.includes('version')) {
    return 'malformed';
  }
  const { directoryId, version } = value as Record<string, unknown>;
  if (!isGatedString(directoryId) || !isGatedString(version)) return 'malformed';
  return { directoryId, version };
}

/** The address of a connector with exactly one server that has a string `url`, else null. */
export function soleServerUrl(c: Pick<Capabilities, 'mcpServers'>): string | null {
  if (c.mcpServers.length !== 1) return null;
  const url = c.mcpServers[0]?.url;
  return typeof url === 'string' ? url : null;
}

/**
 * Whether an edit changed where the connector connects: the ORDERED lists of
 * server addresses (a missing `url` reads as null) differ, raw strings
 * compared. Adding, removing or reordering servers counts; renaming a server
 * or changing its hosts or slots does not.
 */
export function serverAddressesChanged(
  before: Pick<Capabilities, 'mcpServers'>,
  after: Pick<Capabilities, 'mcpServers'>,
): boolean {
  const was = before.mcpServers.map((s) => s.url ?? null);
  const now = after.mcpServers.map((s) => s.url ?? null);
  return was.length !== now.length || was.some((url, i) => url !== now[i]);
}

/**
 * Codes only, never the message: a provider's error text could quote the
 * client's `directoryId` / `version` (the directory logs its own failures the
 * same way).
 */
function logFailure(ctx: AgentContext, connectorId: string, hook: string, err: unknown): void {
  ctx.logger.warn('connectors_directory_provenance_failed', {
    connectorId,
    hook,
    ...faultLogFields(err),
  });
}

/**
 * After a successful create from a directory listing, tell the directory which
 * listing it was. Skipped when no directory provides the hook. Any throw,
 * including the directory refusing the values, is logged and swallowed.
 */
export async function recordDirectoryProvenance(
  bus: HookBus,
  ctx: AgentContext,
  connector: Pick<Connector, 'id' | 'capabilities'>,
  from: FromDirectory,
): Promise<void> {
  if (!bus.hasService(DIRECTORY_PROVENANCE_RECORD_HOOK)) return;
  try {
    await bus.call<ProvenanceRecordInputLike, ProvenanceRecordOutputLike>(
      DIRECTORY_PROVENANCE_RECORD_HOOK,
      ctx,
      {
        connectorId: connector.id,
        directoryId: from.directoryId,
        version: from.version,
        serverUrl: soleServerUrl(connector.capabilities),
      },
    );
  } catch (err) {
    logFailure(ctx, connector.id, DIRECTORY_PROVENANCE_RECORD_HOOK, err);
  }
}

/**
 * After a committed edit changed a server address, tell the directory the
 * connector no longer matches its listing. Skipped when no directory provides
 * the hook. Any throw is logged and swallowed.
 */
export async function markDirectoryProvenanceEdited(
  bus: HookBus,
  ctx: AgentContext,
  connectorId: string,
): Promise<void> {
  if (!bus.hasService(DIRECTORY_PROVENANCE_MARK_EDITED_HOOK)) return;
  try {
    await bus.call<ProvenanceMarkEditedInputLike, ProvenanceMarkEditedOutputLike>(
      DIRECTORY_PROVENANCE_MARK_EDITED_HOOK,
      ctx,
      { connectorId },
    );
  } catch (err) {
    logFailure(ctx, connectorId, DIRECTORY_PROVENANCE_MARK_EDITED_HOOK, err);
  }
}
