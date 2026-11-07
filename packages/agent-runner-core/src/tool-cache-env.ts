// ---------------------------------------------------------------------------
// Tool-fetch cache redirect.
//
// The SDK subprocess runs with HOME = the agent's home (`/files`, durable and
// shown to the person in the Files tab), and `npx`/`uvx` default their caches
// to HOME (`~/.npm/_npx`, `~/.cache/uv`). Left alone, the first `npx <tool>` /
// `uvx <tool>` an agent runs (sub-project D: capabilities.packages) would fill
// the person's files with fetch caches that count toward their storage quota
// and outlive the session that needed them.
//
// Point the caches at the session scratch root (AX_EPHEMERAL_ROOT, surfaced as
// env.ephemeralRoot) instead. It is granted to the SDK as an additional
// directory and is gone with the session, matching D's "per-session ephemeral
// fetch" intent.
//
// matplotlib (pre-installed in the venv template for charts) writes its config
// and font cache to MPLCONFIGDIR, defaulting to ~/.config/matplotlib — i.e.
// `/files`. Point it at scratch too, and pin the headless Agg backend so a
// chart script never probes for a display.
// ---------------------------------------------------------------------------

/**
 * Env vars that redirect `npx` (npm), `uvx` (uv) and matplotlib caches off the
 * agent's home and onto the session scratch root, plus matplotlib's headless
 * backend.
 */
export function buildToolCacheEnv(ephemeralRoot: string): Record<string, string> {
  return {
    npm_config_cache: `${ephemeralRoot}/.npm`, // npx fetch-and-run cache
    UV_CACHE_DIR: `${ephemeralRoot}/uv`, // uvx ephemeral-env cache
    XDG_CACHE_HOME: `${ephemeralRoot}/.cache`, // belt-and-suspenders for other XDG-aware tools
    MPLCONFIGDIR: `${ephemeralRoot}/.matplotlib`, // matplotlib config + font cache
    MPLBACKEND: 'Agg', // headless rendering; no display in the sandbox
  };
}
