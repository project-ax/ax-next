import { focusFirst, keyboardIsClaimed } from './focus-when-ready';

/**
 * Run `fn` once a confirmation dialog that has just resolved has finished closing.
 *
 * Radix returns focus (or, in controlled `ConfirmAction`, our own restore does) from a
 * `setTimeout(0)` queued while the dialog unmounts, which happens at the commit that follows
 * the confirm. Focusing from the `onConfirm` continuation itself, or from a single timeout,
 * can run before that, then get overwritten by it or pulled back into the dialog's focus trap.
 * Two timeouts land after the commit and after the restore.
 */
export function afterDialogCloses(fn: () => void): void {
  setTimeout(() => setTimeout(fn, 0), 0);
}

/**
 * Where keyboard focus goes after a confirmed removal deleted the control that
 * opened the confirmation.
 *
 * `ConfirmAction` hands focus back to whatever opened it, but only when that
 * element is still in the document. A removal takes the row (or menu) with it,
 * so there is nothing left to return to and focus would fall to `<body>`. The
 * caller names a stand-in instead: the next control up the page that survives
 * (a list's "New ..." button, a heading with `tabIndex={-1}`). Selectors are
 * tried in order, as in {@link focusFirst}.
 *
 * It acts only if focus really did fall to `<body>`. A failed removal leaves its
 * opener in place and `ConfirmAction` has already put focus back on it; that is
 * not ours to take.
 */
export function focusAfterRemoval(...selectors: readonly string[]): void {
  afterDialogCloses(() => {
    if (keyboardIsClaimed(document)) return;
    focusFirst(selectors);
  });
}
