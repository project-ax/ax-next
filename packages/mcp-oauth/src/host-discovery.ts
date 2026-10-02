import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { discoverMetadata } from './oauth-flow.js';
import { BlockedUrlError, isPrivateIp, type HostResolver } from './ssrf.js';

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_REQUESTS = 16;
const MAX_HOSTS = 12;
const DISCOVERY_TIMEOUT_MS = 15_000;

/** The draft URL is not an approved network capability yet. Preview is limited
 * to public HTTPS on port 443, with no embedded credentials or fragments. */
export function metadataUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BlockedUrlError('invalid metadata URL'); }
  if (value.length > 2048 || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) {
    throw new BlockedUrlError('metadata discovery requires HTTPS on port 443 without embedded credentials or a fragment');
  }
  return url;
}

export interface MetadataRequestOptions {
  address: string;
  signal: AbortSignal;
  headersOnly: boolean;
}

/** Pin the checked address at connect time, keeping the URL hostname for TLS
 * verification/SNI. No pooled connection, cookies, authorization or body; this
 * transport can only GET metadata. Header-only resource probes never buffer SSE. */
export function requestMetadata(url: URL, opts: MetadataRequestOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      agent: false,
      rejectUnauthorized: true,
      signal: opts.signal,
      headers: { Accept: 'application/json, text/event-stream' },
      lookup: (_hostname, options, callback) => {
        const family = isIP(opts.address);
        if (options.all) callback(null, [{ address: opts.address, family }]);
        else callback(null, opts.address, family);
      },
    }, (incoming) => {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      }
      const status = incoming.statusCode ?? 502;
      if (status < 200 || status > 599) {
        incoming.destroy();
        reject(new Error('Invalid OAuth metadata HTTP status'));
        return;
      }
      if (opts.headersOnly || (status >= 300 && status < 400) || !incoming.statusCode || status === 204 || status === 205) {
        resolve(new Response(null, { status, headers }));
        incoming.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_METADATA_BYTES) {
          req.destroy(new Error('OAuth metadata response too large'));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('error', reject);
      incoming.on('aborted', () => reject(new Error('OAuth metadata response aborted')));
      incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status, headers })));
    });
    req.on('error', reject);
    req.end();
  });
}

async function resolveBeforeTimeout(resolver: HostResolver, host: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('OAuth host discovery timed out'));
    signal.addEventListener('abort', abort, { once: true });
    resolver(host).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** What the authoring form needs to pick its sign-in options.
 * - `oauth`: the server publishes OAuth metadata; `clientRegistration` says
 *   which automatic client methods its authorization server advertises.
 * - `none`: the server answered without an auth challenge and publishes no
 *   OAuth metadata.
 * - `other`: the server challenged (401/403) but publishes no OAuth metadata,
 *   so it expects some other credential (typically a request header). */
export type OAuthDiscovery =
  | { hosts: string[]; auth: 'oauth'; clientRegistration: { cimd: boolean; dcr: boolean } }
  | { hosts: string[]; auth: 'none' | 'other' };

/** Discover only the hosts needed for PRM/AS discovery and OAuth endpoints.
 * This is an authenticated authoring preview, never an OAuth/client-secret
 * request. Its result grants nothing until the owner saves the connector. */
export async function discoverOAuthHosts(opts: {
  resourceUrl: string;
  resolver?: HostResolver;
  request?: typeof requestMetadata;
  signal?: AbortSignal;
}): Promise<OAuthDiscovery> {
  const resource = metadataUrl(opts.resourceUrl);
  const resolver = opts.resolver ?? (async (host: string) => (await lookup(host)).address);
  const get = opts.request ?? requestMetadata;
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const hosts = new Set<string>();
  let requests = 0;
  // Status of the unauthenticated resource probe, and whether any metadata
  // request after it succeeded. Together they separate "this server has no
  // OAuth" from "OAuth discovery broke part-way".
  let resourceStatus: number | undefined;
  let metadataSeen = false;

  async function check(value: string): Promise<{ url: URL; address: string }> {
    signal.throwIfAborted();
    const url = metadataUrl(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const address = isIP(host) ? host : await resolveBeforeTimeout(resolver, host, signal);
    if (isPrivateIp(address) || ipaddr.parse(address).range() !== 'unicast') {
      throw new BlockedUrlError('OAuth metadata host resolves to a private address or reserved range');
    }
    hosts.add(host);
    if (hosts.size > MAX_HOSTS) throw new BlockedUrlError('too many OAuth metadata hosts');
    return { url, address };
  }

  const fetchFn: FetchLike = async (input, init) => {
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET' || init?.body) {
      throw new BlockedUrlError('OAuth host discovery only supports unauthenticated GET');
    }
    let current = input.toString();
    for (let hop = 0; ; hop++) {
      if (++requests > MAX_REQUESTS) throw new BlockedUrlError('too many OAuth metadata requests');
      const { url, address } = await check(current);
      const isResource = input.toString() === resource.href;
      const response = await get(url, { address, signal, headersOnly: isResource });
      if (response.status < 300 || response.status >= 400) {
        if (isResource) resourceStatus = response.status;
        else if (response.ok) metadataSeen = true;
        return response;
      }
      const location = response.headers.get('location');
      if (!location) return response;
      if (hop >= 5) throw new BlockedUrlError('too many OAuth metadata redirects');
      current = new URL(location, url).href;
    }
  };

  let metadata: Awaited<ReturnType<typeof discoverMetadata>>['metadata'];
  try {
    ({ metadata } = await discoverMetadata({
      resourceUrl: resource.href,
      fetchFn,
      checkUrl: async (url) => { await check(url); },
    }));
  } catch (err) {
    // Only a server that answered and published no metadata at all is
    // classified; blocked hosts, timeouts and partial metadata stay failures.
    if (err instanceof BlockedUrlError || signal.aborted || resourceStatus === undefined || metadataSeen) throw err;
    const challenged = resourceStatus === 401 || resourceStatus === 403;
    return { hosts: [resource.hostname.replace(/^\[|\]$/g, '')], auth: challenged ? 'other' : 'none' };
  }
  // Authorization is opened in the browser; token and registration endpoints
  // receive credentials later. Validate and show them, but never fetch them here.
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error('OAuth metadata has no authorization or token endpoint');
  }
  for (const endpoint of [metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
    if (endpoint) await check(endpoint);
  }
  return {
    hosts: [...hosts].sort(),
    auth: 'oauth',
    clientRegistration: {
      cimd: metadata.client_id_metadata_document_supported === true,
      dcr: Boolean(metadata.registration_endpoint),
    },
  };
}
