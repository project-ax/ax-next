import { describe, it, expect } from 'vitest';
import { validateScope, validateOwnerIdForScope, SCOPE_VALUES } from '../plugin.js';

describe('scope validation', () => {
  it('accepts the three documented scope values', () => {
    expect(SCOPE_VALUES).toEqual(['global', 'user', 'agent']);
    for (const s of SCOPE_VALUES) expect(() => validateScope(s)).not.toThrow();
  });

  it('rejects unknown scope', () => {
    expect(() => validateScope('team')).toThrow(/scope must be one of/);
  });

  it('requires ownerId=null for scope=global', () => {
    expect(() => validateOwnerIdForScope('global', null)).not.toThrow();
    expect(() => validateOwnerIdForScope('global', 'alice')).toThrow(
      /ownerId must be null when scope='global'/,
    );
  });

  it('requires non-null ownerId for scope=user|agent', () => {
    expect(() => validateOwnerIdForScope('user', 'alice')).not.toThrow();
    expect(() => validateOwnerIdForScope('agent', 'agent-1')).not.toThrow();
    expect(() => validateOwnerIdForScope('user', null)).toThrow(/ownerId is required/);
    expect(() => validateOwnerIdForScope('agent', null)).toThrow(/ownerId is required/);
  });

  it('validates ownerId character set (mirrors existing USER_ID_RE)', () => {
    expect(() => validateOwnerIdForScope('user', 'a..b')).not.toThrow();
    expect(() => validateOwnerIdForScope('user', 'has space')).toThrow();
    expect(() => validateOwnerIdForScope('user', '')).toThrow();
  });
});
