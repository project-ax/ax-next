// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AttachmentChip } from '../components/AttachmentChip';
import {
  ATTACHMENT_NAME_MAX_CHARS,
  clampAttachmentName,
  clampFileName,
} from '../lib/attachment-name';

describe('AttachmentChip', () => {
  // vi.spyOn + restoreAllMocks keeps the window.open stub scoped to this
  // describe block. Object.defineProperty(window, 'open', …) would persist
  // across the whole test file and leak into anything that mounts after.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders display name and downloads by conversation and attachment id on click', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <AttachmentChip
        attachmentId="3f1c2b9e-0d4a-4e7b-9c51-2a8f6e1d7b40"
        displayName="Q4 Report.pdf"
        mediaType="application/pdf"
        conversationId="c & 1"
      />,
    );
    expect(screen.getByTitle('Q4 Report.pdf').textContent).toBe('Q4 Report.pdf');
    // The whole chip is the one download control.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Download Q4 Report.pdf' }));
    // By id, never by a path, and every value encoded.
    expect(openSpy).toHaveBeenCalledWith(
      '/api/files?conversationId=c%20%26%201&id=3f1c2b9e-0d4a-4e7b-9c51-2a8f6e1d7b40',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('renders an image preview for image/*, fetched by conversation and attachment id', () => {
    const { container } = render(
      <AttachmentChip
        attachmentId="att-1"
        displayName="cat.png"
        mediaType="image/png"
        conversationId="c1"
      />,
    );
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('/api/files?conversationId=c1&id=att-1');
    expect(screen.getByRole('button', { name: 'Download cat.png' })).toBeTruthy();
  });

  it('shows the size, through the one size formatter', () => {
    render(
      <AttachmentChip
        attachmentId="att-1"
        displayName="Q4 Report.pdf"
        mediaType="application/pdf"
        conversationId="c1"
        sizeBytes={2048}
      />,
    );
    expect(screen.getByText('2 KB')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download Q4 Report.pdf' })).toHaveAccessibleDescription('2 KB');
  });

  it('an image is viewable inline: a preview of the file itself, which is also the download control', () => {
    const { container } = render(
      <AttachmentChip attachmentId="att-1" displayName="cat.png" mediaType="image/png" conversationId="c1" sizeBytes={2048} />,
    );
    const img = container.querySelector('[data-part="preview"] img');
    expect(img?.getAttribute('src')).toBe('/api/files?conversationId=c1&id=att-1');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Download cat.png' })).toHaveAccessibleDescription('2 KB');
  });

  it('a pending chip shows the name and offers nothing to press', () => {
    render(<AttachmentChip variant="pending" displayName="Q4 Report.pdf" mediaType="application/pdf" />);
    expect(screen.getByTitle('Q4 Report.pdf')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  /*
    TASK-431 — the clamp lives HERE, in the sink, not at the call sites.

    Three call sites render this chip and only one of them clamped by hand,
    which is the whole reason the card exists. These pin the bound at the one
    place all three pass through, so a fourth call site inherits it.
  */
  describe('clamps displayName at the sink', () => {
    const LONG = `${'z'.repeat(400)}.png`;
    // The stem clamped to the cap (119 characters and an ellipsis), the extension kept.
    const CLAMPED = `${'z'.repeat(ATTACHMENT_NAME_MAX_CHARS - 1)}….png`;

    it('bounds the image variant aria-label, keeps the extension, and leaves the preview alt empty', () => {
      const { container } = render(
        <AttachmentChip
          attachmentId="att-1"
          displayName={LONG}
          mediaType="image/png"
          conversationId="c1"
        />,
      );
      // The preview is decorative (the button's name already says what it
      // is), so its alt is empty and cannot carry the long name at all.
      expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
      const label = container.querySelector('button')?.getAttribute('aria-label') ?? '';
      expect(label).toBe(`Download ${CLAMPED}`);
      expect(label).toBe(`Download ${clampFileName(LONG)}`);
      expect(screen.getByTitle(CLAMPED).textContent).toBe(CLAMPED);
    });

    it('bounds the download-button aria-label on the non-image variant', () => {
      render(
        <AttachmentChip
          attachmentId="att-1"
          displayName={`${'q'.repeat(400)}.pdf`}
          mediaType="application/pdf"
          conversationId="c1"
        />,
      );
      const label =
        screen.getByRole('button').getAttribute('aria-label') ?? '';
      expect(label).toBe(`Download ${'q'.repeat(ATTACHMENT_NAME_MAX_CHARS - 1)}….pdf`);
    });

    it('bounds the pending variant, which has no id and no label', () => {
      const { container } = render(
        <AttachmentChip variant="pending" displayName={LONG} mediaType="image/png" />,
      );
      expect(container.textContent).toBe(CLAMPED);
      expect(container.innerHTML).not.toContain(LONG);
    });

    it('leaves an ordinary name exactly as it came in', () => {
      render(
        <AttachmentChip
          attachmentId="att-1"
          displayName="Q4 Report.pdf"
          mediaType="application/pdf"
          conversationId="c1"
        />,
      );
      // No ellipsis, no truncation, no "…" creeping into a short filename.
      expect(screen.getByTitle('Q4 Report.pdf').textContent).toBe('Q4 Report.pdf');
      expect(
        screen.getByRole('button').getAttribute('aria-label'),
      ).toBe('Download Q4 Report.pdf');
    });
  });
});

/*
  The clamp itself, away from any renderer. `clampAttachmentName` counts UTF-16
  units, which is what `String.length` counts, so the bound it advertises is the
  bound callers get. Slicing by UTF-16 unit can land between the two halves of a
  surrogate pair, though, and a lone half is ill-formed UTF-16 — a name built
  entirely out of astral characters is the case that finds it.
*/
describe('clampAttachmentName', () => {
  it('returns a short name untouched, including at exactly the cap', () => {
    expect(clampAttachmentName('report.pdf')).toBe('report.pdf');
    const exact = 'a'.repeat(ATTACHMENT_NAME_MAX_CHARS);
    expect(clampAttachmentName(exact)).toBe(exact);
    // One over is the first one that moves.
    const over = 'a'.repeat(ATTACHMENT_NAME_MAX_CHARS + 1);
    expect(clampAttachmentName(over)).not.toBe(over);
    expect(clampAttachmentName(over).length).toBe(ATTACHMENT_NAME_MAX_CHARS);
  });

  it('never leaves a lone surrogate half behind', () => {
    // U+1F4C4 PAGE FACING UP is two UTF-16 units, so a run of them puts a pair
    // boundary on every odd index — and the naive slice at cap-1 (119, odd)
    // lands inside one.
    const astral = '\u{1F4C4}'.repeat(200);
    const clamped = clampAttachmentName(astral);
    expect(clamped.length).toBeLessThanOrEqual(ATTACHMENT_NAME_MAX_CHARS);
    expect(clamped.endsWith('…')).toBe(true);
    // Every code point in the body is a whole PAGE FACING UP — no orphaned
    // half, which would iterate as a lone \uD83D and fail this.
    const body = clamped.slice(0, -1);
    expect([...body].every((c) => c === '\u{1F4C4}')).toBe(true);
    expect(body.length % 2).toBe(0);
  });
});

/*
  The filename clamp the three chips share: the stem is bounded, the extension
  is put back, so a long name still says what kind of file it is.
*/
describe('clampFileName', () => {
  it('clamps the stem and keeps the extension', () => {
    const long = `${'a'.repeat(400)}TAIL.csv`;
    expect(clampFileName(long)).toBe(`${'a'.repeat(ATTACHMENT_NAME_MAX_CHARS - 1)}….csv`);
    expect(clampFileName(long)).not.toContain('TAIL');
  });

  it('returns a short name untouched, including a stem at exactly the cap', () => {
    expect(clampFileName('report.final.csv')).toBe('report.final.csv');
    const exact = `${'a'.repeat(ATTACHMENT_NAME_MAX_CHARS)}.csv`;
    expect(clampFileName(exact)).toBe(exact);
  });

  it('clamps a name with no extension, or a dotfile, whole', () => {
    const plain = 'b'.repeat(400);
    expect(clampFileName(plain)).toBe(clampAttachmentName(plain));
    const dot = `.${'c'.repeat(400)}`;
    expect(clampFileName(dot)).toBe(clampAttachmentName(dot));
  });
});
