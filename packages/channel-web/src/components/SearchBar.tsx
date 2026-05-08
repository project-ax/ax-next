/**
 * SearchBar — search input rendered above the timeline when search mode
 * is open.
 *
 * Bound to `useSearchStore()` for the query value. Actual filtering is
 * deferred until assistant-ui exposes a stable message-iteration API;
 * for now the affordance is honest but inert (Thread shows a "filter
 * active" banner while the query is non-empty).
 *
 * The semantic-search button is gated behind `SEMANTIC_SEARCH` (off for
 * MVP). When eventually flipped on, it'd hand off to an embeddings
 * search hook — out of scope here.
 */
import { useSearchStore, searchStoreActions } from '../lib/search-store';
import { SEMANTIC_SEARCH } from '../lib/features';

export function SearchBar() {
  const { query } = useSearchStore();
  return (
    <div
      className="flex items-center gap-2 px-6 py-2.5 border-b border-border bg-background"
      role="search"
    >
      <input
        type="search"
        value={query}
        placeholder="search messages…"
        className="
          flex-1 bg-transparent border-0 outline-none p-0
          text-[15px] text-foreground placeholder:text-muted-foreground
        "
        onChange={(e) => searchStoreActions.setQuery(e.currentTarget.value)}
        autoFocus
      />
      <button
        type="button"
        className="
          inline-flex items-center justify-center h-[22px] w-[22px] rounded
          text-[16px] leading-none text-muted-foreground
          hover:text-foreground hover:bg-muted
          focus-visible:text-foreground focus-visible:bg-muted focus-visible:outline-none
          transition-colors
        "
        onClick={() => searchStoreActions.clear()}
        aria-label="Clear search"
      >
        ×
      </button>
      {SEMANTIC_SEARCH && (
        <button
          type="button"
          className="
            font-mono text-[11px] tracking-[0.02em]
            text-muted-foreground hover:text-foreground hover:bg-muted
            px-2 py-1 rounded border border-border transition-colors
          "
        >
          try semantic
        </button>
      )}
    </div>
  );
}
