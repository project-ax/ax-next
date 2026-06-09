import {
  type AgentContext,
  type HookBus,
  isRejection,
  makeAgentContext,
  PluginError,
} from '@ax/core';
import type { discover, ensureClient, buildAuthorization, redeemCode } from './oauth-flow.js';
import type { McpOAuthStore } from './store.js';
import {
  clientKeyOf,
  encodeTokenBlob,
  type McpOAuthTokenBlob,
  type PendingAuthorization,
} from './types.js';

// ---------------------------------------------------------------------------
// The OAuth begin/callback HTTP routes — the security lynchpin of the MCP-OAuth
// flow. Three things must hold or a token can be bound to the wrong agent / a
// CSRF'd victim:
//
//   1. CSRF binding. `state` is server-generated, single-use, TTL'd, and bound
//      to the initiating user at `begin`. `callback` re-checks `pending.userId`
//      against the authenticated session user before storing anything.
//   2. Agent-ownership authz. Binding a token to an agent is gated by
//      `agents:resolve`, whose ACL only resolves a personal agent for its owner
//      and a team agent for members — a successful resolve IS the authorization.
//   3. The vault write only happens after 1+2 pass, with `scope: 'agent'` and a
//      ref keyed by the connector id.
//
// We NEVER log the authorization code, tokens, code_verifier, or client secret.
// Error responses carry only neutral codes (and, for discovery, an error
// message that is a host/url — never a credential).
//
// Duck-typed request/response (invariant #2: no @ax/http-server import; mirrors
// its HttpRequest / HttpResponse — plus `redirect`, which `callback` uses).
// ---------------------------------------------------------------------------

export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  header(name: string, value: string): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  redirect(url: string, status?: number): void;
  end(): void;
}

/** 64 KiB request-body cap — mirrors @ax/connectors `ADMIN_BODY_MAX_BYTES`. */
const OAUTH_BODY_MAX_BYTES = 64 * 1024;

export interface McpOAuthRouteConfig {
  /** Public origin we serve under; the OAuth redirect_uri is derived from it. */
  publicOrigin: string;
  /** Where the callback redirects the browser back to on success/error. */
  connectorReturnPath: string;
}

export interface McpOAuthRouteDeps {
  bus: { call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O> };
  store: McpOAuthStore;
  flow: {
    discover: typeof discover;
    ensureClient: typeof ensureClient;
    buildAuthorization: typeof buildAuthorization;
    redeemCode: typeof redeemCode;
  };
  config: McpOAuthRouteConfig;
  /** `crypto.randomBytes(32).toString('hex')` in prod; deterministic in tests. */
  genState: () => string;
  now: () => number;
  /** Pending-authorization TTL (~10 minutes). */
  pendingTtlMs: number;
  /**
   * Operator-facing structured logger for callback/begin faults. Defaults to
   * the `initCtx.logger` we build below; tests inject a spy. We log only NEUTRAL
   * fields (stage/connectorId/error name/PluginError code) — NEVER a token,
   * authorization code, code_verifier, client secret, or a raw provider error
   * body (see the redeem path: name only).
   */
  logger?: { error(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

// --- connector shapes (type-only re-declaration; invariant #2). We read only
// the fields we need off `connectors:get`, treating the rest as opaque. ------

interface OAuthSlot {
  slot: string;
  kind: 'oauth';
  server: string;
  scopes?: string[];
  clientId?: string;
  clientSecretRef?: string;
  authServerUrl?: string;
  tokenUrl?: string;
}

interface ConnectorView {
  capabilities: {
    allowedHosts: string[];
    credentials: Array<{ kind: string; [k: string]: unknown }>;
    mcpServers: Array<{ name: string; url?: string; [k: string]: unknown }>;
  };
}

/** Is this thrown value an authz/not-found rejection (vs a real bug)? */
function isReject(err: unknown): boolean {
  return err instanceof PluginError || isRejection(err);
}

function neutralMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createMcpOAuthRouteHandlers(deps: McpOAuthRouteDeps): {
  begin(req: RouteRequest, res: RouteResponse): Promise<void>;
  callback(req: RouteRequest, res: RouteResponse): Promise<void>;
} {
  const { bus, store, flow, config, genState, now, pendingTtlMs } = deps;
  const redirectUri = `${config.publicOrigin}/api/connectors/oauth/callback`;

  // A neutral ctx for the auth probe; the per-user hooks (`connectors:get`,
  // `agents:resolve`, `credentials:*`) key on the explicit `userId` in their
  // INPUT, so we hand them a userId-bearing ctx too for good measure but rely
  // on the input field as the contract.
  function ctxFor(userId: string): AgentContext {
    return makeAgentContext({ sessionId: 'mcp-oauth', agentId: '@ax/mcp-oauth', userId });
  }
  const initCtx = ctxFor('init');
  // Default to the initCtx logger so a real callback fault always leaves an
  // operator trace; tests inject a spy. The core Logger's error/warn signatures
  // are structurally compatible with the narrowed deps shape.
  const logger = deps.logger ?? initCtx.logger;

  // The ONLY error fields safe to log on a fault. A `PluginError`'s message is
  // author-facing and carries no secret, so we include it; everything else is
  // reduced to name (and a `code` if the caught value happens to carry one).
  function errFields(err: unknown): { name: string; code?: string; message?: string } {
    const name = err instanceof Error ? err.name : 'unknown';
    const code = (err as { code?: unknown })?.code;
    const out: { name: string; code?: string; message?: string } = { name };
    if (typeof code === 'string') out.code = code;
    if (err instanceof PluginError) out.message = err.message;
    return out;
  }

  async function requireUser(
    req: RouteRequest,
    res: RouteResponse,
  ): Promise<{ id: string; isAdmin: boolean } | null> {
    try {
      const { user } = await bus.call<
        { req: RouteRequest },
        { user: { id: string; isAdmin: boolean } }
      >('auth:require-user', initCtx, { req });
      return user;
    } catch (err) {
      if (isReject(err)) {
        res.status(401).json({ error: 'unauthenticated' });
        return null;
      }
      throw err;
    }
  }

  async function begin(req: RouteRequest, res: RouteResponse): Promise<void> {
    const user = await requireUser(req, res);
    if (!user) return;

    // Parse + validate the body (small cap; connectorId required, agentId optional).
    if (req.body.length > OAUTH_BODY_MAX_BYTES) {
      res.status(413).json({ error: 'body-too-large' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body.toString('utf8') || '{}');
    } catch {
      res.status(400).json({ error: 'invalid-json' });
      return;
    }
    const body = parsed as { connectorId?: unknown; agentId?: unknown };
    const connectorId = body.connectorId;
    const rawAgentId = body.agentId;
    if (typeof connectorId !== 'string' || !connectorId) {
      res.status(400).json({ error: 'connectorId and agentId are required' });
      return;
    }
    // agentId is optional: when present it must be a non-empty string.
    if (rawAgentId !== undefined && (typeof rawAgentId !== 'string' || !rawAgentId)) {
      res.status(400).json({ error: 'connectorId and agentId are required' });
      return;
    }
    const agentId = rawAgentId as string | undefined;

    // Authz gate + credScope selection. When agentId is present, a successful
    // agents:resolve IS the owner/member binding check; the agent's visibility
    // determines which scope the token is stored under. When absent, the flow is
    // user-scoped and gated only by connector ownership (connectors:get below).
    let credScope: 'user' | 'agent' = 'user';
    let pendingAgentId = '';
    if (agentId !== undefined) {
      let agent: { visibility: 'personal' | 'team'; ownerId: string };
      try {
        const out = await bus.call<
          { agentId: string; userId: string },
          { agent: { visibility: 'personal' | 'team'; ownerId: string } }
        >('agents:resolve', ctxFor(user.id), { agentId, userId: user.id });
        agent = out.agent;
      } catch (err) {
        if (isReject(err)) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        throw err;
      }
      credScope = agent.visibility === 'team' ? 'agent' : 'user';
      pendingAgentId = agentId;
    }

    // Resolve the connector (owner-scoped by userId).
    let connector: ConnectorView;
    try {
      const out = await bus.call<
        { userId: string; connectorId: string },
        { connector: ConnectorView }
      >('connectors:get', ctxFor(user.id), { userId: user.id, connectorId });
      connector = out.connector;
    } catch (err) {
      if (isReject(err)) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      throw err;
    }

    const caps = connector.capabilities;
    const oauthSlots = caps.credentials.filter((c) => c.kind === 'oauth') as unknown as OAuthSlot[];
    if (oauthSlots.length === 0) {
      res.status(400).json({ error: 'connector has no oauth credential slot' });
      return;
    }
    if (oauthSlots.length > 1) {
      // The per-connector vault ref is `account:<connectorId>` — it can only
      // hold ONE token. A 2nd oauth slot would silently be dead, so reject
      // rather than bind one slot's token and leave the other broken.
      res.status(400).json({ error: 'multiple_oauth_slots_unsupported' });
      return;
    }
    if (caps.credentials.length > 1) {
      // ONE SOURCE OF TRUTH (invariant #4): the callback always writes the
      // COLLAPSED ref `account:<connectorId>`, but `foldConnectorCaps` /
      // `deriveCredentialPlan` switch to the PER-SLOT ref
      // `account:<connectorId>:<slot>` the moment a connector carries ≥2 total
      // credential slots. So a connector with one oauth slot PLUS any other slot
      // would store the token at a ref the orchestrator never resolves → silent
      // no-credential. Until the callback learns the per-slot ref shape, reject a
      // multi-slot connector that includes an oauth slot (no discovery yet).
      res.status(400).json({ error: 'oauth_with_multiple_slots_unsupported' });
      return;
    }
    const slot = oauthSlots[0]!;
    const server = caps.mcpServers.find((s) => s.name === slot.server);
    if (!server || !server.url) {
      res.status(400).json({ error: 'oauth slot references no mcpServer with a url' });
      return;
    }
    const resource = server.url;
    const allowedHosts = new Set(caps.allowedHosts);
    const scope = slot.scopes?.join(' ');

    // Resolve a pinned client (non-DCR). DCR is the default when no clientId.
    let pinned: { clientId: string; clientSecret?: string } | undefined;
    if (slot.clientId) {
      let clientSecret: string | undefined;
      if (slot.clientSecretRef) {
        try {
          clientSecret = await bus.call<{ ref: string; userId: string }, string>(
            'credentials:get',
            ctxFor(user.id),
            { ref: slot.clientSecretRef, userId: user.id },
          );
        } catch (err) {
          // A missing/forbidden clientSecretRef is a connector-config problem,
          // not a server fault — report a neutral 400 (no secret in the error).
          logger.warn('mcp_oauth_begin_client_secret_unavailable', {
            connectorId,
            ...errFields(err),
          });
          res.status(400).json({ error: 'oauth_client_secret_unavailable' });
          return;
        }
      }
      pinned = { clientId: slot.clientId, ...(clientSecret !== undefined ? { clientSecret } : {}) };
    }

    // Discovery → client registration → authorize-URL build. Any failure here
    // is an upstream/metadata problem; report a neutral 502 (message is a
    // host/url, never a secret) and store nothing.
    try {
      const { authServerUrl, metadata } = await flow.discover({
        resourceUrl: resource,
        ...(slot.authServerUrl !== undefined ? { pinnedAuthServerUrl: slot.authServerUrl } : {}),
        allowedHosts,
      });

      const clientKey = clientKeyOf(connectorId, authServerUrl);
      const client = await flow.ensureClient({
        metadata,
        clientKey,
        redirectUri,
        ...(scope !== undefined ? { scope } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        allowedHosts,
      });
      await store.putClient(client);

      const state = genState();
      const { authorizationUrl, codeVerifier } = await flow.buildAuthorization({
        metadata,
        client,
        redirectUri,
        resource,
        ...(scope !== undefined ? { scope } : {}),
        state,
        allowedHosts,
      });

      const pending: PendingAuthorization = {
        state,
        userId: user.id,
        agentId: pendingAgentId,
        connectorId,
        slot: slot.slot,
        codeVerifier,
        authServerUrl,
        clientKey,
        resource,
        scope,
        credScope,
        createdAt: now(),
      };
      await store.putPending(pending);

      res.status(200).json({ authorizationUrl });
    } catch (err) {
      // NEVER include code/secret/token here — by construction only discovery /
      // registration / URL-build ran, none of which we hold secrets for; the
      // message is a host/url from the SSRF guard or SDK.
      logger.warn('mcp_oauth_begin_discovery_failed', { connectorId, ...errFields(err) });
      res.status(502).json({ error: 'oauth_discovery_failed', message: neutralMessage(err) });
    }
  }

  function returnUrl(connectorId: string, outcome: 'success' | 'error'): string {
    return `${config.publicOrigin}${config.connectorReturnPath}?connector=${encodeURIComponent(connectorId)}&oauth=${outcome}`;
  }

  async function callback(req: RouteRequest, res: RouteResponse): Promise<void> {
    const user = await requireUser(req, res);
    if (!user) return;

    // Provider-side denial (e.g. user clicked "Deny"). We don't yet have a
    // trusted return target keyed off state, but the provider only ever
    // redirects back here for a state we minted, so reflect the connector if we
    // can recover it from the (still-present) pending row WITHOUT consuming it?
    // No — keep it simple and safe: redirect to the generic return path with
    // oauth=error. We do NOT consume the pending row (the user may retry).
    const providerError = req.query.error;
    if (providerError) {
      res.redirect(`${config.publicOrigin}${config.connectorReturnPath}?oauth=error`);
      return;
    }

    const state = req.query.state;
    const code = req.query.code;
    if (!state || !code) {
      res.status(400).json({ error: 'missing code or state' });
      return;
    }

    // Peek-then-consume (anti-DoS): a read-only `getPending` first, so the CSRF
    // user-binding is checked BEFORE the single-use row is burned. A third party
    // who learns a victim's in-flight `state` would otherwise be able to cancel
    // the victim's flow just by hitting the callback. A null peek means
    // unknown/expired/replayed — no trusted return target, so 400 (no redirect).
    const peeked = await store.getPending(state);
    if (!peeked) {
      res.status(400).json({ error: 'invalid_or_expired_state' });
      return;
    }
    // CSRF binding: the session user MUST be the user who began this flow. We
    // reject WITHOUT consuming, so a cross-user hit can't burn the victim's row.
    if (peeked.userId !== user.id) {
      res.status(403).json({ error: 'state_user_mismatch' });
      return;
    }
    // The user matches — now atomically consume (single-use + TTL gate). A null
    // here means it expired or a concurrent request already consumed it.
    const pending = await store.consumePending(state, now(), pendingTtlMs);
    if (!pending) {
      res.status(400).json({ error: 'invalid_or_expired_state' });
      return;
    }

    // Re-fetch the connector to re-derive allowedHosts for the redeem hop
    // (guards discovery/redeem against a connector that changed/vanished).
    let connector: ConnectorView;
    try {
      const out = await bus.call<
        { userId: string; connectorId: string },
        { connector: ConnectorView }
      >('connectors:get', ctxFor(pending.userId), {
        userId: pending.userId,
        connectorId: pending.connectorId,
      });
      connector = out.connector;
    } catch (err) {
      if (isReject(err)) {
        res.status(404).json({ error: 'not-found' });
        return;
      }
      // A non-reject connectors:get failure is a SERVER fault, not "OAuth
      // failed" — log it (neutral fields) so an operator has a trace, then give
      // the browser the same clean oauth=error redirect.
      logger.error('mcp_oauth_callback_failed', {
        stage: 'connector',
        connectorId: pending.connectorId,
        ...errFields(err),
      });
      res.redirect(returnUrl(pending.connectorId, 'error'));
      return;
    }
    const allowedHosts = new Set(connector.capabilities.allowedHosts);

    // Client-registration lookup. A throw is a DB/server fault; a null is a
    // server-state inconsistency. Both are SERVER faults → log + clean redirect
    // (uniform with the other post-state failures, per the review).
    let client;
    try {
      client = await store.getClient(pending.clientKey);
    } catch (err) {
      logger.error('mcp_oauth_callback_failed', {
        stage: 'getClient',
        connectorId: pending.connectorId,
        ...errFields(err),
      });
      res.redirect(returnUrl(pending.connectorId, 'error'));
      return;
    }
    if (!client) {
      logger.error('mcp_oauth_callback_failed', {
        stage: 'getClient',
        connectorId: pending.connectorId,
        reason: 'client_registration_missing',
      });
      res.redirect(returnUrl(pending.connectorId, 'error'));
      return;
    }

    // Discovery is a server-side metadata fetch; a failure here is a server/
    // upstream fault → logger.error (neutral fields), clean redirect.
    let metadata;
    try {
      ({ metadata } = await flow.discover({
        resourceUrl: pending.resource,
        pinnedAuthServerUrl: pending.authServerUrl,
        allowedHosts,
      }));
    } catch (err) {
      logger.error('mcp_oauth_callback_failed', {
        stage: 'discover',
        connectorId: pending.connectorId,
        ...errFields(err),
      });
      res.redirect(returnUrl(pending.connectorId, 'error'));
      return;
    }

    // Token redemption — the hop most likely to be a PROVIDER rejection of the
    // code (warn, not error). NEVER log err.message or code here: an SDK token-
    // exchange error can echo the provider's response body, which may contain
    // sensitive detail. Name only.
    let tokens;
    try {
      tokens = await flow.redeemCode({
        metadata,
        client,
        code,
        codeVerifier: pending.codeVerifier,
        redirectUri,
        resource: pending.resource,
        allowedHosts,
      });
    } catch (err) {
      logger.warn('mcp_oauth_redeem_failed', {
        connectorId: pending.connectorId,
        name: err instanceof Error ? err.name : 'unknown',
      });
      res.redirect(returnUrl(pending.connectorId, 'error'));
      return;
    }

    const blob: McpOAuthTokenBlob = {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      tokenType: tokens.token_type ?? 'Bearer',
      ...(tokens.expires_in !== undefined ? { expiresAt: now() + tokens.expires_in * 1000 } : {}),
      ...(tokens.scope
        ? { scope: tokens.scope }
        : pending.scope
          ? { scope: pending.scope }
          : {}),
      resource: pending.resource,
      authServerUrl: pending.authServerUrl,
      tokenEndpoint: metadata.token_endpoint,
      clientKey: pending.clientKey,
    };

    // The vault write. A throw is a SERVER/DB fault (NOT "OAuth failed") → log
    // it so the operator can tell a storage outage from a provider rejection.
    try {
      await bus.call<
        {
          scope: 'agent';
          ownerId: string;
          ref: string;
          kind: string;
          payload: Uint8Array;
          expiresAt?: number;
        },
        void
      >('credentials:set', ctxFor(pending.userId), {
        scope: 'agent',
        ownerId: pending.agentId,
        ref: `account:${pending.connectorId}`,
        kind: 'mcp-oauth',
        payload: encodeTokenBlob(blob),
        ...(blob.expiresAt !== undefined ? { expiresAt: blob.expiresAt } : {}),
      });
    } catch (err) {
      logger.error('mcp_oauth_callback_failed', {
        stage: 'store',
        connectorId: pending.connectorId,
        ...errFields(err),
      });
      res.redirect(returnUrl(pending.connectorId, 'error'));
      return;
    }

    res.redirect(returnUrl(pending.connectorId, 'success'));
  }

  return { begin, callback };
}

/**
 * Register the begin (POST) + callback (GET) routes against @ax/http-server via
 * the `http:register-route` hook. Returns the unregister callbacks (the plugin
 * tracks them and calls them on shutdown so a re-init doesn't trip
 * duplicate-route).
 */
export async function registerMcpOAuthRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  deps: McpOAuthRouteDeps,
): Promise<Array<() => void>> {
  const handlers = createMcpOAuthRouteHandlers(deps);
  const routes: Array<{
    method: 'GET' | 'POST';
    path: string;
    handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  }> = [
    { method: 'POST', path: '/api/connectors/oauth/begin', handler: handlers.begin },
    { method: 'GET', path: '/api/connectors/oauth/callback', handler: handlers.callback },
  ];
  const unregisters: Array<() => void> = [];
  for (const route of routes) {
    const result = await bus.call<unknown, { unregister: () => void }>(
      'http:register-route',
      initCtx,
      route,
    );
    unregisters.push(result.unregister);
  }
  return unregisters;
}
