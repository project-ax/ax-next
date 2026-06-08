import { describe, expect, it } from 'vitest';
import { buildHomeBinEnv } from '../home-bin-env.js';

// ---------------------------------------------------------------------------
// buildHomeBinEnv APPENDS `<homeDir>/bin` to the SDK subprocess PATH so that
// binaries the agent installs into $HOME/bin (HOME=/agent, the git-bundled
// workspace that persists between sessions — see main.ts) are found in later
// sessions. The SDK Bash tool runs a NON-INTERACTIVE shell whose PATH comes
// entirely from the explicit query({options:{env}}) env (proxy-startup.ts
// forwards process.env.PATH), NOT from any .bashrc — so this PATH layer is the
// load-bearing mechanism.
//
// APPEND (not prepend) is deliberate (I5 / codex review): $HOME=/agent is
// model-writable + restored across sessions, so prepending would let an
// injected `/agent/bin/git` (etc.) PERSISTENTLY shadow trusted binaries.
// Appending keeps installed tools discoverable while trusted base/venv bins win.
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
      buildHomeBinEnv('/agent', '/usr/local/bin:/usr/bin:/bin'),
    ).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin:/agent/bin' });
  });

  it("puts $HOME/bin at the BACK so trusted base/venv bins win on name collisions", () => {
    // currentPath here is what the venv layer already produced (venv bin first).
    const out = buildHomeBinEnv('/agent', '/ephemeral/py/bin:/usr/bin');
    expect(out.PATH).toBe('/ephemeral/py/bin:/usr/bin:/agent/bin');
    expect(out.PATH?.endsWith(':/agent/bin')).toBe(true);
  });

  it('yields a bare binDir when currentPath is undefined or empty', () => {
    expect(buildHomeBinEnv('/agent', undefined)).toEqual({ PATH: '/agent/bin' });
    expect(buildHomeBinEnv('/agent', '')).toEqual({ PATH: '/agent/bin' });
  });

  it('is idempotent: returns {} when PATH already ends with binDir', () => {
    // Never double-append (defensive; the subprocess env is fresh each session,
    // but a future caller might feed an already-appended PATH).
    expect(
      buildHomeBinEnv('/agent', '/usr/bin:/agent/bin'),
    ).toEqual({});
    // Exact-match (PATH is only the binDir) is also a no-op.
    expect(buildHomeBinEnv('/agent', '/agent/bin')).toEqual({});
  });

  it('does not treat a different dir that merely shares a suffix as already-present', () => {
    // `/opt/agent/bin` ends with the same basename but is NOT `/agent/bin`
    // as a full PATH segment (the `:` boundary check guards this).
    expect(
      buildHomeBinEnv('/agent', '/usr/bin:/opt/agent/bin'),
    ).toEqual({ PATH: '/usr/bin:/opt/agent/bin:/agent/bin' });
  });
});
