import { describe, expect, it } from 'vitest';
import { buildTtyHintEnv } from '../tty-hint-env.js';

// ---------------------------------------------------------------------------
// buildTtyHintEnv returns terminal-hint env vars for the SDK Bash tool's
// child process. The Bash tool runs a fully-detached, no-controlling-TTY
// shell; TTY-detecting CLIs (cliffy/Deno e.g. @schpet/linear-cli, ink, chalk,
// CI-aware tools) emit ZERO stdout — including plain `--help` — when they
// detect they're not on a terminal. These inert hint strings flip the common
// detectors so the tools emit (plain or colored) output. (TASK-26.)
//
// Pure + constant: the helper takes no input. The values are a FLOOR — main.ts
// spreads them FIRST in the SDK env literal so a genuinely-forwarded
// TERM/COLUMNS (if the host ever has a TTY) overrides them. We assert the
// exact set so any future change to the hints is a visible, reviewed diff.
// ---------------------------------------------------------------------------

describe('buildTtyHintEnv', () => {
  it('returns the exact terminal-hint set', () => {
    expect(buildTtyHintEnv()).toEqual({
      TERM: 'xterm-256color',
      COLUMNS: '120',
      LINES: '40',
      FORCE_COLOR: '1',
      CI: '1',
    });
  });

  it('returns plain string values (so a later env spread can override them)', () => {
    // The values are a default floor, not a clamp: main.ts spreads
    // buildTtyHintEnv() FIRST, then ...proxyStartup.anthropicEnv, so a real
    // forwarded TERM/COLUMNS wins. That only works if these are ordinary
    // string entries a subsequent spread replaces — guard that contract here.
    const hints = buildTtyHintEnv();
    for (const [k, v] of Object.entries(hints)) {
      expect(typeof v, `${k} should be a string`).toBe('string');
      expect(v.length, `${k} should be non-empty`).toBeGreaterThan(0);
    }
    // A later spread of an overriding value wins (object-spread last-write).
    const merged = { ...buildTtyHintEnv(), TERM: 'dumb', COLUMNS: '80' };
    expect(merged.TERM).toBe('dumb');
    expect(merged.COLUMNS).toBe('80');
    // Untouched hints survive the override.
    expect(merged.FORCE_COLOR).toBe('1');
  });

  it('sets FORCE_COLOR and CI so color/CI-aware writers stay enabled without a TTY', () => {
    const hints = buildTtyHintEnv();
    // chalk / supports-color honor FORCE_COLOR even when !isTTY.
    expect(hints.FORCE_COLOR).toBe('1');
    // CI-aware tools select a plain non-interactive (still PRESENT) writer.
    expect(hints.CI).toBe('1');
  });

  it('sets a real TERM type plus terminal dimensions for size-sensitive tools', () => {
    const hints = buildTtyHintEnv();
    // Not 'dumb' — cliffy/ncurses-style tools treat 'dumb' as no-capabilities.
    expect(hints.TERM).toBe('xterm-256color');
    // Numeric, parseable dimensions for tools that bail when they can't size.
    expect(Number.isInteger(Number(hints.COLUMNS))).toBe(true);
    expect(Number.isInteger(Number(hints.LINES))).toBe(true);
  });

  it('returns a fresh object each call (no shared-mutable-state surprises)', () => {
    const a = buildTtyHintEnv();
    const b = buildTtyHintEnv();
    expect(a).not.toBe(b);
    a.TERM = 'mutated';
    expect(b.TERM).toBe('xterm-256color');
  });
});
