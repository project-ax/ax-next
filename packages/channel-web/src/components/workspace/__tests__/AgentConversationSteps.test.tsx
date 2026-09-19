/**
 * The step panel, drawn (TASK-352).
 *
 * The seam test (`src/__tests__/workspace-steps-seam.test.tsx`) proves the two
 * paths agree; this proves the thing they agree ON is actually drawable — the
 * disclosure opens and shuts, identical rows survive, and a tool-only turn
 * renders its panel without an empty bubble above it.
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
    time: '4:12 PM',
    stepsLabel: '2 steps',
    steps: [
      { text: 'Bash', status: 'done' },
      { text: 'Bash', status: 'done' },
    ],
    ...over,
  }) as ThreadMessage;

function rows(container: HTMLElement): string[] {
  const panel = container.querySelector('[data-testid="workspace-steps"]');
  if (panel === null) throw new Error('no step panel');
  return [...panel.querySelectorAll('li')].map((li) => (li.textContent ?? '').trim());
}

describe('the step panel', () => {
  it('keeps two identical rows as two rows', () => {
    // An agent that ran the same tool twice did two things. Keying the list by
    // the sentence would make those a duplicate React key across siblings.
    const { container } = renderThread([steps()]);
    expect(rows(container)).toEqual(['Bash', 'Bash']);
  });

  it('opens by default and can be shut', () => {
    const { container } = renderThread([steps()]);
    expect(rows(container)).toHaveLength(2);
    const trigger = container.querySelector(
      '[data-testid="workspace-steps"] button',
    );
    fireEvent.click(trigger!);
    expect(
      container.querySelectorAll('[data-testid="workspace-steps"] li'),
    ).toHaveLength(0);
  });

  it('draws no empty bubble above a turn that only ran tools', () => {
    const { container } = renderThread([steps({ text: '' })]);
    expect(rows(container)).toHaveLength(2);
    // The prose bubble carries this class; with no prose it must not exist.
    expect(container.querySelector('.text-pretty')).toBeNull();
  });

  it('still draws the reply above the panel when there is one', () => {
    const { container } = renderThread([steps({ text: 'Done.' })]);
    expect(container.querySelector('.text-pretty')?.textContent).toContain('Done.');
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
