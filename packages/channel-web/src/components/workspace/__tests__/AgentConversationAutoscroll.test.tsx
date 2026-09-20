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
/** Rounding, not intent: nobody scrolls by six pixels on purpose. */
const A_HAIR_PX = 6;
/** Intent, not rounding: this reader went back to look at something. */
const SCROLLED_UP_PX = 300;

const asked: ThreadMessage = {
  kind: 'user',
  id: 'u1',
  text: 'can you deploy the site tonight',
};

const replied = (text: string): ThreadMessage => ({
  kind: 'agent',
  id: 'a1',
  text,
  at: '2026-09-17T16:12:00.000Z',
});

function conversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return (
    <AgentConversation
      agent={quill}
      thread={[asked]}
      conversationId="c1"
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

/**
 * A `ResizeObserver` whose callback the test can fire (TASK-405).
 *
 * `test-setup.ts` installs a global stub that never calls anything back, so the
 * hook's SECOND trigger — the one that catches growth happening after the
 * commit, outside React — had never been executed by any test. Its own header
 * said so. That branch got a great deal more load-bearing when the agent bubble
 * started rendering markdown: a table, a list or a long code block finishing
 * layout is precisely the growth `contentKey` cannot see.
 *
 * This does not simulate layout. It stands in for the browser's "that box got
 * taller" notification and lets the hook's real arithmetic run against the same
 * stubbed viewport every other test here uses.
 */
function observableResize() {
  const callbacks: Array<() => void> = [];
  const prior = globalThis.ResizeObserver;
  class Stub {
    constructor(cb: () => void) {
      callbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = Stub as unknown as typeof ResizeObserver;
  return {
    /** How many observers subscribed — 0 means the branch never ran at all. */
    get subscribers() {
      return callbacks.length;
    },
    /** The box got taller and React was not involved. */
    fire() {
      for (const cb of callbacks) cb();
    },
    restore() {
      globalThis.ResizeObserver = prior;
    },
  };
}

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

  it('still follows when the reader is a few pixels short of the bottom', () => {
    const { rerender } = render(conversation({ thread: [asked] }));
    const pane = viewport(scroller(), {
      contentHeight: 2_000,
      foldHeight: FOLD_PX,
    });

    // Sub-pixel rounding and a scrollbar gutter leave a pinned viewport a few
    // pixels short of the end. Someone who never scrolled must not lose the
    // stick to that.
    pane.readerScrollsTo(2_000 - FOLD_PX - A_HAIR_PX);

    pane.grow(BELOW_FOLD_PX);
    rerender(conversation({ thread: [asked, replied('deploy finished')] }));

    expect(newestIsVisible(scroller())).toBe(true);
  });

  it('drops the stick once the reader is a screenful-ish above the end', () => {
    const { rerender } = render(conversation({ thread: [asked] }));
    const pane = viewport(scroller(), {
      contentHeight: 2_000,
      foldHeight: FOLD_PX,
    });

    // DELIBERATELY AN ABSOLUTE DISTANCE, not one expressed in terms of
    // `STICK_SLACK_PX`. A test written against the constant moves with it, so
    // widening the slack to something enormous — a real way to get this wrong —
    // would keep passing. With this pair straddling a fixed gap, a slack large
    // enough to swallow `SCROLLED_UP_PX` reddens here and a slack of 0 reddens
    // the test above, so the value is pinned from both sides.
    pane.readerScrollsTo(2_000 - FOLD_PX - SCROLLED_UP_PX);
    const wasAt = pane.scrollTop;

    pane.grow(BELOW_FOLD_PX);
    rerender(conversation({ thread: [asked, replied('deploy finished')] }));

    expect(pane.scrollTop).toBe(wasAt);
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

  it('opens a different conversation at its own newest line, not the last one’s offset', () => {
    // `AgentView` swaps `thread` under a component that is mounted ONCE and
    // un-keyed, so the scroller is the same DOM element across the swap and its
    // `scrollTop` is a raw pixel offset with no meaning in the new content.
    const { rerender } = render(
      conversation({ thread: [asked], conversationKey: 'live:a-quill' }),
    );
    const pane = viewport(scroller(), {
      contentHeight: 2_000,
      foldHeight: FOLD_PX,
    });

    // Scrolled up reading the live thread — the case where the stick is off and
    // nothing would otherwise move the scroller at all.
    pane.readerScrollsTo(300);

    // They click a past conversation in the rail. Different content entirely.
    rerender(
      conversation({
        thread: [asked, replied('that was last week')],
        readOnly: true,
        conversationKey: 'past:a-quill:c-17',
      }),
    );

    expect(newestIsVisible(scroller())).toBe(true);
    expect(pane.scrollTop).not.toBe(300);
  });

  it('re-arms the stick for the conversation it just opened', () => {
    const { rerender } = render(
      conversation({ thread: [asked], conversationKey: 'live:a-quill' }),
    );
    const pane = viewport(scroller(), {
      contentHeight: 2_000,
      foldHeight: FOLD_PX,
    });

    pane.readerScrollsTo(0);
    rerender(
      conversation({ thread: [asked], conversationKey: 'live:a-scribe' }),
    );

    // Having landed at the end of the new conversation, it must FOLLOW it —
    // otherwise switching agents mid-reply resurrects the original bug for the
    // whole of that conversation.
    pane.grow(BELOW_FOLD_PX);
    rerender(
      conversation({
        thread: [asked, replied('deploy finished')],
        conversationKey: 'live:a-scribe',
      }),
    );

    expect(newestIsVisible(scroller())).toBe(true);
  });

  /*
    TASK-405 — the trigger nothing had ever run.

    These two are the same pair as the `contentKey` tests above (follows when
    pinned, stays put when not), driven through the observer instead of through
    a re-render. Both are needed: a "re-pin on any resize" implementation
    passes the first and fails the second, and it is the second that makes
    reading back through a conversation possible.
  */
  describe('growth React cannot predict', () => {
    it('re-pins when content grows after the commit — a rendered table, a decoded image', () => {
      const ro = observableResize();
      try {
        const { rerender } = render(conversation({ thread: [asked] }));
        const pane = viewport(scroller(), {
          contentHeight: FOLD_PX,
          foldHeight: FOLD_PX,
        });

        // A reply lands and is followed, the ordinary way.
        pane.grow(120);
        rerender(conversation({ thread: [asked, replied('deploy finished')] }));
        expect(newestIsVisible(scroller())).toBe(true);

        // The observer is actually subscribed. Asserted rather than assumed:
        // if `contentRef` were ever null when the effect ran, everything below
        // would pass vacuously with the pane already at the bottom.
        expect(ro.subscribers).toBeGreaterThan(0);

        // NOW the box gets taller with no React commit at all — the markdown
        // table finished laying out. Nothing re-renders; only the observer can
        // notice.
        pane.grow(BELOW_FOLD_PX);
        expect(newestIsVisible(scroller())).toBe(false);

        ro.fire();

        expect(newestIsVisible(scroller())).toBe(true);
        expect(pane.fromBottom).toBe(0);
      } finally {
        ro.restore();
      }
    });

    it('leaves a reader who scrolled up where they are when it fires', () => {
      const ro = observableResize();
      try {
        render(conversation({ thread: [asked] }));
        const pane = viewport(scroller(), {
          contentHeight: 2_000,
          foldHeight: FOLD_PX,
        });

        pane.readerScrollsTo(0);
        pane.grow(BELOW_FOLD_PX);

        ro.fire();

        expect(pane.scrollTop).toBe(0);
        expect(newestIsVisible(scroller())).toBe(false);
      } finally {
        ro.restore();
      }
    });
  });
});
