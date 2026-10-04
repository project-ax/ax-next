import { describe, it, expect } from 'vitest';
import { makeAgentContext, type AgentContext, type HookBus, type Logger } from '@ax/core';
import { authorizeGlobalAccountRead } from '../credential-authz.js';
import type { AvailableConnector, ConnectorStore } from '../store.js';
import type { Connector } from '../types.js';

// ---------------------------------------------------------------------------
// TASK-797 — global read of a connector's OAuth CLIENT SECRET.
//
// `credentials:authorize-global:account` as a pure function over a fake store
// and a fake `auth:get-user` (no database). The store's `getSoleSharedById`
// selection (shared + unambiguous + what this user resolves) is tested against
// real postgres in store.test.ts; this file pins what the rule does with its
// answer. On main every case here was a deny (the client secret is not in the
// credential plan), so the allow case is the one that fails unfixed; the deny
// cases are pinned so the new allow cannot widen.
// ---------------------------------------------------------------------------

const REF = 'account:gmail:OAUTH_CLIENT_SECRET';

function ctx(): AgentContext {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return makeAgentContext({ sessionId: 's', agentId: '', userId: 'signer', logger });
}

function connector(overrides: Partial<Connector> = {}, credentials?: unknown[]): Connector {
  return {
    id: 'gmail',
    name: 'Gmail',
    keyMode: 'personal',
    visibility: 'shared',
    capabilities: {
      allowedHosts: ['mcp.example.com'],
      credentials: credentials ?? [
        {
          slot: 'GMAIL',
          kind: 'oauth',
          server: 'gmail',
          clientId: 'admin-client',
          clientRegistration: 'custom',
          clientSecretRef: REF,
        },
      ],
      mcpServers: [
        { name: 'gmail', transport: 'http', url: 'https://mcp.example.com/mcp', allowedHosts: [], credentials: [] },
      ],
      packages: { npm: [], pypi: [] },
      services: [],
    },
    ...overrides,
  } as unknown as Connector;
}

interface Calls {
  sole: Array<[string, string]>;
  available: Array<[string, string]>;
}

function fakeStore(
  sole: AvailableConnector | null | Error,
  available: AvailableConnector | null = null,
): { store: ConnectorStore; calls: Calls } {
  const calls: Calls = { sole: [], available: [] };
  const fail = (): never => {
    throw new Error('unexpected store call');
  };
  const store = {
    listForUser: fail,
    listDefaults: fail,
    getByIdNotDeleted: fail,
    listAvailable: fail,
    upsert: fail,
    softDelete: fail,
    async getAvailableById(userId: string, connectorId: string) {
      calls.available.push([userId, connectorId]);
      return available;
    },
    async getSoleSharedById(userId: string, connectorId: string) {
      calls.sole.push([userId, connectorId]);
      if (sole instanceof Error) throw sole;
      return sole;
    },
  } as unknown as ConnectorStore;
  return { store, calls };
}

function fakeBus(users: Record<string, { isAdmin: boolean } | null>, hasAuth = true): HookBus {
  return {
    hasService: (name: string) => name === 'auth:get-user' && hasAuth,
    call: async (name: string, _ctx: AgentContext, input: { userId: string }) => {
      if (name !== 'auth:get-user') throw new Error(`unexpected call ${name}`);
      return users[input.userId] ?? null;
    },
  } as unknown as HookBus;
}

const ADMIN_OWNED = (c: Connector = connector()): AvailableConnector => ({
  connector: c,
  ownerUserId: 'admin',
});

describe('TASK-797: global read of an OAuth client secret', () => {
  it('allows a non-admin signer to read an admin-owned SHARED connector\'s exact client-secret ref (fails on main)', async () => {
    const { store, calls } = fakeStore(ADMIN_OWNED());
    const out = await authorizeGlobalAccountRead(store, fakeBus({ admin: { isAdmin: true } }), ctx(), {
      userId: 'signer',
      ref: REF,
    });
    expect(out).toEqual({ allowed: true });
    // Decided by the shared-connector predicate, never by the owned-or-shared pick.
    expect(calls.sole).toEqual([['signer', 'gmail']]);
    expect(calls.available).toEqual([]);
  });

  it('denies when the user does not resolve the ONE shared definition (private, or two sharers)', async () => {
    const { store, calls } = fakeStore(null, ADMIN_OWNED());
    const out = await authorizeGlobalAccountRead(store, fakeBus({ admin: { isAdmin: true } }), ctx(), {
      userId: 'signer',
      ref: REF,
    });
    expect(out).toEqual({ allowed: false });
    // The workspace-key rule (getAvailableById) is NOT consulted for this ref.
    expect(calls.available).toEqual([]);
  });

  it('denies when the owner is not an admin', async () => {
    const { store } = fakeStore({ connector: connector(), ownerUserId: 'mallory' });
    const out = await authorizeGlobalAccountRead(
      store,
      fakeBus({ admin: { isAdmin: true }, mallory: { isAdmin: false } }),
      ctx(),
      { userId: 'signer', ref: REF },
    );
    expect(out).toEqual({ allowed: false });
  });

  it('denies when the owner no longer exists or there is no auth provider', async () => {
    const gone = fakeStore(ADMIN_OWNED());
    expect(
      await authorizeGlobalAccountRead(gone.store, fakeBus({}), ctx(), { userId: 'signer', ref: REF }),
    ).toEqual({ allowed: false });
    const noAuth = fakeStore(ADMIN_OWNED());
    expect(
      await authorizeGlobalAccountRead(noAuth.store, fakeBus({ admin: { isAdmin: true } }, false), ctx(), {
        userId: 'signer',
        ref: REF,
      }),
    ).toEqual({ allowed: false });
  });

  it('denies when no OAuth slot names exactly this ref', async () => {
    const other = connector({}, [
      { slot: 'GMAIL', kind: 'oauth', server: 'gmail', clientId: 'c', clientSecretRef: 'account:gmail:OTHER' },
    ]);
    const none = connector({}, [{ slot: 'GMAIL', kind: 'oauth', server: 'gmail' }]);
    for (const c of [other, none]) {
      const { store } = fakeStore(ADMIN_OWNED(c));
      expect(
        await authorizeGlobalAccountRead(store, fakeBus({ admin: { isAdmin: true } }), ctx(), {
          userId: 'signer',
          ref: REF,
        }),
      ).toEqual({ allowed: false });
    }
  });

  it('denies when the ref is ALSO a credential-plan slot (it would reach the credential proxy)', async () => {
    // Two non-header slots → per-slot refs, so the api-key slot's ref is the client-secret ref.
    // keyMode workspace: the TASK-697 rule alone would have granted this ref at global.
    const colliding = connector({ keyMode: 'workspace' } as Partial<Connector>, [
      { slot: 'GMAIL', kind: 'oauth', server: 'gmail', clientId: 'c', clientSecretRef: REF },
      { slot: 'OAUTH_CLIENT_SECRET', kind: 'api-key' },
    ]);
    const { store } = fakeStore(ADMIN_OWNED(colliding), ADMIN_OWNED(colliding));
    expect(
      await authorizeGlobalAccountRead(store, fakeBus({ admin: { isAdmin: true } }), ctx(), {
        userId: 'signer',
        ref: REF,
      }),
    ).toEqual({ allowed: false });
  });

  it('denies (fails closed) when the store throws', async () => {
    const { store } = fakeStore(new Error('db down'));
    expect(
      await authorizeGlobalAccountRead(store, fakeBus({ admin: { isAdmin: true } }), ctx(), {
        userId: 'signer',
        ref: REF,
      }),
    ).toEqual({ allowed: false });
  });

  it('matches the ref EXACTLY: near-miss refs are never granted by the client-secret rule', async () => {
    // A connector whose secret ref uses a longer tag the TASK-712 grammar allows.
    const longer = connector({}, [
      { slot: 'GMAIL', kind: 'oauth', server: 'gmail', clientId: 'c', clientSecretRef: 'account:gmail:OAUTH_CLIENT_SECRET_X' },
    ]);
    const nearMisses = [
      'account:gmail:OAUTH_CLIENT_SECRET_X', // suffix — the connector even names it
      'account:gmail:oauth_client_secret', // case
      'account:gmail:XOAUTH_CLIENT_SECRET', // prefix
      'account:gmail', // the token ref
    ];
    for (const ref of nearMisses) {
      const { store, calls } = fakeStore(ADMIN_OWNED(longer), ADMIN_OWNED(longer));
      expect(
        await authorizeGlobalAccountRead(store, fakeBus({ admin: { isAdmin: true } }), ctx(), {
          userId: 'signer',
          ref,
        }),
      ).toEqual({ allowed: false });
      expect(calls.sole).toEqual([]);
    }
    // And a connector that names the exact ref does not open a near miss of it.
    const { store } = fakeStore(ADMIN_OWNED(), ADMIN_OWNED());
    expect(
      await authorizeGlobalAccountRead(store, fakeBus({ admin: { isAdmin: true } }), ctx(), {
        userId: 'signer',
        ref: 'account:gmail:OAUTH_CLIENT_SECRET_X',
      }),
    ).toEqual({ allowed: false });
  });

  it('leaves other refs on the TASK-697 workspace-key rule', async () => {
    // A differently tagged ref is not a client secret: the shared-connector
    // predicate is not asked, the owned-or-shared pick is.
    const { store, calls } = fakeStore(ADMIN_OWNED(), null);
    const out = await authorizeGlobalAccountRead(store, fakeBus({ admin: { isAdmin: true } }), ctx(), {
      userId: 'signer',
      ref: 'account:gmail:SOMETHING_ELSE',
    });
    expect(out).toEqual({ allowed: false });
    expect(calls.sole).toEqual([]);
    expect(calls.available).toEqual([['signer', 'gmail']]);
  });
});
