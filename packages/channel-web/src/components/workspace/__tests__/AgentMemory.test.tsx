/**
 * The rules-only Memory tab (AW-13 / TASK-234) — what a deployment without
 * facts memory shows. These tests pin that the human's rules are kept word for
 * word and editable here, and that each read state gets a sentence that is
 * true of it (TASK-417).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentMemoryRead } from '@/lib/workspace-api';
import { AgentMemory } from '../AgentMemory';

/**
 * A read that WORKED, with whatever the rules happen to hold.
 *
 * Every fixture goes through one of these three rather than through a literal,
 * because the whole point of the shape is that a caller cannot accidentally
 * write "we read nothing" when it means "we could not read" (TASK-417).
 */
const read = (rulesBody = ''): AgentMemoryRead => ({
  rules: {
    status: 'ok',
    doc: { name: 'Your rules', scope: 'rules', body: rulesBody },
  },
});

/** A rules provider exists and would not answer. Retrying is a real offer. */
const failed = (): AgentMemoryRead => ({
  rules: { status: 'failed', doc: null },
});

/** No memory plugin is loaded on this deployment. Retrying is not an offer. */
const unavailable = (): AgentMemoryRead => ({
  rules: { status: 'unavailable', doc: null },
});

describe('AgentMemory', () => {
  it('draws only the rules tier — the agent-notes section went with TASK-608', () => {
    render(<AgentMemory agentName="Quill" memory={read('- cc Priya')} onSaveRules={vi.fn()} />);
    expect(screen.getByText('Rules you gave me')).toBeInTheDocument();
    expect(screen.queryByText('What it worked out')).toBeNull();
  });

  it('promises the rules are kept verbatim and never rewritten', () => {
    render(<AgentMemory agentName="Quill" memory={read()} onSaveRules={vi.fn()} />);
    expect(
      screen.getByText(/Kept word for word\. Quill reads them before every run/u),
    ).toBeInTheDocument();
  });

  it('shows the editor even when nothing has been written yet', () => {
    render(<AgentMemory agentName="Quill" memory={read()} onSaveRules={vi.fn()} />);
    const box = screen.getByLabelText('Rules you gave me');
    expect(box).toHaveValue('');
    // Save is off until there is something to save.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('placeholders the empty editor with two example rules, not a bare example', () => {
    render(<AgentMemory agentName="Quill" memory={read()} onSaveRules={vi.fn()} />);
    const box = screen.getByLabelText('Rules you gave me');
    expect(box).toHaveAttribute(
      'placeholder',
      'No rules yet. For example:\nAlways cc Priya on customer email.\nNever touch the billing spreadsheet without asking.',
    );
  });

  it('saves what the user typed, through the caller\'s write path', async () => {
    const onSaveRules = vi.fn().mockImplementation(async (b: string) => `${b}\n`);
    render(<AgentMemory agentName="Quill" memory={read()} onSaveRules={onSaveRules} />);

    fireEvent.change(screen.getByLabelText('Rules you gave me'), {
      target: { value: '- cc Priya' },
    });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(onSaveRules).toHaveBeenCalledWith('- cc Priya');
    });
  });

  it('settles to "Saved." even though the writer normalizes the text', async () => {
    /*
      The bug this pins: the store keeps `"- cc Priya\n"` for a textarea holding
      `"- cc Priya"`, so an editor that compared its own text against the
      re-read body stayed dirty forever — Save re-enabled, "Saved." never
      shown, every save reporting as not-saved on the one tab whose whole job
      is persistence confidence. The editor adopts the STORED text instead.
    */
    const onSaveRules = vi.fn().mockImplementation(async (b: string) => `${b}\n`);
    const { rerender } = render(
      <AgentMemory agentName="Quill" memory={read()} onSaveRules={onSaveRules} />,
    );

    fireEvent.change(screen.getByLabelText('Rules you gave me'), {
      target: { value: '- cc Priya' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByText('Saved.')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    // ...and the re-read that follows the save delivers the normalized body.
    // It must not knock the editor back into "Unsaved changes."
    rerender(
      <AgentMemory
        agentName="Quill"
        memory={read('- cc Priya\n')}
        onSaveRules={onSaveRules}
      />,
    );
    expect(screen.queryByText('Unsaved changes.')).toBeNull();
    expect(screen.getByText('Saved.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says so when the save fails instead of implying it stuck', async () => {
    const onSaveRules = vi.fn().mockRejectedValue(new Error('workspace /rules → 503'));
    render(<AgentMemory agentName="Quill" memory={read()} onSaveRules={onSaveRules} />);

    fireEvent.change(screen.getByLabelText('Rules you gave me'), {
      target: { value: '- cc Priya' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(
        screen.getByText(/We could not save that, so nothing changed/u),
      ).toBeInTheDocument();
    });
    // And what the user typed is still in the box — losing it would be the
    // second betrayal in a row.
    expect(screen.getByLabelText('Rules you gave me')).toHaveValue('- cc Priya');
  });

  it('refuses to show an empty editor when no rules row came back', () => {
    // The dangerous case: an unreadable rules file must NOT render as a
    // blank box, or the next Save overwrites rules the user still has.
    render(<AgentMemory agentName="Quill" memory={failed()} onSaveRules={vi.fn()} />);
    expect(screen.getByText('Rules you gave me')).toBeInTheDocument();
    expect(screen.queryByLabelText('Rules you gave me')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(
      screen.getByText(/We could not read your rules just now/u),
    ).toBeInTheDocument();
  });

  /*
    THIS ROW IS THE WORKED EXAMPLE FOR `lib/read-register.ts`'s third clause,
    and it is the one that clause exists to protect.

    By the first two clauses of that rule a failed read with no retry armed is
    `destructive` — so a reader applying the rule literally would "correct" this
    notice to red. They would be wrong, and nothing here said so: the row above
    pins that the editor is withheld but never pinned the REGISTER, so the
    repaint would have stayed green.

    Neutral is right because this is not a failure report, it is a withheld
    control. The editor is removed so nobody types into a blank box and saves
    over rules that are still safely on disk; nothing the reader holds is at
    risk, no obligation of theirs is going unmet, and the next read may work.
    Contrast `RulesEditor`'s save error, a failed WRITE, which IS red — and
    which the first two clauses predict correctly. (It was cited here by line
    number until TASK-417 moved it; symbols survive edits, line numbers do not.)
  */
  it('does not dress a withheld editor up as something having gone wrong', () => {
    render(<AgentMemory agentName="Quill" memory={failed()} onSaveRules={vi.fn()} />);
    expect(screen.getByRole('alert').className).not.toContain('destructive');
  });

  it('renders read-only when the caller has no write path', () => {
    render(<AgentMemory agentName="Quill" memory={read('- cc Priya')} />);
    expect(screen.getByLabelText('Rules you gave me')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  /*
    ───────────────────────────────────────────────────────────────────────────
    TASK-417 — three states, three sentences, and no promise we cannot keep.

    The walk that filed this found the tab on a deployment running no memory
    backend at all. It said confident things that were false — among them
    "try again in a moment" over the rules, a promise nothing can keep when
    there is no backend to come back.

    Every row below fails against the shape that existed before this card,
    because that shape (`MemoryDoc[]`) had nowhere to put the difference.
    ───────────────────────────────────────────────────────────────────────────
  */
  describe('with no memory backend on this deployment', () => {
    it('offers NO retry for the rules tier — there is nothing to come back', () => {
      render(
        <AgentMemory
          agentName="Quill"
          memory={unavailable()}
          onSaveRules={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      // And no prose retry either — the wording is the whole bug.
      expect(screen.queryByText(/try again in a moment/iu)).toBeNull();
      expect(
        screen.getByText(/Memory rules for Quill aren't switched on for this workspace yet/u),
      ).toBeInTheDocument();
      expect(screen.queryByText(/This copy of AX/iu)).toBeNull();
    });

    it('does not make the reader feel they broke something', () => {
      render(<AgentMemory agentName="Quill" memory={unavailable()} />);
      expect(
        screen.getByText(/Ask your workspace administrator about enabling them/u),
      ).toBeInTheDocument();
      // A setup choice on the server, not a malfunction: register stays neutral.
      expect(screen.getByRole('alert').className).not.toContain('destructive');
    });
  });

  describe('with a memory backend that would not answer', () => {
    it('offers a retry that actually re-runs the read', () => {
      const onRetry = vi.fn();
      render(
        <AgentMemory
          agentName="Quill"
          memory={failed()}
          onSaveRules={vi.fn()}
          onRetry={onRetry}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('withholds the retry when the caller gave us nothing to run', () => {
      // A button with no handler is the same lie in a different costume.
      render(<AgentMemory agentName="Quill" memory={failed()} onSaveRules={vi.fn()} />);
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    });
  });

  it('keeps the three states in three different words', () => {
    /*
      The point of the card in one row: render all three and check that no two
      of them say the same thing. An earlier version of this tab drew
      `unavailable` in `ok`-empty's or `failed`'s words, and a reader had no way
      to tell which situation they were in.
    */
    const sentences = (memory: AgentMemoryRead): string => {
      const { container, unmount } = render(
        <AgentMemory agentName="Quill" memory={memory} onSaveRules={vi.fn()} />,
      );
      const text = container.textContent ?? '';
      unmount();
      return text;
    };
    const empty = sentences(read());
    const broke = sentences(failed());
    const absent = sentences(unavailable());

    expect(empty).not.toEqual(broke);
    expect(broke).not.toEqual(absent);
    expect(empty).not.toEqual(absent);
  });
});
