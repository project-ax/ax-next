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
 * own scroll is the authority, and the only things that re-arm the stick are
 * the reader scrolling back down to the end themselves, and opening a different
 * conversation.
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
 *
 * TWO TRIGGERS, AND NEITHER IS REDUNDANT. `contentKey` is synchronous: it runs
 * in a layout effect on the same commit that added the content, so nothing is
 * ever painted at the old offset. It cannot see growth that happens LATER and
 * outside React — an image in a reply finishing its decode, a web font
 * swapping, a code block being highlighted, an approval card changing height
 * because the decision behind it resolved. That is what the `ResizeObserver` is
 * for, and it is why the growth key does not have to enumerate every prop that
 * can change a row's height. jsdom cannot exercise the observer (no layout, and
 * the suite installs a no-op stub), so the tests cover the key path and this
 * paragraph covers the other one.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from 'react';

/**
 * How near the end still counts as "following along", in CSS pixels.
 *
 * Roughly one line of transcript. Large enough to survive sub-pixel rounding,
 * small enough that a reader who has scrolled up to read anything at all is
 * past it.
 */
export const STICK_SLACK_PX = 64;

/** How far the viewport's bottom edge sits above the end of the content. */
function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** Is this scroller at, or near enough to, the end of its content? */
function isNearBottom(el: HTMLElement): boolean {
  return distanceFromBottom(el) <= STICK_SLACK_PX;
}

/**
 * `scrollHeight - clientHeight` rather than `scrollHeight`, which browsers
 * clamp to the same number but jsdom does not. Writing the clamped value means
 * the component behaves identically in both, so a test can assert the exact
 * resting offset instead of a browser's rounding of it.
 */
function pinToBottom(el: HTMLElement): void {
  el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
}

interface StickOptions {
  /** The scrolling element — the one with `overflow-y: auto`. */
  viewportRef: RefObject<HTMLElement | null>;
  /**
   * The element INSIDE the viewport whose height IS the content's. Observed for
   * growth the render pass cannot predict. Observing the viewport instead would
   * watch the wrong box: its size is the pane's, and the pane does not change
   * size when the transcript gets longer.
   */
  contentRef: RefObject<HTMLElement | null>;
  /**
   * A string that changes whenever the rendered content GROWS OR CHANGES SHAPE
   * — not a render counter. The distinction matters for streaming: a reply
   * arrives as a last message whose text lengthens token by token, which is not
   * a new array entry, so a key built from a message COUNT would pin once on
   * the first token and then let the rest of the reply run off the bottom. The
   * caller owns the key because only the caller knows what it drew.
   */
  contentKey: string;
  /**
   * Which conversation is on screen. A change here means DIFFERENT CONTENT
   * ENTIRELY, not more of the same, so the reader's scroll position from the
   * last one means nothing: a raw pixel offset carried onto another
   * conversation lands wherever it happens to land, which is the state this
   * surface reaches today when someone scrolls up and then opens a past
   * conversation from the rail. Changing it re-arms the stick and lands the new
   * conversation on its newest line — what opening a conversation does
   * everywhere else.
   */
  conversationKey: string;
}

/**
 * Pin a scroller to the bottom as its content grows, unless the reader has
 * scrolled away from it.
 *
 * Returns the `onScroll` handler to attach to the viewport element. It is the
 * whole of the "did the reader move" half of the rule, and it is deliberately
 * not an internal `addEventListener`: React's own `onScroll` keeps the
 * listener's lifetime tied to the element that owns it, and the element is
 * already the caller's, ref and all.
 *
 * Layout effect, not effect: it runs after the DOM is mutated but before the
 * browser paints, so the new content is never shown at the wrong offset first.
 * `useEffect` here would paint one frame at the old position and jump.
 */
export function useStickToBottom({
  viewportRef,
  contentRef,
  contentKey,
  conversationKey,
}: StickOptions): () => void {
  // Starts stuck: a thread opens showing its newest line, which is the same
  // thing every message surface does and what the reader came here to see.
  const stuck = useRef(true);

  const onScroll = useCallback(() => {
    const el = viewportRef.current;
    if (el === null) return;
    stuck.current = isNearBottom(el);
  }, [viewportRef]);

  /*
    DECLARED BEFORE THE PIN BELOW, and the ordering is the mechanism rather than
    a matter of taste: effects run in declaration order, so on the commit that
    swaps the conversation this re-arms the stick and the pin below then lands
    the new conversation at its end. Reversed, the new conversation would open
    at the previous one's leftover offset.
  */
  useLayoutEffect(() => {
    stuck.current = true;
  }, [conversationKey]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (el === null || !stuck.current) return;
    pinToBottom(el);
  }, [viewportRef, contentKey, conversationKey]);

  /*
    The growth React cannot predict — see the header. `stuck` is re-read inside
    the callback rather than captured, so the observer is subscribed once and
    never needs replacing when the reader's position changes.

    Guarded on `ResizeObserver` existing because this module is also loaded in
    environments that lack it. Setting `scrollTop` changes no box's size, so the
    callback cannot re-trigger itself.
  */
  useEffect(() => {
    const el = viewportRef.current;
    const content = contentRef.current;
    if (el === null || content === null) return;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!stuck.current) return;
      pinToBottom(el);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [viewportRef, contentRef]);

  return onScroll;
}
