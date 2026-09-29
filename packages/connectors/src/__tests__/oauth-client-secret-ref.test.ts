import { PluginError } from '@ax/core';
import { describe, expect, it } from 'vitest';
import {
  assertOwnClientSecretRefs,
  isOwnClientSecretRef,
} from '../oauth-client-secret-ref.js';

// ---------------------------------------------------------------------------
// TASK-712 — the pure grammar. The DB-backed behaviour (connectors:upsert, the
// user and admin routes, a legacy row staying readable) is in admin-routes.test.ts
// and hooks.test.ts; @ax/mcp-oauth keeps a local copy of this grammar and its
// routes.test.ts runs the same table.
// ---------------------------------------------------------------------------

describe('isOwnClientSecretRef', () => {
  it.each([
    ['account:linear:oauth-client-secret'], // what the connector edit dialog writes
    ['account:linear:OAUTH_SECRET'],
    ['account:linear:s'],
    [`account:linear:${'x'.repeat(64)}`],
  ])('accepts %j', (ref) => {
    expect(isOwnClientSecretRef('linear', ref)).toBe(true);
  });

  it.each([
    // platform-minted namespaces hold the OPERATOR's credentials
    ['provider:anthropic'],
    ['provider:probe'],
    ['mcp:linear:env:API_KEY'],
    ['mcp:linear:header:Authorization'],
    ['skill:linear:SLOT'],
    ['routine:linear:daily:hmac'],
    // an env-fallback name
    ['anthropic-api'],
    // someone else's account key, and ids that merely share our prefix
    ['account:opskey'],
    ['account:zendesk:oauth-client-secret'],
    ['account:linear-direct:oauth-client-secret'],
    ['account:linear2:oauth-client-secret'],
    // the connector's own TOKEN ref (bare), and malformed tags
    ['account:linear'],
    ['account:linear:'],
    ['account:linear:a:b'],
    ['account:linear:a.b'],
    ['account:linear:a/b'],
    ['account:linear:../x'],
    ['account:linear:-lead'],
    ['account:linear:oauth-client-secret '],
    ['account:linear: oauth-client-secret'],
    [`account:linear:${'x'.repeat(65)}`],
    ['ACCOUNT:linear:oauth-client-secret'],
    [' account:linear:oauth-client-secret'],
    ['account:LINEAR:oauth-client-secret'],
    [''],
  ])('refuses %j', (ref) => {
    expect(isOwnClientSecretRef('linear', ref)).toBe(false);
  });

  it('is total: a non-string ref or an empty connector id is false, never a throw', () => {
    for (const bad of [undefined, null, 0, {}, [], ['account:linear:x']]) {
      expect(isOwnClientSecretRef('linear', bad)).toBe(false);
    }
    expect(isOwnClientSecretRef('', 'account::x')).toBe(false);
  });

  it('judges the ref against the id it is given, not any connector id', () => {
    expect(isOwnClientSecretRef('a', 'account:a:s')).toBe(true);
    expect(isOwnClientSecretRef('b', 'account:a:s')).toBe(false);
  });
});

function caps(over: { credentials?: unknown[]; mcpServers?: unknown[] } = {}) {
  return {
    allowedHosts: [],
    credentials: over.credentials ?? [],
    mcpServers: over.mcpServers ?? [],
    packages: { npm: [], pypi: [] },
  };
}

const oauth = (ref?: string, slot = 'MCP_TOKEN') => ({
  slot,
  kind: 'oauth',
  server: 'srv',
  ...(ref !== undefined ? { clientSecretRef: ref } : {}),
});

describe('assertOwnClientSecretRefs', () => {
  it('passes for no slots, api-key slots, an oauth slot with no ref, and an own ref', () => {
    expect(() => assertOwnClientSecretRefs('linear', caps())).not.toThrow();
    expect(() =>
      assertOwnClientSecretRefs(
        'linear',
        caps({ credentials: [{ slot: 'KEY', kind: 'api-key' }] }),
      ),
    ).not.toThrow();
    expect(() =>
      assertOwnClientSecretRefs('linear', caps({ credentials: [oauth()] })),
    ).not.toThrow();
    expect(() =>
      assertOwnClientSecretRefs(
        'linear',
        caps({ credentials: [oauth('account:linear:oauth-client-secret')] }),
      ),
    ).not.toThrow();
  });

  it("treats '' as no ref (mcp-oauth never dereferences a falsy one)", () => {
    expect(() =>
      assertOwnClientSecretRefs('linear', caps({ credentials: [oauth('')] })),
    ).not.toThrow();
  });

  it('throws invalid-payload for a foreign ref on a top-level oauth slot', () => {
    let caught: unknown;
    try {
      assertOwnClientSecretRefs(
        'linear',
        caps({ credentials: [oauth('provider:anthropic', 'MAIN')] }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginError);
    const e = caught as PluginError;
    expect(e.code).toBe('invalid-payload');
    expect(e.message).toContain("oauth slot 'MAIN'");
    expect(e.message).toContain("'account:linear:<name>'");
    // The offending ref is author-controlled and may be a pasted credential.
    expect(e.message).not.toContain('provider:anthropic');
  });

  it('checks every oauth slot, not just the first', () => {
    expect(() =>
      assertOwnClientSecretRefs(
        'linear',
        caps({
          credentials: [oauth('account:linear:ok', 'A'), oauth('anthropic-api', 'B')],
        }),
      ),
    ).toThrow(/oauth slot 'B'/);
  });

  it('checks the credential list nested under an mcpServer too', () => {
    expect(() =>
      assertOwnClientSecretRefs(
        'linear',
        caps({
          mcpServers: [
            { name: 'srv', transport: 'http', allowedHosts: [], credentials: [oauth('provider:anthropic')] },
          ],
        }),
      ),
    ).toThrow(/clientSecretRef must be/);
  });

  it('a bare own account ref (the token ref) is refused', () => {
    expect(() =>
      assertOwnClientSecretRefs('linear', caps({ credentials: [oauth('account:linear')] })),
    ).toThrow(/clientSecretRef must be/);
  });

  it('never throws on a malformed shape (zod has already run; this stays total)', () => {
    expect(() => assertOwnClientSecretRefs('linear', {})).not.toThrow();
    expect(() =>
      assertOwnClientSecretRefs('linear', { credentials: 'nope', mcpServers: [null, 3, {}] }),
    ).not.toThrow();
  });
});
