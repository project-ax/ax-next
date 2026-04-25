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
