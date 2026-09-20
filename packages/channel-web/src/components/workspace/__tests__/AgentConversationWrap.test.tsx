/**
 * TASK-503 — the user's own bubble may not lose the user's own words.
 *
 * WHAT THIS TEST CAN AND CANNOT PROVE, stated up front because the honest
 * answer is narrower than the bug. jsdom has no CSS engine and no layout:
 * `getBoundingClientRect` returns zeros, no stylesheet is applied, and media
 * queries never evaluate. So an assertion that the text "overflows", "is
 * clipped" or "wraps at 390px" is vacuous BY CONSTRUCTION — it passes just as
 * happily against the unfixed component, which is worse than no test. What
 * jsdom does hold honestly is the class list (the pattern #642 established),
 * the DOM text, and the attributes. Those are what this file asserts.
 *
 * The layout claim itself was settled where layout exists — MEASURED in Chrome
 * at a 390px viewport, on a page reproducing this bubble's box (`max-w-[80%]`
 * inside a `flex flex-col items-end` column). Bubble overflow
 * (`scrollWidth - clientWidth`), before → after `break-words`:
 *
 *     bare 101-char path                     77px → 0
 *     URL with a query string               178px → 0
 *     70-char unbroken token                238px → 0
 *     long snake_case run                   252px → 0
 *     short slash-separated path              0  → 0   (unchanged, no new line)
 *     path with one long slash-delimited seg  0  → 0   (unchanged, no new line)
 *
 * Note the last two, because the card's own repro was one of them: Chrome's
 * UAX-14 line breaking already offers an opportunity around `/`, so a plain
 * slash-separated path was never the casualty. What loses characters is any
 * long run the breaker cannot split. The samples below are those.
 *
 * So the division of labour is: the browser measurement says `break-words` is
 * the right fix and costs nothing elsewhere; this test stops the class from
 * being dropped again, and pins the two decisions that came with it — the
 * class sits on the SAME box that carries the width cap, and the bubble keeps
 * the whole string as readable text rather than a `title=` (TASK-436's
 * distinction: a `title` is the remedy for a CSS CLAMP, and this bubble clamps
 * nothing once it wraps).
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

const userTurn = (text: string): ThreadMessage => ({
  kind: 'user',
  id: 'u1',
  text,
});

function conversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return (
    <AgentConversation
      agent={quill}
      thread={[userTurn('hello')]}
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

/**
 * The bubble, found the way the BUG finds it rather than by a test id: it is
 * the box inside the user turn that carries the width cap, because a capped
 * box is the only kind that can have text outside it. Resolving it this way
 * means the assertions below are about "the box that can overflow", not about
 * whichever div someone tagged.
 */
function bubble(): HTMLElement {
  const turn = screen.getByTestId('workspace-user-message');
  const capped = Array.from(turn.querySelectorAll<HTMLElement>('div')).filter(
    (el) => /(^|\s)max-w-/.test(el.className),
  );
  // The attachment strip is capped too, so narrow to the one holding the text.
  const withText = capped.filter((el) => (el.textContent ?? '').length > 0);
  expect(
    withText,
    'expected exactly one width-capped box carrying the message text',
  ).toHaveLength(1);
  return withText[0]!;
}

/** Runs with no break opportunity a browser will take on its own. */
const UNBREAKABLE = {
  'a long unbroken token':
    'ThisIsOneVeryLongUnbrokenTokenThatHasNoSlashesOrSpacesAnywhereInItAtAll',
  'a snake_case run':
    'the_quick_brown_fox_jumps_over_the_lazy_dog_and_keeps_on_going_forever_v2',
  'a URL with a query string':
    'https://ax-next-std.example.com/workspace/agents/agt_RM7T7ZuHsdu32Lu5wAn2FQ?tab=activity&find=deploy',
} as const;

describe('the user bubble lets long text wrap', () => {
  it('puts a wrap escape on the same box that carries the width cap', () => {
    render(conversation({ thread: [userTurn(UNBREAKABLE['a snake_case run'])] }));

    const el = bubble();

    // The cap is what makes the escape necessary; both belong to one box.
    expect(el.className).toMatch(/(^|\s)max-w-/);
    expect(el.className).toContain('break-words');

    // And NOT the escape's evil twin. `break-all` breaks every line at the
    // box edge, including ordinary prose mid-word, which would be a new bug
    // wearing this fix's clothes.
    expect(el.className).not.toContain('break-all');
  });

  it.each(Object.entries(UNBREAKABLE))(
    'keeps every character of %s as readable text, with no title= stand-in',
    (_label, text) => {
      render(conversation({ thread: [userTurn(text)] }));

      const el = bubble();

      // The whole string, character for character — nothing elided, nothing
      // replaced by an ellipsis. (jsdom can say the text is THERE; only the
      // browser measurement above can say it is on screen.)
      expect(el.textContent).toBe(text);

      // TASK-436's distinction, pinned: a `title` is what a CLAMP owes the
      // reader. Wrapped text owes nothing — a tooltip here would be a
      // hover-only duplicate of visible text, and touch cannot open it.
      expect(el).not.toHaveAttribute('title');
      expect(el.querySelector('[title]')).toBeNull();
    },
  );
});
