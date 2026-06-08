// ---------------------------------------------------------------------------
// Tool-fetch cache redirect.
//
// The SDK subprocess runs with HOME=/agent (the git-tracked workspace
// root — see main.ts), and `npx`/`uvx` default their caches to HOME
// (`~/.npm/_npx`, `~/.cache/uv`). Left alone, the first `npx <tool>` /
// `uvx <tool>` an agent runs (sub-project D: capabilities.packages) writes
// its fetch cache into /agent, where the turn-end `git add -A` stages,
// commits, and bundles it back to the host — bloating every bundle with
// cache files.
//
// Point the caches at the session-scoped ephemeral tier (AX_EPHEMERAL_ROOT,
// surfaced as env.ephemeralRoot) instead. That dir is granted to the SDK as
// an additionalDirectory and never round-trips to the host, matching D's
// "per-session ephemeral fetch" intent.
// ---------------------------------------------------------------------------

/**
 * Env vars that redirect `npx` (npm) and `uvx` (uv) fetch caches off the
 * bundled workspace and onto the ephemeral scratch tier. Returns `{}` when no
 * ephemeral root is available (caches then fall back to HOME — the `.gitignore`
 * scaffold's `.npm/`/`.cache/` entries are the backstop in that case).
 */
export function buildToolCacheEnv(ephemeralRoot: string | undefined): Record<string, string> {
  if (ephemeralRoot === undefined || ephemeralRoot === '') return {};
  return {
    npm_config_cache: `${ephemeralRoot}/.npm`, // npx fetch-and-run cache
    UV_CACHE_DIR: `${ephemeralRoot}/uv`, // uvx ephemeral-env cache
    XDG_CACHE_HOME: `${ephemeralRoot}/.cache`, // belt-and-suspenders for other XDG-aware tools
  };
}
