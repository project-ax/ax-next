import { describe, it, expect } from 'vitest';
import {
  skillCredentialEnvName,
  projectEnvMapToBareNames,
} from '../credential-namespace.js';

const PH = (n: number) => `ax-cred:${String(n).padStart(32, '0')}`;

describe('skillCredentialEnvName', () => {
  it('formats the per-skill namespace as skill:<id>:<slot>', () => {
    expect(skillCredentialEnvName('linear', 'LINEAR_API_KEY')).toBe(
      'skill:linear:LINEAR_API_KEY',
    );
  });
});

describe('projectEnvMapToBareNames', () => {
  it('projects a namespaced skill slot back to its bare env-var name', () => {
    const out = projectEnvMapToBareNames({
      namespacedEnvMap: { 'skill:linear:LINEAR_API_KEY': PH(1) },
      trustedBareNames: new Set(),
      skillSlots: [{ envName: 'skill:linear:LINEAR_API_KEY', bareSlot: 'LINEAR_API_KEY' }],
    });
    expect(out).toEqual({ LINEAR_API_KEY: PH(1) });
  });

  it('keeps a trusted bare name verbatim', () => {
    const out = projectEnvMapToBareNames({
      namespacedEnvMap: { ANTHROPIC_API_KEY: PH(7) },
      trustedBareNames: new Set(['ANTHROPIC_API_KEY']),
      skillSlots: [],
    });
    expect(out).toEqual({ ANTHROPIC_API_KEY: PH(7) });
  });

  it('the FIRST skill wins when two skills share a bare slot name', () => {
    const out = projectEnvMapToBareNames({
      namespacedEnvMap: {
        'skill:linear-a:LINEAR_API_KEY': PH(1),
        'skill:linear-b:LINEAR_API_KEY': PH(2),
      },
      trustedBareNames: new Set(),
      skillSlots: [
        { envName: 'skill:linear-a:LINEAR_API_KEY', bareSlot: 'LINEAR_API_KEY' },
        { envName: 'skill:linear-b:LINEAR_API_KEY', bareSlot: 'LINEAR_API_KEY' },
      ],
    });
    // Only ONE bare LINEAR_API_KEY survives in the flat env; the first wins.
    expect(out).toEqual({ LINEAR_API_KEY: PH(1) });
  });

  it('a skill can NEVER hijack a trusted bare name (trusted wins)', () => {
    const out = projectEnvMapToBareNames({
      namespacedEnvMap: {
        ANTHROPIC_API_KEY: PH(9),
        'skill:evil:ANTHROPIC_API_KEY': PH(666),
      },
      trustedBareNames: new Set(['ANTHROPIC_API_KEY']),
      skillSlots: [
        { envName: 'skill:evil:ANTHROPIC_API_KEY', bareSlot: 'ANTHROPIC_API_KEY' },
      ],
    });
    // The trusted credential — not the skill's — is what the sandbox sees.
    expect(out).toEqual({ ANTHROPIC_API_KEY: PH(9) });
  });

  it('drops a malformed bare slot name (smuggled-env-name guard)', () => {
    const out = projectEnvMapToBareNames({
      namespacedEnvMap: { 'skill:x:BAD-NAME': PH(1) },
      trustedBareNames: new Set(),
      skillSlots: [{ envName: 'skill:x:BAD-NAME', bareSlot: 'BAD-NAME' }],
    });
    expect(out).toEqual({});
  });

  it('drops a value that is not a valid placeholder (fail-closed)', () => {
    const out = projectEnvMapToBareNames({
      namespacedEnvMap: { 'skill:x:TOKEN': 'not-a-placeholder' },
      trustedBareNames: new Set(),
      skillSlots: [{ envName: 'skill:x:TOKEN', bareSlot: 'TOKEN' }],
    });
    expect(out).toEqual({});
  });

  it('mixes a trusted base and a coexisting skill slot', () => {
    const out = projectEnvMapToBareNames({
      namespacedEnvMap: {
        ANTHROPIC_API_KEY: PH(1),
        'skill:linear:LINEAR_API_KEY': PH(2),
      },
      trustedBareNames: new Set(['ANTHROPIC_API_KEY']),
      skillSlots: [{ envName: 'skill:linear:LINEAR_API_KEY', bareSlot: 'LINEAR_API_KEY' }],
    });
    expect(out).toEqual({ ANTHROPIC_API_KEY: PH(1), LINEAR_API_KEY: PH(2) });
  });
});
