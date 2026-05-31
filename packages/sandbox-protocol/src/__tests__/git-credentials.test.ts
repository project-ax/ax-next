import { describe, it, expect } from 'vitest';
import { buildGitCredentialEnv } from '../git-credentials.js';

// A 32-hex placeholder — the exact `ax-cred:<hex>` shape the credential-proxy
// registry mints and the sandbox stamps into slot env vars / the envMap.
const PH = 'ax-cred:0123456789abcdef0123456789abcdef';
const PH2 = 'ax-cred:fedcba9876543210fedcba9876543210';

describe('buildGitCredentialEnv', () => {
  it('returns {} when there are no installed skills', () => {
    expect(buildGitCredentialEnv({ installedSkills: [], envMap: {}, baseCount: 1 })).toEqual({});
  });

  it('returns {} when a skill declares hosts but no credential slots', () => {
    // No credential → nothing to inject; git keeps prompting (proxy still gates).
    expect(
      buildGitCredentialEnv({
        installedSkills: [{ allowedHosts: ['github.com'], credentials: [] }],
        envMap: {},
        baseCount: 1,
      }),
    ).toEqual({});
  });

  it('returns {} when the credential slot has no placeholder in the envMap', () => {
    expect(
      buildGitCredentialEnv({
        installedSkills: [
          { allowedHosts: ['github.com'], credentials: [{ slot: 'GIT_TOKEN' }] },
        ],
        envMap: {},
        baseCount: 1,
      }),
    ).toEqual({});
  });

  it('returns {} when the envMap value is not an ax-cred:<hex> placeholder', () => {
    // Defense-in-depth (I1): a regressed wiring that put a real secret in the
    // slot must NOT be embedded into a git URL — only the opaque placeholder is.
    expect(
      buildGitCredentialEnv({
        installedSkills: [
          { allowedHosts: ['github.com'], credentials: [{ slot: 'GIT_TOKEN' }] },
        ],
        envMap: { GIT_TOKEN: 'ghp_realLookingSecretToken' },
        baseCount: 1,
      }),
    ).toEqual({});
  });

  it('appends an insteadOf rewrite carrying the placeholder for a credentialed host', () => {
    // baseCount=1 (the backend already stamped safe.directory at index 0) →
    // our entry lands at index 1 and bumps the count to 2.
    const out = buildGitCredentialEnv({
      installedSkills: [
        { allowedHosts: ['github.com'], credentials: [{ slot: 'GIT_TOKEN' }] },
      ],
      envMap: { GIT_TOKEN: PH },
      baseCount: 1,
    });
    expect(out).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: `url.https://x-access-token:${PH}@github.com/.insteadOf`,
      GIT_CONFIG_VALUE_1: 'https://github.com/',
    });
    // Must NOT re-emit the backend's index-0 (safe.directory) entry.
    expect(out).not.toHaveProperty('GIT_CONFIG_KEY_0');
    expect(out).not.toHaveProperty('GIT_CONFIG_VALUE_0');
  });

  it('starts at index 0 when there is no prior git config (baseCount=0)', () => {
    const out = buildGitCredentialEnv({
      installedSkills: [
        { allowedHosts: ['github.com'], credentials: [{ slot: 'GIT_TOKEN' }] },
      ],
      envMap: { GIT_TOKEN: PH },
      baseCount: 0,
    });
    expect(out).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.https://x-access-token:${PH}@github.com/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/',
    });
  });

  it('stamps one rewrite per allowedHost using the skill\'s first credential slot', () => {
    const out = buildGitCredentialEnv({
      installedSkills: [
        {
          allowedHosts: ['github.com', 'gitlab.com'],
          credentials: [{ slot: 'GIT_TOKEN' }],
        },
      ],
      envMap: { GIT_TOKEN: PH },
      baseCount: 1,
    });
    expect(out.GIT_CONFIG_COUNT).toBe('3');
    const keys = Object.entries(out)
      .filter(([k]) => k.startsWith('GIT_CONFIG_KEY_'))
      .map(([, v]) => v);
    expect(keys).toContain(`url.https://x-access-token:${PH}@github.com/.insteadOf`);
    expect(keys).toContain(`url.https://x-access-token:${PH}@gitlab.com/.insteadOf`);
  });

  it('uses each skill\'s own first credential for its own hosts (multi-skill)', () => {
    const out = buildGitCredentialEnv({
      installedSkills: [
        { allowedHosts: ['github.com'], credentials: [{ slot: 'GH_TOKEN' }] },
        { allowedHosts: ['gitlab.example.com'], credentials: [{ slot: 'GL_TOKEN' }] },
      ],
      envMap: { GH_TOKEN: PH, GL_TOKEN: PH2 },
      baseCount: 1,
    });
    const keys = Object.entries(out)
      .filter(([k]) => k.startsWith('GIT_CONFIG_KEY_'))
      .map(([, v]) => v);
    expect(keys).toContain(`url.https://x-access-token:${PH}@github.com/.insteadOf`);
    expect(keys).toContain(`url.https://x-access-token:${PH2}@gitlab.example.com/.insteadOf`);
  });

  it('skips a host whose value would inject into the url config key (defense-in-depth)', () => {
    // allowedHosts are validated upstream, but a host containing '@', '/',
    // whitespace, or control bytes could break out of url.<...>.insteadOf.
    const out = buildGitCredentialEnv({
      installedSkills: [
        {
          allowedHosts: ['evil.com/\r\nfetch.url', 'a b.com', 'user@host.com'],
          credentials: [{ slot: 'GIT_TOKEN' }],
        },
      ],
      envMap: { GIT_TOKEN: PH },
      baseCount: 1,
    });
    expect(out).toEqual({});
  });

  it('accepts a host:port authority', () => {
    const out = buildGitCredentialEnv({
      installedSkills: [
        { allowedHosts: ['git.internal:8443'], credentials: [{ slot: 'GIT_TOKEN' }] },
      ],
      envMap: { GIT_TOKEN: PH },
      baseCount: 1,
    });
    expect(out.GIT_CONFIG_KEY_1).toBe(
      `url.https://x-access-token:${PH}@git.internal:8443/.insteadOf`,
    );
    expect(out.GIT_CONFIG_VALUE_1).toBe('https://git.internal:8443/');
  });

  it('de-duplicates the same host declared by two skills (first credential wins)', () => {
    const out = buildGitCredentialEnv({
      installedSkills: [
        { allowedHosts: ['github.com'], credentials: [{ slot: 'GH_A' }] },
        { allowedHosts: ['github.com'], credentials: [{ slot: 'GH_B' }] },
      ],
      envMap: { GH_A: PH, GH_B: PH2 },
      baseCount: 1,
    });
    const values = Object.entries(out)
      .filter(([k]) => k.startsWith('GIT_CONFIG_VALUE_'))
      .map(([, v]) => v);
    expect(values.filter((v) => v === 'https://github.com/')).toHaveLength(1);
    expect(out.GIT_CONFIG_COUNT).toBe('2');
  });

  // TASK-86 — per-skill placeholder threading.
  it('prefers the slot\'s own placeholder over envMap[slot]', () => {
    // The flat-env envMap carries the OTHER skill's value for the shared bare
    // slot, but this skill's own placeholder must win for its own git host.
    const out = buildGitCredentialEnv({
      installedSkills: [
        {
          allowedHosts: ['github.com'],
          credentials: [{ slot: 'GIT_TOKEN', placeholder: PH2 }],
        },
      ],
      envMap: { GIT_TOKEN: PH }, // flat-env winner is the OTHER skill (PH)
      baseCount: 1,
    });
    expect(out.GIT_CONFIG_KEY_1).toBe(
      `url.https://x-access-token:${PH2}@github.com/.insteadOf`,
    );
  });

  it('TASK-86: two skills sharing a bare slot each wire git with their OWN credential', () => {
    // The exact namespacing case: both skills declare `LINEAR_API_KEY`. The flat
    // env can carry only one value; per-skill placeholders keep each skill's git
    // egress correct for its own host.
    const out = buildGitCredentialEnv({
      installedSkills: [
        {
          allowedHosts: ['a.linear.app'],
          credentials: [{ slot: 'LINEAR_API_KEY', placeholder: PH }],
        },
        {
          allowedHosts: ['b.linear.app'],
          credentials: [{ slot: 'LINEAR_API_KEY', placeholder: PH2 }],
        },
      ],
      // Flat env collapsed to ONE value for the shared bare name.
      envMap: { LINEAR_API_KEY: PH },
      baseCount: 1,
    });
    const keys = Object.entries(out)
      .filter(([k]) => k.startsWith('GIT_CONFIG_KEY_'))
      .map(([, v]) => v);
    expect(keys).toContain(`url.https://x-access-token:${PH}@a.linear.app/.insteadOf`);
    expect(keys).toContain(`url.https://x-access-token:${PH2}@b.linear.app/.insteadOf`);
  });

  it('rejects a placeholder that is not the ax-cred:<hex> shape (falls back / skips)', () => {
    // A malformed own-placeholder must NOT embed a real secret; with no valid
    // fallback in envMap either, the skill is skipped.
    const out = buildGitCredentialEnv({
      installedSkills: [
        {
          allowedHosts: ['github.com'],
          credentials: [{ slot: 'GIT_TOKEN', placeholder: 'ghp_realSecret' }],
        },
      ],
      envMap: {},
      baseCount: 1,
    });
    expect(out).toEqual({});
  });
});
