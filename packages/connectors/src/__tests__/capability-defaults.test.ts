import { describe, it, expect } from 'vitest';
import { withCapabilityDefaults, withOAuthSlotDefaults } from '../types.js';
import type { Capabilities } from '../types.js';

describe('withOAuthSlotDefaults', () => {
  const base = { slot: 'TOKEN', kind: 'oauth' as const, server: 's' };

  it('reads a missing clientRegistration as custom with a pinned clientId, auto without', () => {
    expect(withOAuthSlotDefaults({ ...base, clientId: 'c' }).clientRegistration).toBe('custom');
    expect(withOAuthSlotDefaults(base).clientRegistration).toBe('auto');
  });

  it('reads an EMPTY clientId as no pinned client (auto), like the sign-in flow does', () => {
    expect(withOAuthSlotDefaults({ ...base, clientId: '' }).clientRegistration).toBe('auto');
  });

  it('reads missing scopes as an empty list', () => {
    expect(withOAuthSlotDefaults(base).scopes).toEqual([]);
  });

  it('keeps values that were written', () => {
    const slot = { ...base, clientId: 'c', clientRegistration: 'dcr' as const, scopes: ['read'] };
    expect(withOAuthSlotDefaults(slot)).toEqual(slot);
  });

  it('does not modify its input', () => {
    const slot = { ...base };
    withOAuthSlotDefaults(slot);
    expect(slot).toEqual(base);
  });
});

describe('withCapabilityDefaults', () => {
  it('fills OAuth slots at the top level and inside each server; leaves api-key slots alone', () => {
    const caps = {
      allowedHosts: [],
      credentials: [
        { slot: 'TOKEN', kind: 'oauth', server: 's', clientId: 'c' },
        { slot: 'KEY', kind: 'api-key' },
      ],
      mcpServers: [
        {
          name: 's',
          transport: 'http',
          url: 'https://mcp.example.com',
          allowedHosts: [],
          credentials: [{ slot: 'INNER', kind: 'oauth', server: 's' }],
        },
      ],
      packages: { npm: [], pypi: [] },
    } as unknown as Capabilities;
    const out = withCapabilityDefaults(caps) as unknown as {
      credentials: Array<Record<string, unknown>>;
      mcpServers: Array<{ credentials: Array<Record<string, unknown>> }>;
    };
    expect(out.credentials[0]).toMatchObject({ clientRegistration: 'custom', scopes: [] });
    expect(out.credentials[1]).toEqual({ slot: 'KEY', kind: 'api-key' });
    expect(out.mcpServers[0]!.credentials[0]).toMatchObject({
      clientRegistration: 'auto',
      scopes: [],
    });
  });
});
