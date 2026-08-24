/**
 * Feature flags for channel-web (Task 26).
 *
 * Two kinds live here:
 *
 *  - **Build-time constants** for affordances whose implementation isn't real
 *    yet. Every one is `false` for MVP; flipping one without wiring the
 *    behavior behind it would be the friction-driven equivalent of "we'll do
 *    it later," which the half-wired-code policy disallows.
 *
 *  - **Server-provided flags** (`fetchFeatures`) for surfaces that exist but
 *    are only lit up on deployments that opted in. The server decides — a
 *    build-time `import.meta.env.DEV` can't, because the same bundle ships
 *    everywhere.
 *
 *   - `SEMANTIC_SEARCH` — when `true`, `<SearchBar />` reveals a
 *     "try semantic" affordance for embeddings-based message search.
 *     Off until we have an embedding store and a search hook.
 */
export const SEMANTIC_SEARCH = false;

/**
 * Server-provided feature flags, from `GET /api/features` (registered by
 * @ax/channel-web).
 *
 *   - `agentWorkspacePreview` — the agent-centric workspace. On only where an
 *     operator turned it on. It answers at `/workspace`, AND it takes over `/`
 *     as the landing surface: enabling the preview means the workspace is home,
 *     not that it is merely available (see `pathRendersWorkspace` in App.tsx).
 *     There is deliberately no way to have one without the other today — if a
 *     deployment ever needs `/workspace` available while `/` stays chat, that
 *     is a second flag, not a tweak to this one. Chat keeps its own address at
 *     `/chat` either way.
 */
export interface Features {
  agentWorkspacePreview: boolean;
}

/**
 * What we assume when the server doesn't tell us otherwise: everything off.
 * Fail closed — a preview surface that appears because a fetch fell over is
 * worse than one that stays hidden until we can ask again.
 */
export const DEFAULT_FEATURES: Features = { agentWorkspacePreview: false };

const FETCH_TIMEOUT_MS = 5_000;

/**
 * Read the feature flags for this deployment.
 *
 * On any fetch error, timeout, non-2xx response, or malformed body we return
 * `DEFAULT_FEATURES` (everything off). We log every fallback so an operator
 * debugging a deploy can see why a surface they enabled didn't show up.
 */
export async function fetchFeatures(): Promise<Features> {
  // AbortSignal.timeout() isn't universally available across the older end
  // of the evergreen-browser matrix yet; pair AbortController with a manual
  // setTimeout for compatibility. (Same pattern as lib/bootstrap-status.ts.)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch('/api/features', {
      credentials: 'include',
      signal: controller.signal,
    });
    if (!r.ok) {
      console.warn('[features] non-2xx, defaulting to all-off', r.status);
      return DEFAULT_FEATURES;
    }
    const body = (await r.json()) as { agentWorkspacePreview?: unknown };
    if (typeof body?.agentWorkspacePreview !== 'boolean') {
      console.warn('[features] invalid agentWorkspacePreview field, defaulting to all-off', body);
      return DEFAULT_FEATURES;
    }
    return { agentWorkspacePreview: body.agentWorkspacePreview };
  } catch (err) {
    console.warn('[features] fetch failed, defaulting to all-off', err);
    return DEFAULT_FEATURES;
  } finally {
    clearTimeout(timeoutId);
  }
}
