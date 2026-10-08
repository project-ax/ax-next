import { describe, it, expect } from 'vitest';
import { makeAgentContext, type AgentContext, type HookBus, type Logger } from '@ax/core';
import { probeConnector } from '../admin-routes.js';
import { purgeConnectorState, type PurgeableConnector } from '../purge.js';
import type { Connector } from '../types.js';

// ---------------------------------------------------------------------------
// Agent-owned sign-ins, slice 5: connector keys are never stored per PERSON.
//
// A `personal` connector's keys live on each agent it is added to, so:
//   - the admin's Test probe has no agent to check and must not fall back to
//     the admin's own (user-scope) vault — it reports `needs-key` and reads
//     nothing;
//   - a delete never deletes a user-scope row, and `credentials:purge-account`
//     never asks for `'user'`.
//
// Pure functions over a recording fake bus (no database), so these run without
// Docker. The Postgres-backed suites (admin-routes, hooks, sweeps) pin the same
// behaviour end to end.
// ---------------------------------------------------------------------------

function ctx(): AgentContext {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return makeAgentContext({ sessionId: 's', agentId: '', userId: 'admin', logger });
}

interface Call {
  name: string;
  input: unknown;
}

function recordingBus(
  rows: Array<{ scope: string; ownerId: string | null; ref: string }> = [],
): { bus: HookBus; calls: Call[] } {
  const calls: Call[] = [];
  const bus = {
    hasService: (name: string) =>
      name === 'credentials:delete' || name === 'credentials:purge-account' || name === 'credentials:list',
    call: async (name: string, _ctx: AgentContext, input: { scope?: string; ownerId?: string | null }) => {
      calls.push({ name, input });
      if (name === 'credentials:list') {
        return {
          credentials: rows.filter(
            (r) =>
              (input.scope === undefined || r.scope === input.scope) &&
              (input.ownerId === undefined || r.ownerId === input.ownerId),
          ),
        };
      }
      if (name === 'credentials:purge-account') return { purged: 0 };
      return undefined;
    },
    fire: async () => ({ rejected: false }),
  } as unknown as HookBus;
  return { bus, calls };
}

function connector(over: Partial<Connector> = {}): Connector {
  return {
    id: 'gdrive',
    name: 'Google Drive',
    description: '',
    usageNote: '',
    keyMode: 'personal',
    capabilities: {
      allowedHosts: ['drive.googleapis.com'],
      credentials: [{ slot: 'GDRIVE', kind: 'api-key' }],
      mcpServers: [
        {
          name: 'gdrive',
          transport: 'http',
          url: 'https://mcp.example.com/gdrive',
          allowedHosts: ['mcp.example.com'],
          credentials: [],
        },
      ],
      packages: { npm: [], pypi: [] },
    },
    ...over,
  } as unknown as Connector;
}

describe('probeConnector — a personal connector is never checked in the admin\'s own vault', () => {
  it('reports needs-key without reading credentials, even when the admin holds an old user-scope row', async () => {
    const { bus, calls } = recordingBus([{ scope: 'user', ownerId: 'admin', ref: 'account:gdrive' }]);
    const out = await probeConnector(connector(), { bus, ctx: ctx() });
    expect(out.status).toBe('needs-key');
    expect(out.detail).toMatch(/each agent adds its own key/i);
    expect(calls).toEqual([]);
  });

  it('a workspace connector still checks the shared (global) key', async () => {
    const { bus, calls } = recordingBus([{ scope: 'global', ownerId: null, ref: 'account:gdrive' }]);
    const out = await probeConnector(connector({ keyMode: 'workspace' }), { bus, ctx: ctx() });
    expect(out.status).toBe('reachable');
    expect(calls).toEqual([{ name: 'credentials:list', input: { scope: 'global', ownerId: null } }]);
  });

  it('a workspace connector with no shared key names the missing slot', async () => {
    const { bus } = recordingBus();
    const out = await probeConnector(connector({ keyMode: 'workspace' }), { bus, ctx: ctx() });
    expect(out).toEqual({ status: 'needs-key', detail: 'missing key for slot "GDRIVE"' });
  });
});

describe('purgeConnectorState — no user-scope deletes, no user-scope purge-account', () => {
  const OAUTH_CAPS = {
    allowedHosts: ['mcp.example.com'],
    credentials: [
      {
        slot: 'TOKEN',
        kind: 'oauth',
        server: 'gdrive',
        clientId: 'cid',
        clientRegistration: 'custom',
        clientSecretRef: 'account:gdrive:OAUTH_CLIENT_SECRET',
      },
    ],
    mcpServers: [
      { name: 'gdrive', transport: 'http', url: 'https://mcp.example.com/gdrive', allowedHosts: [], credentials: [] },
    ],
    packages: { npm: [], pypi: [] },
  };

  function opts(over: Partial<Parameters<typeof purgeConnectorState>[4]> = {}): Parameters<typeof purgeConnectorState>[4] {
    return {
      purgeGlobal: true,
      purgeAgentSignIns: true,
      agentSignInsSkipReason: 'not-authorized',
      idStillLive: false,
      announce: false,
      ...over,
    };
  }

  it('a personal connector: agents\' keys go via purge-account [agent] only; nothing is deleted per person', async () => {
    const { bus, calls } = recordingBus();
    const c = connector({ capabilities: OAUTH_CAPS } as Partial<Connector>) as PurgeableConnector;
    const { failed } = await purgeConnectorState(bus, ctx(), 'admin', c, opts());
    expect(failed).toEqual([]);
    expect(calls).toEqual([
      // The connector's client secret, at global.
      {
        name: 'credentials:delete',
        input: { scope: 'global', ownerId: null, ref: 'account:gdrive:OAUTH_CLIENT_SECRET' },
      },
      { name: 'credentials:purge-account', input: { connectorId: 'gdrive', scopes: ['agent'] } },
    ]);
  });

  it('still asks for agent scope only when the id is still live elsewhere', async () => {
    const { bus, calls } = recordingBus();
    await purgeConnectorState(bus, ctx(), 'admin', connector() as PurgeableConnector, opts({ idStillLive: true }));
    expect(calls).toEqual([
      { name: 'credentials:purge-account', input: { connectorId: 'gdrive', scopes: ['agent'] } },
    ]);
  });

  it('a workspace connector deletes its global key when authorized, and skips it when not', async () => {
    const authorized = recordingBus();
    const c = connector({ keyMode: 'workspace' }) as PurgeableConnector;
    await purgeConnectorState(authorized.bus, ctx(), 'admin', c, opts());
    expect(authorized.calls).toEqual([
      { name: 'credentials:delete', input: { scope: 'global', ownerId: null, ref: 'account:gdrive' } },
      { name: 'credentials:purge-account', input: { connectorId: 'gdrive', scopes: ['agent'] } },
    ]);

    const unauthorized = recordingBus();
    await purgeConnectorState(
      unauthorized.bus,
      ctx(),
      'admin',
      c,
      opts({ purgeGlobal: false, purgeAgentSignIns: false }),
    );
    expect(unauthorized.calls).toEqual([]);
  });

  it('no call ever names user scope', async () => {
    for (const keyMode of ['personal', 'workspace'] as const) {
      for (const idStillLive of [true, false]) {
        const { bus, calls } = recordingBus();
        const c = connector({ keyMode, capabilities: OAUTH_CAPS } as Partial<Connector>) as PurgeableConnector;
        await purgeConnectorState(bus, ctx(), 'admin', c, opts({ idStillLive }));
        expect(JSON.stringify(calls), `${keyMode}/${idStillLive}`).not.toContain('"user"');
      }
    }
  });
});
