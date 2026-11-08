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
    fireEvent.click(screen.getByRole('button', { name: /Q3 report/ }));
    expect(onOpen).toHaveBeenCalledWith('art-1');
  });

  it('with no viewer a click downloads, handing the minted url to the browser', async () => {
    artifactToken.mockResolvedValue({ url: 'http://c/d/tok', expiresAt: 'x' });
    render(<ArtifactCard artifact={artifact} />);
    fireEvent.click(screen.getByRole('button', { name: /Q3 report/ }));
    await waitFor(() => expect(saveFromContentOrigin).toHaveBeenCalledWith('http://c/d/tok'));
    expect(artifactToken).toHaveBeenCalledWith('art-1', 2, 'download');
  });
});
