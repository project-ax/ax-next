// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArtifactChip } from '../components/ArtifactChip';

describe('ArtifactChip', () => {
  it('renders displayName + size + a download trigger (inline variant)', () => {
    render(
      <ArtifactChip
        variant="inline"
        path="workspace/reports/Q4.pdf"
        displayName="Q4 Report"
        mediaType="application/pdf"
        sizeBytes={482113}
        conversationId="c1"
      />,
    );
    expect(screen.getByText('Q4 Report')).toBeTruthy();
    expect(screen.getByText(/470/)).toBeTruthy(); // 482113 / 1024 ≈ 471 KB
    expect(screen.getByLabelText(/Download Q4 Report/)).toBeTruthy();
  });

  it('renders a disabled "unknown artifact" pill when no match is provided', () => {
    render(
      <ArtifactChip
        variant="link"
        artifactId="unknown-id"
        conversationId="c1"
        // No path / displayName given → unknown.
      />,
    );
    expect(screen.getByText(/unknown artifact/i)).toBeTruthy();
  });

  it('link variant renders inline with the display name as link text', () => {
    render(
      <ArtifactChip
        variant="link"
        path="workspace/x.pdf"
        displayName="x.pdf"
        mediaType="application/pdf"
        sizeBytes={1024}
        conversationId="c1"
      />,
    );
    const a = screen.getByRole('link', { name: 'x.pdf' });
    expect(a).toBeTruthy();
    expect(a.getAttribute('href')).toMatch(/\/api\/files\?/);
  });
});
