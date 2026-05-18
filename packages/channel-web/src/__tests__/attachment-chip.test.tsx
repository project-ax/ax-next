// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AttachmentChip } from '../components/AttachmentChip';

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
});
