import { describe, expect, it } from 'vitest';
import {
  AgentAppsReadSchema, AppConnectorBodySchema, AppGrantSchema, ApprovalPromptSchema, approvePagePath,
  APPROVE_PAGE_PREFIX, APPS_SETTINGS_ROUTES, ApproveBodySchema, LinkCodeBodySchema, LinkCodeResponseSchema,
  MAX_GRANT_TOOLS, parseApprovePagePath, SaveGrantBodySchema, SaveGrantResponseSchema, SETTINGS_BODY_MAX_BYTES,
  SETTINGS_ERRORS, TOOL_KEY_RE, UnlinkAppBodySchema,
} from '../settings.js';

const APP = 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6B';
const KEY = 'mcp.c0123456789.list_issues';
const NOW = '2026-11-21T12:00:00.000Z';

describe('settings shapes', () => {
  it('TOOL_KEY_RE is the same literal as mcp-client CONNECTOR_TOOL_KEY_RE', () => {
    expect(TOOL_KEY_RE.source).toBe('^mcp\\.(c[0-9a-f]{10})\\.([\\x21-\\x7e]{1,128})$');
    expect(TOOL_KEY_RE.flags).toBe('');
    expect(TOOL_KEY_RE.test(KEY)).toBe(true);
    for (const bad of ['mcp.c012345678.x', 'mcp.C0123456789.x', 'mcp.c0123456789.a b', 'mcp.c0123456789.', `mcp.c0123456789.${'x'.repeat(129)}`]) {
      expect(TOOL_KEY_RE.test(bad), bad).toBe(false);
    }
  });

  it('pins the routes, limits and error table', () => {
    expect(MAX_GRANT_TOOLS).toBe(200);
    expect(SETTINGS_BODY_MAX_BYTES).toBe(16_384);
    expect(APPS_SETTINGS_ROUTES).toEqual({
      read: '/settings/apps/:agentId',
      linkCode: '/settings/apps/:agentId/link-code',
      unlink: '/settings/apps/:agentId/unlink',
      grant: '/settings/apps/:agentId/grant',
      ungrant: '/settings/apps/:agentId/ungrant',
      revoke: '/settings/apps/:agentId/revoke',
      approval: '/settings/app-approval/:platformId/:appId/:connectorId',
    });
    expect(SETTINGS_ERRORS).toEqual({
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
    });
  });

  it('approve page paths round-trip and reject everything else', () => {
    expect(APPROVE_PAGE_PREFIX).toBe('/apps/approve/');
    const path = approvePagePath('canopy', APP, 'linear');
    expect(path).toBe(`/apps/approve/canopy/${APP}/linear`);
    expect(parseApprovePagePath(path)).toEqual({ platformId: 'canopy', appId: APP, connectorId: 'linear' });
    for (const bad of [
      `${path}/`,
      `${path}/extra`,
      `/apps/approve/canopy/${APP}`,
      `/apps/approve/canopy%2F${APP}/linear`,
      `/apps/approve/canopy/${APP}/lin%65ar`,
      `${path}?x=1`,
      `${path}#x`,
      `/apps/approve/Canopy/${APP}/linear`,
      `/apps/approve/canopy/a.b/linear`,
      `/apps/approve/canopy/${APP}/_linear`,
      `/apps/approve/canopy//linear`,
      `/apps/approve/canopy/../linear`,
      `/apps/approve//${APP}/linear`,
      `/x/apps/approve/canopy/${APP}/linear`,
      `apps/approve/canopy/${APP}/linear`,
      `//apps/approve/canopy/${APP}/linear`,
      '/apps/approve/',
      '',
    ]) expect(parseApprovePagePath(bad), bad).toBeNull();
    expect(() => approvePagePath('Canopy', APP, 'linear')).toThrow();
    expect(() => approvePagePath('canopy', 'a/b', 'linear')).toThrow();
    expect(() => approvePagePath('canopy', APP, '_linear')).toThrow();
    expect(() => approvePagePath('canopy', '', 'linear')).toThrow();
  });

  it('a grant body needs 1..200 tool keys of the canonical shape', () => {
    const body = { appId: APP, connectorId: 'linear', mode: 'builder', toolKeys: [KEY] };
    expect(SaveGrantBodySchema.parse(body)).toEqual(body);
    expect(SaveGrantBodySchema.safeParse({ ...body, toolKeys: [] }).success).toBe(false);
    const many = Array.from({ length: MAX_GRANT_TOOLS }, (_, i) => `mcp.c0123456789.t${i}`);
    expect(SaveGrantBodySchema.safeParse({ ...body, toolKeys: many }).success).toBe(true);
    expect(SaveGrantBodySchema.safeParse({ ...body, toolKeys: [...many, 'mcp.c0123456789.t200'] }).success).toBe(false);
    expect(SaveGrantBodySchema.safeParse({ ...body, toolKeys: ['list_issues'] }).success).toBe(false);
    expect(SaveGrantBodySchema.safeParse({ ...body, mode: 'admin' }).success).toBe(false);
    expect(SaveGrantBodySchema.safeParse({ ...body, connectorId: '_x' }).success).toBe(false);

    const grant = { connectorId: 'linear', connectorName: 'Linear', mode: 'viewer', tools: [{ toolKey: KEY, name: 'list_issues' }] };
    expect(SaveGrantResponseSchema.parse({ grant })).toEqual({ grant });
    const tools = Array.from({ length: MAX_GRANT_TOOLS + 1 }, (_, i) => ({ toolKey: `mcp.c0123456789.t${i}`, name: `t${i}` }));
    expect(AppGrantSchema.safeParse({ ...grant, tools }).success).toBe(false);
    expect(AppGrantSchema.safeParse({ ...grant, tools: tools.slice(0, MAX_GRANT_TOOLS) }).success).toBe(true);
    expect(AppGrantSchema.safeParse({ ...grant, tools: [{ toolKey: KEY, name: 'a b' }] }).success).toBe(false);
  });

  it('settings bodies are strict', () => {
    const bodies = [
      [LinkCodeBodySchema, {}],
      [UnlinkAppBodySchema, { appId: APP }],
      [SaveGrantBodySchema, { appId: APP, connectorId: 'linear', mode: 'viewer', toolKeys: [KEY] }],
      [AppConnectorBodySchema, { appId: APP, connectorId: 'linear' }],
      [ApproveBodySchema, { agentId: 'agent-1', tools: ['list_issues'] }],
    ] as const;
    for (const [schema, body] of bodies) {
      expect(schema.safeParse(body).success).toBe(true);
      expect(schema.safeParse({ ...body, extra: 1 }).success).toBe(false);
    }
    expect(ApproveBodySchema.safeParse({ agentId: '', tools: [] }).success).toBe(false);
    expect(ApproveBodySchema.safeParse({ agentId: 'a'.repeat(257), tools: [] }).success).toBe(false);
    // The tools the page showed: required, tool names, at most a grant's worth.
    expect(ApproveBodySchema.safeParse({ agentId: 'agent-1' }).success).toBe(false);
    expect(ApproveBodySchema.safeParse({ agentId: 'agent-1', tools: ['a b'] }).success).toBe(false);
    const names = Array.from({ length: MAX_GRANT_TOOLS + 1 }, (_, i) => `t${i}`);
    expect(ApproveBodySchema.safeParse({ agentId: 'agent-1', tools: names }).success).toBe(false);
    expect(ApproveBodySchema.safeParse({ agentId: 'agent-1', tools: names.slice(0, MAX_GRANT_TOOLS) }).success).toBe(true);
    expect(UnlinkAppBodySchema.safeParse({ appId: 'a b' }).success).toBe(false);
  });

  it('a link code answer carries a well-formed code and an ISO expiry', () => {
    const code = `axl_${'a'.repeat(32)}`;
    expect(LinkCodeResponseSchema.safeParse({ code, expiresAt: NOW }).success).toBe(true);
    expect(LinkCodeResponseSchema.safeParse({ code: 'axl_x', expiresAt: NOW }).success).toBe(false);
    expect(LinkCodeResponseSchema.safeParse({ code, expiresAt: 'tomorrow' }).success).toBe(false);
    expect(LinkCodeResponseSchema.safeParse({ code, expiresAt: NOW, extra: 1 }).success).toBe(false);
  });

  it('the Apps read is off, or the full closed shape', () => {
    expect(AgentAppsReadSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(AgentAppsReadSchema.safeParse({ enabled: false, links: [] }).success).toBe(false);
    const grant = { connectorId: 'linear', connectorName: 'Linear', mode: 'builder', tools: [{ toolKey: KEY, name: 'list_issues' }] };
    const read = {
      enabled: true,
      canManage: true,
      links: [{ appId: APP, appName: 'Expense approvals', createdAt: NOW, grants: [grant] }],
      approvals: [{ appId: APP, appName: 'Expense approvals', connectorId: 'linear', connectorName: 'Linear', createdAt: NOW }],
    };
    expect(AgentAppsReadSchema.parse(read)).toEqual(read);
    expect(AgentAppsReadSchema.safeParse({ ...read, canManage: undefined }).success).toBe(false);
    expect(AgentAppsReadSchema.safeParse({ ...read, extra: 1 }).success).toBe(false);
    expect(AgentAppsReadSchema.safeParse({ ...read, links: [{ ...read.links[0], platformId: 'canopy' }] }).success).toBe(false);
    expect(AgentAppsReadSchema.safeParse({ ...read, approvals: [{ ...read.approvals[0], createdAt: 'x' }] }).success).toBe(false);
  });

  it('an approval prompt is the closed shape', () => {
    const prompt = {
      platformId: 'canopy', appId: APP, appName: 'Expense approvals', connectorId: 'linear', connectorName: 'Linear',
      tools: ['list_issues'], agents: [{ agentId: 'agent-1', displayName: 'Juniper' }], approvedAgentId: null,
    };
    expect(ApprovalPromptSchema.parse(prompt)).toEqual(prompt);
    expect(ApprovalPromptSchema.safeParse({ ...prompt, approvedAgentId: 'agent-1' }).success).toBe(true);
    expect(ApprovalPromptSchema.safeParse({ ...prompt, approvedAgentId: undefined }).success).toBe(false);
    expect(ApprovalPromptSchema.safeParse({ ...prompt, platformId: 'Canopy' }).success).toBe(false);
    expect(ApprovalPromptSchema.safeParse({ ...prompt, tools: ['a b'] }).success).toBe(false);
    expect(ApprovalPromptSchema.safeParse({ ...prompt, agents: [{ agentId: '', displayName: 'x' }] }).success).toBe(false);
    expect(ApprovalPromptSchema.safeParse({ ...prompt, agents: [{ agentId: 'a', displayName: 'x', ownerId: 'u' }] }).success).toBe(false);
    expect(ApprovalPromptSchema.safeParse({ ...prompt, extra: 1 }).success).toBe(false);
  });
});
