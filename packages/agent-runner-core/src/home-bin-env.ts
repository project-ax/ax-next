// ---------------------------------------------------------------------------
// $HOME/bin PATH append.
//
// The SDK subprocess runs with HOME = the agent's home (`/files`, the durable
// per-agent NFS mount — see `runnerHomeDir` and the runners' `query()` env).
// Binaries an agent installs into `$HOME/bin` (`/files/bin`) therefore PERSIST
// between sessions — but they're only USEFUL if that dir is on PATH.
//
// The SDK's Bash tool runs a NON-INTERACTIVE shell: its PATH comes entirely
// from the explicit `query({ options: { env } })` env we hand the SDK
// (proxy-startup.ts forwards `process.env.PATH`; its comment notes that
// without that forward the Bash tool's `ls` exits 127 — proof no rc file is
// sourced, since otherwise a default PATH would exist). So a `.bashrc` alone
// would never reach the agent's shell. This helper is the load-bearing layer:
// it APPENDS `<HOME>/bin` to the PATH we pass the SDK. (The image's `.bashrc`
// carries the same append for any interactive / BASH_ENV shell and as the
// discoverable convention.)
//
// APPEND, not prepend (capability minimization / I5 — codex review): `$HOME`
// is `/files`, a model-WRITABLE dir that persists across sessions. A
// prompt-injection or malicious tool output could drop `/files/bin/git`
// (or `node`, `python`, ...) in one session; PREPENDING it would let that file
// shadow the trusted image/venv binary for every Bash tool command — and
// because `/files` is durable, the hijack would PERSIST into
// future sessions the user trusts. Appending keeps newly installed agent tools
// discoverable (the goal) while the trusted base + venv binaries always win on
// name collisions. Spread this LAST in the main.ts env literal so it lands at
// the END of whatever PATH the prior (proxy-allowlist + venv) layers produced.
// ---------------------------------------------------------------------------

import * as path from 'node:path';

/**
 * Env override that puts `<homeDir>/bin` at the END of the SDK subprocess PATH.
 * Returns `{}` when:
 *   - `homeDir` is undefined/`''` (feature off → no phantom PATH entry), or
 *   - `currentPath` already ends with (or equals) `<homeDir>/bin` (idempotent —
 *     never double-append).
 *
 * @param homeDir     The SDK subprocess HOME (= `runnerHomeDir(env)`, the
 *                    agent's home). NOT caller/model-supplied — host config.
 * @param currentPath The PATH the SDK subprocess would otherwise get (after the
 *                    proxy-allowlist forward + any venv/cache layers).
 */
export function buildHomeBinEnv(
  homeDir: string | undefined,
  currentPath: string | undefined,
): Record<string, string> {
  if (homeDir === undefined || homeDir === '') return {};
  const binDir = path.join(homeDir, 'bin');
  if (currentPath !== undefined && currentPath !== '') {
    // Idempotent: already at the end (exact, or as the last PATH segment).
    if (currentPath === binDir || currentPath.endsWith(`:${binDir}`)) {
      return {};
    }
    return { PATH: `${currentPath}:${binDir}` };
  }
  return { PATH: binDir };
}
