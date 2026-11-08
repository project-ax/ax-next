/**
 * The step panel, drawn (TASK-352).
 *
 * The seam test (`src/__tests__/workspace-steps-seam.test.tsx`) proves the two
 * paths agree; this proves the thing they agree ON is actually drawable — the
 * disclosure starts shut and opens, sits ABOVE the reply and its artifacts,
 * folds a run of one kind, and keeps the raw input one click further down.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { ThreadMessage, WorkspaceAgent } from '@/lib/workspace-api';

const quill: WorkspaceAgent = {
  id: 'a1',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function renderThread(
  thread: ThreadMessage[],
): ReturnType<typeof render> {
  const props: ComponentProps<typeof AgentConversation> = {
    agent: quill,
    thread,
    conversationId: 'c1',
    decisions: [],
    readOnly: false,
    onSend: vi.fn(),
    onApprove: vi.fn(),
    onDismiss: vi.fn(),
    onUndo: vi.fn(),
    approvalRead: 'ok',
    onRetryApprovals: vi.fn(),
    grants: [],
    onGrantResolved: vi.fn(),
    onGranted: vi.fn(async () => true),
  };
  return render(<AgentConversation {...props} />);
}

const steps = (over: Partial<Extract<ThreadMessage, { kind: 'steps' }>> = {}) =>
  ({
    kind: 'steps',
    id: 't1',
    text: 'Done.',
    at: '2026-09-17T16:12:00.000Z',
    stepsLabel: '2 steps',
    steps: [
      { text: 'Bash', status: 'done' },
      { text: 'Bash', status: 'done' },
    ],
    ...over,
  }) as ThreadMessage;

function panelOf(container: HTMLElement): HTMLElement {
  const panel = container.querySelector<HTMLElement>('[data-testid="workspace-steps"]');
  if (panel === null) throw new Error('no step panel');
  return panel;
}

/** Open the panel (it starts shut) and read its rows. */
function rows(container: HTMLElement): string[] {
  const panel = panelOf(container);
  if (panel.querySelectorAll('li').length === 0) fireEvent.click(panel.querySelector('button')!);
  return [...panel.querySelectorAll('li')].map((li) => (li.textContent ?? '').trim());
}

/*
  TASK-436 — WHAT THE CLAMP HIDES HAS TO BE RECOVERABLE.

  jsdom has no CSS and no layout, so nothing below asserts that anything is
  visually truncated — there is nothing here to truncate it, and such an
  assertion would be vacuous by construction. What IS assertable, and what
  this card is actually about, is that the element doing the hiding carries
  the WHOLE source string in `title`.
*/

describe('the step panel', () => {
  it('keeps two identical rows as two rows', () => {
    // An agent that ran the same tool twice did two things. Keying the list by
    // the sentence would make those a duplicate React key across siblings.
    const { container } = renderThread([steps()]);
    expect(rows(container)).toEqual(['Bash', 'Bash']);
  });

  it('starts shut, says what it did in one line, and opens on click', () => {
    const { container } = renderThread([
      steps({
        steps: [
          { text: 'Read index.js', status: 'done', kind: 'read', detail: '/tmp/r/index.js' },
          { text: 'Ran a command', status: 'done', kind: 'command', detail: 'ls -la' },
          { text: 'Ran a command', status: 'done', kind: 'command', detail: 'cat README.md' },
        ],
      }),
    ]);
    const panel = panelOf(container);
    expect(panel.querySelectorAll('li')).toHaveLength(0);
    const trigger = panel.querySelector('button')!;
    expect(trigger.textContent).toBe('Read a file, ran 2 commands');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.querySelectorAll('li').length).toBeGreaterThan(0);
  });

  it('folds a run of one kind into one row, with each raw input inside it', () => {
    const { container } = renderThread([
      steps({
        steps: [
          { text: 'Ran a command', status: 'done', kind: 'command', detail: 'ls -la' },
          { text: 'Ran a command', status: 'done', kind: 'command', detail: 'cat README.md' },
          { text: 'Read index.js', status: 'done', kind: 'read', detail: '/tmp/r/index.js' },
        ],
      }),
    ]);
    expect(rows(container)).toEqual(['Ran 2 commands', 'Read index.js']);
    // The raw command is not on screen until its row is opened.
    expect(container.textContent).not.toContain('ls -la');
    const group = [...panelOf(container).querySelectorAll('li button')].find((b) =>
      (b.textContent ?? '').includes('Ran 2 commands'),
    )!;
    fireEvent.click(group);
    const codes = [...panelOf(container).querySelectorAll('code')].map((c) => c.textContent);
    expect(codes).toEqual(['ls -la', 'cat README.md']);
  });

  it('never folds a failed step into a group', () => {
    const { container } = renderThread([
      steps({
        steps: [
          { text: 'Ran a command', status: 'done', kind: 'command', detail: 'a' },
          { text: "Ran a command — didn't finish", status: 'failed', kind: 'command', detail: 'b' },
          { text: 'Ran a command', status: 'done', kind: 'command', detail: 'c' },
        ],
      }),
    ]);
    expect(rows(container)).toEqual(['Ran a command', "Ran a command — didn't finish", 'Ran a command']);
    // Shut, the title does not raise the failure — no words, no icon, no red.
    const title = panelOf(container).querySelector('button')!;
    expect(title.textContent).toBe('Ran 3 commands');
    expect(title.querySelector('svg.text-destructive')).toBeNull();
    expect(title.className).not.toContain('text-destructive');
  });

  it('sits ABOVE the reply, and the reply\'s artifact sits below both', () => {
    const { container } = renderThread([
      steps({ id: 't1', text: '', steps: [{ text: 'Making a report', status: 'done' }] }),
      {
        kind: 'agent',
        id: 't2',
        text: '',
        at: '2026-09-17T16:12:01.000Z',
        artifacts: [{ artifactId: 'art1', version: 1, title: 'Q3 report', kind: 'document', extension: 'PDF' }],
      } as ThreadMessage,
      steps({ id: 't3', text: '', steps: [{ text: 'Checking the report', status: 'done' }] }),
      { kind: 'agent', id: 't4', text: 'Your report is ready.', at: '2026-09-17T16:12:03.000Z' } as ThreadMessage,
    ]);
    // One panel for the whole reply, holding the steps from BOTH sides of the card.
    expect(container.querySelectorAll('[data-testid="workspace-steps"]')).toHaveLength(1);
    expect(rows(container)).toEqual(['Making a report', 'Checking the report']);
    const text = container.textContent ?? '';
    const at = (s: string) => text.indexOf(s);
    expect(at('Making a report')).toBeGreaterThan(-1);
    expect(at('Making a report')).toBeLessThan(at('Your report is ready.'));
    expect(at('Your report is ready.')).toBeLessThan(at('Q3 report'));
  });

  it('keeps narration from between the steps inside the panel, not in the reply', () => {
    const { container } = renderThread([
      steps({ id: 't1', text: 'Let me look at the repo.', steps: [{ text: 'Ran a command', status: 'done' }] }),
      { kind: 'agent', id: 't2', text: 'Here is how it works.', at: '2026-09-17T16:12:03.000Z' } as ThreadMessage,
    ]);
    expect(container.querySelector('.text-pretty')?.textContent).toBe('Here is how it works.');
    expect(rows(container)).toEqual(['Let me look at the repo.', 'Ran a command']);
  });

  it('draws no empty bubble above a turn that only ran tools', () => {
    const { container } = renderThread([steps({ text: '' })]);
    expect(rows(container)).toEqual(['Bash', 'Bash']);
    // The prose bubble carries this class; with no prose it must not exist.
    expect(container.querySelector('.text-pretty')).toBeNull();
  });

  it('still draws the reply, under the panel, when there is one', () => {
    const { container } = renderThread([steps({ text: 'Done.' })]);
    expect(container.querySelector('.text-pretty')?.textContent).toContain('Done.');
    const panel = panelOf(container);
    const reply = container.querySelector('.text-pretty')!;
    expect(panel.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // --- a failure has to LOOK like one (TASK-419) ---------------------------
  //
  // A walk against the live deployment read a step that had failed as one that
  // had worked. The row's only difference from a successful one was three
  // trailing words in exactly the same grey — no colour, no mark, nothing a
  // reader scanning a list would catch. "It tells you if you read every word"
  // is not a signal; it is a footnote on a claim of success.

  /**
   * The colour tokens on a row, and nothing else.
   *
   * `text-[12.5px]` is a SIZE wearing a `text-` prefix, so it is filtered out
   * — otherwise every row would look like it had a tone.
   */
  const toneOf = (el: HTMLElement): string[] =>
    el.className
      .split(/\s+/)
      .filter((c) => c.startsWith('text-') && !c.startsWith('text-['));

  /** The `li` for one row, by the text it carries. */
  function rowFor(container: HTMLElement, text: string): HTMLElement {
    rows(container);
    const li = [...container.querySelectorAll('li')].find((el) =>
      (el.textContent ?? '').includes(text),
    );
    if (li === undefined) throw new Error(`no step row saying "${text}"`);
    return li as HTMLElement;
  }

  it('does not draw a failed step the same way as one that worked', () => {
    const { container } = renderThread([
      steps({
        stepsLabel: "2 steps, 1 didn't finish",
        steps: [
          { text: 'Bash: pnpm build', status: 'done' },
          { text: "Bash: not-a-command — didn't finish", status: 'failed' },
        ],
      }),
    ]);

    const ok = rowFor(container, 'pnpm build');
    const bad = rowFor(container, 'not-a-command');

    /*
      THE ASSERTION THAT REDDENS AGAINST THE UNFIXED CODE. Compared on the
      COLOUR tokens alone, not on the whole class string: rows after the first
      also carry a separator class, so a raw string comparison would pass on
      the unfixed code for a reason that has nothing to do with what a reader
      sees. Measured — with the mark removed, both sides of this are
      `['text-muted-foreground']`.
    */
    expect(toneOf(bad)).not.toEqual(toneOf(ok));
    // And the difference is the token the rest of the product already uses for
    // a failure, not an ad-hoc colour (invariant 6).
    expect(bad.className).toContain('text-destructive');
    expect(ok.className).toContain('text-muted-foreground');
    expect(ok.className).not.toContain('text-destructive');
    // Colour alone is not readable by everyone, so the row is marked twice:
    // an icon as well as a tone. The successful row carries neither.
    expect(bad.querySelector('svg')).not.toBeNull();
    expect(ok.querySelector('svg')).toBeNull();
    // The words stay too — the mark is additive, never a replacement for
    // saying what happened.
    expect(bad.textContent).toContain("didn't finish");
  });

  it('marks a step waiting on a person as waiting, not as a failure', () => {
    // Per row, a hold is not a failure: a call waiting on somebody has not run
    // and has not gone wrong, and painting it red tells them it is over.
    const { container } = renderThread([
      steps({
        stepsLabel: '2 steps, 1 waiting for you',
        steps: [
          { text: 'Bash: pnpm build', status: 'done' },
          { text: 'Sending the email — waiting for you', status: 'waiting' },
        ],
      }),
    ]);
    const held = rowFor(container, 'Sending the email');
    expect(held.className).toContain('text-warning');
    expect(held.className).not.toContain('text-destructive');
    expect(held.querySelector('svg')).not.toBeNull();
  });

  it('leaves a step still running in the ordinary tone', () => {
    // Nothing has gone wrong yet, so nothing is marked. A row of alarm icons
    // over "in progress" is noise the real exceptions have to compete with.
    const { container } = renderThread([
      steps({
        stepsLabel: '1 step, 1 in progress',
        steps: [{ text: 'Bash: pnpm build — in progress', status: 'running' }],
      }),
    ]);
    const live = rowFor(container, 'pnpm build');
    expect(live.className).toContain('text-muted-foreground');
    expect(live.querySelector('svg')).toBeNull();
  });
});

describe('a clamped step row (TASK-436)', () => {
  it('carries the whole row text in `title`', () => {
    const row =
      'Read: /permanent/projects/quarterly-review/2026-Q3/regional-breakdown-emea.csv';
    const { container } = renderThread([
      steps({ stepsLabel: '1 step', steps: [{ text: row, status: 'done' }] }),
    ]);
    rows(container);
    const span = container.querySelector(
      '[data-testid="workspace-steps"] li span[title]',
    );
    expect(span).toBeTruthy();
    expect(span?.getAttribute('title')).toBe(row);
    // And the element with the title is the one holding the text — a title on
    // some ancestor is not a tooltip on the thing that got cut.
    expect(span?.textContent).toBe(row);
  });

  it('still says in words what a failed row did, title or no title', () => {
    // The status suffix is part of the row, so it has to be inside `title`
    // too: a reader recovering the row by hover must not lose the outcome.
    const { container } = renderThread([
      steps({
        stepsLabel: '1 step',
        steps: [{ text: "Sending the email — didn't finish", status: 'failed' }],
      }),
    ]);
    rows(container);
    const span = container.querySelector(
      '[data-testid="workspace-steps"] li span[title]',
    );
    expect(span?.getAttribute('title')).toBe("Sending the email — didn't finish");
  });
});
