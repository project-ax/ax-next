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
  it('uses the slot account when present (share-by-service)', () => {
    expect(serviceTagForSlot({ slot: 'X', kind: 'api-key', account: 'google' }, 'gdrive')).toBe(
      'google',
    );
  });
  it('falls back to the connector id when the slot has no account', () => {
    expect(serviceTagForSlot({ slot: 'X', kind: 'api-key' }, 'salesforce')).toBe('salesforce');
  });
});

describe('accountRef', () => {
  it('builds the account:<service> vault ref', () => {
    expect(accountRef('google')).toBe('account:google');
  });
});

describe('deriveCredentialPlan — personal keyMode binds the per-user vault (scope=user)', () => {
  it('maps each slot to scope=user, ref=account:<service>', () => {
    const plan = deriveCredentialPlan(
      connector({
        keyMode: 'personal',
        capabilities: {
          allowedHosts: [],
          credentials: [{ slot: 'SF_TOKEN', kind: 'api-key', account: 'salesforce' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    expect(plan).toEqual([{ slot: 'SF_TOKEN', scope: 'user', ref: 'account:salesforce' }]);
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
    expect(plan).toEqual([{ slot: 'SF_TOKEN', scope: 'user', ref: 'account:salesforce' }]);
  });
});

describe('deriveCredentialPlan — workspace keyMode spends the single company key (scope=global)', () => {
  it('maps each slot to scope=global, ref=account:<service>', () => {
    const plan = deriveCredentialPlan(
      connector({
        keyMode: 'workspace',
        capabilities: {
          allowedHosts: [],
          credentials: [{ slot: 'SF_TOKEN', kind: 'api-key', account: 'salesforce' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      }),
    );
    expect(plan).toEqual([{ slot: 'SF_TOKEN', scope: 'global', ref: 'account:salesforce' }]);
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

  it('produces one plan entry per declared slot, preserving order', () => {
    const plan = deriveCredentialPlan(
      connector({
        keyMode: 'personal',
        capabilities: {
          allowedHosts: [],
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
      { slot: 'A', scope: 'user', ref: 'account:svc-a' },
      { slot: 'B', scope: 'user', ref: 'account:salesforce' },
    ]);
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
