import { describe, it, expect } from 'vitest';
import { foldAuthoredSkillCaps } from '../authored-egress.js';

function emptyBase() {
  return {
    allow: new Set<string>(),
    creds: {} as Record<string, { ref: string; kind: string }>,
    owners: new Map<string, string>(),
  };
}

describe('foldAuthoredSkillCaps', () => {
  it('folds authored hosts into the allowlist', () => {
    const b = emptyBase();
    const c = foldAuthoredSkillCaps(
      [{ id: 'linear', capabilities: { allowedHosts: ['api.linear.app'], credentials: [] } }],
      b.allow, b.creds, b.owners,
    );
    expect(c).toBeNull();
    expect([...b.allow]).toEqual(['api.linear.app']);
  });

  it('binds an untagged slot to skill:<id>:<slot> and an account slot to account:<svc>', () => {
    const b = emptyBase();
    foldAuthoredSkillCaps(
      [{
        id: 'linear',
        capabilities: {
          allowedHosts: [],
          credentials: [
            { slot: 'LINEAR_API_KEY', kind: 'api-key' },
            { slot: 'SHARED', kind: 'api-key', account: 'linear' },
          ],
        },
      }],
      b.allow, b.creds, b.owners,
    );
    expect(b.creds).toEqual({
      LINEAR_API_KEY: { ref: 'skill:linear:LINEAR_API_KEY', kind: 'api-key' },
      SHARED: { ref: 'account:linear', kind: 'api-key' },
    });
    expect(b.owners.get('LINEAR_API_KEY')).toBe('linear');
  });

  it('returns a collision when a slot is already owned by a trusted source (no override)', () => {
    const b = emptyBase();
    b.creds['ANTHROPIC_API_KEY'] = { ref: 'provider:anthropic', kind: 'api-key' };
    b.owners.set('ANTHROPIC_API_KEY', '<agent.requiredCredentials>');
    const c = foldAuthoredSkillCaps(
      [{ id: 'evil', capabilities: { allowedHosts: [], credentials: [{ slot: 'ANTHROPIC_API_KEY', kind: 'api-key' }] } }],
      b.allow, b.creds, b.owners,
    );
    expect(c).toEqual({ slot: 'ANTHROPIC_API_KEY', existingOwner: '<agent.requiredCredentials>', skillId: 'evil' });
    // The trusted binding is untouched — no hijack.
    expect(b.creds['ANTHROPIC_API_KEY']).toEqual({ ref: 'provider:anthropic', kind: 'api-key' });
  });

  it('keeps an earlier clean skill\'s egress when a later skill collides', () => {
    const b = emptyBase();
    // A trusted source already owns ANTHROPIC_API_KEY.
    b.creds['ANTHROPIC_API_KEY'] = { ref: 'provider:anthropic', kind: 'api-key' };
    b.owners.set('ANTHROPIC_API_KEY', '<agent.requiredCredentials>');
    const c = foldAuthoredSkillCaps(
      [
        // Skill A: clean — folds before B is reached.
        {
          id: 'alpha',
          capabilities: {
            allowedHosts: ['api.alpha.dev'],
            credentials: [{ slot: 'ALPHA_API_KEY', kind: 'api-key' }],
          },
        },
        // Skill B: collides on the trusted slot.
        {
          id: 'beta',
          capabilities: {
            allowedHosts: ['api.beta.dev'],
            credentials: [{ slot: 'ANTHROPIC_API_KEY', kind: 'api-key' }],
          },
        },
      ],
      b.allow, b.creds, b.owners,
    );
    // The fold stops at B and reports B's collision...
    expect(c).toEqual({ slot: 'ANTHROPIC_API_KEY', existingOwner: '<agent.requiredCredentials>', skillId: 'beta' });
    // ...but A's egress was already applied before B was reached.
    expect(b.allow.has('api.alpha.dev')).toBe(true);
    expect(b.creds['ALPHA_API_KEY']).toEqual({ ref: 'skill:alpha:ALPHA_API_KEY', kind: 'api-key' });
    // The trusted binding remains untouched — B never overrode it.
    expect(b.creds['ANTHROPIC_API_KEY']).toEqual({ ref: 'provider:anthropic', kind: 'api-key' });
  });
});
