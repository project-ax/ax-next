import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createToolConnectorProposePlugin } from '../plugin.js';
import { CONNECTOR_PROPOSE_TOOL_NAME } from '../descriptor.js';

const EXECUTE_HOOK = `tool:execute:${CONNECTOR_PROPOSE_TOOL_NAME}` as const;

interface InstallAuthoredCall {
  ownerUserId: string;
  agentId: string;
  connectorId: string;
  name: string;
  hosts: string[];
  slots: unknown[];
  packages?: unknown;
  mcpServers?: unknown[];
  usageNote?: string;
  keyMode: string;
}

/**
 * A bus with the tool-dispatcher (`tool:register`) + a stub
 * `connectors:install-authored` hook. The stub records the input and returns the
 * pending verdict, unless `installThrows` is set (to exercise error mapping).
 */
function busWithStubs(
  opts: { installThrows?: PluginError | null; registerInstall?: boolean } = {},
) {
  const bus = new HookBus();
  const registered: string[] = [];
  const installCalls: InstallAuthoredCall[] = [];
  bus.registerService('tool:register', 'disp', async (_c, d: unknown) => {
    registered.push((d as { name: string }).name);
    return { ok: true };
  });
  if (opts.registerInstall !== false) {
    bus.registerService(
      'connectors:install-authored',
      'connectors',
      async (_c, input: unknown) => {
        if (opts.installThrows) throw opts.installThrows;
        const i = input as InstallAuthoredCall;
        installCalls.push(i);
        return { connectorId: i.connectorId, status: 'pending' as const };
      },
    );
  }
  return { bus, registered, installCalls };
}

const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent_1', userId: 'user_1' });

async function init(bus: HookBus): Promise<void> {
  const plugin = createToolConnectorProposePlugin();
  await plugin.init({ bus, config: {} });
}

async function callTool(bus: HookBus, input: unknown): Promise<unknown> {
  return bus.call(EXECUTE_HOOK, ctx, { id: 't1', name: CONNECTOR_PROPOSE_TOOL_NAME, input });
}

describe('@ax/tool-connector-propose — plugin', () => {
  it('registers the descriptor + the execute hook on init', async () => {
    const { bus, registered } = busWithStubs();
    await init(bus);
    expect(registered).toContain(CONNECTOR_PROPOSE_TOOL_NAME);
    expect(bus.hasService(EXECUTE_HOOK)).toBe(true);
  });

  it('forwards a valid draft to connectors:install-authored with ctx-derived scope', async () => {
    const { bus, installCalls } = busWithStubs();
    await init(bus);
    const out = (await callTool(bus, {
      connectorId: 'salesforce',
      name: 'Salesforce',
      hosts: ['login.salesforce.com'],
      slots: [{ slot: 'SF_API_KEY', kind: 'api-key' }],
      packages: { npm: ['@salesforce/cli'] },
      usageNote: 'Drive the sf CLI.',
      keyMode: 'workspace',
    })) as { connectorId: string; status: string };

    expect(out).toEqual({ connectorId: 'salesforce', status: 'pending' });
    expect(installCalls).toHaveLength(1);
    const c = installCalls[0]!;
    // Scope comes from the trusted ctx, NOT the model input (a runner can't
    // author into a foreign agent).
    expect(c.ownerUserId).toBe('user_1');
    expect(c.agentId).toBe('agent_1');
    expect(c.connectorId).toBe('salesforce');
    expect(c.keyMode).toBe('workspace');
    expect(c.hosts).toEqual(['login.salesforce.com']);
  });

  it('rejects a missing/blank connectorId BEFORE calling the hook', async () => {
    const { bus, installCalls } = busWithStubs();
    await init(bus);
    await expect(callTool(bus, { name: 'X', keyMode: 'personal' })).rejects.toThrow();
    await expect(callTool(bus, { connectorId: '   ', name: 'X', keyMode: 'personal' })).rejects.toThrow();
    expect(installCalls).toHaveLength(0);
  });

  it('rejects a missing name and a missing/invalid keyMode before the hook', async () => {
    const { bus, installCalls } = busWithStubs();
    await init(bus);
    await expect(callTool(bus, { connectorId: 'x', keyMode: 'personal' })).rejects.toThrow();
    await expect(callTool(bus, { connectorId: 'x', name: 'X' })).rejects.toThrow();
    await expect(
      callTool(bus, { connectorId: 'x', name: 'X', keyMode: 'bogus' }),
    ).rejects.toThrow();
    expect(installCalls).toHaveLength(0);
  });

  it('maps a hook structural-validation PluginError to a clean model-safe error (no message echo)', async () => {
    // The id passes THIS tool's loose local check but the (stubbed) hook rejects
    // it — exercising the hook-error → model-safe-message mapping path.
    const secretMessage = 'internal: connector_id grammar rejected SECRET-DETAIL';
    const { bus } = busWithStubs({
      installThrows: new PluginError({
        code: 'invalid-payload',
        plugin: '@ax/connectors',
        message: secretMessage,
      }),
    });
    await init(bus);
    await expect(
      callTool(bus, { connectorId: 'ok-id', name: 'X', keyMode: 'personal' }),
    ).rejects.toThrow(/connector draft is invalid/i);
    // I9: the plugin-supplied message is never echoed to the model.
    await expect(
      callTool(bus, { connectorId: 'ok-id', name: 'X', keyMode: 'personal' }),
    ).rejects.not.toThrow(/SECRET-DETAIL/);
  });

  it('rejects an UNBOUND session (ipc-server placeholder owner) before calling the hook', async () => {
    const { bus, installCalls } = busWithStubs();
    await init(bus);
    const unboundUser = makeAgentContext({ sessionId: 's', agentId: 'agent_1', userId: 'ipc-server' });
    const unboundAgent = makeAgentContext({ sessionId: 's', agentId: 'ipc-server', userId: 'user_1' });
    const valid = { connectorId: 'salesforce', name: 'Salesforce', keyMode: 'workspace' };
    await expect(
      bus.call(EXECUTE_HOOK, unboundUser, { id: 't', name: CONNECTOR_PROPOSE_TOOL_NAME, input: valid }),
    ).rejects.toThrow(/not bound to a user\+agent/i);
    await expect(
      bus.call(EXECUTE_HOOK, unboundAgent, { id: 't', name: CONNECTOR_PROPOSE_TOOL_NAME, input: valid }),
    ).rejects.toThrow(/not bound to a user\+agent/i);
    expect(installCalls).toHaveLength(0);
  });

  it('propagates a NON-structural hook error (e.g. forbidden) unchanged for host redaction', async () => {
    const { bus } = busWithStubs({
      installThrows: new PluginError({
        code: 'forbidden',
        plugin: '@ax/connectors',
        message: 'nope',
      }),
    });
    await init(bus);
    await expect(
      callTool(bus, { connectorId: 'ok-id', name: 'X', keyMode: 'personal' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
