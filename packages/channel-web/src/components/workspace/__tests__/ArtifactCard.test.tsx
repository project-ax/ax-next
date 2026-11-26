import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ArtifactCard } from '../ArtifactCard';

const artifactToken = vi.fn();
const saveFromContentOrigin = vi.fn();
vi.mock('@/lib/workspace-api', () => ({ workspaceApi: { artifactToken: (...a: unknown[]) => artifactToken(...a) } }));
vi.mock('@/lib/file-download', () => ({ saveFromContentOrigin: (u: string) => saveFromContentOrigin(u) }));

const artifact = { artifactId: 'art-1', version: 2, title: 'Q3 report', kind: 'document' as const, extension: 'PDF' };

describe('ArtifactCard', () => {
  it('shows the name and type line', () => {
    render(<ArtifactCard artifact={artifact} onOpen={() => {}} />);
    expect(screen.getByText('Q3 report')).toBeTruthy();
    expect(screen.getByText('Document · PDF')).toBeTruthy();
  });

  it('the whole card is the control: clicking it opens, and there are no Open or Copy link buttons', () => {
    const onOpen = vi.fn();
    render(<ArtifactCard artifact={artifact} onOpen={onOpen} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Q3 report' }));
    expect(onOpen).toHaveBeenCalledWith('art-1');
    // The type line is the button's description, so a screen reader hears what it opens.
    expect(screen.getByRole('button')).toHaveAccessibleDescription('Document · PDF');
  });

  it('with no viewer a click downloads, handing the minted url to the browser', async () => {
    artifactToken.mockResolvedValue({ url: 'http://c/d/tok', expiresAt: 'x' });
    render(<ArtifactCard artifact={artifact} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download Q3 report' }));
    await waitFor(() => expect(saveFromContentOrigin).toHaveBeenCalledWith('http://c/d/tok'));
    expect(artifactToken).toHaveBeenCalledWith('art-1', 2, 'download');
  });

  it('while the download link is minted the card is busy, keeps focus, and ignores a second click', async () => {
    artifactToken.mockReset();
    saveFromContentOrigin.mockReset();
    let answer!: (v: { url: string; expiresAt: string }) => void;
    artifactToken.mockReturnValue(new Promise((r) => { answer = r; }));
    render(<ArtifactCard artifact={artifact} />);
    const button = screen.getByRole('button', { name: 'Download Q3 report' });
    button.focus();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(artifactToken).toHaveBeenCalledOnce();
    answer({ url: 'http://c/d/tok2', expiresAt: 'x' });
    await waitFor(() => expect(saveFromContentOrigin).toHaveBeenCalledWith('http://c/d/tok2'));
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'));
    expect(button).toHaveFocus();
  });
});
