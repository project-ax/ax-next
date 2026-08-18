import { describe, it, expect } from 'vitest';
import { buildToolCacheEnv } from '../tool-cache-env.js';

describe('buildToolCacheEnv', () => {
  it('redirects npx + uvx caches under the ephemeral root', () => {
    expect(buildToolCacheEnv('/ephemeral')).toEqual({
      npm_config_cache: '/ephemeral/.npm',
      UV_CACHE_DIR: '/ephemeral/uv',
      XDG_CACHE_HOME: '/ephemeral/.cache',
    });
  });

  it('returns an empty object when no ephemeral root is wired (caches fall back to HOME)', () => {
    expect(buildToolCacheEnv(undefined)).toEqual({});
    expect(buildToolCacheEnv('')).toEqual({});
  });

  it('keeps cache vars off HOME so they never land in the bundled workspace', () => {
    const cacheEnv = buildToolCacheEnv('/ephemeral');
    for (const value of Object.values(cacheEnv)) {
      expect(value.startsWith('/ephemeral/')).toBe(true);
      expect(value.startsWith('/agent')).toBe(false);
    }
  });
});
