/**
 * The viewport stub, in one place.
 *
 * jsdom ships no `matchMedia` at all, which is exactly why `lib/use-compact.ts`
 * guards for its absence and reads `false` — so every suite in this package
 * that does not opt in keeps rendering the desktop tree untouched. A suite that
 * wants a phone installs one deliberately, with `setViewport(true)`.
 *
 * It lives here because it had been hand-copied twice already
 * (`responsive-shell.test.tsx`, `AgentViewHeadings.test.tsx`) and TASK-455 was
 * about to make three. The stub is small but it is not trivial — it has to
 * answer the compact query from the argument and EVERYTHING ELSE `false`, or a
 * test that widens the viewport also flips `theme.ts`'s
 * `prefers-color-scheme` as a side effect; and it has to carry both the modern
 * `addEventListener` pair and the legacy `addListener` pair, because
 * `useSyncExternalStore` subscribes through the first and a missing one is a
 * `TypeError` at render rather than a wrong answer. Three copies of that is
 * three chances for one of them to drift into being subtly wrong while still
 * passing.
 *
 * WHAT IT DOES NOT DO is dispatch `change`. Nothing in this package tests a
 * live resize — the suites set a viewport and then render — and a stub that
 * pretended to support one would be a fake with more surface than its callers
 * use.
 */

/**
 * The exact string `lib/use-compact.ts` asks for. Deliberately duplicated
 * rather than imported: a test helper that reads the query out of the module
 * under test answers "yes" to whatever that module happens to ask, so a typo
 * in the real query would still match here and the whole stub would agree with
 * a broken hook. Spelled out, the two have to agree with each other.
 */
const COMPACT_QUERY = 'not all and (min-width: 768px)';

/**
 * Install a `matchMedia` that reports a phone (`compact`) or a desktop.
 *
 * Pair it with {@link clearViewport} in an `afterEach`, or the next file in the
 * same worker inherits a viewport it never asked for.
 */
export function setViewport(compact: boolean): void {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query === COMPACT_QUERY ? compact : false,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/**
 * Remove the stub, restoring "no `matchMedia` at all" — the state the rest of
 * the package renders under, and the one `use-compact.ts`'s guard is written
 * for.
 */
export function clearViewport(): void {
  delete (window as Partial<Window>).matchMedia;
}
