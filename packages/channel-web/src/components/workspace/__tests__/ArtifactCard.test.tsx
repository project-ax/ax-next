import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtifactCard } from '../ArtifactCard';

const copyShareLink = vi.fn();
vi.mock('@/lib/copy-share-link', () => ({ copyShareLink: (id: string) => copyShareLink(id) }));

const artifact = { artifactId: 'art-1', version: 2, title: 'Q3 report', kind: 'document' as const, extension: 'PDF' };

describe('ArtifactCard', () => {
  it('shows the name and type line', () => {
    render(<ArtifactCard artifact={artifact} onOpen={() => {}} />);
    expect(screen.getByText('Q3 report')).toBeTruthy();
    expect(screen.getByText('Document · PDF')).toBeTruthy();
  });

  it('Open calls onOpen; Copy link ensures and copies', () => {
    copyShareLink.mockResolvedValue({ kind: 'copied' });
    const onOpen = vi.fn();
    render(<ArtifactCard artifact={artifact} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith('art-1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(copyShareLink).toHaveBeenCalledWith('art-1');
  });
});
