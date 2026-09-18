/**
 * Keep a growing transcript pinned to its newest line — TASK-418.
 *
 * The agent conversation never auto-scrolled. A walk against the live
 * deployment measured it: after a send, `scrollTop` is 0 with the new content
 * 471px below the fold. The reply had arrived and was rendered correctly; it
 * was simply off-screen. To a person that reads as "the agent didn't respond" —
 * the most alarming interpretation available, and a false one. So this is a
 * trust bug wearing a layout bug's clothes, and the fix is behavioural: no new
 * markup, no new primitive, no colour.
 *
 * THE RULE, STATED ONCE: stick to the bottom only if we were ALREADY at (or
 * within `STICK_SLACK_PX` of) the bottom when the content grew. Scrolling
 * someone back down while they are deliberately reading earlier history is a
 * worse bug than the one this fixes — it is unfixable from the reader's side,
 * because every new streamed token would yank them away again. So the reader's
 * own scroll is the authority, and the only thing that re-arms the stick is the
 * reader scrolling back down to the end themselves.
 *
 * WHY A THRESHOLD RATHER THAN `=== 0`. A pinned viewport is not exactly at the
 * bottom as often as it looks: fractional device pixels, a scrollbar-gutter
 * rounding, and the browser's own sub-pixel `scrollHeight` all leave a couple
 * of pixels behind. An exact test would silently drop the stick for a reader
 * who never scrolled at all. `STICK_SLACK_PX` is also the small kindness of
 * treating "nearly at the end" as "following along".
 *
 * WHY THE READER'S POSITION IS SAMPLED ON `scroll` RATHER THAN READ AT GROWTH
 * TIME: by the time new content has been laid out, the distance from the bottom
 * has already grown by the height of that content, so a reader who was pinned
 * now measures as far from the bottom. The last value sampled BEFORE the growth
 * is the one that answers "were they following along" — so we keep it.
 */
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * How near the end still counts as "following along", in CSS pixels.
 *
 * Roughly one line of transcript. Large enough to survive sub-pixel rounding,
 * small enough that a reader who has scrolled up to read anything at all is
 * past it.
 */
export const STICK_SLACK_PX = 64;

/** How far the viewport's bottom edge sits above the end of the content. */
export function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** Is this scroller at, or near enough to, the end of its content? */
export function isNearBottom(el: HTMLElement, slack = STICK_SLACK_PX): boolean {
  return distanceFromBottom(el) <= slack;
}

/**
 * Pin `ref`'s scroller to the bottom whenever `contentKey` changes, unless the
 * reader has scrolled away from it.
 *
 * `contentKey` is a string that changes whenever the rendered content GROWS OR
 * CHANGES SHAPE — not a render counter. The distinction matters for streaming:
 * a reply arrives as a last message whose text lengthens token by token, which
 * is not a new array entry, so a key built from `thread.length` alone would pin
 * once on the first token and then let the rest of the reply run off the
 * bottom. The caller owns the key because only the caller knows what it drew.
 *
 * Returns the `onScroll` handler to attach to the same element. It is the whole
 * of the "did the reader move" half of the rule, and it is deliberately not an
 * internal `addEventListener`: React's own `onScroll` keeps the listener's
 * lifetime tied to the element that owns it, and the element is already this
 * component's, ref and all.
 *
 * Layout effect, not effect: it runs after the DOM is mutated but before the
 * browser paints, so the new content is never shown at the wrong offset first.
 * `useEffect` here would paint one frame at the old position and jump.
 */
export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  contentKey: string,
): () => void {
  // Starts stuck: a thread opens showing its newest line, which is the same
  // thing every message surface does and what the reader came here to see.
  const stuck = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    stuck.current = isNearBottom(el);
  }, [ref]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || !stuck.current) return;
    // `scrollHeight - clientHeight` rather than `scrollHeight`, which browsers
    // clamp to the same number but jsdom does not. Writing the clamped value
    // means the component behaves identically in both, so a test can assert
    // the exact resting offset instead of a browser's rounding of it.
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  }, [ref, contentKey]);

  return onScroll;
}
