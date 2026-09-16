/**
 * The workspace composer's attachment chip (TASK-353).
 *
 * Three states have to be told apart by looking — and, here, by
 * `data-status`, so the assertions below pin behaviour rather than a class
 * string. The one that did not exist on chat's chip is `failed`: chat's
 * version can only be uploading or done, so a file that bounced off the
 * server had nowhere to say so. Here the sentence is real, readable DOM text
 * with a Retry next to it.
 *
 * The filename is untrusted input (it is whatever the person's disk says), so
 * it is rendered as a React text child and clamped before it reaches the DOM.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceAttachmentChip } from '../WorkspaceAttachmentChip';
import type { WorkspaceAttachment } from '@/lib/workspace-attachments';

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
  const root = container.querySelector('[data-status]');
  if (!root) throw new Error('chip rendered without a data-status root');
  return { root, onRemove, onRetry };
}

const FAILURE = 'That file is too big to send. The limit is 25 MB.';

describe('WorkspaceAttachmentChip — the three states', () => {
  it('uploading shows a progress bar and a way out', () => {
    const { root, onRemove } = chip({ status: 'uploading', progress: 0.4 });
    expect(root.getAttribute('data-status')).toBe('uploading');
    expect(screen.getByText('notes.txt')).toBeInTheDocument();

    // Radix's Progress renders role="progressbar". Its absence means the
    // person is watching a chip that never says anything is happening.
    const bar = screen.getByRole('progressbar');
    expect(bar).toBeInTheDocument();
    /*
      The bar has to reflect THIS chip's progress, not merely exist. We read
      the indicator's transform rather than `aria-valuenow`, because the local
      `ui/progress.tsx` wrapper destructures `value` out and never forwards it
      to the Radix Root — so `aria-valuenow` is null for every Progress in this
      app. (A real a11y gap, but in a shared file this task does not own.)
      The transform is the signal that survives: a chip that forwarded the raw
      0..1 fraction would render translateX(-99.6%) here.
    */
    const indicator = bar.firstElementChild as HTMLElement | null;
    expect(indicator).not.toBeNull();
    expect(indicator!.style.transform).toBe('translateX(-60%)');

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('uploaded says so in words, and stops the progress bar', () => {
    const { root, onRemove } = chip({
      status: 'uploaded',
      progress: 1,
      attachmentId: 'att-1',
    });
    expect(root.getAttribute('data-status')).toBe('uploaded');
    expect(screen.getByText('Ready to send')).toBeInTheDocument();
    // A bar still spinning on a finished upload reads as stuck.
    expect(screen.queryByRole('progressbar')).toBeNull();
    // No retry offered for something that worked.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('failed prints the sentence as readable text with both ways forward', () => {
    const { root, onRemove, onRetry } = chip({
      status: 'failed',
      message: FAILURE,
    });
    expect(root.getAttribute('data-status')).toBe('failed');

    // Real DOM text, not a tooltip and not a `title=`. A title attribute is
    // invisible on touch, invisible to a person who does not hover, and
    // unreadable by half of assistive tech.
    expect(screen.getByText(FAILURE)).toBeInTheDocument();
    expect(root.querySelector('[title]')).toBeNull();

    const retry = screen.getByRole('button', { name: 'Retry' });
    const remove = screen.getByRole('button', { name: 'Remove' });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);

    // Destructive border, via the semantic token — not a raw colour.
    expect(root.className).toContain('border-destructive');
  });

  it('the three states are distinguishable from each other', () => {
    const statuses = (['uploading', 'uploaded', 'failed'] as const).map((s) => {
      const { container, unmount } = render(
        <WorkspaceAttachmentChip
          attachment={attachment({ status: s, message: s === 'failed' ? FAILURE : null })}
          onRemove={vi.fn()}
          onRetry={vi.fn()}
        />,
      );
      const value = container
        .querySelector('[data-status]')
        ?.getAttribute('data-status');
      unmount();
      return value;
    });
    expect(statuses).toEqual(['uploading', 'uploaded', 'failed']);
  });
});

describe('WorkspaceAttachmentChip — the filename is untrusted', () => {
  it('clamps a pathological name before it reaches the DOM', () => {
    const name = `${'a'.repeat(400)}TAIL.txt`;
    const { root } = chip({ name });
    const rendered = root.querySelector('[data-slot="attachment-name"]');
    expect(rendered).not.toBeNull();
    const text = rendered!.textContent ?? '';
    expect(text).toHaveLength(120);
    // The far end of a 400-character name must not be in the document at all
    // — `truncate` only hides it visually, it stays in the accessibility tree
    // and in the layout budget.
    expect(root.textContent).not.toContain('TAIL');
  });

  it('leaves a normal-length name exactly as it is', () => {
    const { root } = chip({ name: 'quarterly-report-final-v3.pdf' });
    expect(
      root.querySelector('[data-slot="attachment-name"]')?.textContent,
    ).toBe('quarterly-report-final-v3.pdf');
  });

  it('renders markup in a name as text, never as markup', () => {
    const { root } = chip({ name: '<img src=x onerror=alert(1)>.png' });
    expect(root.querySelector('img')).toBeNull();
    expect(
      screen.getByText('<img src=x onerror=alert(1)>.png'),
    ).toBeInTheDocument();
  });

  it('labels the remove control with the clamped name too', () => {
    const name = `${'b'.repeat(400)}TAIL.txt`;
    chip({ name });
    // An aria-label built from the raw name would be a 400-character
    // announcement. The button still has to exist and still has to be findable.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    const label = buttons[0]!.getAttribute('aria-label') ?? '';
    expect(label.startsWith('Remove ')).toBe(true);
    expect(label).not.toContain('TAIL');
  });
});
