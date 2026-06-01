import { describe, it, expect } from 'vitest';
import {
  accountRef,
  serviceTagForSlot,
  deriveCredentialPlan,
  requiresSharedKeyConsent,
  sharedKeyConsentMessage,
  SHARED_KEY_CONSENT_COPY,
  emptyCapabilities,
  type Connector,
} from '../connectors';

/**
 * Drift / behavior guard for the client-side re-declaration of TASK-96's
 * credential-plan derivation (source of truth: `@ax/connectors`
 * `credential-plan.ts`). A runtime cross-plugin import of `@ax/connectors` is
 * forbidden (eslint invariant I2 — it is NOT on the allowlist), so — exactly as
 * `lib/credentials.ts` re-declares `refForDestination` — these functions are
 * copied locally and pinned here. If the canonical derivation in `@ax/connectors`
 * ever changes the scope mapping, ref shape, consent rule, or consent COPY, this
 * test and that module must be updated together.
 */

function connector(overrides: Partial<Connector>): Connector {
  return {
    id: 'c1',
    name: 'C1',
    description: '',
    usageNote: '',
    keyMode: 'personal',
    visibility: 'private',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    capabilities: emptyCapabilities(),
    defaultAttached: false,
    ...overrides,
  };
}

describe('connector credential-plan derivation (TASK-96 parity, local re-decl)', () => {
  it('accountRef builds the account:<service> vault ref', () => {
    expect(accountRef('salesforce')).toBe('account:salesforce');
  });

  it('serviceTagForSlot prefers the slot account, falls back to connectorId', () => {
    expect(
      serviceTagForSlot({ slot: 'token', kind: 'api-key', account: 'gmail' }, 'my-conn'),
    ).toBe('gmail');
    expect(serviceTagForSlot({ slot: 'token', kind: 'api-key' }, 'my-conn')).toBe('my-conn');
    // Empty-string account falls back too (mirrors the >0-length guard upstream).
    expect(
      serviceTagForSlot({ slot: 'token', kind: 'api-key', account: '' }, 'my-conn'),
    ).toBe('my-conn');
  });

  describe('deriveCredentialPlan — keyMode → scope', () => {
    it('personal keyMode → scope:user, one entry per credential slot, account:<service> ref', () => {
      const c = connector({
        id: 'my-notion',
        keyMode: 'personal',
        capabilities: {
          ...emptyCapabilities(),
          credentials: [{ slot: 'token', kind: 'api-key', account: 'notion' }],
        },
      });
      expect(deriveCredentialPlan(c)).toEqual([
        { slot: 'token', scope: 'user', ref: 'account:notion' },
      ]);
    });

    it('workspace keyMode → scope:global', () => {
      const c = connector({
        id: 'company-sf',
        keyMode: 'workspace',
        capabilities: {
          ...emptyCapabilities(),
          credentials: [{ slot: 'sf-key', kind: 'api-key' }],
        },
      });
      expect(deriveCredentialPlan(c)).toEqual([
        { slot: 'sf-key', scope: 'global', ref: 'account:company-sf' },
      ]);
    });

    it('a connector with no credential slots yields an empty plan', () => {
      expect(deriveCredentialPlan(connector({}))).toEqual([]);
    });
  });

  describe('requiresSharedKeyConsent — the "act as you" gate', () => {
    it('personal + private → false (you only ever act as yourself)', () => {
      expect(
        requiresSharedKeyConsent(connector({ keyMode: 'personal', visibility: 'private' })),
      ).toBe(false);
    });
    it('workspace → true (one key, every allowed agent spends it)', () => {
      expect(
        requiresSharedKeyConsent(connector({ keyMode: 'workspace', visibility: 'private' })),
      ).toBe(true);
    });
    it('shared visibility → true (bound to a shared/team agent)', () => {
      expect(
        requiresSharedKeyConsent(connector({ keyMode: 'personal', visibility: 'shared' })),
      ).toBe(true);
    });
  });

  describe('consent copy — the security-relevant contract', () => {
    it('pins the EXACT shared-key consent copy', () => {
      expect(SHARED_KEY_CONSENT_COPY).toBe(
        "Sharing this key lets their assistant act as you on %SERVICE%. They can't copy the key — but they can use it.",
      );
    });
    it('fills the %SERVICE% placeholder', () => {
      expect(sharedKeyConsentMessage('Salesforce')).toBe(
        "Sharing this key lets their assistant act as you on Salesforce. They can't copy the key — but they can use it.",
      );
    });
  });
});
