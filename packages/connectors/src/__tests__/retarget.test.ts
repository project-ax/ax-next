import { describe, expect, it } from 'vitest';
import { pointsSomewhereNew, type RetargetSubject } from '../retarget.js';
import type { Capabilities, KeyMode } from '../types.js';

// ---------------------------------------------------------------------------
// TASK-887 — when does an edit point a connector "somewhere new"? Pure table,
// no harness. @ax/channel-web keeps a copy of this rule (lib/connector-form.ts)
// and its contract test (src/__tests__/connector-retarget-contract.test.ts)
// runs this same table through both copies: change a row here, change it there.
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
// ...and a second server under that server's name, after it.
const docsWithInnerTwin = edit(docsWithInner, (c) => {
  c.mcpServers.push({ name: 'docs', transport: 'http', url: ELSEWHERE_URL, allowedHosts: [], credentials: [] });
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
  // The write schema allows a repeated server name. At run time a slot's
  // credential goes only to the FIRST server carrying that name (the session
  // proxy, the host-side header builder and sign-in all bind to it), so the
  // rule binds each slot to that first server's address: putting a twin ahead
  // of it, or dropping it, re-points every stored credential. The rule also
  // keeps a fact per same-name server, a deliberately cautious extra: it may
  // warn about a twin that never gets the credential, and can't miss one that
  // would.
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
  ['linear: [A, B] same-name servers kept as they are', linearWithTwin, linearWithTwin, false],
  [
    'linear: [A, B] same-name servers swapped to [B, A]',
    linearWithTwin,
    edit(linearWithTwin, (c) => {
      c.mcpServers.reverse();
    }),
    true,
  ],
  [
    'linear: [A, B] same-name servers → [B] (the first one dropped)',
    linearWithTwin,
    edit(linearWithTwin, (c) => {
      c.mcpServers.shift();
    }),
    true,
  ],
  [
    'linear: [A, B] same-name servers → [A] (the second one dropped)',
    linearWithTwin,
    edit(linearWithTwin, (c) => {
      c.mcpServers.pop();
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
  // ...and, like a top-level slot, follows the FIRST server with that name.
  [
    'server-level slot: its server and a same-name server swapped',
    docsWithInnerTwin,
    edit(docsWithInnerTwin, (c) => {
      c.mcpServers.reverse();
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

describe('pointsSomewhereNew (TASK-887)', () => {
  it.each(rows)('%s', (_name, before, after, expected) => {
    expect(pointsSomewhereNew(before, after)).toBe(expected);
  });
});
