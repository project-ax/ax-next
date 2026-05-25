// ---------------------------------------------------------------------------
// Terminal-hint env for the SDK Bash tool's child process (TASK-26).
//
// The SDK Bash tool runs a fully-detached, no-controlling-TTY shell: its env
// comes entirely from the explicit `query({ options: { env } })` literal in
// main.ts (no rc file is sourced — see home-bin-env.ts / tool-cache-env.ts,
// which exist for exactly this "the Bash child only sees this env" reason).
//
// The problem: CLIs that detect a terminal emit ZERO stdout in that detached
// shape — including plain `--help` with no network. Observed with cliffy/Deno
// tools (e.g. @schpet/linear-cli), and the same class covers ink, chalk /
// supports-color, and CI-aware tools. The tool exits 0, writes nothing, and the
// agent gets an empty result with no error. (Network still works — the proxy +
// credentials are fine. This is purely a sandbox-stdio / tool-compat finding.)
//
// The fix is env-hints, NOT a pseudo-TTY. A pty would meaningfully weaken the
// sandbox boundary — a real /dev/pts master/slave kernel object, an ioctl
// surface, and an interactive control channel handed to untrusted, model-driven
// Bash — which capability-minimization (invariant #5) forbids. These hints are
// inert constant strings that change zero capabilities; the Bash tool already
// spawns arbitrary model-requested commands, so handing them a few terminal
// hints grants nothing new. (See SECURITY.md for the threat-model walk and the
// compatibility note on which CLI output shapes work vs not.)
//
// Why each hint:
//   - TERM=xterm-256color — a real terminal type. cliffy/Deno + ncurses-style
//     tools read it to decide they have a terminal and what it supports. NOT
//     'dumb' (which signals "no capabilities" and can suppress output again).
//   - COLUMNS / LINES — terminal dimensions. Tools that bail when they can't
//     size the terminal now have a value to render against.
//   - FORCE_COLOR=1 — chalk / supports-color force-enable styled output even
//     when stdout is not a TTY.
//   - CI=1 — many CI-aware tools select a plain, non-interactive (but still
//     PRESENT) output writer when CI is set, instead of suppressing output.
//
// Ordering contract: main.ts spreads buildTtyHintEnv() FIRST in the env literal
// (before ...proxyStartup.anthropicEnv), so these are a default FLOOR, not a
// clamp — a genuinely-forwarded TERM/COLUMNS/LINES from the host (if it ever has
// a real TTY) overrides them via last-write-wins object spread.
// ---------------------------------------------------------------------------

/**
 * Terminal-hint env vars for the SDK Bash tool's detached child shell so that
 * TTY-detecting CLIs emit output. Pure + constant — takes no input. Returns a
 * fresh object each call. Spread FIRST in the main.ts SDK env literal so a real
 * forwarded TERM/COLUMNS can still override these defaults.
 */
export function buildTtyHintEnv(): Record<string, string> {
  return {
    TERM: 'xterm-256color',
    COLUMNS: '120',
    LINES: '40',
    FORCE_COLOR: '1',
    CI: '1',
  };
}
