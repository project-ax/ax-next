/**
 * TASK-418 — the conversation follows the newest line.
 *
 * MEASURED, NOT GUESSED. A manual-acceptance walk against the live deployment
 * (TASK-357) probed the scroller after a send and found `scrollTop === 0` with
 * the new content 471px below the fold. The reply had arrived and rendered
 * correctly; it was simply off-screen — which to a person reads as "the agent
 * didn't respond". The numbers in the fixtures below are that walk's.
 *
 * WHY THE LAYOUT IS STUBBED. jsdom has no layout engine at all: every element
 * reports `scrollHeight === 0` and `clientHeight === 0`, so nothing can be
 * "below the fold" and the bug cannot reproduce on its own. `viewport()` gives
 * one element the three numbers a real scroller has, with `scrollTop` a real
 * read/write property, and then the component's own arithmetic is exercised
 * for real. Nothing about the component is mocked.
 *
 * WHAT THE ASSERTIONS SAY. `newestIsVisible` is the acceptance sentence
 * ("after a send, the newest content is within the viewport") expressed once,
 * rather than each test pinning a magic offset — a test that asserts
 * `scrollTop === 471` passes just as well for a component that scrolls to a
 * coincidentally-correct wrong place.
 *
 * THE HALF A NAIVE FIX BREAKS is the last two tests. "Always scroll to the
 * bottom" satisfies every assertion above them and is a WORSE bug than the one
 * being fixed: it makes reading back through a streaming conversation
 * impossible, because each token yanks the reader forward again.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import { STICK_SLACK_PX } from '@/lib/use-stick-to-bottom';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

/** What the walk's viewport was: a pane 500px tall over a filled thread. */
const FOLD_PX = 500;
/** What the walk measured after the send — the reply, 471px below the fold. */
const BELOW_FOLD_PX = 471;

const asked: ThreadMessage = {
  kind: 'user',
  id: 'u1',
  text: 'can you deploy the site tonight',
};

const replied = (text: string): ThreadMessage => ({
  kind: 'agent',
  id: 'a1',
  text,
  time: '4:12 PM',
});

function conversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return (
    <AgentConversation
      agent={quill}
      thread={[asked]}
      decisions={[]}
      readOnly={false}
      onSend={vi.fn()}
      onApprove={vi.fn()}
      onDismiss={vi.fn()}
      onUndo={vi.fn()}
      approvalRead="ok"
      onRetryApprovals={vi.fn()}
      grants={[]}
      onGrantResolved={vi.fn()}
      onGranted={vi.fn(async () => true)}
      {...over}
    />
  );
}

const scroller = (): HTMLElement =>
  screen.getByRole('region', { name: 'Conversation with Quill' });

/**
 * Give a jsdom element the three numbers a real scroller has.
 *
 * `scrollTop` is backed by a variable rather than left to jsdom (whose setter
 * is a no-op on an element with no layout), so a write by the component is
 * readable by the test — and so a component that writes nothing stays at 0,
 * which is precisely the bug.
 */
function viewport(
  el: HTMLElement,
  init: { contentHeight: number; foldHeight: number },
) {
  let scrollTop = 0;
  let scrollHeight = init.contentHeight;
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => init.foldHeight,
  });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  return {
    /** The reply grew — more content, same pane. */
    grow(by: number) {
      scrollHeight += by;
    },
    /** The reader dragged the bar. Fires the event a real scroll fires. */
    readerScrollsTo(top: number) {
      scrollTop = top;
      fireEvent.scroll(el);
    },
    get scrollTop() {
      return scrollTop;
    },
    get fromBottom() {
      return scrollHeight - scrollTop - init.foldHeight;
    },
  };
}

/** The acceptance sentence: the end of the content is inside the pane. */
const newestIsVisible = (el: HTMLElement): boolean =>
  el.scrollTop + el.clientHeight >= el.scrollHeight;

describe('the agent conversation follows the newest line', () => {
  it('after a send, the reply is inside the viewport rather than below the fold', () => {
    const { rerender } = render(conversation({ thread: [asked] }));
    const pane = viewport(scroller(), {
      contentHeight: FOLD_PX,
      foldHeight: FOLD_PX,
    });

    // The turn lands. This is the walk's measurement exactly: the new content
    // puts the end of the thread 471px past the bottom of the pane.
    pane.grow(BELOW_FOLD_PX);
    rerender(conversation({ thread: [asked, replied('deploy finished')] }));

    expect(newestIsVisible(scroller())).toBe(true);
    // And says so in the walk's own units: nothing is left below the fold.
    expect(pane.fromBottom).toBe(0);
    expect(pane.scrollTop).toBe(BELOW_FOLD_PX);
  });

  it('keeps following while the reply streams in, not only on the first token', () => {
    const { rerender } = render(conversation({ thread: [asked] }));
    const pane = viewport(scroller(), {
      contentHeight: FOLD_PX,
      foldHeight: FOLD_PX,
    });

    // A streaming reply is ONE message whose text lengthens — the array never
    // gains an entry after the first token. A fix keyed on `thread.length`
    // pins here and then lets every later chunk run off the bottom.
    let text = '';
    for (const chunk of ['deploy ', 'finished ', '— it took 4s']) {
      text += chunk;
      pane.grow(120);
      rerender(conversation({ thread: [asked, replied(text)] }));
      expect(newestIsVisible(scroller())).toBe(true);
    }

    expect(pane.fromBottom).toBe(0);
  });

  it('still follows when the reader is a line short of the bottom', () => {
    const { rerender } = render(conversation({ thread: [asked] }));
    const pane = viewport(scroller(), {
      contentHeight: 2_000,
      foldHeight: FOLD_PX,
    });

    // Sub-pixel rounding and a scrollbar gutter leave a pinned viewport a few
    // pixels short of the end. Someone who never scrolled must not lose the
    // stick to that.
    pane.readerScrollsTo(2_000 - FOLD_PX - (STICK_SLACK_PX - 1));

    pane.grow(BELOW_FOLD_PX);
    rerender(conversation({ thread: [asked, replied('deploy finished')] }));

    expect(newestIsVisible(scroller())).toBe(true);
  });

  it('leaves a reader who scrolled up to read history exactly where they are', () => {
    const { rerender } = render(conversation({ thread: [asked] }));
    const pane = viewport(scroller(), {
      contentHeight: 2_000,
      foldHeight: FOLD_PX,
    });

    // They went back to re-read the top of the conversation.
    pane.readerScrollsTo(0);

    // The reply streams in underneath them. Three chunks, because "always
    // scroll to bottom" is not merely wrong once here — it is wrong on every
    // token, which is what makes reading back impossible rather than annoying.
    let text = '';
    for (const chunk of ['deploy ', 'finished ', '— it took 4s']) {
      text += chunk;
      pane.grow(120);
      rerender(conversation({ thread: [asked, replied(text)] }));
      expect(pane.scrollTop).toBe(0);
    }

    expect(newestIsVisible(scroller())).toBe(false);
  });

  it('picks the thread back up once the reader scrolls back to the end', () => {
    const { rerender } = render(conversation({ thread: [asked] }));
    const pane = viewport(scroller(), {
      contentHeight: 2_000,
      foldHeight: FOLD_PX,
    });

    pane.readerScrollsTo(0);
    pane.grow(120);
    rerender(conversation({ thread: [asked, replied('deploy ')] }));
    expect(pane.scrollTop).toBe(0);

    // Scrolling back down to the end is the ONLY thing that re-arms the stick,
    // and it has to, or the reader is stranded off the bottom for the rest of
    // the conversation with no way back that survives the next token.
    pane.readerScrollsTo(2_120 - FOLD_PX);

    pane.grow(120);
    rerender(conversation({ thread: [asked, replied('deploy finished')] }));

    expect(newestIsVisible(scroller())).toBe(true);
    expect(pane.fromBottom).toBe(0);
  });
});
