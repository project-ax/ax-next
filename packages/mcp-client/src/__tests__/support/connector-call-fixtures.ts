import { createLogger, makeAgentContext, type AgentContext } from '@ax/core';
import type { ConnectorCallBus } from '../../connector-inventory/connector-call.js';

// ---------------------------------------------------------------------------
// Fixtures for the hooks built on the shared connector-call core
// (connector-call.ts): `connectors:call-tool-result` and, side by side with
// it, `connectors:call-tool`.
//
// Copied from connector-call-tool.test.ts (its `linear()`, `effective()`,
// `EFFECTIVE`, `AGENT_ROW`, `CREDENTIALS` and fake bus), which keeps its own
// copy: that file is the regression net for the extraction and is not edited
// here. Folding it onto this module is a follow-up.
// ---------------------------------------------------------------------------

export const USER = 'owner-1';
export const AGENT = 'agent-1';
/** linear's `main` server: the one the call names. */
export const NS = 'c0123456789';
/** linear's `docs` server: same connector, other server, its own key. */
export const NS_DOCS = 'c00000000aa';
/** Another connector the agent also has. */
export const NS_OTHER = 'cfedcba9876';
export const MAIN_URL = 'https://mcp.linear.app/mcp';
export const DOCS_URL = 'https://docs.linear.app/mcp';
export const TOKEN = 'tok-SECRET-main';
export const DOCS_KEY = 'key-SECRET-docs';
export const TOOL_KEY = `mcp.${NS}.save_comment`;

export type Json = Record<string, unknown>;

/** `connectors:resolve`'s answer for linear: two servers, each with its own credential. */
export function linear(over: { capabilities?: Json; toolNamespaces?: unknown; credentialPlan?: unknown } = {}) {
  return {
    id: 'linear',
    keyMode: 'personal',
    usageNote: '',
    capabilities: {
      allowedHosts: ['docs.linear.app', 'mcp.linear.app'],
      credentials: [
        { slot: 'docs-key', kind: 'api-key', headerName: 'X-Docs-Key', server: 'docs' },
        { slot: 'token', kind: 'oauth', server: 'main' },
      ],
      mcpServers: [
        { name: 'docs', transport: 'http', url: DOCS_URL, allowedHosts: ['docs.linear.app'], credentials: [] },
        { name: 'main', transport: 'http', url: MAIN_URL, allowedHosts: ['mcp.linear.app'], credentials: [] },
      ],
      packages: { npm: [], pypi: [] },
      services: [],
      ...over.capabilities,
    },
    credentialPlan: over.credentialPlan ?? [
      { slot: 'docs-key', scope: 'agent', ref: 'account:linear:docs-key', service: 'linear', slotTag: 'docs-key' },
      { slot: 'token', scope: 'agent', ref: 'account:linear:token', service: 'linear', slotTag: 'token' },
    ],
    toolNamespaces: over.toolNamespaces ?? [
      { server: 'docs', toolNamespace: NS_DOCS },
      { server: 'main', toolNamespace: NS },
    ],
  };
}

/** One `connectors:list-effective` entry. */
export function effective(id: string, toolNamespaces: Array<{ server: string; toolNamespace: string }>) {
  return {
    summary: {
      id,
      name: id,
      description: '',
      usageNote: '',
      keyMode: 'personal',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      canEdit: true,
      requiresAttachment: true,
    },
    source: 'attached',
    capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] }, services: [] },
    toolNamespaces,
  };
}

/** The agent's effective set: linear is second, so a "first entry" shortcut is wrong. */
export const EFFECTIVE = () => ({
  connectors: [
    effective('github', [{ server: 'gh', toolNamespace: NS_OTHER }]),
    effective('linear', [
      { server: 'docs', toolNamespace: NS_DOCS },
      { server: 'main', toolNamespace: NS },
    ]),
  ],
});

export const AGENT_ROW = () => ({
  agent: {
    id: AGENT,
    ownerId: USER,
    ownerType: 'user',
    connectorAttachments: ['github', 'linear'],
    connectorExclusions: ['old-crm'],
  },
});

export const CREDENTIALS: Record<string, string> = {
  'account:linear:token': TOKEN,
  'account:linear:docs-key': DOCS_KEY,
};

export interface BusSetup {
  agentsResolve?: () => unknown;
  listEffective?: () => unknown;
  /** Default true. */
  hasListEffective?: boolean;
  resolve?: () => unknown;
  credential?: (ref: string) => unknown;
  /** How far the clock moves while each hook is being answered. */
  clockJumps?: Partial<Record<string, number>>;
}

/**
 * A bus that answers the four hooks the core reads, records every call, and
 * moves a fake clock (`now`) as each hook is answered.
 */
export function fakeConnectorBus(s: BusSetup = {}) {
  let clock = 1_800_000_000_000;
  const calls: Array<{ hook: string; ctx: AgentContext; input: unknown }> = [];
  const bus: ConnectorCallBus = {
    async call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O> {
      calls.push({ hook, ctx, input });
      clock += s.clockJumps?.[hook] ?? 0;
      switch (hook) {
        case 'agents:resolve':
          return (s.agentsResolve ?? AGENT_ROW)() as O;
        case 'connectors:list-effective':
          return (s.listEffective ?? EFFECTIVE)() as O;
        case 'connectors:resolve':
          return (s.resolve ?? (() => linear()))() as O;
        case 'credentials:get': {
          const { ref } = input as { ref: string };
          return (s.credential ?? ((r: string) => CREDENTIALS[r]))(ref) as O;
        }
        default:
          throw new Error(`unexpected hook ${hook}`);
      }
    },
    hasService: (hook) => hook !== 'connectors:list-effective' || s.hasListEffective !== false,
  };
  return { bus, calls, hooks: () => calls.map((c) => c.hook), now: () => clock };
}

/** A logger whose lines land, parsed, in `logs`. */
export function captureLogs() {
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({ reqId: 'r', writer: (line) => logs.push(JSON.parse(line) as Record<string, unknown>) });
  const ctx = (over: Partial<{ userId: string; agentId: string }> = {}) =>
    makeAgentContext({ sessionId: 'apps-bridge-call', userId: USER, agentId: AGENT, logger, ...over });
  return { logs, logger, ctx };
}

export const payload = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  agentId: AGENT,
  toolKey: TOOL_KEY,
  input: { issueId: 'ENG-1', body: 'Shipped' },
  ...over,
});

export const FAILED = (reason: string) => ({ outcome: 'failed', reason });
