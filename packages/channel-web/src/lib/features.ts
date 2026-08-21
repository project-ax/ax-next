/**
 * Feature flags for channel-web (Task 26).
 *
 * MVP defaults are deliberately conservative — we ship the bare bones and
 * light up advanced affordances only after the underlying behavior is real.
 * Every flag below is `false` for MVP; flipping one without wiring the
 * implementation behind it would be the friction-driven equivalent of
 * "we'll do it later," which the half-wired-code policy disallows.
 *
 *   - `SEMANTIC_SEARCH` — when `true`, `<SearchBar />` reveals a
 *     "try semantic" affordance for embeddings-based message search.
 *     Off until we have an embedding store and a search hook.
 */
export const SEMANTIC_SEARCH = false;

/**
 * `AGENT_WORKSPACE_PREVIEW` — the agent-centric workspace prototype at
 * `/workspace`. Dev-only: it stands on the Vite mock backend
 * (`mock/workspace.ts`), so in a production build the route falls through to
 * the normal chat shell rather than rendering a surface with no data behind it.
 * Not a half-wired feature — a design artifact with an explicit gate.
 */
export const AGENT_WORKSPACE_PREVIEW = import.meta.env.DEV;
