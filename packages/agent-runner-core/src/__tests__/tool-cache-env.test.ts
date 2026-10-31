import { describe, it, expect } from 'vitest';
import { buildToolCacheEnv } from '../tool-cache-env.js';

describe('buildToolCacheEnv', () => {
  it('redirects npx + uvx caches under the scratch root', () => {
    expect(buildToolCacheEnv('/tmp')).toEqual({
      npm_config_cache: '/tmp/.npm',
      UV_CACHE_DIR: '/tmp/uv',
      XDG_CACHE_HOME: '/tmp/.cache',
    });
  });

  it('follows whatever scratch root the sandbox stamps (subprocess: a per-session tempdir)', () => {
    expect(buildToolCacheEnv('/var/folders/xx/ax-ipc-abc/ephemeral')).toEqual({
      npm_config_cache: '/var/folders/xx/ax-ipc-abc/ephemeral/.npm',
      UV_CACHE_DIR: '/var/folders/xx/ax-ipc-abc/ephemeral/uv',
      XDG_CACHE_HOME: '/var/folders/xx/ax-ipc-abc/ephemeral/.cache',
    });
  });

  it("keeps every cache off the agent's home, so none of it lands in the person's files", () => {
    for (const value of Object.values(buildToolCacheEnv('/tmp'))) {
      expect(value.startsWith('/tmp/')).toBe(true);
      expect(value.startsWith('/files')).toBe(false);
    }
  });
});
