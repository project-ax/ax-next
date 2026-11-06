import { describe, expect, it } from 'vitest';
import {
  CapabilitiesSchema,
  pointsSomewhereNew as serverPointsSomewhereNew,
  type Capabilities,
  type KeyMode,
  type RetargetSubject,
} from '@ax/connectors';
import { pointsSomewhereNew as clientPointsSomewhereNew } from '../lib/connector-form';
import type { Connector } from '../lib/connectors';

// ---------------------------------------------------------------------------
// TASK-887 contract: the client copy of the "does this edit point a connector
// somewhere new?" rule (lib/connector-form.ts) and the server original
// (@ax/connectors retarget.ts) answer the SAME on every row of the server's
// table (packages/connectors/src/__tests__/retarget.test.ts), copied below in
// full. Change a row there, change it here.
//
// WHY IT LIVES HERE. Invariant 2 keeps channel-web from importing @ax/connectors
// at runtime, so the editors run a copy. This file (test-only, which the
// no-restricted-imports block exempts) is the only thing that compares them.
// A PR that edits only @ax/connectors selects @ax/channel-web through its
// devDependency, so the guard fires for whichever side drifts.
//
// THE INPUT IS WHAT THE STORE EMITS. Every capabilities literal goes through
// `CapabilitiesSchema.parse` before either copy sees it, as in
// connector-credential-refs-contract.test.ts, so a fixture can't "find" a drift
// no stored connector can have.
// ---------------------------------------------------------------------------

// A loose, writable view of the fixtures so a row can edit any field.
// `Capabilities.credentials` is typed api-key only (the shared skills-parser
// shape), so the literals are cast, as the other tests in this package do.
interface Slot {
  slot: string;
  kind: 'api-key' | 'oauth';
  server?: string;
  headerName?: string;
  scopes?: string[];
  clientId?: string;
  clientRegistration?: 'auto' | 'cimd' | 'dcr' | 'custom';
  clientSecretRef?: string;
  authServerUrl?: string;
  tokenUrl?: string;
}
interface Server {
  name: string;
  transport: 'http';
  url?: string;
  allowedHosts: string[];
  credentials: Slot[];
}
interface Caps {
  allowedHosts: string[];
  credentials: Slot[];
  mcpServers: Server[];
  packages: { npm: string[]; pypi: string[] };
  services: unknown[];
}

function subject(id: string, keyMode: KeyMode, capabilities: Caps): RetargetSubject {
  return { id, keyMode, capabilities: capabilities as unknown as Capabilities };
}

/** A deep copy of `s` with `change` applied to its capabilities. */
function edit(s: RetargetSubject, change: (caps: Caps) => void): RetargetSubject {
  const copy = structuredClone(s);
  change(copy.capabilities as unknown as Caps);
  return copy;
}

const LINEAR_URL = 'https://mcp.linear.app/mcp';
const ELSEWHERE_URL = 'https://elsewhere.example/mcp';

/** Personal OAuth, with a pinned client and its own client secret. */
function linear(): RetargetSubject {
  return subject('linear', 'personal', {
    allowedHosts: ['mcp.linear.app'],
    credentials: [
      {
        slot: 'MCP_OAUTH',
        kind: 'oauth',
        server: 'linear',
        clientId: 'cid',
        clientSecretRef: 'account:linear:OAUTH_CLIENT_SECRET',
      },
    ],
    mcpServers: [
      { name: 'linear', transport: 'http', url: LINEAR_URL, allowedHosts: ['mcp.linear.app'], credentials: [] },
    ],
    packages: { npm: [], pypi: [] },
    services: [],
  });
}

/** Workspace (shared key), sent as a request header to its server. */
function crm(): RetargetSubject {
  return subject('crm', 'workspace', {
    allowedHosts: ['mcp.crm.example'],
    credentials: [{ slot: 'HEADER_1', kind: 'api-key', headerName: 'X-Api-Key', server: 'crm' }],
    mcpServers: [
      {
        name: 'crm',
        transport: 'http',
        url: 'https://mcp.crm.example/mcp',
        allowedHosts: ['mcp.crm.example'],
        credentials: [],
      },
    ],
    packages: { npm: [], pypi: [] },
    services: [],
  });
}

/** Personal CLI: an env key, bound to the top-level allowed hosts. */
function sf(): RetargetSubject {
  return subject('sf', 'personal', {
    allowedHosts: ['login.salesforce.com'],
    credentials: [{ slot: 'SF_TOKEN', kind: 'api-key' }],
    mcpServers: [],
    packages: { npm: ['@salesforce/cli'], pypi: [] },
    services: [],
  });
}

/** An MCP server that needs no key. */
function docs(): RetargetSubject {
  return subject('docs', 'personal', {
    allowedHosts: ['mcp.docs.example'],
    credentials: [],
    mcpServers: [
      {
        name: 'docs',
        transport: 'http',
        url: 'https://mcp.docs.example/mcp',
        allowedHosts: ['mcp.docs.example'],
        credentials: [],
      },
    ],
    packages: { npm: [], pypi: [] },
    services: [],
  });
}

/**
 * Two slots that share ONE name: a header key, then an env key. The write
 * schema allows it, and the runtime then binds by position: the session fold
 * keeps only the first slot of a name, and the host-side header builder takes
 * the first plan ref of a name.
 */
function dup(): RetargetSubject {
  return subject('dup', 'personal', {
    allowedHosts: ['api.dup.example'],
    credentials: [
      { slot: 'KEY', kind: 'api-key', headerName: 'X-Key', server: 'dup' },
      { slot: 'KEY', kind: 'api-key' },
    ],
    mcpServers: [
      { name: 'dup', transport: 'http', url: 'https://mcp.dup.example/mcp', allowedHosts: [], credentials: [] },
    ],
    packages: { npm: [], pypi: [] },
    services: [],
  });
}

const linearWithEu = edit(linear(), (c) => {
  c.mcpServers.push({
    name: 'linear-eu',
    transport: 'http',
    url: 'https://mcp.eu.linear.app/mcp',
    allowedHosts: [],
    credentials: [],
  });
});
const linearWithCopy = edit(linear(), (c) => {
  c.mcpServers.push({ name: 'linear-copy', transport: 'http', url: LINEAR_URL, allowedHosts: [], credentials: [] });
});
const linearWithTokenUrl = edit(linear(), (c) => {
  c.credentials[0]!.tokenUrl = 'https://linear.app/oauth/token';
});
const linearWithTeamHeader = edit(linear(), (c) => {
  c.credentials.push({ slot: 'HEADER_1', kind: 'api-key', headerName: 'X-Team', server: 'linear' });
});
const linearWithTwin = edit(linear(), (c) => {
  // A second server under the SAME name as the one the OAuth slot names.
  c.mcpServers.push({ name: 'linear', transport: 'http', url: ELSEWHERE_URL, allowedHosts: [], credentials: [] });
});
// A server-level slot and no top-level slot, so only the server-level fact moves.
const docsWithInner = edit(docs(), (c) => {
  c.mcpServers[0]!.credentials.push({ slot: 'INNER', kind: 'api-key', headerName: 'X-Inner' });
});
const crmWithTwoHeaders = edit(crm(), (c) => {
  c.credentials.push({ slot: 'HEADER_2', kind: 'api-key', headerName: 'X-Org', server: 'crm' });
});
const crmWithEu = edit(crm(), (c) => {
  c.mcpServers.push({
    name: 'crm-eu',
    transport: 'http',
    url: 'https://mcp.eu.crm.example/mcp',
    allowedHosts: [],
    credentials: [],
  });
});
const sfWithTwoHosts = edit(sf(), (c) => {
  c.allowedHosts.push('test.salesforce.com');
});
const sfWithTwoSlots = edit(sf(), (c) => {
  c.credentials.push({ slot: 'SF_INSTANCE_URL', kind: 'api-key' });
});

const rows: Array<[name: string, before: RetargetSubject, after: RetargetSubject, expected: boolean]> = [
  ['identical', linear(), linear(), false],

  // -- an OAuth server's address --
  [
    'linear url → https://elsewhere.example/mcp (kept name)',
    linear(),
    edit(linear(), (c) => {
      c.mcpServers[0]!.url = ELSEWHERE_URL;
    }),
    true,
  ],
  [
    'linear url path only → https://mcp.linear.app/v2/mcp',
    linear(),
    edit(linear(), (c) => {
      c.mcpServers[0]!.url = 'https://mcp.linear.app/v2/mcp';
    }),
    true,
  ],
  [
    'linear server renamed linear2, slot server follows, same url',
    linear(),
    edit(linear(), (c) => {
      c.mcpServers[0]!.name = 'linear2';
      c.credentials[0]!.server = 'linear2';
    }),
    false,
  ],
  [
    'linear: second server added at a new url, no slot names it',
    linear(),
    edit(linear(), (c) => {
      c.mcpServers.push({ name: 'extra', transport: 'http', url: ELSEWHERE_URL, allowedHosts: [], credentials: [] });
    }),
    false,
  ],
  [
    'linear: server and its slot removed',
    linear(),
    edit(linear(), (c) => {
      c.mcpServers = [];
      c.credentials = [];
    }),
    false,
  ],
  [
    'two servers; oauth slot re-pointed to the one with a different url',
    linearWithEu,
    edit(linearWithEu, (c) => {
      c.credentials[0]!.server = 'linear-eu';
    }),
    true,
  ],
  [
    'two servers with the same url; oauth slot re-pointed between them',
    linearWithCopy,
    edit(linearWithCopy, (c) => {
      c.credentials[0]!.server = 'linear-copy';
    }),
    false,
  ],
  // The host-side header builder (@ax/mcp-client connector-headers.ts) sends a
  // slot's credential to EVERY server carrying the slot's server name, not just
  // the first, and the write schema allows a repeated server name.
  ['linear: a second server added under the oauth slot’s server name, at a new url', linear(), linearWithTwin, true],
  ['linear: that duplicate-name server removed again', linearWithTwin, linear(), false],
  [
    'linear: a duplicate-name server added at the SAME url',
    linear(),
    edit(linear(), (c) => {
      c.mcpServers.push({ name: 'linear', transport: 'http', url: LINEAR_URL, allowedHosts: [], credentials: [] });
    }),
    false,
  ],

  // -- the OAuth slot's sign-in pins --
  [
    'linear authServerUrl added',
    linear(),
    edit(linear(), (c) => {
      c.credentials[0]!.authServerUrl = 'https://auth.elsewhere.example';
    }),
    true,
  ],
  [
    'linear tokenUrl changed',
    linearWithTokenUrl,
    edit(linearWithTokenUrl, (c) => {
      c.credentials[0]!.tokenUrl = 'https://auth.elsewhere.example/token';
    }),
    true,
  ],
  [
    'linear clientSecretRef removed (canonical → absent)',
    linear(),
    edit(linear(), (c) => {
      delete c.credentials[0]!.clientSecretRef;
    }),
    false,
  ],
  [
    'linear clientSecretRef → account:linear:HEADER_1',
    linear(),
    edit(linear(), (c) => {
      c.credentials[0]!.clientSecretRef = 'account:linear:HEADER_1';
    }),
    true,
  ],
  [
    'linear scopes changed',
    linear(),
    edit(linear(), (c) => {
      c.credentials[0]!.scopes = ['read', 'write'];
    }),
    false,
  ],
  [
    'linear clientId changed',
    linear(),
    edit(linear(), (c) => {
      c.credentials[0]!.clientId = 'another-client';
    }),
    false,
  ],
  [
    'linear clientRegistration changed',
    linear(),
    edit(linear(), (c) => {
      c.credentials[0]!.clientRegistration = 'dcr';
    }),
    false,
  ],
  [
    'linear allowedHosts gains auth.linear.app (OAuth-only connector)',
    linear(),
    edit(linear(), (c) => {
      c.allowedHosts.push('auth.linear.app');
    }),
    false,
  ],

  // -- a header key --
  [
    'crm headerName → Authorization',
    crm(),
    edit(crm(), (c) => {
      c.credentials[0]!.headerName = 'Authorization';
    }),
    true,
  ],
  ['crm header slot added', crm(), crmWithTwoHeaders, true],
  ['crm header slot removed', crmWithTwoHeaders, crm(), false],
  [
    'crm header slot re-pointed to a second server with another url',
    crmWithEu,
    edit(crmWithEu, (c) => {
      c.credentials[0]!.server = 'crm-eu';
    }),
    true,
  ],
  [
    'slot kind oauth → api-key, same slot name',
    linear(),
    edit(linear(), (c) => {
      c.credentials = [{ slot: 'MCP_OAUTH', kind: 'api-key', headerName: 'Authorization', server: 'linear' }];
    }),
    true,
  ],

  // -- an env key and its hosts --
  ['sf host added', sf(), sfWithTwoHosts, true],
  ['sf host removed', sfWithTwoHosts, sf(), false],
  [
    'sf package added',
    sf(),
    edit(sf(), (c) => {
      c.packages.npm.push('jsforce');
    }),
    false,
  ],
  [
    'sf services added',
    sf(),
    edit(sf(), (c) => {
      c.services.push({
        name: 'db',
        image: `postgres@sha256:${'a'.repeat(64)}`,
        ports: [5432],
        env: {},
        writablePaths: [],
      });
    }),
    false,
  ],
  ['sf with two env slots → one removed (ref collapses to account:sf)', sfWithTwoSlots, sf(), true],

  // -- no key at all --
  [
    'no-credential connector url changed',
    docs(),
    edit(docs(), (c) => {
      c.mcpServers[0]!.url = 'https://mcp.docs2.example/mcp';
    }),
    false,
  ],

  // -- server-level slots and hosts (no consumer today) --
  [
    'server-level slot added',
    linear(),
    edit(linear(), (c) => {
      c.mcpServers[0]!.credentials.push({ slot: 'INNER', kind: 'api-key', headerName: 'X-Inner' });
    }),
    true,
  ],
  [
    'server-level host added',
    linear(),
    edit(linear(), (c) => {
      c.mcpServers[0]!.allowedHosts.push('other.linear.app');
    }),
    false,
  ],
  // The same name rule as a top-level slot: a server-level slot follows its
  // server's name, so a twin under that name is somewhere new.
  [
    'server-level slot: a second server added under its server’s name, at a new url',
    docsWithInner,
    edit(docsWithInner, (c) => {
      c.mcpServers.push({ name: 'docs', transport: 'http', url: ELSEWHERE_URL, allowedHosts: [], credentials: [] });
    }),
    true,
  ],

  // -- slot order --
  [
    'slots with distinct names re-ordered',
    linearWithTeamHeader,
    edit(linearWithTeamHeader, (c) => {
      c.credentials.reverse();
    }),
    false,
  ],
  // A repeated slot name binds by position (see `dup`), so moving one of them
  // changes which stored key goes where.
  [
    'two slots share a name: their order swapped',
    dup(),
    edit(dup(), (c) => {
      c.credentials.reverse();
    }),
    true,
  ],
  [
    'two slots share a name: removing the first lets the second take effect',
    dup(),
    edit(dup(), (c) => {
      c.credentials.shift();
    }),
    true,
  ],
];

/** What the store emits for `s`: its capabilities, schema-parsed. */
function parsed(s: RetargetSubject): RetargetSubject {
  return { id: s.id, keyMode: s.keyMode, capabilities: CapabilitiesSchema.parse(s.capabilities) };
}

type ClientSubject = Pick<Connector, 'id' | 'keyMode' | 'capabilities'>;
const asClient = (s: RetargetSubject): ClientSubject => s as unknown as ClientSubject;

describe('pointsSomewhereNew: client copy === server original (TASK-887)', () => {
  it.each(rows)('%s', (_name, rawBefore, rawAfter, expected) => {
    const before = parsed(rawBefore);
    const after = parsed(rawAfter);
    const server = serverPointsSomewhereNew(before, after);
    const client = clientPointsSomewhereNew(asClient(before), asClient(after));
    expect(server).toBe(expected);
    expect(client).toBe(server);
  });
});

// ---------------------------------------------------------------------------
// THE TABLE ABOVE ONLY PINS THE PAIRS SOMEONE THOUGHT OF. Every row is one
// hand-picked before/after, so a future drift in a fact no row exercises (a
// field one copy stops reading, say) passes. This walks EVERY ordered
// before × after pair of the same connector id, drawn from both sides of every
// row, and asks only that the two copies agree. It needs no expected value, so
// a fixture added to the table above joins the sweep for free.
// ---------------------------------------------------------------------------

/** Every distinct (by content) subject in the table, grouped by connector id. */
function subjectsById(): Map<string, RetargetSubject[]> {
  const byId = new Map<string, Map<string, RetargetSubject>>();
  for (const [, rawBefore, rawAfter] of rows) {
    for (const raw of [rawBefore, rawAfter]) {
      const s = parsed(raw);
      const group = byId.get(s.id) ?? new Map<string, RetargetSubject>();
      group.set(JSON.stringify([s.keyMode, s.capabilities]), s);
      byId.set(s.id, group);
    }
  }
  return new Map([...byId].map(([id, group]) => [id, [...group.values()]]));
}

describe('pointsSomewhereNew: client copy === server original over every same-id pair (TASK-887)', () => {
  it('agrees on every before × after pair drawn from the table’s fixtures', () => {
    let pairs = 0;
    const disagreements: string[] = [];
    for (const [id, group] of subjectsById()) {
      for (const before of group) {
        for (const after of group) {
          pairs++;
          const server = serverPointsSomewhereNew(before, after);
          const client = clientPointsSomewhereNew(asClient(before), asClient(after));
          if (client !== server) {
            disagreements.push(
              `${id}: server=${server} client=${client}\n  before=${JSON.stringify(before.capabilities)}\n  after=${JSON.stringify(after.capabilities)}`,
            );
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
    // Non-vacuous: the sweep visited a lot of pairs.
    expect(pairs).toBeGreaterThan(200);
    console.info(`[contract] same-id pairs checked: ${pairs}`);
  });
});
