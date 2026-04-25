/**
 * SearchBar — search input rendered above the timeline when search mode
 * is open (Task 26).
 *
 * Bound to `useSearchStore()` for the query value. The substantive
 * Task-26 work is the toggle + body class + feature flag, not actual
 * filtering — `<Thread />` shows a "filter active" banner while the
 * query is non-empty so the affordance isn't a lie. The real filter
 * lands when assistant-ui exposes a stable message-iteration API.
 *
 * The semantic-search button is gated behind `SEMANTIC_SEARCH` (off for
 * MVP). When eventually flipped on, it'd hand off to an embeddings
 * search hook — out of scope for this task.
 */
import { useSearchStore, searchStoreActions } from '../lib/search-store';
import { SEMANTIC_SEARCH } from '../lib/features';

export function SearchBar() {
  const { query } = useSearchStore();
  return (
    <div className="search-bar" role="search">
      <input
        type="search"
        value={query}
        placeholder="search messages…"
        className="search-input"
        onChange={(e) => searchStoreActions.setQuery(e.currentTarget.value)}
        autoFocus
      />
      <button
        type="button"
        className="search-clear"
        onClick={() => searchStoreActions.clear()}
        aria-label="Clear search"
      >
        ×
      </button>
      {SEMANTIC_SEARCH && (
        <button type="button" className="search-semantic">
          try semantic
        </button>
      )}
    </div>
  );
}
