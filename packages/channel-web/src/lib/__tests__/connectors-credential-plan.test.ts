import { describe, it, expect } from 'vitest';
import {
  accountRef,
  serviceTagForSlot,
  deriveCredentialPlan,
  requiresSharedKeyConsent,
  sharedKeyConsentMessage,
  SHARED_KEY_CONSENT_COPY,
  emptyCapabilities,
  mechanismHint,
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

  // TASK-124 — a supplied slot expands the ref to the per-slot form.
  it('accountRef builds account:<service>:<slot> when a slot is supplied', () => {
    expect(accountRef('salesforce', 'CLIENT_ID')).toBe('account:salesforce:CLIENT_ID');
  });

  it('serviceTagForSlot always returns the connectorId (each connector owns its own key)', () => {
    expect(serviceTagForSlot({ slot: 'token', kind: 'api-key' }, 'my-conn')).toBe('my-conn');
  });

  describe('deriveCredentialPlan — keyMode → scope', () => {
    it('personal keyMode → scope:user, one entry per credential slot, account:<connectorId> ref', () => {
      const c = connector({
        id: 'my-notion',
        keyMode: 'personal',
        capabilities: {
          ...emptyCapabilities(),
          credentials: [{ slot: 'token', kind: 'api-key' }],
        },
      });
      expect(deriveCredentialPlan(c)).toEqual([
        // Single-slot connector keeps the collapsed ref + `service`, keyed by the
        // connector id (no share-by-service).
        { slot: 'token', scope: 'user', ref: 'account:my-notion', service: 'my-notion' },
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
        { slot: 'sf-key', scope: 'global', ref: 'account:company-sf', service: 'company-sf' },
      ]);
    });

    it('a connector with no credential slots yields an empty plan', () => {
      expect(deriveCredentialPlan(connector({}))).toEqual([]);
    });

    // TASK-124 — parity with @ax/connectors: ≥2 slots derive a distinct per-slot
    // ref each (the collision fix), and the structured slotTag is carried so the
    // connect dialog builds `{kind:'account', service, slot}` without ref parsing.
    it('multi-slot connector → distinct account:<service>:<slot> per slot (collision fix)', () => {
      const c = connector({
        id: 'oauthsvc',
        keyMode: 'personal',
        capabilities: {
          ...emptyCapabilities(),
          credentials: [
            { slot: 'CLIENT_ID', kind: 'api-key' },
            { slot: 'CLIENT_SECRET', kind: 'api-key' },
          ],
        },
      });
      expect(deriveCredentialPlan(c)).toEqual([
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
    });

    it('single-slot connector carries no slotTag (drives the collapsed destination)', () => {
      const c = connector({
        id: 'gh',
        capabilities: {
          ...emptyCapabilities(),
          credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
        },
      });
      const plan = deriveCredentialPlan(c);
      expect(plan[0]).not.toHaveProperty('slotTag');
      expect(plan[0]!.service).toBe('gh');
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

  // TASK-132 — the per-slot field's mechanism hint MUST be truthful per mechanism
  // (it tells the user where their secret actually lands: an env var, an HTTP
  // header, or a request-auth field). A connector's mechanism is connector-level
  // — keyed off the single leading mcpServer's transport (the same model the
  // admin Connector registry form edits), or Direct API when there's no MCP
  // backing at all.
  describe('mechanismHint — truthful per mechanism', () => {
    it('stdio MCP → "env var"', () => {
      const c = connector({
        capabilities: {
          ...emptyCapabilities(),
          mcpServers: [
            {
              name: 's',
              transport: 'stdio',
              command: 'foo',
              allowedHosts: [],
              credentials: [],
            },
          ],
        },
      });
      expect(mechanismHint(c)).toBe('env var');
    });

    it('http MCP → "header"', () => {
      const c = connector({
        capabilities: {
          ...emptyCapabilities(),
          mcpServers: [
            {
              name: 's',
              transport: 'http',
              url: 'https://example.com',
              allowedHosts: ['example.com'],
              credentials: [],
            },
          ],
        },
      });
      expect(mechanismHint(c)).toBe('header');
    });

    it('no MCP backing (Direct API) → "request auth"', () => {
      const c = connector({
        capabilities: {
          ...emptyCapabilities(),
          allowedHosts: ['api.example.com'],
          credentials: [{ slot: 'API_KEY', kind: 'api-key' }],
        },
      });
      expect(mechanismHint(c)).toBe('request auth');
    });
  });
});
