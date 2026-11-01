import { describe, expect, it } from 'vitest';
import { buildHomeBinEnv } from '../home-bin-env.js';

// ---------------------------------------------------------------------------
// buildHomeBinEnv APPENDS `<homeDir>/bin` to the SDK subprocess PATH so that
// binaries the agent installs into $HOME/bin (HOME=/files, the durable home that
// persists between sessions) are found in later sessions. The SDK Bash tool runs
// a NON-INTERACTIVE shell whose PATH comes entirely from the explicit
// query({options:{env}}) env (proxy-startup.ts forwards process.env.PATH), NOT
// from any .bashrc — so this PATH layer is the load-bearing mechanism.
//
// APPEND (not prepend) is deliberate (I5 / codex review): $HOME=/files is
// model-writable + durable, so prepending would let an injected
// `/files/bin/git` (etc.) PERSISTENTLY shadow trusted binaries. Appending keeps
// installed tools discoverable while trusted base/venv bins win.
// ---------------------------------------------------------------------------

describe('buildHomeBinEnv', () => {
  it('returns {} when homeDir is undefined (feature off → no phantom PATH)', () => {
    expect(buildHomeBinEnv(undefined, '/usr/bin:/bin')).toEqual({});
  });

  it('returns {} when homeDir is the empty string', () => {
    expect(buildHomeBinEnv('', '/usr/bin:/bin')).toEqual({});
  });

  it('appends `:<homeDir>/bin` to a non-empty PATH', () => {
    expect(
      buildHomeBinEnv('/files', '/usr/local/bin:/usr/bin:/bin'),
    ).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin:/files/bin' });
  });

  it("puts $HOME/bin at the BACK so trusted base/venv bins win on name collisions", () => {
    // currentPath here is what the venv layer already produced (venv bin first).
    const out = buildHomeBinEnv('/files', '/tmp/py/bin:/usr/bin');
    expect(out.PATH).toBe('/tmp/py/bin:/usr/bin:/files/bin');
    expect(out.PATH?.endsWith(':/files/bin')).toBe(true);
  });

  it('yields a bare binDir when currentPath is undefined or empty', () => {
    expect(buildHomeBinEnv('/files', undefined)).toEqual({ PATH: '/files/bin' });
    expect(buildHomeBinEnv('/files', '')).toEqual({ PATH: '/files/bin' });
  });

  it('is idempotent: returns {} when PATH already ends with binDir', () => {
    // Never double-append (defensive; the subprocess env is fresh each session,
    // but a future caller might feed an already-appended PATH).
    expect(
      buildHomeBinEnv('/files', '/usr/bin:/files/bin'),
    ).toEqual({});
    // Exact-match (PATH is only the binDir) is also a no-op.
    expect(buildHomeBinEnv('/files', '/files/bin')).toEqual({});
  });

  it('does not treat a different dir that merely shares a suffix as already-present', () => {
    // `/opt/files/bin` ends with the same basename but is NOT `/files/bin`
    // as a full PATH segment (the `:` boundary check guards this).
    expect(
      buildHomeBinEnv('/files', '/usr/bin:/opt/files/bin'),
    ).toEqual({ PATH: '/usr/bin:/opt/files/bin:/files/bin' });
  });

  it('follows the home it is given: a per-agent directory under the subprocess sandbox', () => {
    // The helper is path-agnostic; this pins the wiring contract that home-bin
    // follows HOME, whatever root the sandbox stamped.
    expect(
      buildHomeBinEnv('/srv/userfiles/agent-1', '/usr/local/bin:/usr/bin:/bin'),
    ).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin:/srv/userfiles/agent-1/bin' });
  });
});
