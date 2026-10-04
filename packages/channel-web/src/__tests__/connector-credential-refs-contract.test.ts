import { describe, expect, it } from 'vitest';
import { buildAuthoredConnectorCard, connectorCredentialSlots } from '@ax/chat-orchestrator';
import { CapabilitiesSchema, deriveCredentialPlan, type Connector } from '@ax/connectors';
import { credentialChecks } from '../server/routes-workspace.js';

/**
 * Contract (TASK-807, TASK-810): every place that names a connector's vault
 * rows names the SAME rows. The two that WRITE rows agree exactly; the two
 * that ASK whether a person has set the connector up agree exactly; and the
 * askers ask about every written row except the admin's OAuth client secret.
 *
 * WHY THIS EXISTS. "Which vault refs does this connector spend" is derived in
 * THREE copies, because invariant 2 keeps the plugins from importing one
 * another and each one needs the answer at its own hop. Four consumers run them:
 *
 *   WRITERS (every slot, the client secret included)
 *   - @ax/connectors `deriveCredentialPlan`           the connect flow WRITES
 *     these rows, and the vault's global-read authz consults the same plan;
 *   - @ax/chat-orchestrator `buildAuthoredConnectorCard` the approval card for
 *     an agent-authored connector, which writes each key to
 *     `account:<service>[:<slotTag>]`. It runs the host's `connectorSlotRefs`.
 *
 *   ASKERS (every slot except `account:<id>:OAUTH_CLIENT_SECRET`)
 *   - @ax/channel-web `credentialChecks`              the rail's `credentials:has`
 *     presence read (needs-sign-in) and the attach gate. It runs this package's
 *     LOCAL copy of the plan (`lib/connectors.ts`), not the @ax/connectors one;
 *   - @ax/chat-orchestrator `connectorCredentialSlots` the host's pre-turn skip
 *     (TASK-806) and the credential map handed to `proxy:open-session`. It
 *     runs `connectorSlotRefs` too, so card and host cannot split.
 *
 * If they drift the person is told the wrong thing: the rail says "signed in"
 * while the turn quietly skips the connector, the rail says "sign in" for a
 * connector that works, or the card stores a key in a row the turn never
 * reads. Nothing else compares them. Each copy has its own test with its own
 * hand-picked cases (`connectors-credential-plan.test.ts`,
 * `connector-union.test.ts`, `connector-card.test.ts`), so a case one author
 * thought of and the other did not stays invisible. This file runs ONE table
 * through all four.
 *
 * THE INPUT IS WHAT THE STORE EMITS. Every fixture goes through
 * `CapabilitiesSchema` (the schema `connectors:list-effective`,
 * `connectors:resolve` and `connectors:list-authored` parse with) before any
 * derivation sees it. That matters for one shape: a legacy `account` tag on an
 * api-key slot is STRIPPED on read, and the `slotDef.account ?? c.id` fallback
 * in `connectorSlotRefs` never fires because of it. A fixture that skipped the
 * parse would "find" a drift no real connector can have; one that parses will
 * fail loudly if the schema ever starts keeping it. The contract therefore
 * holds for store-parsed input only. A path that folded connector capabilities
 * WITHOUT that parse could reach the `account` fallback, and this file would
 * not see it (it always parses).
 *
 * WRITERS vs ASKERS (TASK-797, TASK-810). `account:<id>:OAUTH_CLIENT_SECRET` is
 * where an admin's OAuth client secret lives. It is used host-side only, never
 * reaches the credential proxy, and nobody signs in with it — so neither asker
 * asks about it: the host would otherwise skip a working connector, and the
 * rail would say "Not signed in yet" to someone who cannot fix that. The plan
 * keeps the slot on purpose (the vault's global-read rule needs to see that the
 * ref is a slot to refuse it), and so does the card, which writes it. That is
 * one rule between two groups, applied to every fixture the same way, not a
 * per-fixture exception: the askers' rows are the writers' rows minus refs
 * with that suffix. The suffix is on the REF, not the slot name — see the
 * lone-slot fixture.
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

/** Run one connector through all four derivations. Refs only, sorted + deduped
 *  (order is not part of the contract; the set of rows asked about is). */
function derive(id: string, keyMode: KeyMode, credentials: RawSlot[]) {
  const capabilities = CapabilitiesSchema.parse({
    allowedHosts: [],
    credentials,
    mcpServers: [],
    packages: { npm: [], pypi: [] },
  });
  // `deriveCredentialPlan` reads only id, keyMode and capabilities.credentials.
  const connectors = sortedUnique(
    deriveCredentialPlan({ id, keyMode, capabilities } as Connector).map((entry) => entry.ref),
  );
  // The card's rows are the address its WRITE path builds
  // (`account:<service>[:<slotTag>]`). It is also handed the plan's refs as
  // "already vaulted", so every slot must find its own row there
  // (`haveExisting`): the read side of the same address.
  const card = buildAuthoredConnectorCard(
    { connectorId: id, name: id, proposal: capabilities, keyMode },
    new Set(connectors),
  );
  const cardSlots = card?.slots ?? [];
  return {
    connectors,
    card: sortedUnique(
      cardSlots.map((s) => `account:${s.service}${s.slotTag !== undefined ? `:${s.slotTag}` : ''}`),
    ),
    cardFoundEveryRow: cardSlots.every((s) => s.haveExisting === true),
    rail: sortedUnique(credentialChecks({ id, keyMode, capabilities }).map((c) => c.ref)),
    host: sortedUnique(connectorCredentialSlots({ id, capabilities }).map((s) => s.ref)),
  };
}

interface Fixture {
  name: string;
  id: string;
  credentials: RawSlot[];
  /** The rows the writers (connect flow, approval card) write. */
  refs: string[];
  /** The rows the askers (rail, host skip) ask about. */
  asked: string[];
}

const FIXTURES: Fixture[] = [
  {
    name: 'single OAuth slot',
    id: 'gmail',
    credentials: [{ slot: 'TOKEN', kind: 'oauth', server: SERVER }],
    refs: ['account:gmail'],
    asked: ['account:gmail'],
  },
  {
    name: 'single API key',
    id: 'notion',
    credentials: [{ slot: 'NOTION_TOKEN', kind: 'api-key' }],
    refs: ['account:notion'],
    asked: ['account:notion'],
  },
  {
    name: 'two API keys (multi-slot expands to a ref per slot)',
    id: 'oauthsvc',
    credentials: [
      { slot: 'CLIENT_ID', kind: 'api-key' },
      { slot: 'CLIENT_SECRET', kind: 'api-key' },
    ],
    refs: ['account:oauthsvc:CLIENT_ID', 'account:oauthsvc:CLIENT_SECRET'],
    asked: ['account:oauthsvc:CLIENT_ID', 'account:oauthsvc:CLIENT_SECRET'],
  },
  {
    name: 'header key alone (a header slot is per-slot even when it is the only one)',
    id: 'linear',
    credentials: [{ slot: 'API_KEY', kind: 'api-key', headerName: 'X-Api-Key', server: SERVER }],
    refs: ['account:linear:API_KEY'],
    asked: ['account:linear:API_KEY'],
  },
  {
    name: 'two header keys (neither counts toward the multi-slot threshold)',
    id: 'twohdr',
    credentials: [
      { slot: 'A', kind: 'api-key', headerName: 'X-A', server: SERVER },
      { slot: 'B', kind: 'api-key', headerName: 'X-B', server: SERVER },
    ],
    refs: ['account:twohdr:A', 'account:twohdr:B'],
    asked: ['account:twohdr:A', 'account:twohdr:B'],
  },
  {
    name: 'OAuth + header key (one non-header slot keeps the collapsed ref)',
    id: 'mixhdr',
    credentials: [
      { slot: 'TOKEN', kind: 'oauth', server: SERVER },
      { slot: 'KEY', kind: 'api-key', headerName: 'X-Key', server: SERVER },
    ],
    refs: ['account:mixhdr', 'account:mixhdr:KEY'],
    asked: ['account:mixhdr', 'account:mixhdr:KEY'],
  },
  {
    name: 'OAuth + plain API key (two non-header slots expand)',
    id: 'mixkey',
    credentials: [
      { slot: 'TOKEN', kind: 'oauth', server: SERVER },
      { slot: 'KEY', kind: 'api-key' },
    ],
    refs: ['account:mixkey:TOKEN', 'account:mixkey:KEY'],
    asked: ['account:mixkey:TOKEN', 'account:mixkey:KEY'],
  },
  {
    name: 'no credential slots',
    id: 'keyless',
    credentials: [],
    refs: [],
    asked: [],
  },
  {
    name: 'legacy `account` tag is stripped on read, the ref is keyed by the connector id',
    id: 'my-gh',
    credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key', account: 'github' }],
    refs: ['account:my-gh'],
    asked: ['account:my-gh'],
  },
  {
    name: 'the OAuth client-secret slot is written, never asked about (TASK-797, TASK-810)',
    id: 'gmail',
    credentials: [
      { slot: 'TOKEN', kind: 'oauth', server: SERVER, clientSecretRef: 'account:gmail:OAUTH_CLIENT_SECRET' },
      { slot: 'OAUTH_CLIENT_SECRET', kind: 'api-key' },
    ],
    refs: ['account:gmail:OAUTH_CLIENT_SECRET', 'account:gmail:TOKEN'],
    asked: ['account:gmail:TOKEN'],
  },
  {
    // The askers' exclusion tests the REF's suffix, not the slot's name. A lone
    // slot with that name collapses to `account:<id>` (no suffix), which is that
    // slot's own key and not the client secret, so both askers keep it and every
    // copy agrees. A name-based exclusion would drop it from an asker only.
    name: 'a lone slot named OAUTH_CLIENT_SECRET collapses to account:<id> and is kept',
    id: 'lonesecret',
    credentials: [{ slot: 'OAUTH_CLIENT_SECRET', kind: 'api-key' }],
    refs: ['account:lonesecret'],
    asked: ['account:lonesecret'],
  },
];

describe('connector credential refs — writers, the rail and the host skip agree', () => {
  describe.each(KEY_MODES)('keyMode %s', (keyMode) => {
    it.each(FIXTURES)('$name', (fixture) => {
      const got = derive(fixture.id, keyMode, fixture.credentials);

      // The pinned table. Without it, four copies that all return [] (or all
      // collapse every slot) would "agree" and the comparisons below would
      // guard nothing.
      expect(got.connectors).toEqual(sortedUnique(fixture.refs));
      expect(got.card).toEqual(sortedUnique(fixture.refs));
      expect(got.rail).toEqual(sortedUnique(fixture.asked));
      expect(got.host).toEqual(sortedUnique(fixture.asked));
      expect(got.cardFoundEveryRow).toBe(true);

      // The contract itself, stated without the table.
      expect(got.card).toEqual(got.connectors);
      expect(got.host).toEqual(got.rail);
      expect(got.rail).toEqual(withoutClientSecret(got.connectors));
    });
  });

  it('keyMode changes the scope a key lands in, never which rows are named', () => {
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

    const drifted: Array<{ shapes: number[] } & ReturnType<typeof derive>> = [];
    const forms = new Set<string>();
    for (const combo of combos) {
      const credentials = combo.map((shape, i) => shapes[shape]!(`S${i}`));
      const got = derive('sweep', 'personal', credentials);
      for (const ref of got.rail) forms.add(ref === 'account:sweep' ? 'collapsed' : 'per-slot');
      const agree =
        JSON.stringify(got.card) === JSON.stringify(got.connectors) &&
        got.cardFoundEveryRow &&
        JSON.stringify(got.host) === JSON.stringify(got.rail) &&
        JSON.stringify(got.rail) === JSON.stringify(withoutClientSecret(got.connectors));
      if (!agree) drifted.push({ shapes: combo, ...got });
    }

    // Empty means "all 121 agree". The shape codes are 0 oauth, 1 api-key,
    // 2 header-key, listed in slot order.
    expect(drifted).toEqual([]);
    // Both ref forms were produced, so the sweep is not agreeing about nothing.
    expect([...forms].sort()).toEqual(['collapsed', 'per-slot']);
  });
});
