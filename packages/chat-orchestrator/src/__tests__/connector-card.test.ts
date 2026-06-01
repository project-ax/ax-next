import { describe, it, expect } from 'vitest';
import {
  buildAuthoredConnectorCard,
  authoredConnectorCardDedupKey,
  hasConnectorShownSurface,
} from '../connector-card.js';

const EMPTY = { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };

describe('buildAuthoredConnectorCard', () => {
  it('builds a connector card from a host+slot proposal, authored:true', () => {
    const card = buildAuthoredConnectorCard(
      {
        connectorId: 'linear',
        name: 'Linear',
        proposal: { ...EMPTY, allowedHosts: ['api.linear.app'], credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }] },
      },
      new Set(),
    );
    expect(card).toEqual({
      kind: 'connector', connectorId: 'linear', name: 'Linear', authored: true,
      hosts: ['api.linear.app'],
      // TASK-124 — single-slot connector keeps the collapsed ref; `service` is the
      // connectorId fallback (slot has no account), no slotTag.
      slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', service: 'linear', haveExisting: false }],
      packages: { npm: [], pypi: [] },
    });
  });

  it('marks an account-tagged slot haveExisting when its vault ref is present', () => {
    const card = buildAuthoredConnectorCard(
      { connectorId: 'gdrive', name: 'Drive', proposal: { ...EMPTY, credentials: [{ slot: 'KEY', kind: 'api-key', account: 'google' }] } },
      new Set(['account:google']),
    );
    expect(card!.slots).toEqual([
      { slot: 'KEY', kind: 'api-key', account: 'google', service: 'google', haveExisting: true },
    ]);
  });

  // TASK-124 — a single-slot connector WITHOUT an account tag now also resolves
  // haveExisting against the connectorId-fallback ref (`account:<connectorId>`),
  // which the pre-TASK-124 card never checked.
  it('marks a single-slot untagged slot haveExisting via the connectorId-fallback ref', () => {
    const card = buildAuthoredConnectorCard(
      { connectorId: 'linear', name: 'Linear', proposal: { ...EMPTY, credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }] } },
      new Set(['account:linear']),
    );
    expect(card!.slots).toEqual([
      { slot: 'LINEAR_API_KEY', kind: 'api-key', service: 'linear', haveExisting: true },
    ]);
  });

  // TASK-124 — a ≥2-slot connector derives a DISTINCT per-slot ref per slot
  // (`account:<service>:<slot>`) so two slots that share the connectorId service
  // tag no longer collide; each slot carries its own slotTag + haveExisting.
  it('builds per-slot refs for a multi-slot connector (the collision fix)', () => {
    const card = buildAuthoredConnectorCard(
      {
        connectorId: 'oauthsvc',
        name: 'OAuth',
        proposal: {
          ...EMPTY,
          credentials: [
            { slot: 'CLIENT_ID', kind: 'api-key' },
            { slot: 'CLIENT_SECRET', kind: 'api-key' },
          ],
        },
      },
      // Only the CLIENT_ID row is vaulted.
      new Set(['account:oauthsvc:CLIENT_ID']),
    );
    expect(card!.slots).toEqual([
      {
        slot: 'CLIENT_ID',
        kind: 'api-key',
        service: 'oauthsvc',
        slotTag: 'CLIENT_ID',
        haveExisting: true,
      },
      {
        slot: 'CLIENT_SECRET',
        kind: 'api-key',
        service: 'oauthsvc',
        slotTag: 'CLIENT_SECRET',
        haveExisting: false,
      },
    ]);
  });

  it('returns null for an empty surface', () => {
    expect(buildAuthoredConnectorCard({ connectorId: 'x', name: 'X', proposal: { ...EMPTY } }, new Set())).toBeNull();
  });

  it('returns null for an mcp-only proposal (mcp deferred — the wall rejects kind:mcp)', () => {
    const proposal = { ...EMPTY, mcpServers: [{ name: 'm', transport: 'stdio' as const, allowedHosts: [], credentials: [] }] };
    expect(buildAuthoredConnectorCard({ connectorId: 'x', name: 'X', proposal }, new Set())).toBeNull();
  });

  it('includes packages in the card surface', () => {
    const card = buildAuthoredConnectorCard(
      { connectorId: 'sf', name: 'Salesforce', proposal: { ...EMPTY, packages: { npm: ['@salesforce/cli'], pypi: [] } } },
      new Set(),
    );
    expect(card!.packages).toEqual({ npm: ['@salesforce/cli'], pypi: [] });
  });
});

describe('authoredConnectorCardDedupKey', () => {
  it('is stable regardless of array order', () => {
    const a = authoredConnectorCardDedupKey('c', { ...EMPTY, allowedHosts: ['b.com', 'a.com'] });
    const b = authoredConnectorCardDedupKey('c', { ...EMPTY, allowedHosts: ['a.com', 'b.com'] });
    expect(a).toBe(b);
  });
  it('changes when the shown surface grows', () => {
    const a = authoredConnectorCardDedupKey('c', { ...EMPTY, allowedHosts: ['a.com'] });
    const b = authoredConnectorCardDedupKey('c', { ...EMPTY, allowedHosts: ['a.com', 'c.com'] });
    expect(a).not.toBe(b);
  });
  it('ignores mcp-only changes (mcp not shown)', () => {
    const base = authoredConnectorCardDedupKey('c', { ...EMPTY, allowedHosts: ['a.com'] });
    const withMcp = authoredConnectorCardDedupKey('c', { ...EMPTY, allowedHosts: ['a.com'], mcpServers: [{ name: 'm' }] });
    expect(base).toBe(withMcp);
  });
});

describe('hasConnectorShownSurface', () => {
  it('is false for an empty proposal and an mcp-only proposal', () => {
    expect(hasConnectorShownSurface({ ...EMPTY })).toBe(false);
    expect(hasConnectorShownSurface({ ...EMPTY, mcpServers: [{ name: 'm' }] })).toBe(false);
  });
  it('is true when any of hosts/slots/npm/pypi is non-empty', () => {
    expect(hasConnectorShownSurface({ ...EMPTY, allowedHosts: ['a.com'] })).toBe(true);
    expect(hasConnectorShownSurface({ ...EMPTY, credentials: [{ slot: 'K', kind: 'api-key' }] })).toBe(true);
    expect(hasConnectorShownSurface({ ...EMPTY, packages: { npm: ['p'], pypi: [] } })).toBe(true);
    expect(hasConnectorShownSurface({ ...EMPTY, packages: { npm: [], pypi: ['q'] } })).toBe(true);
  });
  it('tolerates a missing packages field', () => {
    expect(hasConnectorShownSurface({ allowedHosts: [], credentials: [] })).toBe(false);
    expect(hasConnectorShownSurface({ allowedHosts: ['a.com'], credentials: [] })).toBe(true);
  });
});
