/**
 * TASK-405 — the agent bubble renders markdown, and find still tells the truth.
 *
 * WHAT THE CARD GOT WRONG, because the next reader should not re-file it. The
 * card blames `white-space: normal` for swallowing newlines. There is no
 * `white-space` declaration in `AgentConversation.tsx` at all; the one in
 * `index.css` belongs to `.msg-body .aui-md`, which is `/chat`, not this
 * surface. Collapsed newlines were a SYMPTOM. The cause was that nothing
 * parsed the message: `m.text` went into the DOM as a string, so `**bold**`,
 * tables, lists and headings were all literal too — which is what the TASK-357
 * re-walk measured and what the first test below pins.
 *
 * THE PART THAT IS EASY TO BREAK is the second half. `findRanges` searches the
 * markdown SOURCE, but a `<mark>` can only land in text the reader can see, and
 * those are not the same set: `**` is a real match in the source that can never
 * carry a mark. #601's rule — the reported count and the painted marks are two
 * readings of ONE result — has to survive that. So every find test here asserts
 * the number in the bar against `querySelectorAll('mark').length`, including
 * the cases designed to pull them apart: a query that only matches markup, and
 * a query that straddles it.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

const agentTurn = (text: string): ThreadMessage => ({
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
      thread={[agentTurn('hello')]}
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

/** Open the bar and type. Returns the bar, scoped for count assertions. */
function search(container: HTMLElement, query: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Find' }));
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Find in this conversation' }),
    { target: { value: query } },
  );
  return within(container).getByRole('textbox', {
    name: 'Find in this conversation',
  }).closest('#thread-find-bar') as HTMLElement;
}

/**
 * The number the reader SEES, read back out of the bar.
 *
 * Deliberately parsed from the rendered sentence rather than recomputed from
 * `buildFindIndex`: a test that calls the index twice proves only that a
 * function is deterministic. This proves the bar and the thread agree.
 */
function reportedTotal(bar: HTMLElement): number {
  const el = bar.querySelector('[data-find-count]');
  if (el === null) return 0;
  const said = el.textContent ?? '';
  if (said === 'No matches') return 0;
  const m = /of (\d+)$/.exec(said);
  return m === null ? Number.NaN : Number(m[1]);
}

describe('the agent bubble renders markdown', () => {
  it('renders bold, headings and paragraphs instead of printing their syntax', () => {
    const { container } = render(
      conversation({
        thread: [agentTurn('## Deploy report\n\nThe build is **green**.')],
      }),
    );

    // The structural claim: real elements, not a string that looks like one.
    expect(container.querySelector('h2')?.textContent).toBe('Deploy report');
    expect(container.querySelector('strong')?.textContent).toBe('green');

    // And the symptom the card named: two blocks, not one run-on line.
    expect(container.querySelectorAll('p')).toHaveLength(1);

    // The negative half, which is the half that fails against `main`: the
    // syntax must be GONE, not merely accompanied by markup. A renderer that
    // emitted `<strong>` while leaving the asterisks in place would satisfy
    // every assertion above.
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('## ');
  });

  it('renders a GFM table as a table', () => {
    const { container } = render(
      conversation({
        thread: [
          agentTurn('| env | status |\n| --- | --- |\n| prod | green |'),
        ],
      }),
    );

    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(container.querySelectorAll('tbody td')).toHaveLength(2);
    expect(container.textContent).not.toContain('| --- |');
  });

  it('keeps a list a list, so line structure survives', () => {
    const { container } = render(
      conversation({ thread: [agentTurn('- one\n- two\n- three')] }),
    );

    expect(container.querySelectorAll('li')).toHaveLength(3);
  });

  it('never fetches a model-authored image — the alt text stands in for it', () => {
    /*
      An `<img>` here would be an outbound request the reader's browser makes
      because the MODEL asked it to, carrying whatever the model put in the URL.
      `Markdown.tsx` renders images as alt text for exactly this reason, and
      this is the surface where that policy matters most. Stated as a test so
      that "render images like /chat does" is a decision somebody has to make
      on purpose rather than one a refactor can make by accident.
    */
    const { container } = render(
      conversation({
        thread: [agentTurn('![a chart](https://tracker.test/pixel.png)')],
      }),
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.textContent).toContain('a chart');
    // …and it got there by being PARSED. Without this line the test passes
    // against the unfixed renderer too, which prints the whole `![a chart](…)`
    // string and therefore also contains 'a chart' and also has no <img>.
    expect(container.textContent).not.toContain('![');
    expect(container.textContent).not.toContain('tracker.test');
  });

  it('leaves raw HTML in a model’s reply inert', () => {
    /*
      The message is MODEL OUTPUT. It just went from "a string in a text node"
      to "input to a markup pipeline", which is the moment a renderer starts
      being an injection surface. `rehype-raw` is not installed and
      `allowDangerousHtml` is off, so html is text — pinned here rather than
      left to the absence of a dependency somebody could add later for an
      unrelated reason.
    */
    const { container } = render(
      conversation({
        thread: [
          agentTurn('<img src=x onerror="alert(1)"> and <script>alert(2)</script>'),
        ],
      }),
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(container.textContent).toContain('alert(1)');
  });

  it('blanks a javascript: link a model wrote', () => {
    const { container } = render(
      conversation({ thread: [agentTurn('[click me](javascript:alert(1))')] }),
    );

    const link = container.querySelector('a');
    expect(link?.textContent).toBe('click me');
    expect(link?.getAttribute('href')).toBe('');
  });

  it('opens a model’s link in a severed window', () => {
    const { container } = render(
      conversation({ thread: [agentTurn('[the report](https://deploy.test/r)')] }),
    );

    const link = container.querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('leaves the user bubble alone — it is not markdown and gains no markup', () => {
    const { container } = render(
      conversation({
        thread: [{ kind: 'user', id: 'u1', text: 'deploy **now** please' }],
      }),
    );

    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('deploy **now** please');
  });
});

describe('find still agrees with itself over rendered markdown', () => {
  it('paints a match that lives inside bold, and counts exactly the marks it painted', () => {
    const { container } = render(
      conversation({ thread: [agentTurn('The build is **green** today.')] }),
    );

    const bar = search(container, 'green');

    expect(reportedTotal(bar)).toBe(1);
    expect(container.querySelectorAll('mark')).toHaveLength(1);
    // Painted INSIDE the rendered element, not next to it — which is the thing
    // a naive "highlight the source then parse it" would get wrong.
    expect(container.querySelector('strong mark')?.textContent).toBe('green');
  });

  it('paints a match inside a table cell', () => {
    const { container } = render(
      conversation({
        thread: [
          agentTurn('| env | status |\n| --- | --- |\n| prod | green |'),
        ],
      }),
    );

    const bar = search(container, 'prod');

    expect(reportedTotal(bar)).toBe(1);
    expect(container.querySelectorAll('mark')).toHaveLength(1);
    expect(container.querySelector('td mark')?.textContent).toBe('prod');
  });

  it('does not count a match that only exists in the markup', () => {
    /*
      THE DRIFT CASE. `**` occurs twice in the source and can never carry a
      mark, because it is not on the screen. Counting it would put "1 of 2" in
      the bar over a thread with nothing highlighted — the precise lie
      `thread-find.ts` exists to prevent, arriving by a new route.
    */
    const { container } = render(
      conversation({ thread: [agentTurn('The build is **green** today.')] }),
    );

    const bar = search(container, '**');

    expect(reportedTotal(bar)).toBe(0);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    // And the thread is still there — a zero-match search never empties it.
    expect(container.textContent).toContain('today');
  });

  it('does not count a match that straddles the markup', () => {
    /*
      The other direction of the same drift. `is **g` is one match in the
      source and would need TWO marks on screen ("is " in the paragraph, "g"
      inside the <strong>) — two marks for one counted match.
    */
    const { container } = render(
      conversation({ thread: [agentTurn('The build is **green** today.')] }),
    );

    const bar = search(container, 'is **g');

    expect(reportedTotal(bar)).toBe(0);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
  });

  it('numbers markdown marks in the same sequence the bar walks', () => {
    const { container } = render(
      conversation({
        thread: [
          { kind: 'user', id: 'u1', text: 'check the deploy' },
          agentTurn('**deploy** started\n\nthen the deploy finished'),
        ],
      }),
    );

    const bar = search(container, 'deploy');

    // One in the user bubble (plain), two in the agent bubble (markdown, one
    // of them inside <strong>). The count spans both renderers.
    expect(reportedTotal(bar)).toBe(3);
    expect(container.querySelectorAll('mark')).toHaveLength(3);

    // Exactly one current mark, and Next walks it forward across the boundary
    // between the plain renderer and the markdown one.
    const current = (): string | undefined =>
      container.querySelector('mark[data-find-active="true"]')?.textContent ??
      undefined;
    expect(container.querySelectorAll('mark[data-find-active="true"]')).toHaveLength(1);
    expect(current()).toBe('deploy');

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(container.querySelectorAll('mark[data-find-active="true"]')).toHaveLength(1);
    // The second match is the bold one, so the current mark is now inside it.
    expect(container.querySelector('strong mark[data-find-active="true"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(container.querySelectorAll('mark[data-find-active="true"]')).toHaveLength(1);
    expect(container.querySelector('strong mark[data-find-active="true"]')).toBeNull();

    // And the bar's own sentence agrees about where we are.
    expect(bar.querySelector('[data-find-count]')?.textContent).toBe('3 of 3');
  });

  it('keeps the markdown rendered while a search is running', () => {
    /*
      A tempting shortcut — "fall back to the plain renderer whenever this
      field has matches" — also keeps count and marks equal, and quietly turns
      the table back into pipes on exactly the message the reader is looking
      at. Pinned so the shortcut cannot be taken later as a simplification.
    */
    const { container } = render(
      conversation({
        thread: [
          agentTurn('| env | status |\n| --- | --- |\n| prod | green |'),
        ],
      }),
    );

    search(container, 'prod');

    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(container.textContent).not.toContain('| --- |');
  });
});
