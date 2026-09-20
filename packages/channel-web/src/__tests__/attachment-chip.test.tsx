// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AttachmentChip } from '../components/AttachmentChip';
import {
  ATTACHMENT_NAME_MAX_CHARS,
  clampAttachmentName,
} from '../lib/attachment-name';

describe('AttachmentChip', () => {
  // vi.spyOn + restoreAllMocks keeps the window.open stub scoped to this
  // describe block. Object.defineProperty(window, 'open', …) would persist
  // across the whole test file and leak into anything that mounts after.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders display name and triggers GET /api/files on click', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <AttachmentChip
        path=".ax/uploads/c1/t1/foo.pdf"
        displayName="Q4 Report.pdf"
        mediaType="application/pdf"
        conversationId="c1"
      />,
    );
    expect(screen.getByText('Q4 Report.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/files\?path=[^&]+&conversationId=c1$/),
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('renders an image preview for image/*', () => {
    const { container } = render(
      <AttachmentChip
        path=".ax/uploads/c1/t1/cat.png"
        displayName="cat.png"
        mediaType="image/png"
        conversationId="c1"
      />,
    );
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toMatch(/\/api\/files\?path=[^&]+&conversationId=c1$/);
  });

  /*
    TASK-431 — the clamp lives HERE, in the sink, not at the call sites.

    Three call sites render this chip and only one of them clamped by hand,
    which is the whole reason the card exists. These pin the bound at the one
    place all three pass through, so a fourth call site inherits it.
  */
  describe('clamps displayName at the sink', () => {
    const LONG = `${'z'.repeat(400)}.png`;

    it('bounds alt and the image variant aria-label', () => {
      const { container } = render(
        <AttachmentChip
          path=".ax/uploads/c1/t1/z.png"
          displayName={LONG}
          mediaType="image/png"
          conversationId="c1"
        />,
      );
      const alt = container.querySelector('img')?.getAttribute('alt') ?? '';
      expect(alt.length).toBeLessThanOrEqual(ATTACHMENT_NAME_MAX_CHARS);
      expect(alt.length).toBeLessThan(LONG.length);
      expect(alt.endsWith('…')).toBe(true);
      expect(
        container.querySelector('button')?.getAttribute('aria-label'),
      ).toBe(`Download ${alt}`);
    });

    it('bounds the download-button aria-label on the non-image variant', () => {
      render(
        <AttachmentChip
          path=".ax/uploads/c1/t1/z.pdf"
          displayName={`${'q'.repeat(400)}.pdf`}
          mediaType="application/pdf"
          conversationId="c1"
        />,
      );
      const label =
        screen.getByRole('button').getAttribute('aria-label') ?? '';
      expect(label.length).toBeLessThanOrEqual(
        'Download '.length + ATTACHMENT_NAME_MAX_CHARS,
      );
      expect(label.startsWith('Download qqq')).toBe(true);
    });

    it('bounds the pending variant, which has no path and no label', () => {
      const { container } = render(
        <AttachmentChip variant="pending" displayName={LONG} mediaType="image/png" />,
      );
      const text = container.textContent ?? '';
      expect(text.length).toBeLessThanOrEqual(ATTACHMENT_NAME_MAX_CHARS);
      expect(container.innerHTML).not.toContain(LONG);
    });

    it('leaves an ordinary name exactly as it came in', () => {
      render(
        <AttachmentChip
          path=".ax/uploads/c1/t1/foo.pdf"
          displayName="Q4 Report.pdf"
          mediaType="application/pdf"
          conversationId="c1"
        />,
      );
      // No ellipsis, no truncation, no "…" creeping into a short filename.
      expect(screen.getByText('Q4 Report.pdf')).toBeTruthy();
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
