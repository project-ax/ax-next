// ---------------------------------------------------------------------------
// Pin an image tag to a digest at import time (dev-services-on-demand, 1.5).
//
// A compose file names images by tag (`mongo:4.4`); the service descriptor
// requires `name@sha256:<64 hex>`. This resolves the tag against the image's
// registry, ANONYMOUSLY, and returns the pinned reference.
//
// This is a host-side outbound-network capability reachable from an admin
// route with admin-supplied strings, so it is an SSRF surface. The guards:
//   - the reference is parsed with a strict grammar BEFORE any network call;
//   - the registry host must be a public-looking DNS name: no IP literals (any
//     numeric form), no `localhost`, no dotless names, no `.local` /
//     `.internal` / `.localhost`, port 443 only, https only;
//   - redirects are never followed blindly: a manifest redirect is followed
//     only to the SAME host over https (at most 3 hops); a token-realm URL
//     gets the same host checks and is never redirected;
//   - every request has a timeout, token JSON is capped at 64 KiB, HEAD
//     responses are never read;
//   - requests carry NO credential of ours (only the anonymous pull token the
//     registry itself hands out, and only back to the registry host). A private
//     image gets a plain error.
// ---------------------------------------------------------------------------

export const REQUEST_TIMEOUT_MS = 10_000;
export const TOKEN_BODY_MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;

const DOCKER_HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';

const PINNED_RE = /^(.+)@sha256:[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const PATH_COMPONENT_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export type PinResult = { pinned: string } | { error: string };

interface ParsedRef {
  registry: string; // host, already host-checked
  repo: string;
  tag: string;
  /** Reference as pinned output prefix: registry/repo */
  name: string;
  digest?: string;
}

/** Host policy shared by the registry and the token realm. Returns an error or null. */
export function checkRegistryHost(hostname: string, port: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0 || host.length > 253) return 'invalid registry host';
  if (host.includes(':') || host.includes('[') || host.includes(']')) {
    return 'IP-literal registries are not allowed';
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return 'local registries are not allowed';
  if (!host.includes('.')) return 'registry host must be a public DNS name';
  if (host.endsWith('.local') || host.endsWith('.internal')) {
    return 'local registries are not allowed';
  }
  const labels = host.split('.');
  if (!labels.every((l) => HOST_LABEL_RE.test(l))) return 'invalid registry host';
  // Any numeric-looking last label means an IPv4 form (dotted, hex, octal, int).
  const last = labels[labels.length - 1] ?? '';
  if (!/[a-z]/.test(last) || /^0x/.test(last)) return 'IP-literal registries are not allowed';
  if (port !== '' && port !== '443') return 'only the default https port is allowed';
  return null;
}

function parseRef(ref: string): ParsedRef | { error: string } {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 255) return { error: 'invalid image reference' };
  if (/[\s\\]/.test(ref) || ref.includes('..') || ref.includes('://') || /[\u0000-\u001f\u007f]/.test(ref)) {
    return { error: 'invalid image reference' };
  }
  let rest = ref;
  let digest: string | undefined;
  const at = rest.indexOf('@');
  if (at !== -1) {
    const m = PINNED_RE.exec(rest);
    if (m === null) return { error: 'invalid image reference' };
    digest = rest.slice(at + 1);
    rest = m[1] as string;
  }
  const parts = rest.split('/');
  let registry = DOCKER_HUB_REGISTRY;
  const first = parts[0] as string;
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first;
    parts.shift();
  }
  // tag lives on the last component only
  const lastIdx = parts.length - 1;
  let tag = 'latest';
  const lastPart = parts[lastIdx] as string;
  const colon = lastPart.indexOf(':');
  if (colon !== -1) {
    tag = lastPart.slice(colon + 1);
    parts[lastIdx] = lastPart.slice(0, colon);
  }
  if (!TAG_RE.test(tag)) return { error: 'invalid image reference' };
  if (parts.length === 0 || !parts.every((p) => PATH_COMPONENT_RE.test(p))) {
    return { error: 'invalid image reference' };
  }
  let port = '';
  let hostname = registry;
  const pc = registry.indexOf(':');
  if (pc !== -1) {
    hostname = registry.slice(0, pc);
    port = registry.slice(pc + 1);
    if (!/^\d{1,5}$/.test(port)) return { error: 'invalid image reference' };
  }
  if (DOCKER_HUB_HOSTS.has(hostname) && port === '') {
    registry = DOCKER_HUB_REGISTRY;
    if (parts.length === 1) parts.unshift('library');
  } else {
    const bad = checkRegistryHost(hostname, port);
    if (bad !== null) return { error: bad };
    registry = hostname.toLowerCase().replace(/\.$/, '');
  }
  const repo = parts.join('/');
  return { registry, repo, tag, name: `${registry}/${repo}`, ...(digest !== undefined && { digest }) };
}

type Deps = { fetch: typeof fetch };

function call(deps: Deps, url: string, init: RequestInit): Promise<Response> {
  return deps.fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to release
  }
}

async function readCappedText(res: Response, cap: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > cap) {
    await discard(res);
    return null;
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseChallenge(header: string): { realm: string; service?: string; scope?: string } | null {
  if (!/^bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) {
    params[(m[1] as string).toLowerCase()] = m[2] as string;
  }
  if (params.realm === undefined) return null;
  return {
    realm: params.realm,
    ...(params.service !== undefined && { service: params.service }),
    ...(params.scope !== undefined && { scope: params.scope }),
  };
}

async function fetchToken(
  deps: Deps,
  challenge: { realm: string; service?: string; scope?: string },
  repo: string,
): Promise<string | { error: string }> {
  let realm: URL;
  try {
    realm = new URL(challenge.realm);
  } catch {
    return { error: 'registry sent an invalid token endpoint' };
  }
  if (realm.protocol !== 'https:' || realm.username !== '' || realm.password !== '') {
    return { error: 'registry sent an unsafe token endpoint' };
  }
  const bad = checkRegistryHost(realm.hostname, realm.port);
  if (bad !== null) return { error: 'registry sent an unsafe token endpoint' };
  realm.search = '';
  realm.hash = '';
  if (challenge.service !== undefined) realm.searchParams.set('service', challenge.service);
  // Always ask only for pull on this repo, whatever scope the registry named.
  realm.searchParams.set('scope', `repository:${repo}:pull`);
  const res = await call(deps, realm.toString(), { method: 'GET', headers: { accept: 'application/json' } });
  if (res.status !== 200) {
    await discard(res);
    return { error: 'registry refused anonymous access (is the image private?)' };
  }
  const text = await readCappedText(res, TOKEN_BODY_MAX_BYTES);
  if (text === null) return { error: 'registry token response too large' };
  try {
    const j = JSON.parse(text) as { token?: unknown; access_token?: unknown };
    const t = typeof j.token === 'string' ? j.token : j.access_token;
    if (typeof t === 'string' && t.length > 0) return t;
  } catch {
    // fall through
  }
  return { error: 'registry sent an unreadable token' };
}

export async function resolveImageDigest(ref: string, deps: Deps): Promise<PinResult> {
  const parsed = parseRef(ref);
  if ('error' in parsed) return parsed;
  if (parsed.digest !== undefined) return { pinned: ref };
  try {
    let url = `https://${parsed.registry}/v2/${parsed.repo}/manifests/${parsed.tag}`;
    let token: string | undefined;
    let authed = false;
    for (let hop = 0; hop <= MAX_REDIRECTS + 1; hop++) {
      const headers: Record<string, string> = { accept: MANIFEST_ACCEPT };
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      const res = await call(deps, url, { method: 'HEAD', headers });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await discard(res);
        let next: URL | null = null;
        try {
          next = loc === null ? null : new URL(loc, url);
        } catch {
          next = null;
        }
        if (
          next === null ||
          next.protocol !== 'https:' ||
          next.host !== new URL(url).host ||
          next.username !== '' ||
          next.password !== ''
        ) {
          return { error: 'registry redirected somewhere we will not follow' };
        }
        url = next.toString();
        continue;
      }
      if (res.status === 401 && !authed) {
        const challenge = parseChallenge(res.headers.get('www-authenticate') ?? '');
        await discard(res);
        if (challenge === null) return { error: 'registry refused anonymous access (is the image private?)' };
        const t = await fetchToken(deps, challenge, parsed.repo);
        if (typeof t !== 'string') return t;
        token = t;
        authed = true;
        continue;
      }
      if (res.status === 200) {
        const digest = res.headers.get('docker-content-digest');
        await discard(res);
        if (digest === null || !DIGEST_RE.test(digest)) {
          return { error: 'registry did not return a usable digest' };
        }
        return { pinned: `${parsed.name}@${digest}` };
      }
      await discard(res);
      if (res.status === 401 || res.status === 403) {
        return { error: 'registry refused anonymous access (is the image private?)' };
      }
      if (res.status === 404) return { error: 'image or tag not found' };
      return { error: `registry answered ${res.status}` };
    }
    return { error: 'too many redirects' };
  } catch {
    return { error: 'could not reach the registry' };
  }
}
