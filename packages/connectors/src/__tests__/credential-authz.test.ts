import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PluginError, type Plugin } from '@ax/core';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createConnectorsPlugin } from '../plugin.js';
import type {
  AuthorizeGlobalInput,
  AuthorizeGlobalOutput,
  Capabilities,
  DeleteInput,
  DeleteOutput,
  KeyMode,
  UpsertInput,
  UpsertOutput,
} from '../types.js';

// ---------------------------------------------------------------------------
// TASK-697 — the `credentials:authorize-global:account` provider, driven
// straight through the bus against a real postgres testcontainer (the store
// is the real one; only `auth:get-user` is a stub).
//
// The rule under test: @ax/credentials may take the GLOBAL step for an
// `account:` ref only if the REQUESTING user owns a live connector with that
// id whose derived plan holds exactly this ref at global scope (keyMode
// 'workspace') AND that user is an admin (checked now, at read time).
//
// Every test carries a one-line "vs always-allow" note: what it does against
// a hypothetical provider that returns {allowed:true} for everything. A test
// that passes either way is a POSITIVE CONTROL (it proves the provider is not
// a deny-all) and is labelled as such; the deny cases are the ones that fail
// against always-allow.
// ---------------------------------------------------------------------------

const HOOK = 'credentials:authorize-global:account';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

/** What the stubbed `auth:get-user` does for a given user id. */
type AuthLookup = (userId: string) => unknown;
let authLookup: AuthLookup;
let authCalls: Array<{ userId: string }>;

const adminUser = (id: string): unknown => ({ id, isAdmin: true });
const plainUser = (id: string): unknown => ({ id, isAdmin: false });

function authStubPlugin(): Plugin {
  return {
    manifest: {
      name: 'auth-stub',
      version: '0.0.0',
      registers: ['auth:get-user'],
      calls: [],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService(
        'auth:get-user',
        'auth-stub',
        async (_ctx, input: { userId: string }) => {
          authCalls.push({ userId: input.userId });
          return authLookup(input.userId);
        },
      );
    },
  };
}

async function makeHarness(opts: { withAuth?: boolean } = {}): Promise<TestHarness> {
  const withAuth = opts.withAuth ?? true;
  const h = await createTestHarness({
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      ...(withAuth ? [authStubPlugin()] : []),
      createConnectorsPlugin(),
    ],
  });
  harnesses.push(h);
  return h;
}

function caps(...slots: string[]): Capabilities {
  return {
    allowedHosts: ['acme.zendesk.com'],
    credentials: slots.map((slot) => ({ slot, kind: 'api-key' as const })),
    mcpServers: [],
    packages: { npm: [], pypi: [] },
    services: [],
  };
}

async function seed(
  h: TestHarness,
  userId: string,
  connectorId: string,
  keyMode: KeyMode,
  ...slots: string[]
): Promise<void> {
  await h.bus.call<UpsertInput, UpsertOutput>(
    'connectors:upsert',
    h.ctx({ userId }),
    {
      userId,
      connectorId,
      name: connectorId,
      keyMode,
      visibility: 'private',
      capabilities: caps(...slots),
    },
  );
}

function authorize(
  h: TestHarness,
  userId: string,
  ref: string,
): Promise<AuthorizeGlobalOutput> {
  return h.bus.call<AuthorizeGlobalInput, AuthorizeGlobalOutput>(
    HOOK,
    h.ctx({ userId }),
    { userId, ref },
  );
}

const ALLOWED = { allowed: true };
const DENIED = { allowed: false };

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

beforeEach(() => {
  authCalls = [];
  authLookup = (userId) => plainUser(userId);
});

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  const cleanup = new (await import('pg')).default.Client({ connectionString });
  await cleanup.connect();
  try {
    await cleanup.query('DROP TABLE IF EXISTS connectors_v1_connectors');
  } finally {
    await cleanup.end().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('credentials:authorize-global:account — the allow path', () => {
  it('admin owner, workspace keyMode, single slot: account:<id> is allowed', async () => {
    // vs always-allow: passes either way (positive control — proves this is not a deny-all).
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');

    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(ALLOWED);
    // The provider asked the auth plugin about the REQUESTING user, nothing else.
    expect(authCalls).toEqual([{ userId: 'root' }]);
  });

  it('single slot has only the collapsed ref: a per-slot ref for it is denied', async () => {
    // vs always-allow: FAILS (always-allow would grant a ref the plan never derives).
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');

    expect(await authorize(h, 'root', 'account:zendesk:ZENDESK_API_KEY')).toEqual(DENIED);
  });

  it('admin owner, workspace, TWO slots: each per-slot ref allowed; bare and unknown refs denied', async () => {
    // vs always-allow: the two positives pass either way; the three denials FAIL against it.
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_TOKEN', 'ZENDESK_EMAIL');

    expect(await authorize(h, 'root', 'account:zendesk:ZENDESK_API_TOKEN')).toEqual(ALLOWED);
    expect(await authorize(h, 'root', 'account:zendesk:ZENDESK_EMAIL')).toEqual(ALLOWED);
    // A multi-slot connector has no collapsed ref.
    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(DENIED);
    // A slot the connector does not declare.
    expect(await authorize(h, 'root', 'account:zendesk:NOPE')).toEqual(DENIED);
    // Slot names are exact, not case-folded.
    expect(await authorize(h, 'root', 'account:zendesk:zendesk_email')).toEqual(DENIED);
  });

  it('a workspace connector with no credential slots has no ref to grant', async () => {
    // vs always-allow: FAILS (always-allow would grant a ref nothing derives).
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace');

    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(DENIED);
  });
});

describe('credentials:authorize-global:account — deny paths', () => {
  it('keyMode personal never reads global, even for an admin owner', async () => {
    // vs always-allow: FAILS. The plan derives scope "user", so no global entry exists.
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'personal', 'ZENDESK_API_KEY');
    await seed(h, 'root', 'zendesk2', 'personal', 'ZENDESK_API_TOKEN', 'ZENDESK_EMAIL');

    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(DENIED);
    expect(await authorize(h, 'root', 'account:zendesk2:ZENDESK_API_TOKEN')).toEqual(DENIED);
    expect(await authorize(h, 'root', 'account:zendesk2:ZENDESK_EMAIL')).toEqual(DENIED);
  });

  it('a non-admin owner of a workspace connector is denied (the role is checked at read time)', async () => {
    // vs always-allow: FAILS. This is the "row that got in through the un-gated admin route" case.
    authLookup = plainUser;
    const h = await makeHarness();
    await seed(h, 'mallory', 'zendesk', 'workspace', 'ZENDESK_API_KEY');

    expect(await authorize(h, 'mallory', 'account:zendesk')).toEqual(DENIED);
    // It did consult the auth plugin (the deny is the role check, not a shortcut).
    expect(authCalls).toEqual([{ userId: 'mallory' }]);
  });

  it('a user who owns no connector with that id is denied, even if another user owns a workspace one', async () => {
    // vs always-allow: FAILS. This is the ref-collision attack: same id, someone else's row.
    authLookup = (userId) => (userId === 'root' ? adminUser(userId) : plainUser(userId));
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');

    // No connector at all.
    expect(await authorize(h, 'mallory', 'account:zendesk')).toEqual(DENIED);
    // A personal connector with the same id, owned by a non-admin.
    await seed(h, 'mallory', 'zendesk', 'personal', 'ZENDESK_API_KEY');
    expect(await authorize(h, 'mallory', 'account:zendesk')).toEqual(DENIED);
    // The legitimate owner is unaffected.
    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(ALLOWED);
  });

  it('a soft-deleted connector is denied, and re-upserting it resurrects the grant', async () => {
    // vs always-allow: the denial FAILS against it; the resurrect step is a positive control.
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');
    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(ALLOWED);

    const del = await h.bus.call<DeleteInput, DeleteOutput>(
      'connectors:delete',
      h.ctx({ userId: 'root' }),
      { userId: 'root', connectorId: 'zendesk' },
    );
    expect(del.deleted).toBe(true);
    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(DENIED);

    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');
    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(ALLOWED);
  });

  it('follows a keyMode change: flipping workspace -> personal revokes the grant', async () => {
    // vs always-allow: the post-flip denial FAILS against it.
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');
    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(ALLOWED);

    await seed(h, 'root', 'zendesk', 'personal', 'ZENDESK_API_KEY');
    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(DENIED);
  });
});

describe('credentials:authorize-global:account — fail closed on the auth lookup', () => {
  it('no auth:get-user provider registered: denied', async () => {
    // vs always-allow: FAILS. Without proof the owner is an admin the company key stays closed.
    const h = await makeHarness({ withAuth: false });
    expect(h.bus.hasService('auth:get-user')).toBe(false);
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');

    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(DENIED);
  });

  it('auth:get-user returns null (unknown user): denied', async () => {
    // vs always-allow: FAILS.
    authLookup = () => null;
    const h = await makeHarness();
    await seed(h, 'ghost', 'zendesk', 'workspace', 'ZENDESK_API_KEY');

    expect(await authorize(h, 'ghost', 'account:zendesk')).toEqual(DENIED);
    expect(authCalls).toEqual([{ userId: 'ghost' }]);
  });

  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['false', false],
    ['undefined', undefined],
    ['null', null],
  ])('auth:get-user returns a user whose isAdmin is %s: denied (only boolean true counts)', async (_label, isAdmin) => {
    // vs always-allow: FAILS. Strict `=== true`, so a truthy-but-not-true value never grants.
    authLookup = (userId) => ({ id: userId, isAdmin });
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');

    expect(await authorize(h, 'root', 'account:zendesk')).toEqual(DENIED);
  });

  it('auth:get-user throws: denied, and the hook itself does not throw', async () => {
    // vs always-allow: FAILS. A lookup outage must read as "no company key", not as an error.
    authLookup = () => {
      throw new PluginError({
        code: 'unavailable',
        plugin: 'auth-stub',
        hookName: 'auth:get-user',
        message: 'auth backend down',
      });
    };
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');

    await expect(authorize(h, 'root', 'account:zendesk')).resolves.toEqual(DENIED);
  });
});

describe('credentials:authorize-global:account — malformed and out-of-namespace refs', () => {
  // An admin-owned workspace connector exists for every one of these, so the ref
  // parse plus the exact-ref match against the derived plan is all that stands
  // between the ref and a grant.
  const REFS: Array<[string, string]> = [
    ['a provider-namespace ref', 'provider:anthropic'],
    ['an empty account id', 'account:'],
    ['no colon at all', 'account'],
    ['too many segments', 'account:a:b:c'],
    ['an uppercase connector id', 'account:UPPER'],
    ['path traversal in the id', 'account:../x'],
    ['a near-miss prefix', 'accounts:zendesk'],
    ['a wrong-case prefix', 'Account:zendesk'],
    ['a leading-space ref', ' account:zendesk'],
    ['a trailing-slot-colon ref', 'account:zendesk:'],
    ['a ref over 256 chars', `account:${'a'.repeat(300)}`],
    ['an id over 128 chars', `account:${'a'.repeat(129)}`],
    ['an empty ref', ''],
  ];

  it.each(REFS)('%s is denied without throwing', async (_label, ref) => {
    // vs always-allow: FAILS for every row.
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');
    // A short-id connector too, so a ref that got truncated or split wrongly
    // would have something real to match.
    await seed(h, 'root', 'a', 'workspace', 'A_KEY');

    await expect(authorize(h, 'root', ref)).resolves.toEqual(DENIED);
  });

  it('an empty userId is denied without throwing', async () => {
    // vs always-allow: FAILS. (bus.call is given a real ctx user; only the payload userId is empty.)
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');

    await expect(
      h.bus.call<AuthorizeGlobalInput, AuthorizeGlobalOutput>(
        HOOK,
        h.ctx({ userId: 'root' }),
        { userId: '', ref: 'account:zendesk' },
      ),
    ).resolves.toEqual(DENIED);
    // A malformed request never reaches the auth plugin.
    expect(authCalls).toEqual([]);
  });

  it('non-string inputs are denied without throwing', async () => {
    // vs always-allow: FAILS. The bus does not validate inputs; the provider must.
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');
    const bad = (input: unknown): Promise<AuthorizeGlobalOutput> =>
      h.bus.call<unknown, AuthorizeGlobalOutput>(HOOK, h.ctx({ userId: 'root' }), input);

    await expect(bad({ userId: 'root', ref: 42 })).resolves.toEqual(DENIED);
    await expect(bad({ userId: 'root' })).resolves.toEqual(DENIED);
    await expect(bad({ userId: 7, ref: 'account:zendesk' })).resolves.toEqual(DENIED);
    await expect(bad({ ref: 'account:zendesk' })).resolves.toEqual(DENIED);
  });
});

describe('credentials:authorize-global:account — response shape', () => {
  it('answers exactly { allowed: boolean } on both the allow and the deny path', async () => {
    // vs always-allow: the deny half FAILS; the shape assertions pass either way.
    authLookup = adminUser;
    const h = await makeHarness();
    await seed(h, 'root', 'zendesk', 'workspace', 'ZENDESK_API_KEY');

    // bus.call already runs the registered `returns` schema; assert the surface too.
    const yes = await authorize(h, 'root', 'account:zendesk');
    const no = await authorize(h, 'root', 'account:nope');
    for (const out of [yes, no]) {
      expect(Object.keys(out)).toEqual(['allowed']);
      expect(typeof out.allowed).toBe('boolean');
    }
    expect(yes.allowed).toBe(true);
    expect(no.allowed).toBe(false);
  });
});
