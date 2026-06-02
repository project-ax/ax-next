import { describe, it, expect } from 'vitest';
import {
  deriveCredentialPlan,
  requiresSharedKeyConsent,
  serviceTagForSlot,
  accountRef,
  sharedKeyConsentMessage,
  SHARED_KEY_CONSENT_COPY,
} from '../credential-plan.js';
import type { Connector } from '../types.js';

// ---------------------------------------------------------------------------
// TASK-96 — reach-by-attachment + keyMode connect flow (design Phase 3).
//
// The credential PLAN is the keyMode→credential-scope mapping the connect flow
// (and the future credential-proxy router) routes on. Reach derives PURELY from
// where the key attaches:
//   - keyMode 'personal'  → scope 'user'   (per-user JIT account:<svc> vault)
//   - keyMode 'workspace' → scope 'global' (one admin/company key, shared)
// No credential gets a visibility flag — scope IS the reach.
// ---------------------------------------------------------------------------

function connector(over: Partial<Connector> = {}): Connector {
  return {
    id: 'salesforce',
    name: 'Salesforce',
    description: '',
    usageNote: '',
    keyMode: 'personal',
    visibility: 'private',
    capabilities: {
      allowedHosts: ['login.salesforce.com'],
      credentials: [{ slot: 'SF_TOKEN', kind: 'api-key' }],
      mcpServers: [],
      packages: { npm: ['@salesforce/cli'], pypi: [] },
    },
    createdAt: '2026-05-31T00:00:00.000Z',
    updatedAt: '2026-05-31T00:00:00.000Z',
    ...over,
  };
}

describe('serviceTagForSlot', () => {
  // Each connector owns its own key(s) — the service tag is ALWAYS the connector
  // id (no share-by-service). A legacy `account` tag on stored data is IGNORED.
  it('ignores a legacy account tag and returns the connector id', () => {
    expect(serviceTagForSlot({ slot: 'X', kind: 'api-key', account: 'google' }, 'gdrive')).toBe(
      'gdrive',
    );
  });
  it('returns the connector id when the slot has no account', () => {
    expect(serviceTagForSlot({ slot: 'X', kind: 'api-key' }, 'salesforce')).toBe('salesforce');
  });
});

describe('accountRef', () => {
  it('builds the account:<service> vault ref', () => {
    expect(accountRef('google')).toBe('account:google');
  });
  // TASK-124 — a supplied slot expands the ref to the per-slot form.
  it('builds account:<service>:<slot> when a slot is supplied', () => {
    expect(accountRef('google', 'CLIENT_ID')).toBe('account:google:CLIENT_ID');
  });
});

describe('deriveCredentialPlan — personal keyMode binds the per-user vault (scope=user)', () => {
  it('maps each slot to scope=user, ref=account:<connectorId>, ignoring a legacy account tag', () => {
    const plan = deriveCredentialPlan(
      connector({
        id: 'salesforce',
        keyMode: 'personal',
        capabilities: {
          allowedHosts: [],
          // A legacy `account` tag on stored data must be IGNORED — the key is
          // keyed by the connector id, not the tag.
          credentials: [{ slot: 'SF_TOKEN', kind: 'api-key', account: 'legacy-shared-tag' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    expect(plan).toEqual([
      { slot: 'SF_TOKEN', scope: 'user', ref: 'account:salesforce', service: 'salesforce' },
    ]);
  });

  it('uses the connector id as the service tag when a slot omits account', () => {
    const plan = deriveCredentialPlan(
      connector({
        id: 'salesforce',
        keyMode: 'personal',
        capabilities: {
          allowedHosts: [],
          credentials: [{ slot: 'SF_TOKEN', kind: 'api-key' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    expect(plan).toEqual([
      { slot: 'SF_TOKEN', scope: 'user', ref: 'account:salesforce', service: 'salesforce' },
    ]);
  });
});

describe('deriveCredentialPlan — workspace keyMode spends the single company key (scope=global)', () => {
  it('maps each slot to scope=global, ref=account:<connectorId>, ignoring a legacy account tag', () => {
    const plan = deriveCredentialPlan(
      connector({
        id: 'salesforce',
        keyMode: 'workspace',
        capabilities: {
          allowedHosts: [],
          credentials: [{ slot: 'SF_TOKEN', kind: 'api-key', account: 'legacy-shared-tag' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    expect(plan).toEqual([
      { slot: 'SF_TOKEN', scope: 'global', ref: 'account:salesforce', service: 'salesforce' },
    ]);
  });
});

describe('deriveCredentialPlan — edges', () => {
  it('returns an empty plan for a connector with no credential slots', () => {
    const plan = deriveCredentialPlan(
      connector({
        capabilities: {
          allowedHosts: ['drive.googleapis.com'],
          credentials: [],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    expect(plan).toEqual([]);
  });

  // TASK-124 — a connector with exactly ONE slot keeps the COLLAPSED ref (no
  // slotTag), byte-identical to today's behaviour. This is the back-compat
  // contract: an existing single-slot connector's stored key resolves unchanged.
  it('single-slot connector keeps the collapsed account:<service> ref (no slotTag)', () => {
    const plan = deriveCredentialPlan(
      connector({
        id: 'gh',
        keyMode: 'personal',
        capabilities: {
          allowedHosts: [],
          credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    expect(plan).toEqual([
      { slot: 'GITHUB_TOKEN', scope: 'user', ref: 'account:gh', service: 'gh' },
    ]);
    // No slotTag on a single-slot connector (drives the collapsed destination).
    expect(plan[0]).not.toHaveProperty('slotTag');
  });

  // TASK-124 — the collision fix. Two slots that BOTH fall back to the same
  // service tag (the connector id) used to collapse to ONE row and overwrite each
  // other; now each gets a distinct per-slot ref.
  it('multi-slot connector derives a distinct per-slot ref (the collision fix)', () => {
    const plan = deriveCredentialPlan(
      connector({
        id: 'oauthsvc',
        keyMode: 'personal',
        capabilities: {
          allowedHosts: [],
          credentials: [
            { slot: 'CLIENT_ID', kind: 'api-key' },
            { slot: 'CLIENT_SECRET', kind: 'api-key' },
          ],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    expect(plan).toEqual([
      {
        slot: 'CLIENT_ID',
        scope: 'user',
        ref: 'account:oauthsvc:CLIENT_ID',
        service: 'oauthsvc',
        slotTag: 'CLIENT_ID',
      },
      {
        slot: 'CLIENT_SECRET',
        scope: 'user',
        ref: 'account:oauthsvc:CLIENT_SECRET',
        service: 'oauthsvc',
        slotTag: 'CLIENT_SECRET',
      },
    ]);
    // The two refs MUST differ — the whole point of the fix.
    expect(plan[0]!.ref).not.toBe(plan[1]!.ref);
  });

  it('multi-slot connector keys every slot by the connector id, ignoring legacy account tags (no collision)', () => {
    const plan = deriveCredentialPlan(
      connector({
        id: 'gdrive',
        keyMode: 'personal',
        capabilities: {
          allowedHosts: [],
          // Slot A carries a legacy account tag; it is IGNORED — both slots key by
          // the connector id, and the per-slot ref form keeps them collision-free.
          credentials: [
            { slot: 'A', kind: 'api-key', account: 'svc-a' },
            { slot: 'B', kind: 'api-key' },
          ],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    expect(plan).toEqual([
      { slot: 'A', scope: 'user', ref: 'account:gdrive:A', service: 'gdrive', slotTag: 'A' },
      { slot: 'B', scope: 'user', ref: 'account:gdrive:B', service: 'gdrive', slotTag: 'B' },
    ]);
    expect(plan[0]!.ref).not.toBe(plan[1]!.ref);
  });
});

describe('requiresSharedKeyConsent — the act-as-you gate', () => {
  it('workspace keyMode requires consent (one key, every allowed agent spends it)', () => {
    expect(requiresSharedKeyConsent(connector({ keyMode: 'workspace', visibility: 'private' }))).toBe(
      true,
    );
  });

  it('a shared-visibility connector requires consent (bound to a shared/team agent)', () => {
    expect(requiresSharedKeyConsent(connector({ keyMode: 'personal', visibility: 'shared' }))).toBe(
      true,
    );
  });

  it('personal + private requires NO consent (you only ever act as yourself)', () => {
    expect(requiresSharedKeyConsent(connector({ keyMode: 'personal', visibility: 'private' }))).toBe(
      false,
    );
  });

  it('workspace + shared still requires consent', () => {
    expect(requiresSharedKeyConsent(connector({ keyMode: 'workspace', visibility: 'shared' }))).toBe(
      true,
    );
  });
});

describe('shared-key consent copy', () => {
  it('the template names the act-as-you risk and the can-use-not-copy distinction', () => {
    expect(SHARED_KEY_CONSENT_COPY).toContain('act as you');
    expect(SHARED_KEY_CONSENT_COPY).toContain("can't copy");
    expect(SHARED_KEY_CONSENT_COPY).toContain('use it');
  });

  it('sharedKeyConsentMessage interpolates the service name', () => {
    const msg = sharedKeyConsentMessage('Salesforce');
    expect(msg).toContain('Salesforce');
    expect(msg).toContain('act as you');
    expect(msg).toContain("can't copy");
  });
});
