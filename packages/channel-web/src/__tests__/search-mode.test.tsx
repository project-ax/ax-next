/**
 * Search mode — pins the toggle behavior + the body class (Task 26).
 *
 * The plan calls for a search affordance in the session header that flips
 * the composer area into a search-input mode. For Task 26 the **substantive**
 * work is the toggle + body class + feature flag — actual timeline filtering
 * is deferred until assistant-ui exposes a stable message-iteration API.
 *
 * What this test pins:
 *
 *   1. `searchStoreActions.open()` flips `body.searching` on, so the
 *      CSS rule `body.searching .attach-btn { display: none }` activates.
 *
 *   2. `close()` clears `body.searching`.
 *
 *   3. Typing in the SearchBar updates the store query (via
 *      `useSyncExternalStore` re-render).
 *
 *   4. The clear button resets the query to empty.
 *
 *   5. The semantic-search affordance is **hidden** by default (the
 *      `SEMANTIC_SEARCH` feature flag is `false` for MVP).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchBar } from '../components/SearchBar';
import { searchStoreActions } from '../lib/search-store';

beforeEach(() => {
  // Reset both the body class and the store between tests so order
  // doesn't matter and the previous test's state doesn't leak.
  document.body.classList.remove('searching');
  searchStoreActions.close();
});

describe('Search mode', () => {
  it('open() sets body.searching', () => {
    searchStoreActions.open();
    expect(document.body.classList.contains('searching')).toBe(true);
  });

  it('close() clears body.searching', () => {
    searchStoreActions.open();
    searchStoreActions.close();
    expect(document.body.classList.contains('searching')).toBe(false);
  });

  it('typing in SearchBar updates query', () => {
    searchStoreActions.open();
    render(<SearchBar />);
    fireEvent.change(screen.getByPlaceholderText(/search messages/i), {
      target: { value: 'hello' },
    });
    expect(screen.getByDisplayValue('hello')).toBeTruthy();
  });

  it('clear button resets the query', () => {
    searchStoreActions.open();
    searchStoreActions.setQuery('xyz');
    render(<SearchBar />);
    fireEvent.click(screen.getByLabelText(/clear search/i));
    expect(screen.getByDisplayValue('')).toBeTruthy();
  });

  it('semantic-search affordance is hidden by default (feature flag off)', () => {
    searchStoreActions.open();
    render(<SearchBar />);
    expect(screen.queryByText(/semantic/i)).toBeNull();
  });
});
