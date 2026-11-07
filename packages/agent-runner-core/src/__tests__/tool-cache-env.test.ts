import { describe, it, expect } from 'vitest';
import { buildToolCacheEnv } from '../tool-cache-env.js';

describe('buildToolCacheEnv', () => {
  it('redirects npx + uvx caches under the scratch root', () => {
    expect(buildToolCacheEnv('/tmp')).toEqual({
      npm_config_cache: '/tmp/.npm',
      UV_CACHE_DIR: '/tmp/uv',
      XDG_CACHE_HOME: '/tmp/.cache',
      MPLCONFIGDIR: '/tmp/.matplotlib',
      MPLBACKEND: 'Agg',
    });
  });

  it('follows whatever scratch root the sandbox stamps (subprocess: a per-session tempdir)', () => {
    expect(buildToolCacheEnv('/var/folders/xx/ax-ipc-abc/ephemeral')).toEqual({
      npm_config_cache: '/var/folders/xx/ax-ipc-abc/ephemeral/.npm',
      UV_CACHE_DIR: '/var/folders/xx/ax-ipc-abc/ephemeral/uv',
      XDG_CACHE_HOME: '/var/folders/xx/ax-ipc-abc/ephemeral/.cache',
      MPLCONFIGDIR: '/var/folders/xx/ax-ipc-abc/ephemeral/.matplotlib',
      MPLBACKEND: 'Agg',
    });
  });

  it('points matplotlib at scratch and the Agg backend', () =>
    expect(buildToolCacheEnv('/tmp')).toMatchObject({ MPLCONFIGDIR: '/tmp/.matplotlib', MPLBACKEND: 'Agg' }));

  it("keeps every cache off the agent's home, so none of it lands in the person's files", () => {
    const { MPLBACKEND: _backend, ...dirs } = buildToolCacheEnv('/tmp');
    for (const value of Object.values(dirs)) {
      expect(value.startsWith('/tmp/')).toBe(true);
      expect(value.startsWith('/files')).toBe(false);
    }
  });
});
