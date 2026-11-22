/**
 * An agent's Apps section, and the approve page: the wire client and the
 * words for its failures. The routes live in @ax/apps-bridge
 * (`packages/apps-bridge/src/settings-routes.ts`); every answer is parsed
 * with @ax/apps-bridge-contract's schemas, the one source of the shapes.
 *
 *   GET  /settings/apps/:agentId             → AgentAppsRead
 *   POST /settings/apps/:agentId/link-code   {} → { code, expiresAt }
 *   POST /settings/apps/:agentId/unlink      { appId } → {}
 *   POST /settings/apps/:agentId/grant       { appId, connectorId, mode, toolKeys } → { grant }
 *   POST /settings/apps/:agentId/ungrant     { appId, connectorId } → {}
 *   POST /settings/apps/:agentId/revoke      { appId, connectorId } → {}
 *   GET  /settings/app-approval/:platformId/:appId/:connectorId  → ApprovalPrompt
 *   POST /settings/app-approval/:platformId/:appId/:connectorId  { agentId, tools } → {}
 *
 * Every request carries the session cookie (`httpFetch`, which also notices a
 * 401), and every POST the `x-requested-with: ax-admin` header the CSRF check
 * wants. A link code is returned to the caller and goes nowhere else: it is
 * never logged and never kept here.
 *
 * Every id is checked against its grammar BEFORE a path is built from it, and
 * a bad one makes no request at all. `encodeURIComponent` alone is not enough:
 * it leaves `.` and `..` as they are, and URL parsing resolves those, so an id
 * of `..` (say, from a crafted approve link) would aim a POST carrying the
 * session cookie and the CSRF header at some other path on this origin.
 */
import {
  AgentAppsReadSchema,
  APP_ID_RE,
  APPS_SETTINGS_ROUTES,
  CONNECTOR_ID_RE,
  PLATFORM_ID_RE,
  ApprovalPromptSchema,
  LinkCodeResponseSchema,
  SaveGrantResponseSchema,
  SETTINGS_ERRORS,
  type AgentAppsRead,
  type AppGrant,
  type ApprovalPrompt,
  type LinkCodeResponse,
  type SaveGrantBody,
  type SettingsError,
} from '@ax/apps-bridge-contract';
import type { z } from 'zod';
import { httpFetch } from './http';

/** `unknown`: a failure whose body named no code we know. `bad-response`: an answer off the schema. */
export type AgentAppsErrorCode = SettingsError | 'unknown' | 'bad-response';

/**
 * A request that failed with an answer we could read, or an answer we
 * couldn't use. `code` is one of the server's own keys, never its prose;
 * `message` is for the console, never a page.
 */
export class AgentAppsError extends Error {
  readonly status: number;
  readonly code: AgentAppsErrorCode;

  constructor(status: number, code: AgentAppsErrorCode) {
    super(`agent apps request failed: ${status} ${code}`);
    this.name = 'AgentAppsError';
    this.status = status;
    this.code = code;
  }
}

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

function isSettingsError(value: unknown): value is SettingsError {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS_ERRORS, value);
}

/**
 * An agent id as the settings routes accept it (the same literal as
 * `AGENT_ID_RE` in @ax/apps-bridge's `settings-routes.ts`, which isn't
 * exported: the SPA depends on no host plugin).
 */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

/** No request is made for an agent id off its grammar: the server would answer `agent-not-found` too. */
function agentPath(route: string, agentId: string): string {
  if (!AGENT_ID_RE.test(agentId)) throw new AgentAppsError(0, 'agent-not-found');
  return route.replace(':agentId', agentId);
}

/** No request is made for an id off its grammar: the server would answer `not-found` too. */
function approvalPath(platformId: string, appId: string, connectorId: string): string {
  if (!PLATFORM_ID_RE.test(platformId) || !APP_ID_RE.test(appId) || !CONNECTOR_ID_RE.test(connectorId)) {
    throw new AgentAppsError(0, 'not-found');
  }
  return APPS_SETTINGS_ROUTES.approval
    .replace(':platformId', platformId)
    .replace(':appId', appId)
    .replace(':connectorId', connectorId);
}

async function failure(res: Response): Promise<AgentAppsError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const error = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['error'] : undefined;
  return new AgentAppsError(res.status, isSettingsError(error) ? error : 'unknown');
}

/** The answer, parsed with `schema`, or a `bad-response`. */
async function parsed<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AgentAppsError(res.status, 'bad-response');
  }
  const out = schema.safeParse(body);
  if (!out.success) throw new AgentAppsError(res.status, 'bad-response');
  return out.data;
}

async function post(path: string, body: unknown): Promise<Response> {
  const res = await httpFetch(path, { method: 'POST', headers: writeHeaders, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  return res;
}

/**
 * The Apps section for one agent. A 404 from the route itself names
 * `agent-not-found` and throws. Any other 404 means this server has no Apps
 * routes: http-server's own answer for an unknown path is a bare
 * `{ error: 'not-found' }` (a word the settings routes also use, but never on
 * this GET), and a host that serves the app answers an unknown GET with the
 * app's own HTML, so a page that isn't JSON means the same. Any other failure
 * throws, for a retry.
 */
export async function fetchAgentApps(agentId: string): Promise<AgentAppsRead | 'unavailable'> {
  const res = await httpFetch(agentPath(APPS_SETTINGS_ROUTES.read, agentId));
  if (res.status === 404) {
    const err = await failure(res);
    if (err.code === 'agent-not-found') throw err;
    return 'unavailable';
  }
  if (!res.ok) throw await failure(res);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return 'unavailable';
  }
  const out = AgentAppsReadSchema.safeParse(body);
  if (!out.success) throw new AgentAppsError(res.status, 'bad-response');
  return out.data;
}

/** A one-time code an app platform trades for a link to this agent. Show it once; keep it nowhere. */
export async function mintLinkCode(agentId: string): Promise<LinkCodeResponse> {
  return parsed(await post(agentPath(APPS_SETTINGS_ROUTES.linkCode, agentId), {}), LinkCodeResponseSchema);
}

/** Unlink an app from this agent, and every grant it held with it. */
export async function unlinkApp(agentId: string, appId: string): Promise<void> {
  await post(agentPath(APPS_SETTINGS_ROUTES.unlink, agentId), { appId });
}

/** Give a linked app one connector's tools (or change what it has). The answer is the grant as saved. */
export async function saveGrant(agentId: string, body: SaveGrantBody): Promise<AppGrant> {
  const res = await post(agentPath(APPS_SETTINGS_ROUTES.grant, agentId), body);
  return (await parsed(res, SaveGrantResponseSchema)).grant;
}

/** Take one connector away from a linked app. */
export async function removeGrant(agentId: string, appId: string, connectorId: string): Promise<void> {
  await post(agentPath(APPS_SETTINGS_ROUTES.ungrant, agentId), { appId, connectorId });
}

/** Take back the caller's own yes: the app stops using this agent's sign-in as them. */
export async function revokeApproval(agentId: string, appId: string, connectorId: string): Promise<void> {
  await post(agentPath(APPS_SETTINGS_ROUTES.revoke, agentId), { appId, connectorId });
}

/** What the approve page asks a viewer. A 404 `not-found` is one answer for every reason it can't. */
export async function fetchApprovalPrompt(
  platformId: string,
  appId: string,
  connectorId: string,
): Promise<ApprovalPrompt> {
  const res = await httpFetch(approvalPath(platformId, appId, connectorId));
  if (!res.ok) throw await failure(res);
  return parsed(res, ApprovalPromptSchema);
}

/**
 * Say yes on the approve page, lending `agentId`'s sign-in. `tools` echoes
 * the prompt's `tools`, the names the page showed: only those are approved.
 */
export async function approveApp(
  platformId: string,
  appId: string,
  connectorId: string,
  agentId: string,
  tools: readonly string[],
): Promise<void> {
  await post(approvalPath(platformId, appId, connectorId), { agentId, tools });
}

/** Refusals that mean the page showed something that has since changed: read it again. */
const STALE: ReadonlySet<AgentAppsErrorCode> = new Set<AgentAppsErrorCode>([
  'not-linked',
  'not-found',
  'connector-not-on-agent',
  'tool-not-on-connector',
  'bridge-off',
]);

export function agentAppsStale(err: unknown): boolean {
  return err instanceof AgentAppsError && STALE.has(err.code);
}

const COPY: Partial<Record<AgentAppsErrorCode, string>> = {
  forbidden: 'Only people who manage this agent can change its apps.',
  'agent-not-found': "We couldn't find this agent. It may have been deleted.",
  'agent-not-eligible': "That agent can't lend this connector. Pick one of your own agents that has it.",
  'bridge-off': "The apps platform isn't set up here any more.",
  'not-linked': "That app isn't linked to this agent any more.",
  'not-found': 'That was already gone.',
  'connector-not-on-agent': "That connector isn't on this agent any more.",
  'tool-not-on-connector': "One of those tools isn't offered by that connector any more.",
  'duplicate-tool-name': 'Two of those tools have the same name, so an app couldn’t tell them apart. Pick one.',
  unavailable: "We couldn't reach the apps service just now. Nothing changed. Please try again.",
};

/** One sentence for a failed write. Never the server's code or prose. */
export function agentAppsErrorCopy(err: unknown): string {
  const fallback = 'Something went wrong, so nothing changed. Please try again.';
  return err instanceof AgentAppsError ? (COPY[err.code] ?? fallback) : fallback;
}
