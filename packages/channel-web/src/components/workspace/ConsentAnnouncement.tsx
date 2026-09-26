/**
 * What a consent card says back, said OUT LOUD (TASK-442).
 *
 * THE BUG THIS EXISTS FOR. TASK-427 gave both renderers of a decision a focus
 * landing: answer a card and focus moves onto the card's own answer, so the
 * ten-second Undo is one Tab away instead of ten blind ones. That serves a
 * sighted keyboard user. It does not, on its own, tell a screen-reader user
 * what happened, and the walk that found this measured two holes:
 *
 *   - `outcome.note` — the quieter second line, the one that says NOTHING HAS
 *     HAPPENED YET and that Undo still stops it — is a SIBLING of the focused
 *     node in both renderers. Landing on the receipt never reads it.
 *   - the landing is armed by the person's own click (`armForResolution`), and
 *     deliberately so. An answer that arrives any other way changes the card in
 *     silence: a deferred irreversible action crossing `pendingUntil` turns
 *     "it is about to go ahead" into "it has gone out" with nobody's finger on
 *     anything.
 *
 * ONE REGION FOR BOTH RENDERERS, which is the shape the card asked for and the
 * one #606 argues for generally: when two surfaces draw the same consent
 * primitive, the guard belongs in the half they share. `ApprovalCard` and
 * `DecisionRow` hand this the same two values and get the same treatment, and
 * the PRECEDENCE between them — a notice outranks the receipt it lands on —
 * lives here rather than being decided twice.
 *
 * FOUR THINGS ABOUT THE MECHANISM, each of which is a way to build this so it
 * looks right and says nothing:
 *
 *   1. IT MUST ALREADY BE IN THE DOM. A live region inserted holding its
 *      message is not reliably announced — the assistive tech has nothing to
 *      have observed changing. So this mounts with the card, empty, and both
 *      renderers hang it ABOVE their branch split so that resolving a card (an
 *      entirely different subtree) does not take the region with it. Same
 *      reasoning as `ThreadFind`'s permanently-mounted count.
 *   2. IT MUST NOT SPEAK ON MOUNT. `InThreadApprovals` draws every receipt
 *      resolved in the last ten seconds above the composer on a plain page
 *      load. Announcing those would report a past event as news — the audible
 *      version of the focus theft `useResolutionFocus`'s arming avoids. The
 *      first render is therefore silent by construction: both regions start
 *      empty and only a CHANGE to what the card says fills one.
 *   3. IT MUST NOT SHARE A NODE WITH THE COUNTDOWN. `role="alert"` (and
 *      `role="status"`) implies `aria-atomic`, so any mutation re-reads the whole region, and a resolved
 *      row re-renders `Undo · Ns` twice a second off `useDecisionClock`. A
 *      region wrapped around the receipt would read it out up to ten times and
 *      bury the reading that mattered. This is its own node, and the only
 *      thing in it is a sentence that changes when the ANSWER does.
 *   4. `sr-only`, not `hidden`. `display:none` takes a node straight back out
 *      of the accessibility tree, which would undo the fix while looking like
 *      it. `sr-only` is absolutely positioned, so it is also not a flex item
 *      and adds no gap to the `flex ... gap-2` containers these cards sit in —
 *      the 6px-twice-over regression `ThreadFind` documents.
 *
 * ASSERTIVE FOR A RECEIPT, NOT POLITE. `role="alert"` interrupts, which is
 * usually the wrong manners for a confirmation. Here the answer is time-boxed:
 * the control that reverses it expires in ten seconds (`UNDO_WINDOW_MS`), and a
 * polite message queued behind whatever the reader was mid-sentence on can
 * spend a real part of that window. Same call `Toast` makes for its error
 * items. That covers everything said while the card is RESOLVED — the receipt,
 * and a notice landing on it (a refused undo) — since both answer a press.
 *
 * POLITE FOR THE OPEN BRANCH (TASK-540). What an open card says — a stale
 * reason, a notice — has no undo window to race, and the human ruling on
 * TASK-275 is that a card which changes because of the agent is announced
 * politely and focus does not move. So the card has TWO regions: the assertive
 * one above (`data-consent-said="receipt"`) and a polite `role="status"` one
 * (`data-consent-said="open"`). A change is routed by the branch the card is
 * in when it happens, and the other region is emptied in the same commit so a
 * reader walking the page never finds a superseded sentence left behind.
 * Two nodes rather than one node whose `role`/`aria-live` flips: politeness
 * is read off the region as its content changes, and flipping it in the very
 * commit that fills it is exactly the kind of timing assistive tech handles
 * inconsistently. Both mount empty with the card, for rule 1.
 *
 * THE COST, NAMED. Focus lands on the outcome line at almost the same moment,
 * so a screen reader may say the first sentence twice — once as the alert, once
 * as the newly focused node. That is a worse experience than saying it once and
 * a much better one than saying it never, and the two cannot be collapsed
 * without making the announcement conditional on a focus move that may not have
 * carried the words anyway (see the `outcome.note` hole above).
 *
 * The same trade holds on `ApprovalCard`'s OPEN branch since TASK-473: press
 * "Move it" on a row whose guard trips and focus lands on the stale paragraph
 * while the polite region says the same sentence. Twice on a click, once with no
 * click, never zero — do not "optimise" the click path back to silence here.
 *
 * THE OPEN BRANCH SPEAKS HERE TOO (TASK-473, TASK-535). An answer is not the
 * only thing that changes a card with nobody's finger on anything: a card can
 * go stale while it sits there (another tab answered it, a queue read brought
 * the new status back), or pick up a notice with no press behind it. The
 * TASK-427 focus landing fires for the person's own click and nobody else's,
 * so without this region those changes were silent — on `ApprovalCard`, whose
 * open branch draws them as plain paragraphs, and on a COLLAPSED `DecisionRow`,
 * which does not draw them at all until it is expanded (and collapsed is the
 * Today default).
 *
 * So each renderer hands this `openNote`: the sentence its open branch has to
 * say. Both now pass the same notice-first sentence, and `DecisionRow`'s
 * `Alert`s drop the `role="alert"` shadcn gives them so that the polite region
 * stays the ONE voice for it, expanded or collapsed. The prop stays required: the
 * shared half owns the MECHANISM — the already-mounted region, the silent
 * mount — and only the renderer knows what its open branch says.
 *
 * The mount rule does not bend for this. A card that MOUNTS already stale (a
 * page load) says nothing here: a region created holding its sentence is the
 * shape this component exists to avoid, and the arrival of a hold is already
 * spoken, politely, by the surface that draws it (`InThreadApprovals`). Only a
 * card that CHANGES to stale, or picks up a notice, while on screen is news.
 *
 * ONE REGION PER CARD, not one per surface, and that is the opposite of where
 * a surface such as `TodayView` keeps the FOCUS region (`data-consent-region`, which has to
 * outlive the row that is disappearing). A region that only has to survive a
 * card's own open-to-resolved swap has no such requirement, and keeping it
 * local is what lets both renderers share one component instead of asking
 * every surface to provide one. An empty region, assertive or polite, is
 * silent, so N rows cost nothing to a reader. Do not "fix" this into a page-level region: that
 * would hand the announcement back to the surfaces and re-open the coupling.
 */
import { useState } from 'react';
import type { DecisionOutcome } from './decision-copy';

/**
 * The one sentence the card would have a reader hear, or `null` for "nothing
 * to say".
 *
 * NOTICE FIRST — on a RESOLVED row, where it matches `answerKey` in both
 * renderers: a refused undo (`DECISION_UNDO_TOO_LATE`) lands on a row that is
 * already resolved, so the receipt beside it is unchanged and stale news, and
 * the freshest thing the card has to say wins.
 *
 * An OPEN row says whatever its renderer handed over as `openNote`, and
 * nothing when that is `null` (see the header). The renderer builds `openNote` in the
 * same notice-first order `answerKey` uses, so the precedence still matches.
 */
function announcedAnswer(
  outcome: DecisionOutcome | null,
  notice: string | null,
  openNote: string | null,
): string | null {
  if (outcome === null) return openNote;
  if (notice !== null) return notice;
  return outcome.note === null ? outcome.line : `${outcome.line} ${outcome.note}`;
}

interface Props {
  /** `decisionOutcome(d, now)` — `null` while the card is still a question. */
  outcome: DecisionOutcome | null;
  /** What the last action came back with, when it was not what was asked for. */
  notice: string | null;
  /**
   * What the OPEN card says, or `null` for nothing (TASK-473). Required, not
   * defaulted, so each renderer states its answer: an omitted prop would look
   * like a decision without being one.
   */
  openNote: string | null;
}

export function ConsentAnnouncement({ outcome, notice, openNote }: Props) {
  const say = announcedAnswer(outcome, notice, openNote);
  /*
    React's own "adjust state when a prop changes" pattern, and a ref would be
    wrong here: the comparison has to survive a double render (and a rendered
    ref write does not), and the answer can legitimately return to a value it
    already had — clear a notice, retry, get the same refusal — which a
    "compare against the first value" test would swallow.

    The mount is silent because `seen` starts AT the current answer. Everything
    after it is a change, and every change is said.
  */
  const [seen, setSeen] = useState(say);
  const [receipt, setReceipt] = useState('');
  const [open, setOpen] = useState('');
  if (seen !== say) {
    setSeen(say);
    /*
      Routed by the branch the card is in NOW (TASK-540). Only a change to
      the sentence is news — the same words staying put while the branch
      flips is not a reason to say them again.
    */
    const resolved = outcome !== null;
    setReceipt(resolved ? (say ?? '') : '');
    setOpen(resolved ? '' : (say ?? ''));
  }

  return (
    <>
      <span
        className="sr-only"
        role="alert"
        aria-live="assertive"
        data-consent-said="receipt"
      >
        {receipt}
      </span>
      <span className="sr-only" role="status" aria-live="polite" data-consent-said="open">
        {open}
      </span>
    </>
  );
}
