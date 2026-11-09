/**
 * Builders for raw registry JSON, shaped like one item of the registry's
 * `GET /v0.1/servers` `servers[]` array. Everything here is test data; the
 * defaults describe one ordinary, valid, latest, active listing.
 */

export const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

export interface ListingOptions {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  remotes?: unknown[];
  packages?: unknown[];
  status?: string;
  isLatest?: boolean;
  updatedAt?: string;
  /**
   * Merged over the official `_meta` defaults. A key set to `undefined` is
   * removed, so a test can drop `updatedAt` or `publishedAt` outright.
   */
  meta?: Record<string, unknown>;
}

export function listing(o: ListingOptions): unknown {
  const server: Record<string, unknown> = {
    name: o.name,
    description: o.description ?? 'A test server',
    version: o.version ?? '1.0.0',
    remotes: o.remotes ?? [remote('https://mcp.example.com/mcp')],
  };
  if (o.title !== undefined) server['title'] = o.title;
  if (o.packages !== undefined) server['packages'] = o.packages;

  const meta: Record<string, unknown> = {
    status: o.status ?? 'active',
    isLatest: o.isLatest ?? true,
    publishedAt: '2026-11-01T00:00:00Z',
    updatedAt: o.updatedAt ?? '2026-11-01T00:00:00Z',
    ...o.meta,
  };
  for (const key of Object.keys(meta)) {
    if (meta[key] === undefined) delete meta[key];
  }
  return { server, _meta: { [OFFICIAL_META]: meta } };
}

export function remote(
  url: string,
  type = 'streamable-http',
  headers?: unknown[],
): Record<string, unknown> {
  return headers === undefined ? { type, url } : { type, url, headers };
}

export function header(
  name: string,
  o: { isRequired?: boolean; isSecret?: boolean } = {},
): Record<string, unknown> {
  const h: Record<string, unknown> = { name, description: 'test header' };
  if (o.isRequired !== undefined) h['isRequired'] = o.isRequired;
  if (o.isSecret !== undefined) h['isSecret'] = o.isSecret;
  return h;
}

/** A package (stdio) entry, for package-only listings. */
export function npmPackage(identifier = '@example/mcp'): Record<string, unknown> {
  return {
    registryType: 'npm',
    identifier,
    version: '1.0.0',
    transport: { type: 'stdio' },
  };
}
