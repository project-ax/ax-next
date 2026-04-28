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
}

export interface ProxyListener {
  /** TCP port (0 when listening on a Unix socket). */
  port: number;
  /** Full address — TCP port number or Unix socket path string. */
  address: string | number;
  stop(): void;
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

// ── Listener ─────────────────────────────────────────────────────────

export async function startProxyListener(opts: ProxyListenerOptions): Promise<ProxyListener> {
  const { listen, sessions, onAudit, resolver, registry, ca } = opts;
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
        // No matching session → no sessionId/userId/classification to stamp.
        // The audit just carries the block reason; the plugin's onAudit will
        // emit the bus event with `blockedReason: 'allowlist'` and the
        // session-attribution fields left empty.
        audit({
          action: 'proxy_request',
          method,
          url,
          status: 403,
          requestBytes: 0,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: `domain_denied: ${hostname}`,
        });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(
          `Domain ${hostname} is not in any session allowlist. Install a skill that declares this domain, or ask an admin to approve it.`,
        );
        return;
      }

      // SSRF block (I3): resolve and verify against private CIDRs.
      // Use the returned IP for the upstream connection — DO NOT re-resolve
      // (DNS rebinding defense). See SECURITY note on resolveAndCheck.
      const resolvedIP = await resolveAndCheck(hostname, allowingSession.allowedIPs, resolver);

      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
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
        body: body.length > 0 ? body : undefined,
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

    // client → (canary scan, then credential substitute) → upstream
    clientTls.on('data', (chunk: Buffer) => {
      requestBytes += chunk.length;

      // Canary scan first — substitution doesn't affect canary detection,
      // but checking before substitution means we see the bytes the model
      // actually wrote (the placeholder→real swap is on the credential
      // bytes, not on canaries).
      for (const token of canaryTokens) {
        if (chunk.includes(token)) {
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
          return;
        }
      }

      const replaced = registry.replaceAllBuffer(chunk);
      if (replaced !== chunk) credentialInjected = true;
      targetTls.write(replaced);
    });

    // upstream → client (no substitution on response — placeholders should
    // never originate upstream).
    targetTls.on('data', (chunk: Buffer) => {
      responseBytes += chunk.length;
      clientTls.write(chunk);
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
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.end();
        // No matching session — same shape as the HTTP allowlist-miss case.
        audit({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 403,
          requestBytes: 0,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: `domain_denied: ${hostname}`,
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
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  // Clean up stale Unix socket
  if (listen.kind === 'unix' && existsSync(listen.path)) {
    unlinkSync(listen.path);
  }

  const stopFn = () => {
    for (const s of activeSockets) s.destroy();
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
