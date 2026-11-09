import { z } from 'zod';
import { ID_MAX, VERSION_MAX } from './limits.js';

/**
 * The service hook other plugins call to search the connector directory (a
 * local mirror of a public MCP server listing). Transport- and
 * storage-agnostic: nothing here names the registry it was copied from.
 */
export const DIRECTORY_SEARCH_HOOK = 'connectors:directory-search';

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
/** UTF-16 code units. */
export const QUERY_MAX = 200;
export const CURSOR_MAX = 64;

/**
 * How strongly the listing's publisher is proven. `'domain'` = the publisher
 * proved control of a domain. `'account'` = a platform account only (or
 * nothing we could verify).
 */
export type PublisherProof = 'domain' | 'account';

/**
 * - `'key'`: the listing says a key is required (`keyHeader` names the header
 *   when usable).
 * - `'none'`: the listing declares no required key. NOT "no sign-in": the
 *   editor discovers sign-in from the address.
 * - `'signin'`: the source itself declares sign-in. The official registry
 *   cannot, so its entries never carry it.
 */
export type DirectoryAuth = 'signin' | 'key' | 'none';

export interface DirectoryEntry {
  id: string;
  title: string;
  description: string;
  publisher: string;
  publisherProof: PublisherProof;
  url: string;
  auth: DirectoryAuth;
  keyHeader?: string;
  version: string;
  updatedAt: string;
  deprecated?: true;
}

export interface DirectorySearchInput {
  query: string;
  limit?: number;
  cursor?: string;
}

export interface DirectorySearchOutput {
  enabled: boolean;
  entries: DirectoryEntry[];
  syncedAt: string | null;
  stale: boolean;
  verifiedOnly: boolean;
  nextCursor?: string;
}

// Raw z.object values (not cast to ZodType) so tests can read `.shape`.
export const DirectorySearchInputSchema = z
  .object({
    query: z.string().max(QUERY_MAX),
    limit: z.number().int().optional(),
    cursor: z.string().max(CURSOR_MAX).optional(),
  })
  .strict();

export const DirectoryEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  publisher: z.string(),
  publisherProof: z.enum(['domain', 'account']),
  url: z.string(),
  auth: z.enum(['signin', 'key', 'none']),
  keyHeader: z.string().optional(),
  version: z.string(),
  updatedAt: z.string(),
  deprecated: z.literal(true).optional(),
});

// Used as the hook's `returns`: zod strips undeclared keys, so this must list
// every output field.
export const DirectorySearchOutputSchema = z.object({
  enabled: z.boolean(),
  entries: z.array(DirectoryEntrySchema),
  syncedAt: z.string().nullable(),
  stale: z.boolean(),
  verifiedOnly: z.boolean(),
  nextCursor: z.string().optional(),
});

// ── Provenance (TASK-1102) ──────────────────────────────────────────────────

/**
 * Remember that a connector was saved from a directory listing. Called by the
 * connector create path after the connector is written. `directoryId` and
 * `version` are opaque listing identifiers, never parsed. `serverUrl` is the
 * saved connector's single server address (null when it has none or several);
 * the directory compares it with the listing's to decide `edited`.
 * `{ recorded: false }` when the listing is not in the copy, or the version is
 * one the sync would refuse. Input outside the schema: PluginError
 * `invalid-payload`.
 */
export const DIRECTORY_PROVENANCE_RECORD_HOOK = 'connectors:directory-provenance-record';

/**
 * Note that a connector's server address was changed by hand after it was
 * saved from a listing. `{ marked: true }` iff a record matched; never
 * creates one.
 */
export const DIRECTORY_PROVENANCE_MARK_EDITED_HOOK = 'connectors:directory-provenance-mark-edited';

/** A connector id's own limit. */
export const PROVENANCE_CONNECTOR_ID_MAX = 128;
/**
 * Compared, never stored. No saved address is longer than the 64 KiB admin
 * request body it arrived in.
 */
export const PROVENANCE_SERVER_URL_MAX = 65_536;

export const ProvenanceRecordInputSchema = z
  .object({
    connectorId: z.string().min(1).max(PROVENANCE_CONNECTOR_ID_MAX),
    directoryId: z.string().min(1).max(ID_MAX),
    version: z.string().min(1).max(VERSION_MAX),
    serverUrl: z.string().max(PROVENANCE_SERVER_URL_MAX).nullable(),
  })
  .strict();

export const ProvenanceRecordOutputSchema = z.object({ recorded: z.boolean() });

export const ProvenanceMarkEditedInputSchema = z
  .object({ connectorId: z.string().min(1).max(PROVENANCE_CONNECTOR_ID_MAX) })
  .strict();

export const ProvenanceMarkEditedOutputSchema = z.object({ marked: z.boolean() });

export type ProvenanceRecordInput = z.infer<typeof ProvenanceRecordInputSchema>;
export type ProvenanceRecordOutput = z.infer<typeof ProvenanceRecordOutputSchema>;
export type ProvenanceMarkEditedInput = z.infer<typeof ProvenanceMarkEditedInputSchema>;
export type ProvenanceMarkEditedOutput = z.infer<typeof ProvenanceMarkEditedOutputSchema>;
