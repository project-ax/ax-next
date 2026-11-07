import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ArtifactCard } from '../ArtifactCard';

const copyShareLink = vi.fn();
const artifactToken = vi.fn();
const saveFromContentOrigin = vi.fn();
vi.mock('@/lib/workspace-api', () => ({ workspaceApi: { artifactToken: (...a: unknown[]) => artifactToken(...a) } }));
vi.mock('@/lib/file-download', () => ({ saveFromContentOrigin: (u: string) => saveFromContentOrigin(u) }));
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

  it('with no viewer it offers Download, not Open, and hands the minted url to the browser', async () => {
    artifactToken.mockResolvedValue({ url: 'http://c/d/tok', expiresAt: 'x' });
    render(<ArtifactCard artifact={artifact} />);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(saveFromContentOrigin).toHaveBeenCalledWith('http://c/d/tok'));
    expect(artifactToken).toHaveBeenCalledWith('art-1', 2, 'download');
  });

  it('a manual copy outcome shows the link in the dialog', async () => {
    copyShareLink.mockResolvedValue({ kind: 'manual', url: 'http://x/a/code123' });
    render(<ArtifactCard artifact={artifact} onOpen={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(screen.getByDisplayValue('http://x/a/code123')).toBeTruthy());
  });
});
