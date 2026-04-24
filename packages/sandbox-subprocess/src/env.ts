// ---------------------------------------------------------------------------
// Shared env-allowlist helper
//
// Both `sandbox:spawn` and `sandbox:open-session` filter the child's env down
// to the same small allowlist (I5 / I2). Extracted here so the two call sites
// cannot drift; a change to the allowlist is a single edit reviewed in SECURITY.md.
//
// Semantics:
//   - Keys in the allowlist are sourced from the parent (host) process at call
//     time. Missing parent values fall through to conservative defaults.
//   - NODE_OPTIONS is pinned to the empty string so a caller-controlled
//     NODE_OPTIONS (e.g. --require) can't inject code into the child.
// ---------------------------------------------------------------------------

export function allowlistFromParent(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    LANG: process.env.LANG ?? 'C',
    LC_ALL: process.env.LC_ALL ?? 'C',
    TZ: process.env.TZ ?? 'UTC',
    NODE_OPTIONS: '',
  };
}
