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
    foldAuthoredSkillCaps(
      [{ id: 'linear', capabilities: { allowedHosts: ['api.linear.app'], credentials: [] } }],
      b.allow, b.creds, b.owners,
    );
    expect([...b.allow]).toEqual(['api.linear.app']);
  });

  it('keys an untagged slot by skill:<id>:<slot> with the per-skill ref, and an account slot with the shared account ref', () => {
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
    // Host-side credential map is now keyed by the NAMESPACED env name.
    expect(b.creds).toEqual({
      'skill:linear:LINEAR_API_KEY': { ref: 'skill:linear:LINEAR_API_KEY', kind: 'api-key' },
      'skill:linear:SHARED': { ref: 'account:linear', kind: 'api-key' },
    });
    expect(b.owners.get('skill:linear:LINEAR_API_KEY')).toBe('linear');
  });

  it('lets two skills declaring the SAME bare slot COEXIST (no collision, no lockout)', () => {
    const b = emptyBase();
    foldAuthoredSkillCaps(
      [
        {
          id: 'linear-a',
          capabilities: {
            allowedHosts: ['api.a.dev'],
            credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
          },
        },
        {
          id: 'linear-b',
          capabilities: {
            allowedHosts: ['api.b.dev'],
            credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
          },
        },
      ],
      b.allow, b.creds, b.owners,
    );
    // Both skills' creds are present under distinct namespaced keys — each
    // resolves its OWN credential; no fatal skill-slot-collision.
    expect(b.creds).toEqual({
      'skill:linear-a:LINEAR_API_KEY': { ref: 'skill:linear-a:LINEAR_API_KEY', kind: 'api-key' },
      'skill:linear-b:LINEAR_API_KEY': { ref: 'skill:linear-b:LINEAR_API_KEY', kind: 'api-key' },
    });
    expect(b.allow.has('api.a.dev')).toBe(true);
    expect(b.allow.has('api.b.dev')).toBe(true);
  });

  it('does NOT overwrite or collide with a trusted bare credential (skill is namespaced)', () => {
    const b = emptyBase();
    // A trusted source owns the bare ANTHROPIC_API_KEY (agent default).
    b.creds['ANTHROPIC_API_KEY'] = { ref: 'provider:anthropic', kind: 'api-key' };
    b.owners.set('ANTHROPIC_API_KEY', '<agent.requiredCredentials>');
    foldAuthoredSkillCaps(
      [{ id: 'evil', capabilities: { allowedHosts: [], credentials: [{ slot: 'ANTHROPIC_API_KEY', kind: 'api-key' }] } }],
      b.allow, b.creds, b.owners,
    );
    // The trusted binding is untouched — the skill's slot lands under its OWN
    // namespaced key, so it can't hijack the trusted env var (no terminate).
    expect(b.creds['ANTHROPIC_API_KEY']).toEqual({ ref: 'provider:anthropic', kind: 'api-key' });
    expect(b.creds['skill:evil:ANTHROPIC_API_KEY']).toEqual({
      ref: 'skill:evil:ANTHROPIC_API_KEY',
      kind: 'api-key',
    });
  });

  it('is idempotent for a single skill declaring the same slot twice', () => {
    const b = emptyBase();
    foldAuthoredSkillCaps(
      [{
        id: 'dup',
        capabilities: {
          allowedHosts: [],
          credentials: [
            { slot: 'TOKEN', kind: 'api-key' },
            { slot: 'TOKEN', kind: 'api-key' },
          ],
        },
      }],
      b.allow, b.creds, b.owners,
    );
    expect(b.creds).toEqual({
      'skill:dup:TOKEN': { ref: 'skill:dup:TOKEN', kind: 'api-key' },
    });
  });
});
