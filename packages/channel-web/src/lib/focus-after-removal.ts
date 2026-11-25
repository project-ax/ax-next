import { focusFirst } from './focus-when-ready';

/**
 * Where keyboard focus goes after a confirmed removal deleted the control that
 * opened the confirmation.
 *
 * `ConfirmAction` hands focus back to whatever opened it, but only when that
 * element is still in the document. A removal takes the row (or menu) with it,
 * so there is nothing left to return to and focus would fall to `<body>`. The
 * caller names a stand-in instead: the next control up the page that survives
 * (a list's "New …" button, a heading). Selectors are tried in order, as in
 * {@link focusFirst}.
 *
 * It waits one task, so the dialog has finished closing and releasing its
 * focus trap first; focusing earlier would be pulled straight back into it.
 */
export function focusAfterRemoval(...selectors: readonly string[]): void {
  setTimeout(() => {
    focusFirst(selectors);
  }, 0);
}
