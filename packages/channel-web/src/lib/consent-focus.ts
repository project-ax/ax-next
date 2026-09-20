/**
 * Where focus goes when a consent surface is answered (TASK-427).
 *
 * THE BUG THIS EXISTS FOR. Resolving a grant or a decision replaced the card's
 * buttons with a receipt — and the button the person had just pressed went with
 * them. The browser's rule for a focused element that disappears is to drop
 * focus on `<body>`, so a keyboard user ended up at the top of the document.
 * The receipt that replaced the card carries a TEN-SECOND Undo
 * (`UNDO_WINDOW_MS`), roughly ten blind Tabs from `<body>` on a real page. The
 * window closed before the control could be reached. A safety mechanism that
 * cannot be operated inside its own timeout is not a safety mechanism, which is
 * why this is a consent bug and not only an accessibility one.
 *
 * WHERE FOCUS LANDS, AND WHY IT IS NOT THE UNDO BUTTON. Undo would be the
 * shortest path to the control, and it is the wrong answer twice over.
 *
 *   1. It arms the reverse of the action under the SAME key that just committed
 *      it. A person approves with Space or Enter; if focus then lands on Undo, a
 *      key repeat, a double-tap, or plain muscle memory silently withdraws the
 *      approval they meant to give. The one surface where the next keystroke
 *      must not be "take it back" is the one where they just said yes.
 *   2. It is assertive. Focus on a button is a prompt to press it, and we would
 *      be prompting someone who has just decided to un-decide.
 *
 * So focus lands on the OUTCOME LINE — the receipt sentence, made focusable
 * with `tabIndex={-1}` and nothing else. It is inert, so no keystroke does
 * anything; a screen reader reads out what actually happened, which is the fact
 * the person needs and one we already have words for; and Undo is rendered as
 * the very next tabbable element, so it is exactly ONE Tab away. One Tab inside
 * ten seconds is operable. Ten blind Tabs is not. That is the whole argument,
 * and `RESOLUTION_FOCUS_RING` below is what makes the landing visible to
 * someone who can see the screen.
 *
 * WHEN THERE IS NO RECEIPT. A host grant turned down with "Not now" leaves
 * nothing behind at all — no outcome line, no Undo, the row is simply gone.
 * There is nothing inside the card to focus, so focus goes to the CONSENT
 * REGION the card lived in: the surface marks a node that outlives the card
 * with `data-consent-region`, and `returnFocusToConsentRegion` walks up to it.
 * That keeps the person where they were working instead of at the top of the
 * document, and whatever is still actionable on that surface is a forward Tab
 * or two away rather than a blind crawl.
 */
import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * The focus ring for a node that is focusable only by script.
 *
 * Same tokens `ui/button.tsx` uses, so a receipt that takes focus is outlined
 * the way every other focused control in the app is. `focus-visible` rather
 * than `focus`: a mouse user who clicked Approve should not be handed a ring
 * they did not ask for, and a keyboard user should.
 */
export const RESOLUTION_FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/**
 * Marks a node as the place focus returns to when a consent card inside it is
 * answered and leaves nothing behind.
 *
 * The node MUST outlive the card — a region that unmounts along with the last
 * row hands focus straight back to `<body>`, which is the bug. It also needs
 * `tabIndex={-1}` to be focusable at all, and an accessible name that is still
 * TRUE once the card is gone: "Waiting on you" over an emptied queue is a
 * worse answer than no name.
 */
export const CONSENT_REGION_ATTR = 'data-consent-region';

/** Focus a script-only target without yanking the page around it. */
export function takeResolutionFocus(el: HTMLElement | null | undefined): void {
  // `preventScroll` because the card is already in view — the person is looking
  // straight at it — and a scroll correction here reads as the page jumping
  // under an answer they just gave.
  el?.focus({ preventScroll: true });
}

/**
 * Hand focus back to the consent region containing `from`, for a resolution
 * that removes the card outright.
 *
 * Call it BEFORE the state change that unmounts the card, while `from` is still
 * in the document: `closest` cannot find anything from a detached node. The
 * region itself survives, so the focus it receives survives the unmount.
 *
 * Returns whether a region was found, so a caller can be tested for having one
 * rather than for having tried.
 */
export function returnFocusToConsentRegion(
  from: HTMLElement | null | undefined,
): boolean {
  const region = from?.closest<HTMLElement>(`[${CONSENT_REGION_ATTR}]`) ?? null;
  if (region === null) return false;
  takeResolutionFocus(region);
  return true;
}

/**
 * Move focus onto a card's own answer, once the card has one.
 *
 * For the cards that resolve IN PLACE — `ApprovalCard` and `DecisionRow` —
 * where the receipt (or, if the POST failed, the notice saying so) replaces the
 * controls in the same node the person was standing in.
 *
 * `answerKey` is "what the card says back, right now, as a string" — `null`
 * only where a surface has nothing to say at all. A receipt, a notice, a stale
 * re-open, and — on the decision cards — the QUESTION ITSELF are all answers:
 * pressing Undo inside the window takes the yes back and `decisions/machine.ts`
 * returns the row to `pending`, so the card goes back to asking, and "we are
 * asking you again" is exactly the thing the person needs to hear. A key that
 * treated only resolutions as answers would strand them on `<body>` in front of
 * a re-opened question — on the very control this whole module exists to make
 * reachable. Put `answerRef` on whichever node is currently rendered, and call
 * `armForResolution` from the click handler of EVERY control that changes what
 * the card says — Undo included.
 *
 * WHY A KEY AND NOT A BOOLEAN. A boolean only fires on the false → true edge,
 * so a card that answers TWICE in a row — approve a stale row, the world moves
 * again, it comes back stale a second time — never gets its second landing, and
 * the person is left on `<body>` staring at a page that looks unchanged. A key
 * that changes with the answer fires every time the answer does. The values to
 * build it from are the ones the server varies: `decisions/machine.ts`
 * re-captures `freshness.value` on every trip of the guard (it has to, or
 * approving again would bounce forever), so two consecutive stale answers
 * cannot carry the same key.
 *
 * THE ARMING IS WHAT KEEPS THIS HONEST. A settled receipt drawn on page load
 * has an answer too — `InThreadApprovals` renders the last ten seconds of them
 * above the composer — and stealing focus for one nobody just acted on would be
 * the reverse of this fix. Focus moves only when THIS person's click is what
 * produced the answer, which is exactly what the flag records.
 *
 * It is a ref, not state, deliberately: arming must not re-render (the click
 * already does), and it must survive the re-render the resolve causes. It
 * disarms when it fires, so it can never move focus twice for one click.
 *
 * A RETRY RE-FIRES on its own now: `workspace-decisions.ts` clears the notice
 * at the start of every action, so the key goes to `null` and back, and even if
 * that clear ever went away the key would still change with the answer.
 *
 * `answerRef` is a CALLBACK ref, and stable across renders, because the nodes
 * it has to attach to are different element types — a `div` for the receipt, a
 * `p` for a stale reason, an `Alert` for a notice — and one object ref cannot
 * be handed to all of them without widening it to something no JSX site will
 * accept. Where two of them are on screen at once, the LAST in document order
 * wins the ref, so build `answerKey` in the same order of precedence.
 */
export function useResolutionFocus(answerKey: string | null): {
  answerRef: (node: HTMLElement | null) => void;
  armForResolution: () => void;
} {
  const answer = useRef<HTMLElement | null>(null);
  const armed = useRef(false);
  const answerRef = useCallback((node: HTMLElement | null) => {
    answer.current = node;
  }, []);
  // A LAYOUT EFFECT, AND THAT IS LOAD-BEARING (TASK-451).
  //
  // A passive `useEffect` runs in a task of its OWN, after the commit that put
  // the answer on screen. That leaves a window — a whole task wide — in which
  // the answer is in the document, focusable, and focus is still on `<body>`:
  // exactly the state this module exists to prevent, just briefly. A layout
  // effect runs inside the commit, before the browser paints and before any
  // `MutationObserver` microtask, so there is no instant at which anything —
  // a screen reader, the paint, a test — can observe the answer without the
  // focus that belongs to it.
  //
  // It is not only a test fix. Keyboard input during that window went to
  // whatever `<body>` forwards it to, and a screen reader that reached the new
  // node first could read it from the old position. The window was small; the
  // fix for a window is to close it, not to wait longer for it to shut.
  useLayoutEffect(() => {
    if (!armed.current || answerKey === null) return;
    armed.current = false;
    takeResolutionFocus(answer.current);
  }, [answerKey]);
  return {
    answerRef,
    armForResolution: () => {
      armed.current = true;
    },
  };
}
