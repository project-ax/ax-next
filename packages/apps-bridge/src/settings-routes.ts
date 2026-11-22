/**
 * The Apps section of an agent's settings, and the page where a viewer lets
 * an app use a connector as them. Mounted on the public listener through
 * `http:register-route`; the platform never calls these (it has its own
 * listener, listener.ts).
 *
 *   GET  /settings/apps/:agentId             → AgentAppsRead           (anyone who can see the agent)
 *   POST /settings/apps/:agentId/link-code   {} → { code, expiresAt }   (a manager)
 *   POST /settings/apps/:agentId/unlink      { appId } → {}             (a manager)
 *   POST /settings/apps/:agentId/grant       { appId, connectorId, mode, toolKeys } → { grant }  (a manager)
 *   POST /settings/apps/:agentId/ungrant     { appId, connectorId } → {} (a manager)
 *   POST /settings/apps/:agentId/revoke      { appId, connectorId } → {} (the viewer, on their own approval)
 *   GET  /settings/app-approval/:platformId/:appId/:connectorId  → ApprovalPrompt  (anyone signed in)
 *   POST /settings/app-approval/:platformId/:appId/:connectorId  { agentId, tools } → {}  (anyone signed in;
 *                                             approves only the shown `tools` still on the grant)
 *
 * Every agent route answers in this order (channel-slack agent-routes.ts's):
 * 401 signed out; the SAME 404 `agent-not-found` for an id no agent could
 * have, an unknown agent and one `agents:resolve` refuses this person (never
 * tell someone an agent exists); then, with the bridge off, `{ enabled:
 * false }` or 409 `bridge-off`; then rights (a manager is whoever
 * `agents:can-manage-connectors` says yes to, asked as a NON-admin: workspace
 * admin status never lends an agent's sign-in); then the body (an unknown
 * key is a 400, so nothing in a body can name another agent or person); then
 * the domain. The approve routes: 401; with the bridge off a POST is 409;
 * then the same 404 `not-found` for an id off its grammar, another platform,
 * an app nobody linked and a connector not granted in viewer mode; then the
 * body; then the domain.
 *
 * The POSTs keep http-server's CSRF check (no `bypassCsrf` here: the caller
 * is a signed-in browser, which sends `x-requested-with: ax-admin`) and cap
 * their bodies at SETTINGS_BODY_MAX_BYTES. A hook failure that isn't an
 * access miss answers 503 `unavailable`, logged code-only. A link code is
 * answered once and never logged or stored: only its sha256 reaches the
 * store. App names are display-only and never logged (I5).
 */
import {
  APPS_SETTINGS_ROUTES,
  APP_ID_RE,
  AppConnectorBodySchema,
  ApproveBodySchema,
  CONNECTOR_ID_RE,
  LinkCodeBodySchema,
  SETTINGS_BODY_MAX_BYTES,
  SETTINGS_ERRORS,
  SaveGrantBodySchema,
  TOOL_KEY_RE,
  UnlinkAppBodySchema,
  type AgentAppsRead,
  type AppGrant as AppGrantView,
  type AppLink as AppLinkView,
  type ApprovalPrompt,
  type LinkCodeResponse,
  type SaveGrantResponse,
  type SettingsError,
  type ViewerApproval as ViewerApprovalView,
} from '@ax/apps-bridge-contract';
import { PluginError, makeAgentContext, ownerlessIdFor, type AgentContext, type HookBus, type Logger } from '@ax/core';
import type { ZodType } from 'zod';
import {
  bridgeCtx,
  canManageAgent,
  connectorNames,
  effectiveConnectors,
  resolveAgent,
  type AgentView,
  type BridgeBus,
} from './access.js';
import type { RouteRequest, RouteSpec } from './http-types.js';
import { LINK_CODE_TTL_MS, hashLinkCode, newLinkCode } from './link-codes.js';
import { loggableCode } from './log-code.js';
import type { AppGrant, AppsBridgeStore } from './store.js';
import { checkUser } from './user-auth.js';

export interface SettingsRoutesDeps {
  store: AppsBridgeStore;
  /** The configured platform; undefined when the bridge is off. */
  platformId: string | undefined;
  logger: Logger;
  /** Epoch milliseconds. */
  now: () => number;
}

const PLUGIN = '@ax/apps-bridge';
const SESSION = 'apps-bridge-settings';
/** An agent id as a path may carry it. Anything else is no agent at all. */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

interface Reply {
  status: number;
  body: unknown;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const refuse = (error: SettingsError): Reply => ({ status: SETTINGS_ERRORS[error], body: { error } });
const utf8 = new TextDecoder('utf-8', { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A POST's JSON body through its (strict) schema. Past the cap (http-server's
 * `maxBodyBytes` refused it first; this is the backstop), not UTF-8, not
 * JSON, or not the schema's shape: null, and the route answers 400.
 */
function readBody<T>(req: RouteRequest, schema: ZodType<T>): T | null {
  if (req.body.length > SETTINGS_BODY_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(req.body));
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** The tool name a key carries (`mcp.<namespace>.<tool>`), or null off the grammar. */
function toolName(key: string): string | null {
  return TOOL_KEY_RE.exec(key)?.[2] ?? null;
}

function grantView(g: AppGrant, connectorName: string): AppGrantView {
  return {
    connectorId: g.connectorId,
    connectorName,
    mode: g.mode,
    tools: g.toolKeys.flatMap((toolKey) => {
      const name = toolName(toolKey);
      return name === null ? [] : [{ toolKey, name }];
    }),
  };
}

/** The person's own personal agents from an `agents:list-for-user` answer; whatever else it holds is dropped. */
function personalAgentsOf(answer: unknown, userId: string): AgentView[] {
  const raw = isRecord(answer) ? answer['agents'] : undefined;
  if (!Array.isArray(raw)) {
    throw new PluginError({ code: 'invalid-return', plugin: PLUGIN, hookName: 'agents:list-for-user', message: 'unreadable answer' });
  }
  const out: AgentView[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (!isRecord(a)) continue;
    const { id, ownerId, ownerType, displayName } = a;
    if (typeof id !== 'string' || !AGENT_ID_RE.test(id) || seen.has(id)) continue;
    if (ownerType !== 'user' || ownerId !== userId || typeof displayName !== 'string') continue;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    seen.add(id);
    out.push({
      id,
      ownerId,
      ownerType,
      displayName,
      connectorAttachments: strings(a['connectorAttachments']),
      connectorExclusions: strings(a['connectorExclusions']),
    });
  }
  return out;
}

/** Who is asking, about which agent, once the agent resolved for them and the bridge is on. */
interface Asked {
  req: RouteRequest;
  ctx: AgentContext;
  userId: string;
  agentId: string;
  agent: AgentView;
  platformId: string;
}

/** Who is asking, about which app's connector, once the approve link's ids passed. */
interface AskedApproval {
  req: RouteRequest;
  userId: string;
  platformId: string;
  appId: string;
  appName: string;
  connectorId: string;
  grant: AppGrant;
}

export function createSettingsRoutes(bus: BridgeBus, deps: SettingsRoutesDeps): RouteSpec[] {
  const { store } = deps;
  const nobody = ownerlessIdFor(SESSION);
  const authCtx = makeAgentContext({ sessionId: SESSION, agentId: nobody, userId: nobody, logger: deps.logger });

  const logFailure = (stage: string, err: unknown): void => {
    try {
      deps.logger.error('apps_settings_route_failed', { stage, code: loggableCode(err) ?? 'unknown' });
    } catch {
      // A log line never changes an answer.
    }
  };

  const manages = (a: Asked): Promise<boolean> => canManageAgent(bus, a.ctx, a.agentId, a.userId);

  async function read(a: Asked): Promise<Reply> {
    const canManage = await manages(a);
    const links = await store.listLinksForAgent(a.platformId, a.agentId);
    const grants = await Promise.all(links.map((l) => store.listGrants(a.platformId, l.appId)));
    const approvals = await store.listApprovalsForViewerAgent(a.userId, a.platformId, a.agentId);
    const names =
      grants.some((g) => g.length > 0) || approvals.length > 0 ? await connectorNames(bus, a.ctx, a.userId) : new Map<string, string>();
    const nameOf = (connectorId: string) => names.get(connectorId) ?? connectorId;

    const linkViews: AppLinkView[] = links.map((l, i) => ({
      appId: l.appId,
      appName: l.appName,
      createdAt: l.createdAt.toISOString(),
      grants: (grants[i] ?? []).map((g) => grantView(g, nameOf(g.connectorId))),
    }));
    const approvalViews: ViewerApprovalView[] = [];
    const appNames = new Map<string, string | null>();
    for (const ap of approvals) {
      if (!appNames.has(ap.appId)) appNames.set(ap.appId, (await store.getLink(a.platformId, ap.appId))?.appName ?? null);
      const appName = appNames.get(ap.appId);
      // Unlinked since the list was read: its approvals went with it.
      if (appName === null || appName === undefined) continue;
      approvalViews.push({
        appId: ap.appId,
        appName,
        connectorId: ap.connectorId,
        connectorName: nameOf(ap.connectorId),
        createdAt: ap.createdAt.toISOString(),
      });
    }
    const out: AgentAppsRead = { enabled: true, canManage, links: linkViews, approvals: approvalViews };
    return ok(out);
  }

  async function linkCode(a: Asked): Promise<Reply> {
    if (!(await manages(a))) return refuse('forbidden');
    if (readBody(a.req, LinkCodeBodySchema) === null) return refuse('invalid-body');
    // Shown once, here; only its hash is kept, and neither is logged.
    const code = newLinkCode();
    const nowMs = deps.now();
    const expiresAt = new Date(nowMs + LINK_CODE_TTL_MS);
    await store.mintLinkCode({ codeHash: hashLinkCode(code), userId: a.userId, agentId: a.agentId, expiresAt, now: new Date(nowMs) });
    const out: LinkCodeResponse = { code, expiresAt: expiresAt.toISOString() };
    return ok(out);
  }

  async function unlink(a: Asked): Promise<Reply> {
    if (!(await manages(a))) return refuse('forbidden');
    const body = readBody(a.req, UnlinkAppBodySchema);
    if (body === null) return refuse('invalid-body');
    // Removes the link only when it is to this agent.
    return (await store.deleteLink(a.platformId, body.appId, a.agentId)) ? ok({}) : refuse('not-linked');
  }

  async function saveGrant(a: Asked): Promise<Reply> {
    if (!(await manages(a))) return refuse('forbidden');
    const body = readBody(a.req, SaveGrantBodySchema);
    if (body === null) return refuse('invalid-body');
    const link = await store.getLink(a.platformId, body.appId);
    if (link === null || link.agentId !== a.agentId) return refuse('not-linked');

    const effective = await effectiveConnectors(bus, a.ctx, a.userId, a.agent);
    const connector = effective.find((c) => c.id === body.connectorId);
    if (connector === undefined) return refuse('connector-not-on-agent');
    // Each key's namespace is this connector's, and no other connector's on
    // the agent (bridge-call.ts refuses such a key at call time too).
    for (const key of body.toolKeys) {
      const namespace = TOOL_KEY_RE.exec(key)?.[1];
      if (namespace === undefined || !connector.toolNamespaces.includes(namespace)) return refuse('tool-not-on-connector');
      if (effective.some((c) => c.id !== connector.id && c.toolNamespaces.includes(namespace))) return refuse('tool-not-on-connector');
    }
    // The platform calls a tool by name, so a name may stand for one key only.
    const names = body.toolKeys.map(toolName);
    if (new Set(names).size !== names.length) return refuse('duplicate-tool-name');

    const saved = await store.putGrant({
      platformId: a.platformId,
      appId: body.appId,
      connectorId: body.connectorId,
      mode: body.mode,
      toolKeys: body.toolKeys,
      // The link may not move to another agent under the write.
      agentId: a.agentId,
    });
    if (saved === 'no-link') return refuse('not-linked');
    const out: SaveGrantResponse = { grant: grantView(saved, connector.name) };
    return ok(out);
  }

  async function ungrant(a: Asked): Promise<Reply> {
    if (!(await manages(a))) return refuse('forbidden');
    const body = readBody(a.req, AppConnectorBodySchema);
    if (body === null) return refuse('invalid-body');
    const link = await store.getLink(a.platformId, body.appId);
    if (link === null || link.agentId !== a.agentId) return refuse('not-linked');
    // Still only while it is linked here: a link that moved since keeps its grant.
    return (await store.deleteGrant(a.platformId, body.appId, body.connectorId, a.agentId)) ? ok({}) : refuse('not-found');
  }

  /** The person's own approval that borrows this agent: nobody else's, and on no other agent. */
  async function revoke(a: Asked): Promise<Reply> {
    const body = readBody(a.req, AppConnectorBodySchema);
    if (body === null) return refuse('invalid-body');
    const removed = await store.deleteApproval(a.userId, a.platformId, body.appId, body.connectorId, a.agentId);
    return removed ? ok({}) : refuse('not-found');
  }

  /**
   * The person's personal agents (never a team's: a viewer lends only their
   * own) whose effective connectors include this one, and that connector's
   * name as the first of them sees it.
   */
  async function candidates(q: AskedApproval): Promise<{ agents: ApprovalPrompt['agents']; connectorName: string | undefined }> {
    const listCtx = bridgeCtx(q.userId, ownerlessIdFor(SESSION), deps.logger);
    // No teamIds: personal agents only.
    const listed = await bus.call<{ userId: string }, unknown>('agents:list-for-user', listCtx, { userId: q.userId });
    const agents: ApprovalPrompt['agents'] = [];
    let connectorName: string | undefined;
    for (const agent of personalAgentsOf(listed, q.userId)) {
      const effective = await effectiveConnectors(bus, bridgeCtx(q.userId, agent.id, deps.logger), q.userId, agent);
      const match = effective.find((c) => c.id === q.connectorId);
      if (match === undefined) continue;
      connectorName ??= match.name;
      agents.push({ agentId: agent.id, displayName: agent.displayName });
    }
    return { agents, connectorName };
  }

  async function approvalPrompt(q: AskedApproval): Promise<Reply> {
    const { agents, connectorName } = await candidates(q);
    const name =
      connectorName ??
      (await connectorNames(bus, bridgeCtx(q.userId, ownerlessIdFor(SESSION), deps.logger), q.userId)).get(q.connectorId) ??
      q.connectorId;
    const existing = await store.getApproval(q.userId, q.platformId, q.appId, q.connectorId);
    const out: ApprovalPrompt = {
      platformId: q.platformId,
      appId: q.appId,
      appName: q.appName,
      connectorId: q.connectorId,
      connectorName: name,
      tools: q.grant.toolKeys.flatMap((k) => {
        const n = toolName(k);
        return n === null ? [] : [n];
      }),
      agents,
      approvedAgentId: existing?.agentId ?? null,
    };
    return ok(out);
  }

  async function approve(q: AskedApproval): Promise<Reply> {
    const body = readBody(q.req, ApproveBodySchema);
    if (body === null) return refuse('invalid-body');
    const { agents } = await candidates(q);
    if (!agents.some((c) => c.agentId === body.agentId)) return refuse('agent-not-eligible');
    // The consent covers only the tools the page showed that are still
    // granted, in the grant's order. A tool granted while the page was open
    // stays unapproved: a call to it answers viewer_approval_required, and
    // the approve link asks again (bridge-call.ts checks this snapshot). A
    // name the grant doesn't hold adds nothing.
    const shown = new Set(body.tools);
    const toolKeys = q.grant.toolKeys.filter((key) => {
      const name = toolName(key);
      return name !== null && shown.has(name);
    });
    // Nothing the page showed is granted any longer (a stale page): there is
    // nothing to approve, so the same 404 as a grant that went.
    if (toolKeys.length === 0) return refuse('not-found');
    const saved = await store.putApproval({
      viewerUserId: q.userId,
      platformId: q.platformId,
      appId: q.appId,
      connectorId: q.connectorId,
      agentId: body.agentId,
      toolKeys,
    });
    return saved === 'saved' ? ok({}) : refuse('not-found');
  }

  /** Answer once; every reply is per-person, so none is cached. */
  async function answer(res: Parameters<RouteSpec['handler']>[1], stage: string, run: () => Promise<Reply>): Promise<void> {
    let reply: Reply;
    try {
      reply = await run();
    } catch (err) {
      logFailure(stage, err);
      reply = refuse('unavailable');
    }
    res.status(reply.status).header('cache-control', 'no-store').json(reply.body);
  }

  function agentRoute(method: RouteSpec['method'], path: string, stage: string, run: (a: Asked) => Promise<Reply>): RouteSpec {
    return {
      method,
      path,
      ...(method === 'POST' ? { maxBodyBytes: SETTINGS_BODY_MAX_BYTES } : {}),
      handler: (req, res) =>
        answer(res, stage, async () => {
          const gate = await checkUser(bus, authCtx, req);
          if (!gate.ok) return { status: gate.status, body: { error: gate.error } };
          const agentId = req.params['agentId'];
          if (agentId === undefined || !AGENT_ID_RE.test(agentId)) return refuse('agent-not-found');
          const ctx = bridgeCtx(gate.userId, agentId, deps.logger);
          const agent = await resolveAgent(bus, ctx, agentId, gate.userId);
          if (agent === null) return refuse('agent-not-found');
          if (deps.platformId === undefined) return method === 'GET' ? ok({ enabled: false } satisfies AgentAppsRead) : refuse('bridge-off');
          return run({ req, ctx, userId: gate.userId, agentId, agent, platformId: deps.platformId });
        }),
    };
  }

  function approvalRoute(method: RouteSpec['method'], stage: string, run: (q: AskedApproval) => Promise<Reply>): RouteSpec {
    return {
      method,
      path: APPS_SETTINGS_ROUTES.approval,
      ...(method === 'POST' ? { maxBodyBytes: SETTINGS_BODY_MAX_BYTES } : {}),
      handler: (req, res) =>
        answer(res, stage, async () => {
          const gate = await checkUser(bus, authCtx, req);
          if (!gate.ok) return { status: gate.status, body: { error: gate.error } };
          if (method === 'POST' && deps.platformId === undefined) return refuse('bridge-off');
          const { platformId, appId, connectorId } = req.params;
          if (
            deps.platformId === undefined ||
            platformId !== deps.platformId ||
            appId === undefined ||
            !APP_ID_RE.test(appId) ||
            connectorId === undefined ||
            !CONNECTOR_ID_RE.test(connectorId)
          ) {
            return refuse('not-found');
          }
          const link = await store.getLink(platformId, appId);
          if (link === null) return refuse('not-found');
          const grant = await store.getGrant(platformId, appId, connectorId);
          if (grant === null || grant.mode !== 'viewer') return refuse('not-found');
          return run({ req, userId: gate.userId, platformId, appId, appName: link.appName, connectorId, grant });
        }),
    };
  }

  const R = APPS_SETTINGS_ROUTES;
  return [
    agentRoute('GET', R.read, 'read', read),
    agentRoute('POST', R.linkCode, 'link-code', linkCode),
    agentRoute('POST', R.unlink, 'unlink', unlink),
    agentRoute('POST', R.grant, 'grant', saveGrant),
    agentRoute('POST', R.ungrant, 'ungrant', ungrant),
    agentRoute('POST', R.revoke, 'revoke', revoke),
    approvalRoute('GET', 'approval', approvalPrompt),
    approvalRoute('POST', 'approve', approve),
  ];
}

/** Run every undo, newest first, emptying the list. One that throws doesn't stop the rest. */
export function unwind(undos: Array<() => void>): void {
  while (undos.length > 0) {
    const undo = undos.pop();
    try {
      undo?.();
    } catch {
      // A route that won't unregister is http-server's to report; keep going.
    }
  }
}

/**
 * Registers every settings route and answers their undos (the plugin calls
 * them in shutdown). A failed registration undoes the ones before it, then
 * throws.
 */
export async function registerSettingsRoutes(bus: HookBus, deps: SettingsRoutesDeps): Promise<Array<() => void>> {
  const ctx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN, userId: 'system', logger: deps.logger });
  const undos: Array<() => void> = [];
  try {
    for (const route of createSettingsRoutes(bus, deps)) {
      const { unregister } = await bus.call<RouteSpec, { unregister(): void }>('http:register-route', ctx, route);
      undos.push(() => unregister());
    }
  } catch (err) {
    unwind(undos);
    throw err;
  }
  return undos;
}
