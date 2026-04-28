/**
 * HTTP forward proxy listener for sandboxed agents.
 *
 * Ported from v1 ~/dev/ai/ax/src/host/web-proxy.ts (lines 158-349 +
 * server-setup at 622-655). The HTTP forwarding path lives here; the
 * CONNECT handler is the raw-tunnel (bypass) path — Task 8 will add
 * the MITM TLS inspection path alongside it.
 *
 * Cuts from v1:
 * - `urlRewrites` block dropped — out of scope for v2.
 * - `onApprove` callback dropped — the per-session allowlist is the
 *   only egress gate (I2 from the Phase 1a plan).
 * - `domainDecisions` cache dropped — only ever cached `onApprove`
 *   results, which no longer exist.
 * - Canary-on-HTTP-body skipped — defer to MITM in Task 8 (HTTP
 *   forwarding is rare for LLM/MCP traffic and lives outside the
 *   credential-injection path anyway).
 * - `onAudit` kept as a no-op stub on options — Task 11 wires it to
 *   `bus.fire('event.http-egress', ...)`.
 *
 * Security:
 * - `resolveAndCheck` is called with the request's hostname; the
 *   returned IP is then used for the actual upstream connection so a
 *   second DNS resolution can't return a different (private) IP. See
 *   the SECURITY docstring on `resolveAndCheck`.
 * - Allowlist check: a host is allowed iff at least one registered
 *   session's `allowlist` contains it. Phase 1a passes `sessions`
 *   directly; Task 9 swaps to a per-process map keyed by sessionId.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import * as net from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolveAndCheck, BlockedIPError, type Resolver } from './private-ip.js';
import type { SharedCredentialRegistry } from './registry.js';

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
   * as a raw TLS tunnel. For Task 7 there is no MITM, so this field is
   * unused at runtime — every CONNECT is already a raw tunnel. Task 8
   * makes MITM the default for HTTPS, and `bypassMITM` becomes the per-
   * session opt-out for cert-pinning hosts (e.g. some CLIs that ship a
   * pinned trust store).
   */
  bypassMITM?: Set<string>;
}

/** Audit entry shape — placeholder until Task 11 finalizes the hook payload. */
export interface ProxyAuditEntry {
  action: 'proxy_request';
  method: string;
  url: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  blocked?: string;
}

export interface ProxyListenerOptions {
  /** Where to listen. TCP on a host:port, or a Unix socket path. */
  listen: { kind: 'tcp'; host?: string; port?: number } | { kind: 'unix'; path: string };
  /** Shared credential registry — touched on the MITM path (Task 8). */
  registry: SharedCredentialRegistry;
  /** Per-session configs. Phase 1a: passed in; Task 9: per-process map. */
  sessions: Map<string, SessionConfig>;
  /** Optional audit sink — defaults to no-op. Task 11 wires bus.fire. */
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

// ── Listener ─────────────────────────────────────────────────────────

export async function startProxyListener(opts: ProxyListenerOptions): Promise<ProxyListener> {
  const { listen, sessions, onAudit, resolver } = opts;
  const activeSockets = new Set<net.Socket>();

  function audit(entry: ProxyAuditEntry): void {
    onAudit?.(entry);
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

      audit({
        action: 'proxy_request',
        method,
        url,
        status: response.status,
        requestBytes,
        responseBytes,
        durationMs: Date.now() - startTime,
      });
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

      audit({
        action: 'proxy_request',
        method,
        url,
        status,
        requestBytes,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked: isBlocked ? message : undefined,
      });
    }
  }

  // ── HTTPS CONNECT — raw TCP tunnel (bypass mode) ──
  //
  // Ported from v1 ~/dev/ai/ax/src/host/web-proxy.ts:353-493 (the non-MITM
  // path at lines 428-471 specifically). Cuts vs. v1:
  //  - urlRewrites block dropped (out of scope for v2).
  //  - onApprove dropped — per-session allowlist is the only egress gate.
  //  - sessionId field on audit entries dropped — Task 11 finalizes the hook
  //    payload shape.
  //
  // For Task 7, ALL CONNECTs flow through this raw-tunnel path. Task 8 will
  // add a `shouldMitm` branch above the `net.connect` call: if the hostname
  // is NOT in any session's `bypassMITM`, traffic is intercepted with a
  // dynamically-minted domain cert and decrypted in-process for credential
  // injection / canary scanning. Hosts in `bypassMITM` continue to fall
  // through to the raw tunnel below.

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

      // Open the raw TCP tunnel against the resolved IP.
      const targetSocket = net.connect(port, resolvedIP, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        activeSockets.add(targetSocket);

        // Pipe bidirectionally — neither side's bytes are inspected here.
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);

        // Flush any bytes the client sent before the upstream opened.
        if (head.length > 0) {
          targetSocket.write(head);
        }

        // Byte counters for the audit entry.
        targetSocket.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
        });
        clientSocket.on('data', (chunk: Buffer) => {
          requestBytes += chunk.length;
        });
      });

      // Cleanup once — first close/error wins, downstream events become no-ops.
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        activeSockets.delete(targetSocket);
        targetSocket.destroy();
        clientSocket.destroy();

        audit({
          action: 'proxy_request',
          method: 'CONNECT',
          url: target,
          status: 200,
          requestBytes,
          responseBytes,
          durationMs: Date.now() - startTime,
        });
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
      const blocked = isBlocked ? (err as BlockedIPError).message : undefined;

      clientSocket.write(
        `HTTP/1.1 ${status} ${isBlocked ? 'Forbidden' : 'Bad Gateway'}\r\n\r\n`,
      );
      clientSocket.end();

      audit({
        action: 'proxy_request',
        method: 'CONNECT',
        url: target,
        status,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked,
      });
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
