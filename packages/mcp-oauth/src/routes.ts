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
//      and a team agent for members — a successful resolve IS the authorization
//      (plus, on a team agent, the team-admin check). `callback` asks both again
//      before it writes anything: the agent may be gone, or the signer demoted.
//   3. The vault write only happens after 1+2 pass, with `scope: 'agent'` and a
//      ref keyed by the connector id. An Add then attaches the connector; if the
//      attach fails the token is deleted again (all or nothing).
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

/**
 * @ax/agents' attach — a type-only mirror of its `AttachConnectorInput` /
 * `AttachConnectorOutput` (invariant #2: no @ax/agents import). An Add's
 * callback attaches the connector once its sign-in is stored. We read nothing
 * off the output: returning at all is the success.
 */
interface AttachConnectorInput {
  actor: { userId: string; isAdmin: boolean };
  agentId: string;
  connectorId: string;
}
interface AttachConnectorOutput {
  agent: unknown;
  changed: boolean;
}

/**
 * Why a callback did not complete, as the popup learns it (`&reason=`). A FIXED
 * set: the popup maps each value to its own copy, so no provider text (an
 * `error_description`, a token-endpoint body) ever reaches the person.
 *   cancelled      — the provider answered `error=access_denied`.
 *   not-allowed    — the agent gate said no on the re-check (the agent is gone,
 *                    or the signer is no longer allowed to sign in for it).
 *   add-failed     — the token was stored but the attach failed, so the token
 *                    was deleted again: nothing was added.
 *   sign-in-failed — anything else.
 */
export type OAuthFailureReason = 'cancelled' | 'not-allowed' | 'add-failed' | 'sign-in-failed';

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
   * TASK-711 — may `agentId` hold this user's sign-in for `connectorId`? See
   * the call in `begin`. Fails closed: no provider, a throw or an answer that
   * is not exactly `allowed: true` is "no".
   *
   * TASK-788 — with `purpose: 'store'` it is the shared-definition question
   * only, NOT "is the connector attached to this agent?": an Add signs in
   * before it attaches. Without `purpose` it is exactly the vault's READ
   * question, which also requires the attachment (Sign in again).
   */
  async function mayHoldOnAgent(
    userId: string,
    agentId: string,
    connectorId: string,
    purpose?: 'store',
  ): Promise<boolean> {
    if (bus.hasService?.(AUTHORIZE_AGENT_ACCOUNT_HOOK) !== true) return false;
    try {
      const out = await bus.call<
        { userId: string; agentId: string; ref: string; purpose?: 'store' },
        { allowed: boolean }
      >(AUTHORIZE_AGENT_ACCOUNT_HOOK, ctxFor(userId), {
        userId,
        agentId,
        ref: `account:${connectorId}`,
        ...(purpose !== undefined ? { purpose } : {}),
      });
      return out?.allowed === true;
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

    // Parse + validate the body (small cap; connectorId, agentId and mode required).
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
    // Valid JSON that is not an object (`null`, an array, a scalar) names no
    // connector or agent. `null` would otherwise throw on the field reads below.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const body = parsed as { connectorId?: unknown; agentId?: unknown; mode?: unknown };
    const connectorId = body.connectorId;
    const agentId = body.agentId;
    const mode = body.mode;
    if (typeof connectorId !== 'string' || !connectorId) {
      res.status(400).json({ error: 'connectorId is required' });
      return;
    }
    // Every sign-in belongs to an agent — never to a person. There is no
    // "connect once for all my agents" sign-in.
    if (agentId === undefined) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    if (typeof agentId !== 'string' || !agentId) {
      res.status(400).json({ error: 'agentId must be a non-empty string' });
      return;
    }
    // `add`: the sign-in is part of adding the connector to the agent (the
    // callback attaches it). `sign-in-again`: the connector is already on the
    // agent and only its sign-in is replaced.
    if (mode !== 'add' && mode !== 'sign-in-again') {
      res.status(400).json({ error: 'mode must be "add" or "sign-in-again"' });
      return;
    }

    // Authz gate. A successful agents:resolve is the "may use this agent"
    // check; on a team agent the team-admin check below (TASK-798, TASK-813) is
    // the "may sign in for everyone" one. The token is always stored on the
    // agent, whatever its visibility.
    let agent: { visibility: 'personal' | 'team' };
    try {
      const out = await bus.call<
        { agentId: string; userId: string },
        { agent: { visibility: 'personal' | 'team' } }
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
    // connector read, vault read, state write or provider redirect. Fails
    // closed: no @ax/agents answer, `allowed: false` or a rejection is a 403.
    if (agent.visibility === 'team' && !(await maySetSharedCredential(user, agentId))) {
      res.status(403).json({ error: 'forbidden' });
      return;
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

    // TASK-711 — a sign-in is stored ON the agent only for the one shared
    // connector every member sees under this id. The vault asks the same
    // `credentials:authorize-agent:account` question before it lets anyone READ
    // an agent row for an `account:` ref, so asking it here keeps the two halves
    // in step. Nothing is ever downgraded to the signer: a "no" refuses the
    // sign-in, before any vault read, state write or provider request. No
    // provider, a denial or a throw all mean "no" (fail closed).
    //   add           — the WRITE question (`purpose: 'store'`): the connector
    //                   is attached only once the sign-in worked (TASK-788).
    //                   Then the READ question: a "yes" means the connector is
    //                   already on the agent, so there is nothing to add — 409
    //                   `already-attached` (the key path's twin), before any
    //                   pending row. Signing in again is the row's own item.
    //   sign-in-again — the READ question (no `purpose`), which also requires
    //                   the connector to be on the agent already. A sign-in the
    //                   agent could never read back is refused, not stored.
    if (mode === 'add') {
      if (!(await mayHoldOnAgent(user.id, agentId, connectorId, 'store'))) {
        res.status(403).json({ error: 'agent-store-refused' });
        return;
      }
      if (await mayHoldOnAgent(user.id, agentId, connectorId)) {
        res.status(409).json({ error: 'already-attached' });
        return;
      }
    } else if (!(await mayHoldOnAgent(user.id, agentId, connectorId))) {
      res.status(409).json({ error: 'not-on-agent' });
      return;
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
        agentId,
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
        mode,
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

  function returnUrl(
    connectorId: string,
    outcome: 'success' | 'error',
    reason?: OAuthFailureReason,
  ): string {
    const url = `${config.publicOrigin}${config.connectorReturnPath}?connector=${encodeURIComponent(connectorId)}&oauth=${outcome}`;
    return reason === undefined ? url : `${url}&reason=${reason}`;
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

    const connectorId = pending.connectorId;
    const agentId = pending.agentId;
    /** Redirect the popup with a failure. Nothing has been written, or it was undone. */
    const fail = (reason: OAuthFailureReason): void => {
      res.redirect(returnUrl(connectorId, 'error', reason));
    };

    // A denied grant ends this authorization too. Return the trusted connector
    // id so the popup can notify its own connect widget, and discard the pending
    // verifier/client secret. A retry starts with a fresh state and PKCE pair.
    // Only the error CODE picks the reason; the provider's text goes nowhere.
    if (providerError) {
      fail(providerError === 'access_denied' ? 'cancelled' : 'sign-in-failed');
      return;
    }
    if (!code) {
      res.status(400).json({ error: 'missing code or state' });
      return;
    }

    // Re-check the agent gate `begin` passed, as the same signer (the session
    // user IS `pending.userId`, checked above): up to `pendingTtlMs` has gone by,
    // and in that time the agent may have been deleted or the signer removed or
    // demoted from its team. A "no" writes nothing — no connector read, no token
    // exchange, no vault write, no attach. A row with no agent can only be one
    // begun before every sign-in belonged to an agent; it has nowhere to go.
    if (!agentId) {
      logger.warn('mcp_oauth_callback_agent_refused', { connectorId, stage: 'no-agent' });
      fail('not-allowed');
      return;
    }
    let visibility: unknown;
    try {
      const out = await bus.call<
        { agentId: string; userId: string },
        { agent: { visibility: 'personal' | 'team' } }
      >('agents:resolve', ctxFor(user.id), { agentId, userId: user.id });
      visibility = out?.agent?.visibility;
    } catch (err) {
      if (isReject(err)) {
        logger.warn('mcp_oauth_callback_agent_refused', { connectorId, stage: 'resolve', ...errFields(err) });
        fail('not-allowed');
        return;
      }
      logger.error('mcp_oauth_callback_failed', { stage: 'agent', connectorId, ...errFields(err) });
      fail('sign-in-failed');
      return;
    }
    // Anything but a personal agent is held to the team rule (fail closed): only
    // a team admin may choose the account every member's runs act as.
    if (visibility !== 'personal') {
      let allowed: boolean;
      try {
        allowed = await maySetSharedCredential(user, agentId);
      } catch (err) {
        logger.error('mcp_oauth_callback_failed', { stage: 'agent', connectorId, ...errFields(err) });
        fail('sign-in-failed');
        return;
      }
      if (!allowed) {
        logger.warn('mcp_oauth_callback_agent_refused', { connectorId, stage: 'team-admin' });
        fail('not-allowed');
        return;
      }
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
        connectorId,
      });
      connector = out.connector;
    } catch (err) {
      if (isReject(err)) {
        // The connector vanished (or is no longer visible to the signer) while
        // the popup was open. The popup still gets a redirect, not a bare 404.
        logger.warn('mcp_oauth_callback_failed', { stage: 'connector-gone', connectorId, ...errFields(err) });
        fail('sign-in-failed');
        return;
      }
      // A non-reject connectors:get failure is a SERVER fault, not "OAuth
      // failed" — log it (neutral fields) so an operator has a trace, then give
      // the browser the same clean oauth=error redirect.
      logger.error('mcp_oauth_callback_failed', {
        stage: 'connector',
        connectorId,
        ...errFields(err),
      });
      fail('sign-in-failed');
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
          connectorId,
          ...errFields(err),
        });
        fail('sign-in-failed');
        return;
      }
      if (!legacy) {
        logger.error('mcp_oauth_callback_failed', {
          stage: 'getClient',
          connectorId,
          reason: 'client_registration_missing',
        });
        fail('sign-in-failed');
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
        connectorId,
        ...errFields(err),
      });
      fail('sign-in-failed');
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
        connectorId,
        name: err instanceof Error ? err.name : 'unknown',
      });
      fail('sign-in-failed');
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
    // Every sign-in belongs to an agent, so the token is always stored ON the
    // agent — never on the signer. That includes a row `begin` wrote before that
    // rule (one meant for the signer) and still in flight: it lands on its agent,
    // where it is read only if the connector is on the agent.
    const ref = `account:${connectorId}`;
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
        ownerId: agentId,
        ref,
        kind: 'mcp-oauth',
        payload: encodeTokenBlob(blob),
        ...(blob.expiresAt !== undefined ? { expiresAt: blob.expiresAt } : {}),
      });
    } catch (err) {
      logger.error('mcp_oauth_callback_failed', {
        stage: 'store',
        connectorId,
        ...errFields(err),
      });
      fail('sign-in-failed');
      return;
    }

    // An Add is all or nothing: the sign-in IS part of adding the connector, so
    // the connector is attached only now that the token is stored — and if the
    // attach fails (refused, e.g. the signer lost the right to manage this
    // agent's connectors mid-flow, or a fault), the token is deleted again so
    // nothing is half-added. @ax/agents decides who may attach; we pass the real
    // actor. Seeding the connector's tool settings is @ax/agents' own
    // best-effort step inside the attach; it is not undone here.
    // Sign in again never attaches: the connector is already on the agent (and
    // if it was removed meanwhile, a token on the agent is unreadable without it).
    if (pending.mode === 'add') {
      try {
        await bus.call<AttachConnectorInput, AttachConnectorOutput>(
          'agents:attach-connector',
          ctxFor(user.id),
          { actor: { userId: user.id, isAdmin: user.isAdmin }, agentId, connectorId },
        );
      } catch (err) {
        try {
          await bus.call<{ scope: 'agent'; ownerId: string; ref: string }, void>(
            'credentials:delete',
            ctxFor(user.id),
            { scope: 'agent', ownerId: agentId, ref },
          );
        } catch (deleteErr) {
          // The token outlives the failed Add. It is unreadable while the
          // connector is not on the agent, but an operator should know.
          logger.error('mcp_oauth_add_compensation_failed', {
            connectorId,
            agentId,
            ...errFields(deleteErr),
          });
        }
        logger.warn('mcp_oauth_add_attach_failed', { connectorId, agentId, ...errFields(err) });
        // The marker is NOT cleared: nothing was added.
        fail('add-failed');
        return;
      }
    }

    // TASK-741 — a completed sign-in renews this access, so the rail's
    // "Sign-in expired" marker goes. TASK-756: the marker is the token OWNER's,
    // and the owner is the agent — it clears for every member. Best-effort: the
    // sign-in is complete, and a stale marker only costs one unnecessary Reconnect.
    try {
      await store.clearNeedsReconnect({ kind: 'agent', agentId }, connectorId);
    } catch (err) {
      logger.warn('mcp_oauth_needs_reconnect_clear_failed', {
        connectorId,
        name: err instanceof Error ? err.name : 'unknown',
      });
    }

    res.redirect(returnUrl(connectorId, 'success'));
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
