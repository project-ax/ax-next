import { describe, it, expect } from 'vitest';
import { buildAuthoredCardPayload, authoredCardDedupKey } from '../authored-card.js';

const EMPTY = { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };

describe('buildAuthoredCardPayload', () => {
  it('builds a skill card from a host+slot delta, authored:true', () => {
    const card = buildAuthoredCardPayload(
      { skillId: 'linear', description: 'Query Linear', delta: { ...EMPTY, allowedHosts: ['api.linear.app'], credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }] } },
      new Set(),
    );
    expect(card).toEqual({
      kind: 'skill', skillId: 'linear', description: 'Query Linear', authored: true,
      hosts: ['api.linear.app'],
      slots: [{ slot: 'LINEAR_API_KEY', kind: 'api-key', haveExisting: false }],
      packages: { npm: [], pypi: [] },
    });
  });

  it('marks an account-tagged slot haveExisting when its vault ref is present', () => {
    const card = buildAuthoredCardPayload(
      { skillId: 'linear', description: 'd', delta: { ...EMPTY, credentials: [{ slot: 'KEY', kind: 'api-key', account: 'linear' }] } },
      new Set(['account:linear']),
    );
    expect(card!.slots).toEqual([{ slot: 'KEY', kind: 'api-key', account: 'linear', haveExisting: true }]);
  });

  it('returns null for an empty shown delta', () => {
    expect(buildAuthoredCardPayload({ skillId: 'x', description: 'd', delta: { ...EMPTY } }, new Set())).toBeNull();
  });

  it('returns null for an mcp-only delta (mcp deferred — D-B2)', () => {
    const delta = { ...EMPTY, mcpServers: [{ name: 'm', transport: 'stdio' as const, allowedHosts: [], credentials: [] }] };
    expect(buildAuthoredCardPayload({ skillId: 'x', description: 'd', delta }, new Set())).toBeNull();
  });
});

describe('authoredCardDedupKey', () => {
  it('is stable regardless of array order', () => {
    const a = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['b.com', 'a.com'] });
    const b = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com', 'b.com'] });
    expect(a).toBe(b);
  });
  it('changes when the shown delta grows', () => {
    const a = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com'] });
    const b = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com', 'c.com'] });
    expect(a).not.toBe(b);
  });
  it('ignores mcp-only changes (mcp not shown)', () => {
    const base = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com'] });
    const withMcp = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com'], mcpServers: [{ name: 'm', transport: 'stdio' as const, allowedHosts: [], credentials: [] }] });
    expect(base).toBe(withMcp);
  });
});
