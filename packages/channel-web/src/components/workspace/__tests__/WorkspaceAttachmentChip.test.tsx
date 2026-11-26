/**
 * The workspace composer's attachment chip (TASK-353).
 *
 * Three states have to be told apart by looking — and, here, by what a
 * person can see and reach (a progress bar, "Ready to send", a Try again),
 * so the assertions below pin behaviour rather than a class string. The one
 * that did not exist on chat's chip is `failed`: chat's version can only be
 * uploading or done, so a file that bounced off the server had nowhere to say
 * so. Here the sentence is real, readable DOM text
 * with a Retry next to it.
 *
 * The filename is untrusted input (it is whatever the person's disk says), so
 * it is rendered as a React text child and clamped before it reaches the DOM.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceAttachmentChip } from '../WorkspaceAttachmentChip';
import type { WorkspaceAttachment } from '@/lib/workspace-attachments';
import { clampFileName } from '@/lib/attachment-name';

function attachment(
  over: Partial<WorkspaceAttachment> = {},
): WorkspaceAttachment {
  return {
    id: 'a1',
    name: 'notes.txt',
    contentType: 'text/plain',
    status: 'uploading',
    progress: 0,
    attachmentId: null,
    message: null,
    ...over,
  };
}

function chip(over: Partial<WorkspaceAttachment> = {}) {
  const onRemove = vi.fn();
  const onRetry = vi.fn();
  const { container } = render(
    <WorkspaceAttachmentChip
      attachment={attachment(over)}
      onRemove={onRemove}
      onRetry={onRetry}
    />,
  );
  return { container, onRemove, onRetry };
}

/** What a person can see and reach in each state: the bar, the ready line, the retry. */
function stateSignature(): string {
  return [
    screen.queryByRole('progressbar') ? 'progress' : '',
    screen.queryByText('Ready to send') ? 'ready' : '',
    screen.queryByRole('button', { name: 'Try again' }) ? 'retry' : '',
  ].join('|');
}

const FAILURE = 'That file is too big to send. The limit is 25 MB.';

describe('WorkspaceAttachmentChip — the three states', () => {
  it('uploading shows a progress bar and a way out', () => {
    const { onRemove } = chip({ status: 'uploading', progress: 0.4 });
    expect(stateSignature()).toBe('progress||');
    expect(screen.getByTitle('notes.txt').textContent).toBe('notes.txt');

    // A progress bar, named by the file. Its absence means the person is
    // watching a chip that never says anything is happening.
    const bar = screen.getByRole('progressbar', { name: 'notes.txt' });
    expect(bar).toBeInTheDocument();
    /*
      The bar has to reflect THIS chip's progress, not merely exist: a chip
      that forwarded the raw 0..1 fraction would show 0 of 100 here. It is a
      native <progress>, so its value is what assistive tech reads too (the
      old shadcn wrapper never forwarded `aria-valuenow`, so no screen reader
      ever heard a number; this pins that it now does).
    */
    expect(bar).toHaveAttribute('max', '100');
    expect(bar).toHaveAttribute('value', '40');
    expect((bar as HTMLProgressElement).value).toBe(40);

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('uploaded says so in words, and stops the progress bar', () => {
    const { onRemove } = chip({
      status: 'uploaded',
      progress: 1,
      attachmentId: 'att-1',
    });
    expect(stateSignature()).toBe('|ready|');
    expect(screen.getByText('Ready to send')).toBeInTheDocument();
    // A bar still spinning on a finished upload reads as stuck.
    expect(screen.queryByRole('progressbar')).toBeNull();
    // No retry offered for something that worked.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('failed prints the sentence as readable text with both ways forward', () => {
    const { container, onRemove, onRetry } = chip({
      status: 'failed',
      message: FAILURE,
    });
    expect(stateSignature()).toBe('||retry');

    // Real DOM text, not a tooltip and not a `title=`. A title attribute is
    // invisible on touch, invisible to a person who does not hover, and
    // unreadable by half of assistive tech. The only title in the chip is
    // the filename's own (the full name behind a truncated one).
    expect(screen.getByText(FAILURE)).toBeVisible();
    expect(Array.from(container.querySelectorAll('[title]')).map((n) => n.getAttribute('title'))).toEqual(['notes.txt']);

    const retry = screen.getByRole('button', { name: 'Try again' });
    // Named by the file in every state: two failed chips never offer two
    // buttons both called just "Remove".
    const remove = screen.getByRole('button', { name: 'Remove notes.txt' });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);

    // Destructive sentence and border, via the semantic danger token — not a raw colour.
    expect(screen.getByText(FAILURE).className).toContain('ax-text-status-danger');
    expect(screen.getByTitle('notes.txt').closest('.ax-isolate')?.className).toContain('ax-border-status-danger');
  });

  it('Try again keeps focus in the chip: it lands on Remove, the same element through the restart', () => {
    const onRetry = vi.fn();
    const props = { onRemove: vi.fn(), onRetry };
    const { rerender } = render(
      <WorkspaceAttachmentChip attachment={attachment({ status: 'failed', message: FAILURE })} {...props} />,
    );
    const remove = screen.getByRole('button', { name: 'Remove notes.txt' });
    const retry = screen.getByRole('button', { name: 'Try again' });
    retry.focus();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(remove).toHaveFocus();
    // The upload restarts: Try again goes, Remove stays the same element and keeps focus.
    rerender(<WorkspaceAttachmentChip attachment={attachment({ status: 'uploading', progress: 0.1 })} {...props} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBe(remove);
    expect(remove).toHaveFocus();
    // And back to failed: still the same Remove.
    rerender(<WorkspaceAttachmentChip attachment={attachment({ status: 'failed', message: FAILURE })} {...props} />);
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBe(remove);
  });

  it('the three states are distinguishable from each other', () => {
    const signatures = (['uploading', 'uploaded', 'failed'] as const).map((s) => {
      const { unmount } = render(
        <WorkspaceAttachmentChip
          attachment={attachment({ status: s, progress: 0.5, message: s === 'failed' ? FAILURE : null })}
          onRemove={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
      const value = stateSignature();
      unmount();
      return value;
    });
    expect(signatures).toEqual(['progress||', '|ready|', '||retry']);
  });
});

describe('WorkspaceAttachmentChip — the filename is untrusted', () => {
  it('clamps a pathological name before it reaches the DOM', () => {
    const name = `${'a'.repeat(400)}TAIL.txt`;
    const { container } = chip({ name });
    // The stem is clamped to the cap (119 characters and an ellipsis) and the
    // extension is kept, so the chip still says what kind of file it is.
    const clamped = `${'a'.repeat(119)}….txt`;
    expect(clampFileName(name)).toBe(clamped);
    const rendered = screen.getByTitle(clamped);
    expect(rendered.textContent).toBe(clamped);
    // The far end of a 400-character name must not be in the document at all
    // — `truncate` only hides it visually, it stays in the accessibility tree
    // and in the layout budget.
    expect(container.textContent).not.toContain('TAIL');
    expect(container.innerHTML).not.toContain('TAIL');
  });

  it('leaves a normal-length name exactly as it is', () => {
    chip({ name: 'quarterly-report-final-v3.pdf' });
    expect(screen.getByTitle('quarterly-report-final-v3.pdf').textContent).toBe('quarterly-report-final-v3.pdf');
  });

  it('renders markup in a name as text, never as markup', () => {
    const { container } = chip({ name: '<img src=x onerror=alert(1)>.png' });
    expect(container.querySelector('img')).toBeNull();
    expect(
      screen.getByTitle('<img src=x onerror=alert(1)>.png').textContent,
    ).toBe('<img src=x onerror=alert(1)>.png');
  });

  it('labels the remove control with the clamped name too', () => {
    const name = `${'b'.repeat(400)}TAIL.txt`;
    chip({ name });
    // An aria-label built from the raw name would be a 400-character
    // announcement. The button still has to exist and still has to be findable.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    const label = buttons[0]!.getAttribute('aria-label') ?? '';
    expect(label).toBe(`Remove ${'b'.repeat(119)}….txt`);
    expect(label).not.toContain('TAIL');
  });
});
