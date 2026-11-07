// The content origin's deploy config (agent artifacts, spec §6.5): parse the
// three env vars the chart stamps on the host pod into the listener config
// @ax/attachments takes.
//
// The content origin serves agent-made HTML, so it must sit on a different
// site from the app: a page there must never see, set or ride the app's
// cookies. We refuse the cheap mistakes here, at boot, before anything
// listens: a content host that equals an app (frame-ancestor) host, or that
// is a subdomain of one, or the reverse. (A sibling under the same registrable
// domain, such as `c.example.com` next to `app.example.com`, needs the public
// suffix list to catch; the chart and deploy/GKE.md tell operators to use a
// separate registrable domain.)
//
// Every value also lands in a response header (CSP `frame-ancestors`, minted
// URLs), so each must be a bare `scheme://host[:port]`, the same shape
// @ax/attachments' startContentOrigin checks again at start.

export const DEFAULT_CONTENT_PORT = 9091;

export interface ContentOriginInput {
  /** AX_CONTENT_ORIGIN: the URL browsers reach the content origin at. */
  origin?: string | undefined;
  /** AX_CONTENT_PORT: the bind port. Unset or empty means 9091. */
  port?: string | undefined;
  /** AX_CONTENT_FRAME_ANCESTORS: comma-separated app origins allowed to frame it. */
  frameAncestors?: string | undefined;
  /** The interface to bind (the public listener's AX_HTTP_HOST). */
  bindHost: string;
}

export interface ParsedContentOrigin {
  host: string;
  port: number;
  /** Omitted when port is 0 (test fixtures): minted URLs then use the bound port. */
  publicOrigin?: string;
  frameAncestors: string[];
}

// Matches @ax/attachments' ORIGIN_RE: http(s), a DNS name or IPv4, an optional
// port, and nothing else. No path, no trailing slash, no credentials.
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/** The lowercased hostname of a bare origin, or null when it is not one. */
function bareOriginHost(raw: string): string | null {
  if (!ORIGIN_RE.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  // The regex already rules out credentials, paths, queries and fragments;
  // the URL parse rules out ports over 65535 and malformed hosts.
  if (u.hostname === '' || u.hostname.startsWith('.') || u.hostname.endsWith('.')) return null;
  return u.hostname.toLowerCase();
}

function sameOrNested(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function parseContentOrigin(i: ContentOriginInput): ParsedContentOrigin {
  const origin = i.origin?.trim() ?? '';
  if (origin === '') {
    throw new Error(
      'AX_CONTENT_ORIGIN is required: the URL of the artifact content site, on a different domain from the app (for example https://ax-usercontent.example.net)',
    );
  }
  const contentHost = bareOriginHost(origin);
  if (contentHost === null) {
    throw new Error(
      'invalid AX_CONTENT_ORIGIN: expected a bare http(s) origin, scheme://host[:port], with no path, query, fragment or credentials',
    );
  }

  const portRaw = i.port ?? '';
  let port = DEFAULT_CONTENT_PORT;
  if (portRaw !== '') {
    port = /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : NaN;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`invalid AX_CONTENT_PORT=${portRaw}; expected 0..65535`);
    }
  }

  const frameAncestors = (i.frameAncestors ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (frameAncestors.length === 0) {
    throw new Error(
      'AX_CONTENT_FRAME_ANCESTORS is required: a comma-separated list of the app origins that may show artifacts (for example https://ax.example.com)',
    );
  }
  const ancestorHosts: string[] = [];
  for (const a of frameAncestors) {
    const h = bareOriginHost(a);
    if (h === null) {
      throw new Error(
        'invalid AX_CONTENT_FRAME_ANCESTORS: every entry must be a bare http(s) origin, scheme://host[:port]',
      );
    }
    ancestorHosts.push(h);
  }

  if (ancestorHosts.some((h) => sameOrNested(contentHost, h))) {
    throw new Error(
      'AX_CONTENT_ORIGIN must be a different site from the app: its hostname may not equal, contain or sit under any AX_CONTENT_FRAME_ANCESTORS hostname (cookies would be shared)',
    );
  }

  return {
    host: i.bindHost,
    port,
    ...(port === 0 ? {} : { publicOrigin: origin }),
    frameAncestors,
  };
}
