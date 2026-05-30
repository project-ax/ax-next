import { describe, it, expect } from 'vitest';
import { buildAuthoredCardPayload, authoredCardDedupKey, hasShownDelta } from '../authored-card.js';

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

  it('keeps account but marks haveExisting:false when the vault ref is absent', () => {
    const card = buildAuthoredCardPayload(
      { skillId: 'linear', description: 'd', delta: { ...EMPTY, credentials: [{ slot: 'KEY', kind: 'api-key', account: 'linear' }] } },
      new Set(['account:other']),
    );
    expect(card!.slots).toEqual([{ slot: 'KEY', kind: 'api-key', account: 'linear', haveExisting: false }]);
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

describe('hasShownDelta', () => {
  it('is false for an empty delta and an mcp-only delta', () => {
    expect(hasShownDelta({ ...EMPTY })).toBe(false);
    expect(
      hasShownDelta({ ...EMPTY, mcpServers: [{ name: 'm', transport: 'stdio', allowedHosts: [], credentials: [] }] }),
    ).toBe(false);
  });
  it('is true when any of hosts/slots/npm/pypi is non-empty', () => {
    expect(hasShownDelta({ ...EMPTY, allowedHosts: ['a.com'] })).toBe(true);
    expect(hasShownDelta({ ...EMPTY, credentials: [{ slot: 'K', kind: 'api-key' }] })).toBe(true);
    expect(hasShownDelta({ ...EMPTY, packages: { npm: ['p'], pypi: [] } })).toBe(true);
    expect(hasShownDelta({ ...EMPTY, packages: { npm: [], pypi: ['q'] } })).toBe(true);
  });
});

describe('optional packages tolerance (ResolvedSkillForOrch-style delta)', () => {
  it('hasShownDelta tolerates a missing packages field', () => {
    expect(hasShownDelta({ allowedHosts: [], credentials: [] })).toBe(false);
    expect(hasShownDelta({ allowedHosts: ['a.com'], credentials: [] })).toBe(true);
  });
  it('buildAuthoredCardPayload normalizes a missing packages field to empty arrays', () => {
    const card = buildAuthoredCardPayload(
      { skillId: 's', description: 'd', delta: { allowedHosts: ['a.com'], credentials: [] } },
      new Set(),
    );
    expect(card).toEqual({
      kind: 'skill', skillId: 's', description: 'd', authored: true,
      hosts: ['a.com'], slots: [], packages: { npm: [], pypi: [] },
    });
  });
  it('authoredCardDedupKey is stable whether packages is omitted or empty', () => {
    const omitted = authoredCardDedupKey('s', { allowedHosts: ['a.com'], credentials: [] });
    const empty = authoredCardDedupKey('s', { ...EMPTY, allowedHosts: ['a.com'] });
    expect(omitted).toBe(empty);
  });
});
