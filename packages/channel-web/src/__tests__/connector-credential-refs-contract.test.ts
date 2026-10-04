import { describe, expect, it } from 'vitest';
import { connectorCredentialSlots } from '@ax/chat-orchestrator';
import { CapabilitiesSchema, deriveCredentialPlan, type Connector } from '@ax/connectors';
import { credentialChecks } from '../server/routes-workspace.js';

/**
 * Contract (TASK-807): the host's connector skip and the rail's needs-sign-in
 * state ask the vault about the SAME credential refs.
 *
 * WHY THIS EXISTS. "Which vault refs does this connector spend" is derived in
 * THREE places, because invariant 2 keeps the plugins from importing one
 * another and each one needs the answer at its own hop:
 *
 *   - @ax/connectors `deriveCredentialPlan`           the connect flow WRITES
 *     these rows, and the vault's global-read authz consults the same plan;
 *   - @ax/channel-web `credentialChecks`              the rail's `credentials:has`
 *     presence read (needs-sign-in) and the attach gate. It runs this package's
 *     LOCAL copy of the plan (`lib/connectors.ts`), not the @ax/connectors one;
 *   - @ax/chat-orchestrator `connectorCredentialSlots` the host's pre-turn skip
 *     (TASK-806) and the credential map handed to `proxy:open-session`.
 *
 * If they drift the person is told the wrong thing: the rail says "signed in"
 * while the turn quietly skips the connector, or the rail says "sign in" for a
 * connector that works. Nothing else compares them. Each copy has its own test
 * with its own hand-picked cases (`connectors-credential-plan.test.ts`,
 * `connector-union.test.ts`), so a case one author thought of and the other did
 * not stays invisible. This file runs ONE table through all three.
 *
 * THE INPUT IS WHAT THE STORE EMITS. Every fixture goes through
 * `CapabilitiesSchema` (the schema `connectors:list-effective` and
 * `connectors:resolve` parse with) before any derivation sees it. That matters
 * for one shape: a legacy `account` tag on an api-key slot is STRIPPED on read,
 * and the host's `slotDef.account ?? c.id` fallback never fires because of it.
 * A fixture that skipped the parse would "find" a drift no real connector can
 * have; one that parses will fail loudly if the schema ever starts keeping it.
 * The contract therefore holds for store-parsed input only. A host path that
 * folded connector capabilities WITHOUT that parse could reach the `account`
 * fallback, and this file would not see it (it always parses).
 *
 * THE ONE DOCUMENTED DIFFERENCE (TASK-797). The host drops a slot whose ref is
 * `account:<id>:OAUTH_CLIENT_SECRET`: that ref is where an OAuth client secret
 * lives, it is used host-side only, and it must never reach the credential
 * proxy. The plan keeps the slot on purpose, so the vault's global-read rule
 * can see that the ref is a slot and refuse it. So the contract is
 * "host == rail minus that suffix", asserted below for every case, and nothing
 * else is allowed to differ. Consequence worth knowing: a connector that names
 * an api-key slot `OAUTH_CLIENT_SECRET` and never stores a value shows
 * needs-sign-in / add-key on the rail while the host keeps it and runs the turn.
 * That is the fixture pinned below; if the owner wants the rail to stop asking,
 * filter it in `credentialChecks` and drop the `hostRefs` override.
 *
 * WHY IT LIVES HERE. CI's PR test job runs the packages a PR changes plus the
 * packages that depend on them (`pnpm --filter "...[BASE]"`, devDependencies
 * included). A PR that edits only @ax/connectors or only @ax/chat-orchestrator
 * selects @ax/channel-web through the two devDependencies this file adds, so
 * the guard fires for whichever side drifts. Test-only peer imports are what
 * `credentials-refs-drift.test.ts` already does, and the `no-restricted-imports`
 * block in eslint.config.mjs exempts `src/__tests__/**`.
 */

const CLIENT_SECRET_SUFFIX = ':OAUTH_CLIENT_SECRET';
const SERVER = 'srv';
const KEY_MODES = ['personal', 'workspace'] as const;
type KeyMode = (typeof KEY_MODES)[number];

type RawSlot = Record<string, unknown>;

const sortedUnique = (refs: readonly string[]): string[] => [...new Set(refs)].sort();
const withoutClientSecret = (refs: readonly string[]): string[] =>
  refs.filter((ref) => !ref.endsWith(CLIENT_SECRET_SUFFIX));

/** Run one connector through all three derivations. Refs only, sorted + deduped
 *  (order is not part of the contract; the set of rows asked about is). */
function derive(id: string, keyMode: KeyMode, credentials: RawSlot[]) {
  const capabilities = CapabilitiesSchema.parse({
    allowedHosts: [],
    credentials,
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  });
  return {
    // `deriveCredentialPlan` reads only id, keyMode and capabilities.credentials.
    connectors: sortedUnique(
      deriveCredentialPlan({ id, keyMode, capabilities } as Connector).map((entry) => entry.ref),
    ),
    rail: sortedUnique(credentialChecks({ id, keyMode, capabilities }).map((c) => c.ref)),
    host: sortedUnique(connectorCredentialSlots({ id, capabilities }).map((s) => s.ref)),
  };
}

interface Fixture {
  name: string;
  id: string;
  credentials: RawSlot[];
  /** The rows the connect flow writes and the rail asks about. */
  refs: string[];
  /** Only where the host legitimately asks about fewer rows (TASK-797). */
  hostRefs?: string[];
}

const FIXTURES: Fixture[] = [
  {
    name: 'single OAuth slot',
    id: 'gmail',
    credentials: [{ slot: 'TOKEN', kind: 'oauth', server: SERVER }],
    refs: ['account:gmail'],
  },
  {
    name: 'single API key',
    id: 'notion',
    credentials: [{ slot: 'NOTION_TOKEN', kind: 'api-key' }],
    refs: ['account:notion'],
  },
  {
    name: 'two API keys (multi-slot expands to a ref per slot)',
    id: 'oauthsvc',
    credentials: [
      { slot: 'CLIENT_ID', kind: 'api-key' },
      { slot: 'CLIENT_SECRET', kind: 'api-key' },
    ],
    refs: ['account:oauthsvc:CLIENT_ID', 'account:oauthsvc:CLIENT_SECRET'],
  },
  {
    name: 'header key alone (a header slot is per-slot even when it is the only one)',
    id: 'linear',
    credentials: [{ slot: 'API_KEY', kind: 'api-key', headerName: 'X-Api-Key', server: SERVER }],
    refs: ['account:linear:API_KEY'],
  },
  {
    name: 'two header keys (neither counts toward the multi-slot threshold)',
    id: 'twohdr',
    credentials: [
      { slot: 'A', kind: 'api-key', headerName: 'X-A', server: SERVER },
      { slot: 'B', kind: 'api-key', headerName: 'X-B', server: SERVER },
    ],
    refs: ['account:twohdr:A', 'account:twohdr:B'],
  },
  {
    name: 'OAuth + header key (one non-header slot keeps the collapsed ref)',
    id: 'mixhdr',
    credentials: [
      { slot: 'TOKEN', kind: 'oauth', server: SERVER },
      { slot: 'KEY', kind: 'api-key', headerName: 'X-Key', server: SERVER },
    ],
    refs: ['account:mixhdr', 'account:mixhdr:KEY'],
  },
  {
    name: 'OAuth + plain API key (two non-header slots expand)',
    id: 'mixkey',
    credentials: [
      { slot: 'TOKEN', kind: 'oauth', server: SERVER },
      { slot: 'KEY', kind: 'api-key' },
    ],
    refs: ['account:mixkey:TOKEN', 'account:mixkey:KEY'],
  },
  {
    name: 'no credential slots',
    id: 'keyless',
    credentials: [],
    refs: [],
  },
  {
    name: 'legacy `account` tag is stripped on read, the ref is keyed by the connector id',
    id: 'my-gh',
    credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key', account: 'github' }],
    refs: ['account:my-gh'],
  },
  {
    name: 'a slot named OAUTH_CLIENT_SECRET (the one documented difference, TASK-797)',
    id: 'gmail',
    credentials: [
      { slot: 'TOKEN', kind: 'oauth', server: SERVER, clientSecretRef: 'account:gmail:OAUTH_CLIENT_SECRET' },
      { slot: 'OAUTH_CLIENT_SECRET', kind: 'api-key' },
    ],
    refs: ['account:gmail:OAUTH_CLIENT_SECRET', 'account:gmail:TOKEN'],
    hostRefs: ['account:gmail:TOKEN'],
  },
  {
    // The host's exclusion tests the REF's suffix, not the slot's name. A lone
    // slot with that name collapses to `account:<id>` (no suffix), which is that
    // slot's own key and not the client secret, so the host keeps it and every
    // copy agrees. A name-based exclusion would drop it from the host only.
    name: 'a lone slot named OAUTH_CLIENT_SECRET collapses to account:<id> and is kept',
    id: 'lonesecret',
    credentials: [{ slot: 'OAUTH_CLIENT_SECRET', kind: 'api-key' }],
    refs: ['account:lonesecret'],
  },
];

describe('connector credential refs — host skip, rail needs-sign-in and the connect flow agree', () => {
  describe.each(KEY_MODES)('keyMode %s', (keyMode) => {
    it.each(FIXTURES)('$name', (fixture) => {
      const got = derive(fixture.id, keyMode, fixture.credentials);

      // The pinned table. Without it, three copies that all return [] (or all
      // collapse every slot) would "agree" and the comparison below would
      // guard nothing.
      expect(got.connectors).toEqual(sortedUnique(fixture.refs));
      expect(got.rail).toEqual(sortedUnique(fixture.refs));
      expect(got.host).toEqual(sortedUnique(fixture.hostRefs ?? fixture.refs));

      // The contract itself, stated without the table: the host asks about
      // every row the rail asks about, minus only the client-secret ref.
      expect(got.host).toEqual(withoutClientSecret(got.rail));
      expect(got.rail).toEqual(got.connectors);
    });
  });

  it('keyMode changes the scope a key lands in, never which rows are asked about', () => {
    for (const fixture of FIXTURES) {
      const personal = derive(fixture.id, 'personal', fixture.credentials);
      const workspace = derive(fixture.id, 'workspace', fixture.credentials);
      expect(workspace, fixture.name).toEqual(personal);
    }
  });

  it('agrees on every combination of up to four slots drawn from the three slot shapes', () => {
    // The named fixtures above are the cases someone thought of. The collapse
    // rule keys on how many NON-header slots there are, and a header key flips
    // its own slot to per-slot regardless, so the interesting drift lives in the
    // mixes nobody wrote down. Enumerate them all: 1 + 3 + 9 + 27 + 81 = 121.
    const shapes: Array<(name: string) => RawSlot> = [
      (name) => ({ slot: name, kind: 'oauth', server: SERVER }),
      (name) => ({ slot: name, kind: 'api-key' }),
      (name) => ({ slot: name, kind: 'api-key', headerName: 'X-Api-Key', server: SERVER }),
    ];
    const combos: number[][] = [[]];
    for (let size = 1; size <= 4; size++) {
      for (const base of combos.filter((c) => c.length === size - 1)) {
        for (let shape = 0; shape < shapes.length; shape++) combos.push([...base, shape]);
      }
    }
    expect(combos).toHaveLength(121);

    const drifted: Array<{ shapes: number[]; connectors: string[]; rail: string[]; host: string[] }> = [];
    const forms = new Set<string>();
    for (const combo of combos) {
      const credentials = combo.map((shape, i) => shapes[shape]!(`S${i}`));
      const got = derive('sweep', 'personal', credentials);
      for (const ref of got.rail) forms.add(ref === 'account:sweep' ? 'collapsed' : 'per-slot');
      const agree =
        JSON.stringify(got.rail) === JSON.stringify(got.connectors) &&
        JSON.stringify(got.host) === JSON.stringify(withoutClientSecret(got.rail));
      if (!agree) drifted.push({ shapes: combo, ...got });
    }

    // Empty means "all 121 agree". The shape codes are 0 oauth, 1 api-key,
    // 2 header-key, listed in slot order.
    expect(drifted).toEqual([]);
    // Both ref forms were produced, so the sweep is not agreeing about nothing.
    expect([...forms].sort()).toEqual(['collapsed', 'per-slot']);
  });
});
