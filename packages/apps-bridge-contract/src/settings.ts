/**
 * AX-internal shapes for the Apps settings section and the approve page.
 * Shared by @ax/apps-bridge (the routes) and @ax/channel-web (the UI). Not
 * part of the external contract: the platform never sees these.
 */
import { z } from 'zod';
import {
  AppIdSchema, AppModeSchema, APP_ID_RE, CONNECTOR_ID_RE, ConnectorIdSchema, LINK_CODE_RE, PLATFORM_ID_RE,
  ToolNameSchema,
} from './wire.js';

/** The same pattern as @ax/mcp-client's CONNECTOR_TOOL_KEY_RE: `mcp.<namespace>.<tool>` (presets/k8s apps-bridge-contract-parity.test.ts compares the two). */
export const TOOL_KEY_RE = /^mcp\.(c[0-9a-f]{10})\.([\x21-\x7e]{1,128})$/;
/**
 * An agent id as the settings routes accept it in a path or body. One copy,
 * so the routes (@ax/apps-bridge) and the SPA's client (@ax/channel-web,
 * which refuses to build a path for an id off it) can't drift apart.
 */
export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
/** At most this many tools per grant (tool names unique within a grant). */
export const MAX_GRANT_TOOLS = 200;
export const SETTINGS_BODY_MAX_BYTES = 16_384;

export const APPS_SETTINGS_ROUTES = {
  read: '/settings/apps/:agentId',
  linkCode: '/settings/apps/:agentId/link-code',
  unlink: '/settings/apps/:agentId/unlink',
  grant: '/settings/apps/:agentId/grant',
  ungrant: '/settings/apps/:agentId/ungrant',
  revoke: '/settings/apps/:agentId/revoke',
  approval: '/settings/app-approval/:platformId/:appId/:connectorId',
} as const;

/** Error keys and their statuses. The body is `{ error: <key> }`. */
export const SETTINGS_ERRORS = {
  unauthenticated: 401,
  internal: 500,
  'agent-not-found': 404,
  forbidden: 403,
  'bridge-off': 409,
  'invalid-body': 400,
  'not-linked': 404,
  'connector-not-on-agent': 400,
  'tool-not-on-connector': 400,
  'duplicate-tool-name': 400,
  'not-found': 404,
  'agent-not-eligible': 400,
  unavailable: 503,
} as const;
export type SettingsError = keyof typeof SETTINGS_ERRORS;

const AgentIdSchema = z.string().min(1).max(256);
const ToolKeySchema = z.string().regex(TOOL_KEY_RE);
const TimestampSchema = z.string().datetime();

// POST link-code
export const LinkCodeBodySchema = z.object({}).strict();
export type LinkCodeBody = z.infer<typeof LinkCodeBodySchema>;
export const LinkCodeResponseSchema = z
  .object({ code: z.string().regex(LINK_CODE_RE), expiresAt: TimestampSchema })
  .strict();
export type LinkCodeResponse = z.infer<typeof LinkCodeResponseSchema>;

// GET read
export const AppToolSchema = z.object({ toolKey: ToolKeySchema, name: ToolNameSchema }).strict();
export type AppTool = z.infer<typeof AppToolSchema>;

export const AppGrantSchema = z
  .object({
    connectorId: ConnectorIdSchema,
    connectorName: z.string(),
    mode: AppModeSchema,
    tools: z.array(AppToolSchema).max(MAX_GRANT_TOOLS),
  })
  .strict();
export type AppGrant = z.infer<typeof AppGrantSchema>;

export const AppLinkSchema = z
  .object({ appId: AppIdSchema, appName: z.string(), createdAt: TimestampSchema, grants: z.array(AppGrantSchema) })
  .strict();
export type AppLink = z.infer<typeof AppLinkSchema>;

export const ViewerApprovalSchema = z
  .object({
    appId: AppIdSchema,
    appName: z.string(),
    connectorId: ConnectorIdSchema,
    connectorName: z.string(),
    createdAt: TimestampSchema,
  })
  .strict();
export type ViewerApproval = z.infer<typeof ViewerApprovalSchema>;

export const AgentAppsReadSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      canManage: z.boolean(),
      links: z.array(AppLinkSchema),
      approvals: z.array(ViewerApprovalSchema),
    })
    .strict(),
]);
export type AgentAppsRead = z.infer<typeof AgentAppsReadSchema>;

// POST unlink -> {}
export const UnlinkAppBodySchema = z.object({ appId: AppIdSchema }).strict();
export type UnlinkAppBody = z.infer<typeof UnlinkAppBodySchema>;

// POST grant -> { grant }
export const SaveGrantBodySchema = z
  .object({
    appId: AppIdSchema,
    connectorId: ConnectorIdSchema,
    mode: AppModeSchema,
    toolKeys: z.array(ToolKeySchema).min(1).max(MAX_GRANT_TOOLS),
  })
  .strict();
export type SaveGrantBody = z.infer<typeof SaveGrantBodySchema>;
export const SaveGrantResponseSchema = z.object({ grant: AppGrantSchema }).strict();
export type SaveGrantResponse = z.infer<typeof SaveGrantResponseSchema>;

// POST ungrant and POST revoke -> {}
export const AppConnectorBodySchema = z.object({ appId: AppIdSchema, connectorId: ConnectorIdSchema }).strict();
export type AppConnectorBody = z.infer<typeof AppConnectorBodySchema>;

// GET approval
export const ApprovalPromptSchema = z
  .object({
    platformId: z.string().regex(PLATFORM_ID_RE),
    appId: AppIdSchema,
    appName: z.string(),
    connectorId: ConnectorIdSchema,
    connectorName: z.string(),
    tools: z.array(ToolNameSchema),
    agents: z.array(z.object({ agentId: AgentIdSchema, displayName: z.string() }).strict()),
    approvedAgentId: z.string().nullable(),
  })
  .strict();
export type ApprovalPrompt = z.infer<typeof ApprovalPromptSchema>;

// POST approval -> {}
// `tools` echoes ApprovalPrompt.tools, the names the page showed: only those
// are approved, so a tool granted while the page was open needs asking again.
export const ApproveBodySchema = z
  .object({ agentId: AgentIdSchema, tools: z.array(ToolNameSchema).max(MAX_GRANT_TOOLS) })
  .strict();
export type ApproveBody = z.infer<typeof ApproveBodySchema>;

// ---------------------------------------------------------------------------
// The approve page: `/apps/approve/<platformId>/<appId>/<connectorId>`.
// Path-only so it survives sign-in (a query string wouldn't).
// ---------------------------------------------------------------------------

export const APPROVE_PAGE_PREFIX = '/apps/approve/';

export interface ApprovePageIds {
  platformId: string;
  appId: string;
  connectorId: string;
}

function idsValid(platformId: string, appId: string, connectorId: string): boolean {
  return PLATFORM_ID_RE.test(platformId) && APP_ID_RE.test(appId) && CONNECTOR_ID_RE.test(connectorId);
}

/** Throws when an id fails its grammar, so no path is built from a bad id. */
export function approvePagePath(platformId: string, appId: string, connectorId: string): string {
  if (!idsValid(platformId, appId, connectorId)) throw new Error('approvePagePath: an id fails its grammar');
  return `${APPROVE_PAGE_PREFIX}${platformId}/${appId}/${connectorId}`;
}

/**
 * Exactly `/apps/approve/<p>/<a>/<c>`: each segment matches its grammar, no
 * trailing slash, no extra segment, no percent-encoding, nothing after the
 * path. Anything else is null.
 */
export function parseApprovePagePath(pathname: string): ApprovePageIds | null {
  if (!pathname.startsWith(APPROVE_PAGE_PREFIX)) return null;
  const parts = pathname.slice(APPROVE_PAGE_PREFIX.length).split('/');
  if (parts.length !== 3) return null;
  const [platformId, appId, connectorId] = parts as [string, string, string];
  return idsValid(platformId, appId, connectorId) ? { platformId, appId, connectorId } : null;
}
