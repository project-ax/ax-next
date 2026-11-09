import { z } from 'zod';

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
