import {
  type AgentContext,
  type HookBus,
  isRejection,
  makeAgentContext,
  PluginError,
} from '@ax/core';
import type { discover, ensureClient, buildAuthorization, redeemCode } from './oauth-flow.js';
import { isOwnClientSecretRef } from './client-secret-ref.js';
import { NeedsReconnectError } from './resolver.js';
import { discoverOAuthHosts, metadataUrl } from './host-discovery.js';
import { DEFAULT_CLIENT_NAME } from './client-name.js';
import type { McpOAuthStore } from './store.js';
import {
  clientKeyOf,
  encodeTokenBlob,
  type McpOAuthTokenBlob,
  type OAuthClientCredentials,
  type PendingAuthorization,
} from './types.js';

// ---------------------------------------------------------------------------
// The OAuth begin/callback HTTP routes — the security lynchpin of the MCP-OAuth
// flow. These must hold or a token can be bound to the wrong agent / a CSRF'd
// victim / a client that can't refresh it:
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
//   4. The token is bound to the OAuth client it was ISSUED to. `begin` records
//      the client it started the authorization with on the pending row; `callback`
//      redeems the code as that client and writes it into the token blob, so the
//      resolver later refreshes as the same client. (`begin` re-registers a
//      dynamic client every time, so "the client for this connector" is not a
//      stable thing to look up later — only the token's own client is.)
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
/**
 * TASK-711 — @ax/credentials' agent-scope read gate for `account:` refs,
 * provided by @ax/connectors. Named here, not imported (I2).
 */
const AUTHORIZE_AGENT_ACCOUNT_HOOK = 'credentials:authorize-agent:account';
/**
 * TASK-813 — @ax/agents' "may this actor choose the shared credential on this
 * agent?" (a team admin of a team agent; no workspace-admin bypass). Named
 * here, not imported (I2).
 */
const CAN_SET_SHARED_CREDENTIAL_HOOK = 'agents:can-set-shared-credential';

export interface McpOAuthRouteConfig {
  /** Public origin we serve under; the OAuth redirect_uri is derived from it. */
  publicOrigin: string;
  /** Where the callback redirects the browser back to on success/error. */
  connectorReturnPath: string;
}

export interface McpOAuthRouteDeps {
  bus: {
    call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O>;
    /** Optional so narrow test buses keep compiling; absent = no optional hooks. */
    hasService?(hook: string): boolean;
  };
  store: McpOAuthStore;
  flow: {
    discoverHosts?: typeof discoverOAuthHosts;
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
   * The client name AX presents to authorization servers (CIMD document and
   * DCR registration). Already sanitized; never throws. Defaults to "AX".
   */
  clientName?: () => Promise<string>;
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
  clientRegistration?: 'auto' | 'cimd' | 'dcr' | 'custom';
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

/**
 * What a failed `begin` tells the browser (TASK-783). A FIXED sentence, never
 * the error's message: discovery / registration / authorize-URL failures come
 * from the SDK and the authorization server, whose text is provider-authored
 * (an RFC 6749 `error_description`, a metadata document's fields) and was
 * shown to the person verbatim. The operator's detail is the warn line's
 * name/code (`errFields`).
 */
const BEGIN_FAILED_MESSAGE =
  "Couldn't start sign-in with this service. Try again in a moment. If it keeps happening, ask an admin to check the connector's address.";

export function createMcpOAuthRouteHandlers(deps: McpOAuthRouteDeps): {
  discoverHosts(req: RouteRequest, res: RouteResponse): Promise<void>;
  begin(req: RouteRequest, res: RouteResponse): Promise<void>;
  callback(req: RouteRequest, res: RouteResponse): Promise<void>;
  status(req: RouteRequest, res: RouteResponse): Promise<void>;
  clientMetadata(req: RouteRequest, res: RouteResponse): Promise<void>;
} {
  const { bus, store, flow, config, genState, now, pendingTtlMs } = deps;
  const clientName = deps.clientName ?? (async () => DEFAULT_CLIENT_NAME);
  const redirectUri = `${config.publicOrigin}/api/connectors/oauth/callback`;
  const clientMetadataUrl = `${config.publicOrigin}/api/connectors/oauth/client-metadata`;

  // A neutral ctx for the auth probe; the per-user hooks (`connectors:get`,
  // `agents:resolve`, `credentials:*`) key on the explicit `userId` in their
  // INPUT, so we hand them a userId-bearing ctx too for good measure but rely
  // on the input field as the contract.
  //
  // NOT a real agent: `'@ax/mcp-oauth'` fails the vault's `ownerId` grammar (the
  // `/`), so a `credentials:get` from `begin` that misses the user scope THROWS at
  // the agent-scope step instead of walking on to global scope or the env fallback
  // (for an `account:` ref the vault now asks `credentials:authorize-agent:account`
  // first, TASK-711, and a denial skips the step instead of throwing).
  // That is an accident of the name, not a control, and nothing may rely on it:
  // `begin` bounds what it may ask the vault for with `isOwnClientSecretRef`.
  function ctxFor(userId: string): AgentContext {
    return makeAgentContext({ sessionId: 'mcp-oauth', agentId: '@ax/mcp-oauth', userId });
  }

  /**
   * TASK-711 — see the call in `begin`. Fails closed to "store on the signer".
   *
   * TASK-788 — asks with `purpose: 'store'`: the shared-definition question
   * only, NOT "is the connector attached to this agent?". The Add-connector
   * flow signs in before it attaches, so requiring the attachment here would
   * store every such team sign-in on the signer. Reading the token back (the
   * vault's question, no `purpose`) still requires the attachment.
   */
  async function mayStoreOnAgent(userId: string, agentId: string, connectorId: string): Promise<boolean> {
    if (bus.hasService?.(AUTHORIZE_AGENT_ACCOUNT_HOOK) !== true) return false;
    try {
      const out = await bus.call<
        { userId: string; agentId: string; ref: string; purpose: 'store' },
        { allowed: boolean }
      >(AUTHORIZE_AGENT_ACCOUNT_HOOK, ctxFor(userId), {
        userId,
        agentId,
        ref: `account:${connectorId}`,
        purpose: 'store',
      });
      return out.allowed === true;
    } catch (err) {
      logger.warn('mcp_oauth_agent_scope_check_failed', { connectorId, ...errFields(err) });
      return false;
    }
  }
  /**
   * TASK-798 / TASK-813 — may this user sign in ON a team agent? The sign-in
   * stored on a team agent is the account every member's runs act as, so
   * choosing it is the team's admins' call. @ax/agents owns the answer; there
   * is NO workspace-admin shortcut here (the real `isAdmin` is passed and the
   * hook ignores it). Fails closed: no provider, `allowed` not exactly `true`,
   * or a refusal from the hook is "no".
   */
  async function maySetSharedCredential(
    user: { id: string; isAdmin: boolean },
    agentId: string,
  ): Promise<boolean> {
    if (bus.hasService?.(CAN_SET_SHARED_CREDENTIAL_HOOK) !== true) return false;
    try {
      const out = await bus.call<
        { actor: { userId: string; isAdmin: boolean }; agentId: string },
        { allowed: boolean }
      >(CAN_SET_SHARED_CREDENTIAL_HOOK, ctxFor(user.id), {
        actor: { userId: user.id, isAdmin: user.isAdmin },
        agentId,
      });
      return out?.allowed === true;
    } catch (err) {
      if (isReject(err)) {
        logger.warn('mcp_oauth_shared_credential_check_refused', errFields(err));
        return false;
      }
      throw err;
    }
  }
  const initCtx = ctxFor('init');
  // Default to the initCtx logger so a real callback fault always leaves an
  // operator trace; tests inject a spy. The core Logger's error/warn signatures
  // are structurally compatible with the narrowed deps shape.
  const logger = deps.logger ?? initCtx.logger;

  // The ONLY error fields safe to log on a fault: names and stable codes, never
  // a message (TASK-713). A `PluginError`'s message is NOT safe by type: when a
  // hook handler throws a foreign error, HookBus.call wraps it as
  // `PluginError{ code:'unknown', message:"service hook '…' threw: <inner message>" }`,
  // and an MCP SDK OAuth error's inner message is the authorization server's
  // free-text `error_description` — provider-authored, and it can echo user data.
  // The wrapped error rides on `.cause`; its name and RFC 6749 wire code
  // (`errorCode`, e.g. `server_error`) are what an operator needs to tell a
  // provider outage from a vault fault, so we lift those instead.
  type ErrFields = { name: string; code?: string; causeName?: string; causeCode?: string };
  function errFields(err: unknown): ErrFields {
    const name = err instanceof Error ? err.name : 'unknown';
    const code = (err as { code?: unknown } | null)?.code;
    const out: ErrFields = { name };
    if (typeof code === 'string') out.code = code;
    const cause = (err as { cause?: unknown } | null)?.cause;
    if (cause instanceof Error) {
      out.causeName = cause.name;
      const c = cause as { code?: unknown; errorCode?: unknown };
      const causeCode = typeof c.errorCode === 'string' ? c.errorCode : c.code;
      if (typeof causeCode === 'string') out.causeCode = causeCode;
    }
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

  // Bound the draft-URL preview separately from OAuth. It can reach public
  // metadata hosts before a connector exists, but never registers a client,
  // reads the vault or stores a grant. Avoid unbounded concurrent network work.
  let activePreviews = 0;
  const previewAttempts = new Map<string, number[]>();
  async function discoverHosts(req: RouteRequest, res: RouteResponse): Promise<void> {
    const user = await requireUser(req, res);
    if (!user) return;
    if (req.body.length > 4096) {
      res.status(413).json({ error: 'body-too-large' });
      return;
    }
    let url: string;
    try {
      const body = JSON.parse(req.body.toString('utf8')) as { url?: unknown };
      if (!body || typeof body.url !== 'string') throw new Error('missing URL');
      url = metadataUrl(body.url).href;
    } catch {
      res.status(400).json({ error: 'invalid-mcp-url', message: 'Enter a public HTTPS MCP URL without embedded credentials or a fragment.' });
      return;
    }
    const cutoff = now() - 60_000;
    for (const [id, attempts] of previewAttempts) {
      const recent = attempts.filter((time) => time > cutoff);
      if (recent.length) previewAttempts.set(id, recent);
      else previewAttempts.delete(id);
    }
    const attempts = previewAttempts.get(user.id) ?? [];
    if (activePreviews >= 4 || attempts.length >= 6 || (!previewAttempts.has(user.id) && previewAttempts.size >= 512)) {
      res.header('Retry-After', '60');
      res.status(429).json({ error: 'discovery-rate-limited', message: 'Please wait a minute before checking this server again.' });
      return;
    }
    previewAttempts.set(user.id, [...attempts, now()]);
    activePreviews++;
    try {
      const result = await (flow.discoverHosts ?? discoverOAuthHosts)({ resourceUrl: url });
      res.status(200).json(result);
    } catch (err) {
      logger.warn('mcp_oauth_host_discovery_failed', { name: err instanceof Error ? err.name : 'unknown' });
      res.status(502).json({ error: 'oauth-host-discovery-failed', message: 'Could not check this server. Check the MCP URL and retry.' });
    } finally {
      activePreviews--;
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
      res.status(400).json({ error: 'connectorId is required' });
      return;
    }
    // agentId is optional: when present it must be a non-empty string.
    if (rawAgentId !== undefined && (typeof rawAgentId !== 'string' || !rawAgentId)) {
      res.status(400).json({ error: 'agentId must be a non-empty string' });
      return;
    }
    const agentId = rawAgentId as string | undefined;

    // Authz gate + credScope selection. When agentId is present, a successful
    // agents:resolve is the "may use this agent" check, and on a team agent the
    // team-admin check below (TASK-798, TASK-813) is the "may sign in for everyone"
    // one; the agent's visibility
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
      // TASK-798 — on a TEAM agent, `agents:resolve` admits every member, but
      // a sign-in started with the agent decides whose account EVERY member's
      // runs act as. So only a team admin may begin one — TASK-813: a workspace
      // admin who is not a team admin is refused too; whose account the team
      // acts as is the team's call. Anyone else is refused here, before any
      // connector read, vault read, state write or provider redirect. A
      // user-scoped sign-in (no agentId) is untouched. Fails closed: no
      // @ax/agents answer, `allowed: false` or a rejection is a 403.
      if (agent.visibility === 'team' && !(await maySetSharedCredential(user, agentId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
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

    // TASK-711 — a team agent's sign-in is stored ON the agent only for the one
    // shared connector every member sees under this id. The vault asks the same
    // `credentials:authorize-agent:account` question before it lets anyone READ
    // an agent row for an `account:` ref, so asking it here keeps the two halves
    // in step: a sign-in for anything else (this person's own private connector
    // that happens to share the id) lands on the signer instead, where only they
    // can use it. No provider, a denial or a throw all mean "the signer".
    if (credScope === 'agent' && !(await mayStoreOnAgent(user.id, pendingAgentId, connectorId))) {
      credScope = 'user';
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
    // Header slots always have independent refs. They do not change the legacy
    // OAuth token ref, so OAuth and up to four custom headers can coexist.
    if (caps.credentials.filter(c => c.kind !== 'api-key' || !c.headerName).length > 1) {
      res.status(400).json({ error: 'oauth_with_multiple_slots_unsupported' });
      return;
    }
    const slot = oauthSlots[0]!;
    // A pinned client secret is dereferenced with `credentials:get` and posted to
    // an authorization server the connector's AUTHOR picked, so the ref may name
    // only this connector's own account key (TASK-712). Refuse anything else BEFORE
    // any vault call. Since TASK-797 the dereference walks user -> global (no agent
    // step), so this check is the ONLY thing standing between an author-chosen ref
    // and a global row. Same truthiness as the dereference below (`''` = no pinned
    // secret).
    if (slot.clientSecretRef && !isOwnClientSecretRef(connectorId, slot.clientSecretRef)) {
      logger.warn('mcp_oauth_begin_client_secret_ref_rejected', { connectorId });
      res.status(400).json({ error: 'oauth_client_secret_ref_not_allowed' });
      return;
    }
    const server = caps.mcpServers.find((s) => s.name === slot.server);
    if (!server || !server.url) {
      res.status(400).json({ error: 'oauth slot references no mcpServer with a url' });
      return;
    }
    const resource = server.url;
    const allowedHosts = new Set(caps.allowedHosts);

    // Resolve a pinned client (non-DCR). DCR is the default when no clientId.
    let pinned: { clientId: string; clientSecret?: string } | undefined;
    if (slot.clientId) {
      let clientSecret: string | undefined;
      if (slot.clientSecretRef) {
        // TASK-797 — read user -> global, with NO agent step (agentId ''), the
        // same convention as the `status` probe. A client secret is stored at the
        // author's user scope, or at global for an admin's SHARED connector so
        // every signer can use it (@ax/connectors' credential-authz decides who
        // may read it there); it is never stored on an agent. With the
        // placeholder agentId the agent step ran first, and for a shared
        // connector it threw on the vault's ownerId grammar before the walk
        // reached global. The value is used only below, against the provider's
        // token endpoint, and never logged or returned.
        const secretCtx = makeAgentContext({ sessionId: 'mcp-oauth', agentId: '', userId: user.id });
        try {
          clientSecret = await bus.call<{ ref: string; userId: string }, string>(
            'credentials:get',
            secretCtx,
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
    // is an upstream/metadata problem; report a neutral 502 (a fixed sentence,
    // never the upstream's text — TASK-783) and store nothing.
    try {
      const { authServerUrl, metadata, scope: discoveredScope } = await flow.discover({
        resourceUrl: resource,
        ...(slot.authServerUrl !== undefined ? { pinnedAuthServerUrl: slot.authServerUrl } : {}),
        allowedHosts,
      });
      // Explicit connector scopes bound the grant. Otherwise use the resource's
      // advertised requirements consistently for DCR, consent and token storage.
      const scope = slot.scopes?.join(' ') || discoveredScope;

      const clientKey = clientKeyOf(connectorId, authServerUrl);
      const client = await flow.ensureClient({
        metadata,
        clientKey,
        redirectUri,
        registration: slot.clientRegistration ?? (slot.clientId ? 'custom' : 'auto'),
        clientName: await clientName(),
        ...(new URL(config.publicOrigin).protocol === 'https:' ? { clientMetadataUrl } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        allowedHosts,
      });

      // Housekeeping BEFORE the new row goes in: a pending row past the TTL can
      // never be redeemed, and it may hold a confidential client's secret in
      // plaintext — an abandoned authorization must not keep it forever. Best-
      // effort by design: a purge failure must never fail a begin.
      try {
        await store.purgeExpiredPending(now() - pendingTtlMs);
      } catch (err) {
        logger.warn('mcp_oauth_begin_purge_failed', errFields(err));
      }

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
        issuerRequired: (metadata as { authorization_response_iss_parameter_supported?: unknown })
          .authorization_response_iss_parameter_supported === true,
        clientKey,
        // The client THIS authorization was started with. The callback redeems the
        // code as it, and the token blob records it, so the token is refreshed by
        // the client it was issued to — never by whichever client a later begin
        // registered for the same connector|authServer.
        clientId: client.clientId,
        ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}),
        resource,
        scope,
        credScope,
        createdAt: now(),
      };
      await store.putPending(pending);

      res.status(200).json({ authorizationUrl });
    } catch (err) {
      // NEVER echo the error: by construction only discovery / registration /
      // URL-build ran, but their messages are SDK / authorization-server text
      // (provider-controlled). The body is a fixed sentence; the log is
      // name/code only.
      logger.warn('mcp_oauth_begin_discovery_failed', { connectorId, ...errFields(err) });
      res.status(502).json({ error: 'oauth_discovery_failed', message: BEGIN_FAILED_MESSAGE });
    }
  }

  function returnUrl(connectorId: string, outcome: 'success' | 'error'): string {
    return `${config.publicOrigin}${config.connectorReturnPath}?connector=${encodeURIComponent(connectorId)}&oauth=${outcome}`;
  }

  async function callback(req: RouteRequest, res: RouteResponse): Promise<void> {
    const user = await requireUser(req, res);
    if (!user) return;

    const providerError = req.query.error;
    const state = req.query.state;
    const code = req.query.code;
    if (!state || (!code && !providerError)) {
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
    // RFC 9207: when the provider identifies the response issuer, it must match
    // the authorization server selected at begin. Reject before burning state
    // or sending the code to a token endpoint. Providers that omit iss still
    // use the server bound to this single-use state.
    const issuer = req.query.iss;
    if ((issuer !== undefined || peeked.issuerRequired) && issuer !== peeked.authServerUrl) {
      res.status(400).json({ error: 'authorization_server_mismatch' });
      return;
    }
    // The user matches — now atomically consume (single-use + TTL gate). A null
    // here means it expired or a concurrent request already consumed it.
    const pending = await store.consumePending(state, now(), pendingTtlMs);
    if (!pending) {
      res.status(400).json({ error: 'invalid_or_expired_state' });
      return;
    }

    // A denied grant ends this authorization too. Return the trusted connector
    // id so the popup can notify its own connect widget, and discard the pending
    // verifier/client secret. A retry starts with a fresh state and PKCE pair.
    if (providerError) {
      res.redirect(returnUrl(pending.connectorId, 'error'));
      return;
    }
    if (!code) {
      res.status(400).json({ error: 'missing code or state' });
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

    // The OAuth client to redeem the code as: the one this authorization was
    // STARTED with, carried on the pending row. (Redeeming as any other client
    // makes a strict authorization server answer `invalid_grant` — RFC 6749 §4.1.3
    // binds the code to the client it was issued to.) Only a row written before
    // TASK-696 (an authorization in flight across the deploy) has no client of its
    // own; that one falls back to the shared row via its legacy `clientKey`.
    let client: OAuthClientCredentials;
    if (pending.clientId !== undefined) {
      client = { clientId: pending.clientId, clientSecret: pending.clientSecret };
    } else {
      // Legacy lookup. A throw is a DB/server fault; a null is a server-state
      // inconsistency. Both are SERVER faults → log + clean redirect (uniform with
      // the other post-state failures, per the review).
      let legacy;
      try {
        legacy = await store.getClient(pending.clientKey);
      } catch (err) {
        logger.error('mcp_oauth_callback_failed', {
          stage: 'getClient',
          connectorId: pending.connectorId,
          ...errFields(err),
        });
        res.redirect(returnUrl(pending.connectorId, 'error'));
        return;
      }
      if (!legacy) {
        logger.error('mcp_oauth_callback_failed', {
          stage: 'getClient',
          connectorId: pending.connectorId,
          reason: 'client_registration_missing',
        });
        res.redirect(returnUrl(pending.connectorId, 'error'));
        return;
      }
      client = legacy;
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
      // `clientKey` stays only as the legacy index for readers that predate the
      // per-token client; the client that redeemed this code — and so the only
      // one that may refresh it — rides on the blob itself.
      clientKey: pending.clientKey,
      clientId: client.clientId,
      ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}),
    };

    // The vault write. A throw is a SERVER/DB fault (NOT "OAuth failed") → log
    // it so the operator can tell a storage outage from a provider rejection.
    // credScope drives where the token is stored:
    //   'user'  → personal agent: stored on the user so all their agents share it.
    //   'agent' → team agent: stored on the agent so sharees each ride on it.
    const writeScope = pending.credScope; // 'user' | 'agent'
    const writeOwnerId = writeScope === 'agent' ? pending.agentId : pending.userId;
    try {
      await bus.call<
        {
          scope: 'user' | 'agent';
          ownerId: string;
          ref: string;
          kind: string;
          payload: Uint8Array;
          expiresAt?: number;
        },
        void
      >('credentials:set', ctxFor(pending.userId), {
        scope: writeScope,
        ownerId: writeOwnerId,
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

    // TASK-741 — a completed sign-in renews this access, so the rail's
    // "Sign-in expired" marker goes. TASK-756: the marker is the token OWNER's —
    // a team agent's shared sign-in clears for every member, a personal one for
    // this person only. Best-effort: the token is already stored, and a stale
    // marker only costs one unnecessary Reconnect.
    try {
      await store.clearNeedsReconnect(
        writeScope === 'agent'
          ? { kind: 'agent', agentId: pending.agentId }
          : { kind: 'user', userId: pending.userId },
        pending.connectorId,
      );
    } catch (err) {
      logger.warn('mcp_oauth_needs_reconnect_clear_failed', {
        connectorId: pending.connectorId,
        name: err instanceof Error ? err.name : 'unknown',
      });
    }

    res.redirect(returnUrl(pending.connectorId, 'success'));
  }

  async function status(req: RouteRequest, res: RouteResponse): Promise<void> {
    const user = await requireUser(req, res);
    if (!user) return;

    // @ax/http-server lowercases all query keys (RouteRequest.query contract),
    // so a browser's ?connectorId=…&agentId=… arrives as connectorid/agentid.
    // Read the lowercased keys — a camelCase read silently 400s every request.
    const connectorId = req.query.connectorid;
    if (!connectorId) {
      res.status(400).json({ error: 'connectorId is required' });
      return;
    }
    const agentId = req.query.agentid || undefined;

    // Authz gate mirrors `begin`: when agentId is present, agents:resolve IS the
    // owner/member binding check; when absent, connector ownership gates (connectors:get).
    //
    // NOTE: the agent path deliberately does NOT also run `connectors:get` (unlike
    // `begin`, which checks both). An agent-scope token belongs to the AGENT, so a
    // team sharee who can resolve the agent but does NOT own the connector must
    // still see "connected" — adding a connector-ownership check here would 404
    // them and regress the shared-credential UX. agents:resolve is the only gate.
    if (agentId !== undefined) {
      try {
        await bus.call<{ agentId: string; userId: string }, unknown>(
          'agents:resolve',
          ctxFor(user.id),
          { agentId, userId: user.id },
        );
      } catch (err) {
        if (isReject(err)) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        throw err;
      }
    } else {
      try {
        await bus.call<{ userId: string; connectorId: string }, unknown>(
          'connectors:get',
          ctxFor(user.id),
          { userId: user.id, connectorId },
        );
      } catch (err) {
        if (isReject(err)) {
          res.status(404).json({ error: 'not-found' });
          return;
        }
        throw err;
      }
    }

    // Probe the credential via the same runtime path a chat turn uses.
    // probeCtx.agentId MUST be the real agentId (when present) so credentials:get
    // walks the agent scope correctly (packages/credentials/src/plugin.ts:567).
    // When ABSENT (user-scope / Connectors-tab probe), it MUST be '' — credentials:get
    // only walks the agent scope when ctx.agentId is a non-empty string, so '' makes
    // it walk user→global only. A non-empty placeholder (e.g. a plugin name) would be
    // fed to the agent-scope lookup as an ownerId and rejected by the ownerId pattern
    // (`^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$`), 500-ing every user-scope status check.
    const ref = `account:${connectorId}`;
    const probeCtx = makeAgentContext({
      sessionId: 'mcp-oauth',
      agentId: agentId ?? '',
      userId: user.id,
    });
    try {
      await bus.call<{ ref: string; userId: string }, string>(
        'credentials:get',
        probeCtx,
        { ref, userId: user.id },
      );
      // Token value is read host-side and DISCARDED — never returned to the caller.
      res.status(200).json({ status: 'connected' });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const msg = err instanceof Error ? err.message : '';
      if (code === 'credential-not-found') {
        res.status(200).json({ status: 'not-connected' });
        return;
      }
      // The resolver throws a bare `NeedsReconnectError` when the refresh token is
      // dead, but it crosses the hook bus TWICE (resolver → credentials:get → here),
      // and HookBus.call wraps any non-PluginError into PluginError{ code:'unknown',
      // cause:<original> } (packages/core/src/hook-bus.ts). So through the real
      // credentials:get the instanceof check is on the WRAPPER's `.cause`, not the
      // thrown value; the bare-instanceof and message-substring checks cover the
      // in-package/direct path and a last-ditch fallback respectively.
      const cause = (err as { cause?: unknown }).cause;
      const isReconnect =
        err instanceof NeedsReconnectError ||
        cause instanceof NeedsReconnectError ||
        msg.includes('reconnect'); // last-ditch fallback
      if (isReconnect) {
        res.status(200).json({ status: 'needs-reconnect' });
        return;
      }
      logger.error('mcp_oauth_status_probe_failed', { connectorId, ...errFields(err) });
      res.status(500).json({ error: 'status_check_failed' });
    }
  }

  async function clientMetadata(_req: RouteRequest, res: RouteResponse): Promise<void> {
    // Public by design: authorization servers fetch this document. All URLs
    // come from the configured origin, never the request's Host header. The
    // name follows the operator's branding; a modest max-age lets a rename
    // reach authorization servers that cache the document.
    res.header('Cache-Control', 'public, max-age=3600');
    res.status(200).json({
      client_id: clientMetadataUrl,
      client_name: await clientName(),
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }
  return { discoverHosts, begin, callback, status, clientMetadata };
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
    { method: 'GET', path: '/api/connectors/oauth/client-metadata', handler: handlers.clientMetadata },
    { method: 'POST', path: '/api/connectors/oauth/discover-hosts', handler: handlers.discoverHosts },
    { method: 'POST', path: '/api/connectors/oauth/begin', handler: handlers.begin },
    { method: 'GET', path: '/api/connectors/oauth/callback', handler: handlers.callback },
    { method: 'GET', path: '/api/connectors/oauth/status', handler: handlers.status },
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
