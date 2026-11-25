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

/** How long a removal may take to land after its confirmation closed (a re-read the confirm did not await). */
export const REMOVAL_WINDOW_MS = 3_000;

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
 * Some callers resolve before the row is gone (a re-read they do not await), so
 * when the dialog has closed and focus is still on a live element (the opener,
 * just restored) this waits, up to {@link REMOVAL_WINDOW_MS}, for that element
 * to leave the document, and parks then. It gives up the moment focus moves to
 * some other live element (the person took the keyboard) or the window ends,
 * so a failed removal that keeps its opener is never touched. Focus falling to `<body>` is not enough on its
 * own: the stand-in is only focused once the opener has left the document.
 */
export function focusAfterRemoval(...selectors: readonly string[]): void {
  afterDialogCloses(() => {
    if (!keyboardIsClaimed(document)) {
      focusFirst(selectors);
      return;
    }
    const holder = document.activeElement;
    const observer = new MutationObserver(() => {
      const now = document.activeElement;
      if (!keyboardIsClaimed(document)) {
        // Focus on <body> while the opener still exists is just a blur (or the opener went disabled); parking now
        // would pull the person somewhere they didn't ask to go. Wait for the opener to actually leave.
        if (holder === null || !holder.isConnected) {
          stop();
          focusFirst(selectors);
        }
      } else if (now !== holder) {
        stop();
      }
    });
    const timer = setTimeout(() => stop(), REMOVAL_WINDOW_MS);
    function stop(): void {
      observer.disconnect();
      clearTimeout(timer);
    }
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
