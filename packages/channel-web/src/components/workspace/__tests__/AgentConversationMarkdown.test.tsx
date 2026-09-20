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
  at: '2026-09-17T16:12:00.000Z',
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

  it('gives a markdown mark the same attributes and classes as a plain one', () => {
    /*
      The two renderers build their marks by different routes — one writes JSX,
      the other writes hast properties a rehype plugin hands to react-markdown —
      and only one of them was ever checked. The classes are the contrast pairs
      measured in `ThreadFind.tsx`'s header against both the agent pane and the
      user bubble; `aria-current` is how a screen reader is told which match is
      the current one. A markdown mark that quietly lost either would be a
      regression nobody could see in a diff.
    */
    const { container } = render(
      conversation({
        thread: [
          { kind: 'user', id: 'u1', text: 'deploy' },
          agentTurn('**deploy**'),
        ],
      }),
    );

    search(container, 'deploy');

    const [plain, md] = [...container.querySelectorAll('mark')];
    // The first match is the active one, so the plain mark carries the active
    // pair and the markdown mark the inactive pair.
    expect(plain?.getAttribute('data-find-field')).toBe('0:u1');
    expect(md?.getAttribute('data-find-field')).toBe('1:a1');
    expect(plain?.getAttribute('data-find-active')).toBe('true');
    expect(plain?.getAttribute('aria-current')).toBe('true');
    expect(md?.getAttribute('data-find-active')).toBeNull();
    expect(md?.getAttribute('class')).toBe(
      'rounded-[3px] border-b border-warning bg-warning-soft px-0.5 text-foreground',
    );

    // Now walk to the markdown one and check the ACTIVE pair crosses too.
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    const nowActive = container.querySelector('mark[data-find-active="true"]');
    expect(nowActive?.closest('strong')).not.toBeNull();
    expect(nowActive?.getAttribute('aria-current')).toBe('true');
    expect(nowActive?.getAttribute('class')).toBe(
      'rounded-[3px] bg-foreground px-0.5 text-background',
    );
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

  it('does not count a match in a footnote body it cannot paint', () => {
    /*
      A real drift found by probing, not by reasoning — and it survived the
      first design, which parsed to mdast here and walked hast in the renderer
      on the argument that the two agree. `mdast-util-to-hast` appends a space
      before a footnote's backref link, so the rendered node's value is not its
      source slice and the renderer drops it. mdast-only kept it, and
      'footnote' reported 1 with nothing highlighted.

      The whole-thread reading is the point: the bar and the DOM, not two calls
      to the same function.
    */
    const { container } = render(
      conversation({
        thread: [agentTurn('Body text[^1] here.\n\n[^1]: the footnote body')],
      }),
    );

    const bar = search(container, 'footnote');

    expect(container.querySelectorAll('mark')).toHaveLength(
      reportedTotal(bar),
    );
    // The body IS on screen — this is an under-count, which is the direction
    // that cannot lie to a reader, not a claim that nothing rendered.
    expect(container.textContent).toContain('the footnote body');
  });

  /*
    THE COUPLING THIS GUARDS (review finding 3).

    `markdown-find.ts` builds its own `unified()` processor and asserts it is
    react-markdown's. Today it is — `remark-rehype@11.1.2` is what
    `react-markdown@10`'s `^11.0.0` resolves to, and `remark-parse`,
    `remark-gfm` and `unified` are single deduped copies — but that is a
    LOCKFILE fact, not a code one. A future react-markdown bump that moves its
    remark-rehype while the direct dep stays pinned (or the reverse) would make
    the counting pipeline and the painting pipeline different documents, and
    every hand-picked test above would keep passing because none of them uses
    the construct that diverged.

    So this asks the question generically, through the REAL render: for a corpus
    of constructs, is the number in the bar the number of marks on the screen?
    It is the one test that a dependency drift cannot dodge by being about a
    construct nobody thought of — as long as the corpus keeps growing when
    somebody meets a new one.

    EACH CASE PINS ITS EXPECTED TOTAL, and that is not decoration. "count ===
    marks" alone is satisfied by a renderer that finds NOTHING and paints
    nothing, which is exactly what a drifted pipeline would look like — every
    node's value stops matching its slice, everything is dropped, and a
    both-are-zero assertion sails through. The third number is what makes the
    case fail instead.

    The totals also double as the readable spec for the accepted gap. Where the
    expected total is below the number of literal occurrences, the difference is
    text that renders but is not a source-mapped node: an alt text, a code
    span's insides, a footnote body that absorbed the backref's space, a
    paragraph unescaped by the parser, or a multi-line blockquote whose value
    has lost its `> ` prefixes. Always fewer, never more.
  */
  describe('the bar and the screen agree across the construct corpus', () => {
    const corpus: ReadonlyArray<
      readonly [name: string, markdown: string, query: string, expected: number]
    > = [
      ['plain prose', 'the deploy finished cleanly', 'deploy', 1],
      ['bold', 'the **deploy** finished', 'deploy', 1],
      ['nested emphasis', 'a **bold *deploy* run** b', 'deploy', 1],
      ['heading', '## deploy report\n\nthe deploy is green', 'deploy', 2],
      ['gfm table', '| env | deploy |\n| --- | --- |\n| prod | deploy ok |', 'deploy', 2],
      // The escaped cell is unescaped in its value, so it drops: 1 of 2.
      ['table, escaped pipe', '| a \\| deploy | c |\n| --- | --- |\n| deploy | 2 |', 'deploy', 1],
      ['list', '- deploy one\n- deploy two', 'deploy', 2],
      ['task list', '- [x] deploy done\n- [ ] deploy open', 'deploy', 2],
      // A multi-line blockquote paragraph's value has lost its `> ` prefixes,
      // so that node drops; the single-line bold run inside it survives.
      ['blockquote', '> the **deploy** went\n> deploy again', 'deploy', 1],
      ['nested blockquote list', '> - **deploy `x` here**\n>   - deploy', 'deploy', 2],
      ['inline code', 'run `deploy --now` then deploy', 'deploy', 1],
      ['fenced code', '```sh\ndeploy --now\n```\n\nthen deploy', 'deploy', 1],
      ['link label', 'see [the deploy](https://x.test/deploy) now', 'deploy', 1],
      ['reference link', 'see [the deploy][r]\n\n[r]: https://x.test/deploy', 'deploy', 1],
      ['image alt', '![a deploy chart](https://x.test/p.png) and deploy', 'deploy', 1],
      ['reference image', '![deploy][i]\n\n[i]: https://x.test/deploy.png', 'deploy', 0],
      ['autolink, angle', 'visit <https://x.test/deploy> now', 'deploy', 1],
      ['autolink, gfm literal', 'visit https://x.test/deploy now', 'deploy', 1],
      ['strikethrough', 'the ~~deploy~~ deploy', 'deploy', 2],
      ['footnote, plain body', 'the deploy[^1]\n\n[^1]: deploy notes', 'deploy', 1],
      ['footnote, formatted body', 'the deploy[^1]\n\n[^1]: **deploy** notes', 'deploy', 2],
      // THE SORT CASE: remark-rehype puts the definition's section last, so
      // document order here is 28-39, 43-48, 6-12, 14-18.
      ['footnote, defined first', '[^1]: **deploy** notes\n\nthe deploy[^1]', 'deploy', 2],
      ['setext heading', 'deploy report\n=====\n\nthe deploy', 'deploy', 2],
      ['hard break', 'deploy one  \ndeploy two', 'deploy', 2],
      ['soft break', 'deploy one\ndeploy two', 'deploy', 2],
      ['crlf paragraphs', 'deploy one\r\n\r\n**deploy** two', 'deploy', 2],
      ['entity', 'deploy &amp; deploy', 'deploy', 0],
      ['escaped asterisk', 'deploy \\*not bold\\* deploy', 'deploy', 0],
      ['inert html', '<div>deploy</div>\n\nthen **deploy**', 'deploy', 1],
      ['thematic break', 'deploy\n\n***\n\ndeploy', 'deploy', 2],
      ['query that is only markup', 'the **deploy** ran', '**', 0],
      ['query straddling markup', 'the **deploy** ran', 'e **d', 0],
      ['query with no match at all', 'the deploy ran', 'zzz', 0],
    ];

    it.each(corpus)('%s', (_name, markdown, query, expected) => {
      const { container } = render(
        conversation({ thread: [agentTurn(markdown)] }),
      );
      const bar = search(container, query);
      const reported = reportedTotal(bar);
      expect(reported).toBe(expected);
      expect(container.querySelectorAll('mark')).toHaveLength(reported);
    });

    it('the corpus is not all zeroes — a renderer that found nothing would pass', () => {
      // The guard on the guard. If the pipeline ever drifts so far that every
      // node's value stops matching its slice, every case above would expect 0
      // and agree; this is the line that notices the corpus stopped asserting.
      const nonZero = corpus.filter(([, , , n]) => n > 0);
      expect(nonZero.length).toBeGreaterThanOrEqual(24);
    });
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
