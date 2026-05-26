/**
 * HTTP / HTTPS forward proxy listener for sandboxed agents.
 *
 * Ported from v1 ~/dev/ai/ax/src/host/web-proxy.ts (HTTP forwarding from
 * lines 158-349, CONNECT handler from 353-493, handleMITMConnect from
 * 497-620, server setup from 622-655).
 *
 * Cuts from v1:
 * - `urlRewrites` block dropped — out of scope for v2.
 * - `onApprove` callback dropped — the per-session allowlist is the
 *   only egress gate (I2 from the Phase 1a plan).
 * - `domainDecisions` cache dropped — only ever cached `onApprove`
 *   results, which no longer exist.
 * - Canary-on-HTTP-body skipped — only the MITM path scans canary,
 *   since HTTP forwarding is rare for LLM/MCP traffic and never
 *   carries credential placeholders.
 * - `onAudit` is the listener's only audit-emission seam. The plugin
 *   wires one that maps each `ProxyAuditEntry` to the public
 *   `event.http-egress` payload and fires it on the bus (Task 11).
 * - Dynamic `import('./proxy-ca.js')` for `generateDomainCert` inlined
 *   to a static import — the v1 lazy load existed only to avoid pulling
 *   node-forge into non-MITM proxy modes that no longer exist in v2.
 *
 * Security:
 * - `resolveAndCheck` is called with the request's hostname; the
 *   returned IP is then used for the actual upstream connection so a
 *   second DNS resolution can't return a different (private) IP. See
 *   the SECURITY docstring on `resolveAndCheck`.
 * - Allowlist check: a host is allowed iff at least one registered
 *   session's `allowlist` contains it. Phase 1a passes `sessions`
 *   directly; Task 9 swaps to a per-process map keyed by sessionId.
 * - MITM is the default for HTTPS. The minted leaf cert chains to the
 *   CA passed via `ProxyListenerOptions.ca`; sandboxed clients trust
 *   that CA via the bridge's env-var injection. `bypassMITM` is the
 *   per-host opt-out for cert-pinning clients.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { existsSync, unlinkSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolveAndCheck, BlockedIPError, type Resolver } from './private-ip.js';
import type { SharedCredentialRegistry } from './registry.js';
import { generateDomainCert, type CAKeyPair } from './ca.js';
import { RequestFramer, findCanaryHit } from './request-framer.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * One session's egress policy. Multiple sessions can share a listener;
 * the allowlist check ORs across all registered sessions.
 */
export interface SessionConfig {
  /** Hostnames this session is allowed to reach (exact match). */
  allowlist: Set<string>;
  /** IPs exempt from the private-range block. Test-only escape hatch. */
  allowedIPs?: Set<string>;
  /**
   * Hostnames whose CONNECT requests should bypass MITM and pass through
   * as a raw TLS tunnel. Used as the per-session opt-out for cert-pinning
   * hosts (e.g. some CLIs that ship a pinned trust store).
   *
   * Aggregation is "any-bypass-wins": if ANY registered session declares
   * bypass for the hostname, the listener takes the safer default and
   * skips MITM for that host. Minting a cert for a pinned host would
   * break the client; failing closed (raw tunnel, no credential injection)
   * is the right call — sessions that wanted MITM still get the bytes
   * passed through, just without inspection.
   */
  bypassMITM?: Set<string>;
  /**
   * Optional canary token. When MITM is active and any decrypted request
   * chunk contains this byte sequence, the proxy aborts with 403 and
   * audits `blocked: 'canary_detected'`. Per-session: each session's token
   * is checked independently; a chunk matches if ANY session's token is
   * present. Used to detect prompt-injection attacks that try to exfiltrate
   * a canary string the model was told not to leak.
   */
  canaryToken?: string;
  /**
   * Stable session identifier. The plugin sets this on open-session so
   * audit emissions can carry it through to `event.http-egress`. Optional
   * for back-compat with tests that build SessionConfig directly without
   * going through the plugin.
   */
  sessionId?: string;
  /**
   * The user this session was opened for. The plugin sets this on
   * open-session; the listener attaches it to audit entries so subscribers
   * can attribute traffic. Optional for the same back-compat reason as
   * `sessionId`.
   */
  userId?: string;
  /**
   * The agent this session was opened for. The plugin sets it on open-session;
   * proxy:add-host returns it so a host-side caller can persist a per-(user,
   * agent) "always-allow" grant (TASK-44) without trusting a browser-supplied
   * agentId. Optional for back-compat with SessionConfigs tests build directly.
   */
  agentId?: string;
  /**
   * Coarse traffic class derived from the session's credential kinds.
   * Computed once at open-session time (cheap; kinds don't change for the
   * life of a session) and stamped onto every audit entry the listener
   * emits for this session.
   *
   * - `'llm'`: any credential's kind is an LLM kind (`'api-key'` today,
   *   future `'anthropic-oauth'` etc).
   * - `'mcp'`: Phase 3 will exercise this for `'mcp-*'` kinds.
   * - `'other'`: everything else (no credentials, or only non-LLM/non-MCP).
   *
   * Optional for back-compat — listener-internal SessionConfig built by
   * tests that don't go through the plugin won't have it set, and the
   * plugin's onAudit callback defaults to `'other'` if missing.
   */
  classification?: 'llm' | 'mcp' | 'other';
  /**
   * Per-session proxy token (TASK-52). An ATTRIBUTION LABEL, not an authz
   * input. Clients send it as `Proxy-Authorization: Basic ax:<token>`; the
   * listener resolves token → session (see findSessionByProxyToken) so even
   * an allowlist-MISS (403) — which matches no session via findAllowingSession
   * — can be attributed to the session that made the request. A missing or
   * forged token degrades to "no attribution" (today's behavior); it NEVER
   * affects the allow/deny decision and can never widen egress. Optional for
   * back-compat with tests that build SessionConfig directly.
   */
  proxyToken?: string;
}

/**
 * In-process audit entry the listener hands to its `onAudit` callback.
 * Shape is intentionally listener-internal — the plugin maps it to the
 * public `event.http-egress` payload (renaming fields, parsing the URL
 * into host/path, translating `blocked` → `blockedReason`).
 *
 * The `blocked` field uses the listener's own vocabulary
 * (`'canary_detected'`, `'tls_error: …'`, `'Blocked: …'` from
 * BlockedIPError, `'domain_denied: <host>'`, `'invalid_target'`); the
 * plugin translates to the bus's `'allowlist' | 'private-ip' | 'canary'
 * | 'tls-error'` enumeration.
 */
export interface ProxyAuditEntry {
  action: 'proxy_request';
  method: string;
  url: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  blocked?: string;
  /** True iff MITM substitution actually replaced bytes on this connection. */
  credentialInjected?: boolean;
  /**
   * Set when the listener could match the request to a registered session
   * (every success case, plus canary/tls-error/private-IP blocks where the
   * allowlist check passed). Unset when no session matched (allowlist miss
   * — the request never had an owner to begin with).
   */
  sessionId?: string;
  /** Same lifecycle as `sessionId`; copied from the matching session. */
  userId?: string;
  /** Same lifecycle as `sessionId`; copied from the matching session. */
  classification?: 'llm' | 'mcp' | 'other';
}

export interface ProxyListenerOptions {
  /** Where to listen. TCP on a host:port, or a Unix socket path. */
  listen: { kind: 'tcp'; host?: string; port?: number } | { kind: 'unix'; path: string };
  /** Shared credential registry — touched on the MITM path (Task 8). */
  registry: SharedCredentialRegistry;
  /** Per-session configs. Phase 1a: passed in; Task 9: per-process map. */
  sessions: Map<string, SessionConfig>;
  /**
   * Root CA used to mint per-domain leaf certs on the MITM path. Required —
   * MITM is the default for HTTPS, and we can't terminate TLS without one.
   * Tests pass a CA minted in tmpdir; production uses `getOrCreateCA(dir)`.
   */
  ca: CAKeyPair;
  /**
   * Optional audit sink — defaults to no-op. The plugin provides one that
   * maps `ProxyAuditEntry` → `event.http-egress` and fires on the bus.
   * Tests may pass a sync function that just collects entries.
   */
  onAudit?: (entry: ProxyAuditEntry) => void;
  /** Optional DNS resolver override — for tests. Default: dns.promises.lookup. */
  resolver?: Resolver;
  /**
   * Max bytes the plain-HTTP forward path buffers for a single request body
   * before returning 413. The HTTP path reads the whole body into memory to
   * re-forward via fetch; without a cap one large upload OOMs a memory-tight
   * host (TASK-24). Default 16 MiB — generous for any legitimate API request
   * body. Large *downloads* (responses) are streamed, not buffered, and the
   * MITM path is backpressure-bounded, so this only governs plain-HTTP uploads.
   */
  maxHttpRequestBodyBytes?: number;
}

export interface ProxyListener {
  /** TCP port (0 when listening on a Unix socket). */
  port: number;
  /** Full address — TCP port number or Unix socket path string. */
  address: string | number;
  stop(): void;
}

// ── Allowlist-miss message ───────────────────────────────────────────

/**
 * The actionable body returned when a request is denied because its host is in
 * no session's allowlist. Shared by the HTTP-forward and HTTPS-CONNECT deny
 * paths so the two can't drift — a binary-download CLI fails over CONNECT, an
 * API call over HTTP, and both deserve the same guidance (TASK-25).
 *
 * The second sentence calls out the prebuilt-binary case specifically: many
 * npm CLIs (esbuild / swc / biome / @schpet/linear-cli, …) are a thin wrapper
 * that downloads a platform binary from a GitHub release — `github.com` →
 * `release-assets.githubusercontent.com` — and those hosts are NOT
 * auto-allowlisted by `capabilities.packages.npm`. The author has to declare
 * them in the skill's `allowedHosts`. See
 * docs/plans/2026-05-22-credentialed-cli-tools-and-git-auth-design.md.
 *
 * `hostname` is caller-controlled (the request target), so it goes in the
 * BODY only — never a header — and the CONNECT/HTTP callers stamp a
 * Content-Length from the byte length. Node's HTTP parser already rejects
 * CR/LF in the request target before either handler runs, so a hostname can't
 * forge a header here regardless.
 */
function allowlistMissBody(hostname: string): string {
  return (
    `Egress to ${hostname} was blocked: it is not in any session allowlist. ` +
    `To fix, install a skill that declares this domain in its allowedHosts, ` +
    `or ask an admin to approve it. ` +
    `(Heads-up: some CLIs download a prebuilt binary from a GitHub release — ` +
    `those need github.com AND release-assets.githubusercontent.com in allowedHosts.)`
  );
}

// ── Allowlist check ──────────────────────────────────────────────────

/**
 * A hostname is allowed iff some registered session's allowlist contains it.
 * Returns the allowedIPs override of the FIRST matching session, or undefined.
 *
 * Phase 1a uses exact-match. Wildcards are deliberately out of scope —
 * the bridge passes literal hostnames extracted from the URL.
 */
function findAllowingSession(
  hostname: string,
  sessions: Map<string, SessionConfig>,
): SessionConfig | undefined {
  for (const session of sessions.values()) {
    if (session.allowlist.has(hostname)) return session;
  }
  return undefined;
}

// TASK-52: the per-session proxy token format, re-asserted at this trust
// boundary (defense in depth — the runner validates independently; no shared
// helper crosses the plugin boundary, per I2). Attribution-only.
const PROXY_TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * Parse a `Proxy-Authorization: Basic base64("ax:<token>")` header into the
 * 32-hex token, or undefined. ATTRIBUTION-ONLY — a malformed/absent header
 * simply yields no attribution; it NEVER affects the allow/deny decision and
 * can never widen egress.
 */
function parseProxyToken(headerValue: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== 'string' || !raw.startsWith('Basic ')) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(raw.slice('Basic '.length), 'base64').toString('utf-8');
  } catch {
    return undefined;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return undefined;
  const token = decoded.slice(sep + 1);
  return PROXY_TOKEN_RE.test(token) ? token : undefined;
}

/**
 * Resolve a proxy token → its SessionConfig (attribution). Linear scan; the
 * per-process session count is small. Returns undefined for an absent or
 * unregistered (forged) token — the caller then leaves the audit unattributed,
 * exactly as before this feature existed.
 */
function findSessionByProxyToken(
  token: string | undefined,
  sessions: Map<string, SessionConfig>,
): SessionConfig | undefined {
  if (token === undefined) return undefined;
  for (const session of sessions.values()) {
    if (session.proxyToken !== undefined && session.proxyToken === token) {
      return session;
    }
  }
  return undefined;
}

/**
 * TASK-52: build the session-attribution fields to spread onto a BLOCKED
 * (allowlist-miss) audit entry, resolved from the request's Proxy-Authorization
 * header. Returns an empty object when no token matches — the block stays
 * unattributed (today's behavior). This is additive: it does NOT touch the
 * allow/deny gate (findAllowingSession), so it can never widen egress.
 */
function blockAttribution(
  proxyAuthHeader: string | string[] | undefined,
  sessions: Map<string, SessionConfig>,
): Partial<Pick<ProxyAuditEntry, 'sessionId' | 'userId' | 'classification'>> {
  const attributed = findSessionByProxyToken(parseProxyToken(proxyAuthHeader), sessions);
  if (attributed === undefined) return {};
  return {
    ...(attributed.sessionId !== undefined ? { sessionId: attributed.sessionId } : {}),
    ...(attributed.userId !== undefined ? { userId: attributed.userId } : {}),
    ...(attributed.classification !== undefined
      ? { classification: attributed.classification }
      : {}),
  };
}

/**
 * Returns true iff ANY registered session has the hostname in `bypassMITM`.
 *
 * "Any wins" is the safer default — minting a leaf cert for a cert-pinned
 * host would break the pinned client. If even one session asked us not to
 * intercept this host, we honor it for all sessions sharing the listener.
 * Sessions that wanted MITM still get bytes through, just unwrapped.
 */
function findAnyBypassingSession(
  hostname: string,
  sessions: Map<string, SessionConfig>,
): boolean {
  for (const session of sessions.values()) {
    if (session.bypassMITM?.has(hostname)) return true;
  }
  return false;
}

/** Collect all canary tokens declared across sessions, deduped + non-empty. */
function collectCanaryTokens(sessions: Map<string, SessionConfig>): string[] {
  const tokens = new Set<string>();
  for (const session of sessions.values()) {
    if (session.canaryToken) tokens.add(session.canaryToken);
  }
  return [...tokens];
}

/** Minimal pausable source the backpressure pump needs. */
export interface PausableSource {
  pause(): void;
  resume(): void;
}
/** Minimal writable sink the backpressure pump needs. */
export interface BackpressureSink {
  /** Returns false when the internal buffer is full (Node stream contract). */
  write(chunk: Buffer): boolean;
  once(event: 'drain', listener: () => void): void;
}

/**
 * Write `chunk` to `dest`, applying backpressure: when `dest.write` returns
 * false (its buffer is full), pause `src` until `dest` emits `'drain'`, then
 * resume. This bounds the host's per-connection memory to the sink's
 * highWaterMark instead of letting a slow consumer accumulate an unbounded
 * write queue — the multi-MB-download OOM vector (TASK-24). Both MITM pumps
 * (download upstream→client, and the framed client→upstream write) route
 * through this so neither can balloon host memory on a slow peer.
 */
export function writeWithBackpressure(
  src: PausableSource,
  dest: BackpressureSink,
  chunk: Buffer,
): void {
  if (chunk.length === 0) return;
  const ok = dest.write(chunk);
  if (!ok) {
    src.pause();
    dest.once('drain', () => src.resume());
  }
}

/** Minimal readable surface the capped-body reader needs (a subset of
 *  IncomingMessage), so it's unit-testable with a fake. */
export interface CappedBodySource {
  readonly destroyed: boolean;
  readonly readableEnded: boolean;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'aborted' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface CappedBodyResult {
  body: Buffer;
  /** True iff the body exceeded `maxBytes` (caller should 413). */
  oversized: boolean;
  bodyBytes: number;
  /** True iff the client hung up before a clean 'end' (caller should bail). */
  aborted: boolean;
}

/**
 * Read a request body into memory, CAPPED at `maxBytes` (TASK-24). Over the cap
 * it stops accumulating but keeps draining to 'end' (no destroy — destroying
 * the readable can reset the socket before a 413 lands). The returned promise
 * settles on EVERY terminal outcome: 'end' (complete), 'error' (stream error),
 * 'close'/'aborted' without 'end' (client hung up), AND the already-terminated
 * case checked up front (the request can close while the caller was awaiting a
 * prior async step — slow DNS — so the terminal event fired before these
 * listeners attached and EventEmitter won't replay it; without this guard the
 * handler hangs forever — Codex).
 */
export function readCappedBody(
  req: CappedBodySource,
  maxBytes: number,
): Promise<CappedBodyResult> {
  return new Promise<CappedBodyResult>((resolve, reject) => {
    const collected: Buffer[] = [];
    let total = 0;
    let over = false;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    // Already-terminated guard (see doc): `destroyed` after abort/close,
    // `readableEnded` after a clean 'end' already passed.
    if (req.destroyed || req.readableEnded) {
      finish(() => resolve({ body: Buffer.alloc(0), oversized: false, bodyBytes: 0, aborted: true }));
      return;
    }
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!over) {
          over = true;
          collected.length = 0; // stop buffering; keep draining to 'end'
        }
        return;
      }
      collected.push(chunk);
    });
    req.on('end', () =>
      finish(() => resolve({ body: Buffer.concat(collected), oversized: over, bodyBytes: total, aborted: false })),
    );
    req.on('error', (err) => finish(() => reject(err)));
    const onAbort = (): void =>
      finish(() => {
        collected.length = 0;
        resolve({ body: Buffer.alloc(0), oversized: over, bodyBytes: total, aborted: true });
      });
    req.on('aborted', onAbort);
    req.on('close', onAbort);
  });
}

// ── Listener ─────────────────────────────────────────────────────────

/** Default cap on a single plain-HTTP forwarded request body: 16 MiB. Over
 *  this we 413 rather than let one upload OOM the host (TASK-24). */
const DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export async function startProxyListener(opts: ProxyListenerOptions): Promise<ProxyListener> {
  const { listen, sessions, onAudit, resolver, registry, ca } = opts;
  const maxHttpRequestBodyBytes =
    opts.maxHttpRequestBodyBytes ?? DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES;
  const activeSockets = new Set<net.Socket>();

  function audit(entry: ProxyAuditEntry): void {
    onAudit?.(entry);
  }

  /**
   * Copy the session-stamping fields (`sessionId`, `userId`, `classification`)
   * off `session` onto an audit entry. No-op if `session` is undefined
   * (allowlist-miss + invalid-target paths can't attribute to a session).
   *
   * `exactOptionalPropertyTypes` means we only set keys when defined;
   * setting `key: undefined` is a type error.
   */
  function stampSession(
    entry: ProxyAuditEntry,
    session: SessionConfig | undefined,
  ): ProxyAuditEntry {
    if (!session) return entry;
    if (session.sessionId !== undefined) entry.sessionId = session.sessionId;
    if (session.userId !== undefined) entry.userId = session.userId;
    if (session.classification !== undefined) entry.classification = session.classification;
    return entry;
  }

  // ── HTTP request forwarding ──

  async function handleHTTPRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    let requestBytes = 0;
    let responseBytes = 0;

    try {
      // The bridge forwards the absolute URL in `req.url` (HTTP-proxy convention).
      // Fall back to constructing one from the Host header so direct curl-style
      // fetches against the listener also work.
      const targetUrl = url.startsWith('http://') || url.startsWith('https://')
        ? new URL(url)
        : new URL(url, `http://${req.headers.host ?? 'unknown'}`);

      // Strip IPv6 brackets if present
      const hostname =
        targetUrl.hostname.startsWith('[') && targetUrl.hostname.endsWith(']')
          ? targetUrl.hostname.slice(1, -1)
          : targetUrl.hostname;

      // Allowlist gate (I2): hostname must be in some session's allowlist.
      const allowingSession = findAllowingSession(hostname, sessions);
      if (!allowingSession) {
        // No allowing session, but the request may still carry a per-session
        // proxy token (TASK-52) — resolve it so even this allowlist-miss 403
        // is attributed to the session that made it. Attribution-only: a
        // missing/forged token just leaves the fields empty (today's
        // behavior); it never affects the allow/deny decision above.
        audit({
          action: 'proxy_request',
          method,
          url,
          status: 403,
          requestBytes: 0,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: `domain_denied: ${hostname}`,
          ...blockAttribution(req.headers['proxy-authorization'], sessions),
        });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(allowlistMissBody(hostname));
        return;
      }

      // SSRF block (I3): resolve and verify against private CIDRs.
      // Use the returned IP for the upstream connection — DO NOT re-resolve
      // (DNS rebinding defense). See SECURITY note on resolveAndCheck.
      const resolvedIP = await resolveAndCheck(hostname, allowingSession.allowedIPs, resolver);

      // Read request body, CAPPED so one large upload can't OOM the host
      // (TASK-24). Over the cap we 413 without forwarding; a client that hangs
      // up mid-upload (including DURING the resolveAndCheck await above) settles
      // as `aborted`. See readCappedBody.
      const { body, oversized, bodyBytes, aborted } = await readCappedBody(
        req,
        maxHttpRequestBodyBytes,
      );
      if (aborted) {
        // Client disconnected mid-upload — nothing to forward, nothing to
        // respond to (the socket is gone). Just release the handler.
        return;
      }
      if (oversized) {
        audit(stampSession({
          action: 'proxy_request',
          method,
          url,
          status: 413,
          requestBytes: bodyBytes,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: 'request_body_too_large',
        }, allowingSession));
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('Request body exceeds the proxy limit.');
        return;
      }
      requestBytes = body.length;

      // Forward headers (strip hop-by-hop and encoding headers — fetch handles these).
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (
          !value ||
          key === 'host' ||
          key === 'connection' ||
          key === 'proxy-connection' ||
          key === 'transfer-encoding' ||
          key === 'content-length'
        )
          continue;
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      // Preserve the original Host so the upstream sees vhost-correct routing.
      headers['host'] = targetUrl.host;

      // Build the upstream URL using the resolved IP (DNS rebinding defense).
      // For IPv6, re-bracket the literal so URL parsing accepts it.
      const ipForUrl = net.isIPv6(resolvedIP) ? `[${resolvedIP}]` : resolvedIP;
      const upstreamUrl = new URL(targetUrl.toString());
      upstreamUrl.hostname = ipForUrl;

      // Forward via fetch and stream response back.
      const response = await fetch(upstreamUrl.toString(), {
        method,
        headers,
        ...(body.length > 0 ? { body } : {}),
        redirect: 'manual',
      });

      const outHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (k !== 'transfer-encoding' && k !== 'content-encoding' && k !== 'content-length') {
          outHeaders[k] = v;
        }
      });
      res.writeHead(response.status, outHeaders);

      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            responseBytes += value.length;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();

      audit(stampSession({
        action: 'proxy_request',
        method,
        url,
        status: response.status,
        requestBytes,
        responseBytes,
        durationMs: Date.now() - startTime,
      }, allowingSession));
    } catch (err) {
      // BlockedIPError → 403 (policy block); anything else → 502 (network/DNS).
      // Reviewer M3 from Task 5: use typed instanceof, not string match.
      const isBlocked = err instanceof BlockedIPError;
      const status = isBlocked ? 403 : 502;
      const message = isBlocked
        ? (err as BlockedIPError).message
        : `Proxy error: ${(err as Error).message}`;

      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'text/plain' });
      }
      res.end(message);

      // Re-resolve the matching session for stamping. The catch can fire
      // either before or after `allowingSession` was set in the try block,
      // and `allowingSession` isn't in scope here. Re-running the lookup is
      // cheap (Map.values iteration over a tiny set) and keeps the flow
      // straightforward.
      const hostnameForCatch = (() => {
        try {
          return new URL(
            url.startsWith('http://') || url.startsWith('https://')
              ? url
              : `http://${req.headers.host ?? 'unknown'}${url}`,
          ).hostname;
        } catch {
          return undefined;
        }
      })();
      const sessionForCatch = hostnameForCatch
        ? findAllowingSession(hostnameForCatch, sessions)
        : undefined;
      const blockedEntry: ProxyAuditEntry = {
        action: 'proxy_request',
        method,
        url,
        status,
        requestBytes,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
      };
      if (isBlocked) blockedEntry.blocked = message;
      audit(stampSession(blockedEntry, sessionForCatch));
    }
  }

  // ── HTTPS CONNECT — MITM path (TLS terminate, substitute, canary scan) ──
  //
  // Ported from v1 ~/dev/ai/ax/src/host/web-proxy.ts:497-620 with adaptations:
  //  - `options.mitm.credentials` → the per-session view of the shared
  //    `SharedCredentialRegistry` already passed to the listener. One tunnel
  //    sees ALL active sessions' placeholders; cross-session collision is
  //    statistically infeasible (16 random bytes per placeholder).
  //  - `generateDomainCert` static-imported (no longer dynamic).
  //  - `canaryToken` aggregated across sessions (per-session field, not
  //    a single global option). A chunk matches if any session's token is in it.
  //  - `sessionId`/`userId`/`classification` are stamped via `stampSession`
  //    from the SessionConfig that allowed the request. The plugin sets
  //    those fields at `proxy:open-session` time (Task 11).

  async function handleMITMConnect(
    clientSocket: net.Socket,
    hostname: string,
    port: number,
    resolvedIP: string,
    head: Buffer,
    startTime: number,
    target: string,
    allowingSession: SessionConfig,
  ): Promise<void> {
    const domainCert = generateDomainCert(hostname, ca);

    // Tell the client the tunnel is established before kicking off TLS.
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Suppress raw-socket errors so an abrupt client disconnect during the
    // TLS handshake doesn't crash with an unhandled 'error' — the TLS wrapper
    // cleanup paths handle teardown.
    clientSocket.on('error', () => { /* handled by TLS wrapper cleanup */ });

    // Terminate the client's TLS with our minted leaf cert.
    const clientTls = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: domainCert.key,
      cert: domainCert.cert,
    });

    // Connect to the upstream by RESOLVED IP (DNS rebinding defense), with
    // SNI = original hostname. Trust store = real roots PLUS our CA so test
    // upstreams signed by the same CA are accepted without disabling cert
    // verification. RFC 6066 forbids SNI for IP literals, so omit servername
    // when the hostname is an IP address (avoids a Node deprecation warning).
    const targetTls = tls.connect({
      host: resolvedIP,
      port,
      ca: [...tls.rootCertificates, ca.cert],
      ...(net.isIP(hostname) ? {} : { servername: hostname }),
    });

    activeSockets.add(clientTls);
    activeSockets.add(targetTls);

    // Track upstream TLS handshake failure separately so the cleanup audit
    // doesn't double-log a 200 over the actual 502.
    let tlsFailed = false;
    targetTls.on('error', (err) => {
      if (!tlsFailed) {
        tlsFailed = true;
        audit(stampSession({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 502,
          requestBytes: head.length,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: `tls_error: ${err.message}`,
        }, allowingSession));
      }
    });

    let requestBytes = head.length;
    let responseBytes = 0;
    let credentialInjected = false;

    // canaryTokens are computed once per connection — sessions don't change
    // mid-tunnel under our model.
    const canaryTokens = collectCanaryTokens(sessions);

    // One framer per connection: it frames the decrypted client→upstream byte
    // stream into HTTP/1.1 requests so each request head's Basic-auth value can
    // be decoded → canary-scanned → placeholder-substituted → re-base64-encoded.
    // Bodies keep the existing per-chunk verbatim substitution (registry is a
    // valid Replacer). Re-encoding base64 cannot emit CR/LF, so a substituted
    // value can't inject headers (I1/§4.5).
    const framer = new RequestFramer(registry, canaryTokens, {
      // Oversized head → verbatim passthrough. Log the event only; never the
      // bytes (no-secret-logging, I7 / §4.5).
      onOversizedHead: () => { /* bounded-head fallback engaged — no value logged */ },
    });

    // Shared canary-block path — used by both the raw-chunk scan (parity with
    // the pre-framer behavior) and the framer's decoded-Basic-blob hit. Emits
    // the SAME 403 audit + tears down the tunnel. Never logs the decoded value.
    const blockCanary = () => {
      audit(stampSession({
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status: 403,
        requestBytes,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked: 'canary_detected',
      }, allowingSession));
      // Send a 403 over the TLS channel before tearing down.
      clientTls.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      clientTls.end();
      targetTls.destroy();
    };

    // client → (canary scan, then per-request Basic-auth transform) → upstream
    clientTls.on('data', (chunk: Buffer) => {
      requestBytes += chunk.length;

      // Raw-chunk canary scan first — catches a canary that appears verbatim in
      // any byte the model wrote (body, Bearer header, etc). The framer's decode
      // pass additionally catches one base64-buried in a Basic blob.
      if (findCanaryHit(chunk, canaryTokens)) {
        blockCanary();
        return;
      }

      const { out, canaryToken, injected } = framer.process(chunk);
      if (canaryToken) {
        blockCanary();
        return;
      }
      // `injected` is true only when a placeholder was actually substituted —
      // not merely when the framer reframed buffered bytes.
      if (injected) credentialInjected = true;
      // The framer holds bytes until end-of-head, so `out` is legitimately empty
      // while a head is still buffering — only write when there's something.
      // Backpressure-aware: a slow upstream can't grow the host's write queue
      // unboundedly (TASK-24).
      if (out.length > 0) {
        writeWithBackpressure(clientTls, targetTls, out);
      }
    });

    // upstream → client (no substitution on response — placeholders should
    // never originate upstream). Backpressure-aware so a slow client (the
    // common case for a multi-MB download into a runner pod) can't pile the
    // response up in the host's socket buffer and OOM it (TASK-24).
    targetTls.on('data', (chunk: Buffer) => {
      responseBytes += chunk.length;
      writeWithBackpressure(targetTls, clientTls, chunk);
    });

    // Flush any inner-TLS bytes the client sent before our upstream socket
    // existed. MUST happen BEFORE we'd otherwise let a clientTls 'data'
    // listener race ahead — same lesson as the Task 7 head-buffer fix.
    // ClientHello bytes won't typically contain placeholders, but run them
    // through replaceAllBuffer anyway in case the head straddles a request
    // boundary on a long-lived tunnel.
    if (head.length > 0) {
      const replaced = registry.replaceAllBuffer(head);
      if (replaced !== head) credentialInjected = true;
      targetTls.write(replaced);
    }

    // Cleanup once — first close/error wins, downstream events become no-ops.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeSockets.delete(clientTls);
      activeSockets.delete(targetTls);
      clientTls.destroy();
      targetTls.destroy();

      // Skip the 200 audit if a TLS handshake error already logged 502.
      if (!tlsFailed) {
        audit(stampSession({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 200,
          requestBytes,
          responseBytes,
          durationMs: Date.now() - startTime,
          // Omit `credentialInjected` when false to satisfy
          // exactOptionalPropertyTypes — only present when substitution fired.
          ...(credentialInjected ? { credentialInjected: true as const } : {}),
        }, allowingSession));
      }
    };

    clientTls.on('close', cleanup);
    clientTls.on('error', cleanup);
    targetTls.on('close', cleanup);
    targetTls.on('error', cleanup);
  }

  // ── HTTPS CONNECT — MITM (default) or raw TCP tunnel (bypassMITM hosts) ──
  //
  // Ported from v1 ~/dev/ai/ax/src/host/web-proxy.ts:353-493 (allowlist + DNS
  // gates) and 497-620 (handleMITMConnect). Cuts vs. v1:
  //  - urlRewrites block dropped (out of scope for v2).
  //  - onApprove dropped — per-session allowlist is the only egress gate.
  //  - sessionId/userId/classification are stamped on audit entries via
  //    `stampSession` from the matching SessionConfig (Task 11).
  //  - bypassDomains field renamed to per-session bypassMITM, aggregated
  //    "any-bypass-wins" so cert-pinning hosts never get a minted cert.
  //
  // MITM is the default. If the hostname is NOT in any session's bypassMITM,
  // traffic is intercepted with a dynamically-minted domain cert and decrypted
  // in-process for credential injection + canary scanning. Hosts in
  // bypassMITM fall through to the raw-tunnel path below (no inspection).

  async function handleCONNECT(
    req: IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const startTime = Date.now();
    const target = req.url ?? '';
    let requestBytes = head.length;
    let responseBytes = 0;

    // Parse host:port from CONNECT target ("host:port")
    const [hostname, portStr] = target.split(':');
    const port = parseInt(portStr ?? '443', 10);

    if (!hostname || Number.isNaN(port)) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.end();
      audit({
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status: 400,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked: 'invalid_target',
      });
      return;
    }

    try {
      // Allowlist gate (I2): hostname must be in some session's allowlist.
      const allowingSession = findAllowingSession(hostname, sessions);
      if (!allowingSession) {
        // Write an ACTIONABLE 403 (not a bare status line): a binary-download
        // CLI fails over CONNECT, and a body-less denial surfaces as an opaque
        // error to the agent and the user. Mirror the HTTP path's guidance via
        // the shared `allowlistMissBody` so the two can't drift (TASK-25). The
        // body carries the caller-controlled hostname; Content-Length is the
        // body's byte length, and the hostname is in the body (never a header).
        const body = allowlistMissBody(hostname);
        const bodyLen = Buffer.byteLength(body);
        clientSocket.write(
          `HTTP/1.1 403 Forbidden\r\n` +
            `Content-Type: text/plain\r\n` +
            `Content-Length: ${bodyLen}\r\n` +
            `Connection: close\r\n` +
            `\r\n` +
            body,
        );
        clientSocket.end();
        // Same shape as the HTTP allowlist-miss case — attribute via the
        // per-session proxy token on the CONNECT request when present
        // (TASK-52). Node exposes the CONNECT request's headers the same way.
        audit({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 403,
          requestBytes: 0,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: `domain_denied: ${hostname}`,
          ...blockAttribution(req.headers['proxy-authorization'], sessions),
        });
        return;
      }

      // SSRF block (I3): resolve and verify against private CIDRs.
      // Use the returned IP for the upstream connection — DO NOT re-resolve
      // (DNS rebinding defense). See SECURITY note on resolveAndCheck.
      const resolvedIP = await resolveAndCheck(hostname, allowingSession.allowedIPs, resolver);

      // MITM unless ANY session has the host in bypassMITM (any-bypass-wins).
      const shouldMitm = !findAnyBypassingSession(hostname, sessions);
      if (shouldMitm) {
        await handleMITMConnect(
          clientSocket,
          hostname,
          port,
          resolvedIP,
          head,
          startTime,
          target,
          allowingSession,
        );
        return;
      }

      // Open the raw TCP tunnel against the resolved IP.
      const targetSocket = net.connect(port, resolvedIP, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        activeSockets.add(targetSocket);

        // Byte counters wired BEFORE pipe() — pipe() subscribes its own
        // 'data' listener; setting ours first removes the ordering brittleness.
        targetSocket.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
        });
        clientSocket.on('data', (chunk: Buffer) => {
          requestBytes += chunk.length;
        });

        // Flush any bytes the client sent before the upstream opened — MUST
        // happen before pipe() wires clientSocket → targetSocket, otherwise
        // a racing client chunk could land on the upstream ahead of `head`
        // and corrupt the TLS ClientHello.
        if (head.length > 0) {
          targetSocket.write(head);
        }

        // Pipe bidirectionally — neither side's bytes are inspected here.
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
      });

      // Cleanup once — first close/error wins, downstream events become no-ops.
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        activeSockets.delete(targetSocket);
        targetSocket.destroy();
        clientSocket.destroy();

        audit(stampSession({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 200,
          requestBytes,
          responseBytes,
          durationMs: Date.now() - startTime,
        }, allowingSession));
      };

      targetSocket.on('close', cleanup);
      targetSocket.on('error', cleanup);
      clientSocket.on('close', cleanup);
      clientSocket.on('error', cleanup);
    } catch (err) {
      // BlockedIPError → 403 (policy block); anything else → 502 (network/DNS).
      // Reviewer M3 from Task 5: typed instanceof, not string match.
      const isBlocked = err instanceof BlockedIPError;
      const status = isBlocked ? 403 : 502;

      clientSocket.write(
        `HTTP/1.1 ${status} ${isBlocked ? 'Forbidden' : 'Bad Gateway'}\r\n\r\n`,
      );
      clientSocket.end();

      // The catch fires either before or after `allowingSession` was set
      // in the try block; re-resolve via hostname to attribute when possible.
      // Allowlist hits with a private-IP block (BlockedIPError) DO have a
      // matching session — the resolveAndCheck call only runs after the
      // allowlist gate passed.
      const sessionForCatch = findAllowingSession(hostname, sessions);
      const blockedEntry: ProxyAuditEntry = {
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
      };
      if (isBlocked) blockedEntry.blocked = (err as BlockedIPError).message;
      audit(stampSession(blockedEntry, sessionForCatch));
    }
  }

  // ── Server setup ──

  const server: Server = createServer(handleHTTPRequest);
  server.on('connect', handleCONNECT);

  server.on('connection', (socket) => {
    // Shutdown-race defense: attach a noop 'error' listener BEFORE the
    // socket can be destroyed by any code path. Node's EventEmitter throws
    // when 'error' is emitted with zero listeners; a kernel-level
    // ECONNRESET that races with `stopFn`'s `socket.destroy()` (or with an
    // in-flight handler awaiting before it attaches its own listener)
    // would otherwise crash the host. Subsequent listeners
    // (handleMITMConnect, handleCONNECT bypass path) stack on top — all
    // fire on emit, so this doesn't suppress real error handling, just
    // prevents the unhandled-error throw. PR #104 walk symptom: "Error:
    // read ECONNRESET at TCP.onStreamRead, Emitted 'error' event on
    // Socket instance" — the "Socket" (not TLSSocket) is exactly this
    // inbound socket.
    socket.on('error', () => { /* see comment above */ });
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  // Clean up stale Unix socket
  if (listen.kind === 'unix' && existsSync(listen.path)) {
    unlinkSync(listen.path);
  }

  const stopFn = () => {
    for (const s of activeSockets) {
      // Belt-and-suspenders: ensure an 'error' listener exists before
      // destroy. Inbound sockets already get one at server.on('connection');
      // clientTls / targetTls / targetSocket get theirs synchronously
      // after creation in the MITM and bypass-MITM paths. This catches
      // any future socket type that someone adds to activeSockets without
      // remembering to attach a listener first.
      s.on('error', () => { /* see server.on('connection') note above */ });
      s.destroy();
    }
    activeSockets.clear();
    server.close();
    if (listen.kind === 'unix') {
      try {
        unlinkSync(listen.path);
      } catch {
        /* ignore */
      }
    }
  };

  if (listen.kind === 'unix') {
    await new Promise<void>((resolve) => {
      server.listen(listen.path, () => resolve());
    });
    return { port: 0, address: listen.path, stop: stopFn };
  }

  // TCP mode
  const host = listen.host ?? '127.0.0.1';
  const port = listen.port ?? 0;
  const assignedPort = await new Promise<number>((resolve) => {
    server.listen(port, host, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  return { port: assignedPort, address: assignedPort, stop: stopFn };
}
