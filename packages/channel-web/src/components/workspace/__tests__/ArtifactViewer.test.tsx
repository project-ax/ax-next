/**
 * The artifact viewer and its owner controls: versions + restore, Download,
 * Copy link, and the ⋯ menu (rename, link off / new link, delete).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkspaceApiError, workspaceApi } from '@/lib/workspace-api';
import { saveFromContentOrigin } from '@/lib/file-download';
import { toastActions } from '@/lib/toast-store';
import type { ArtifactDetail } from '@/lib/workspace-types';
import { ArtifactViewer } from '../ArtifactViewer';

vi.mock('@/lib/file-download', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/lib/file-download')),
  saveFromContentOrigin: vi.fn(),
}));

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      artifact: vi.fn(),
      artifactText: vi.fn(),
      artifactToken: vi.fn(),
      renameArtifact: vi.fn(),
      restoreArtifact: vi.fn(),
      setArtifactLink: vi.fn(),
      deleteArtifact: vi.fn(),
    },
  };
});

const api = vi.mocked(workspaceApi);
const NOW = Date.parse('2026-11-06T12:00:00Z');

function detail(over: Partial<ArtifactDetail> = {}): ArtifactDetail {
  return {
    artifactId: 'art-1',
    agentId: 'a-quill',
    title: 'Deal tracker',
    mediaType: 'text/html',
    kind: 'web',
    preview: 'html',
    extension: 'HTML',
    currentVersion: 3,
    sizeBytes: 10,
    linkOn: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-06T10:00:00Z',
    versions: [
      { version: 3, mediaType: 'text/html', sizeBytes: 10, createdAt: '2026-11-06T10:00:00Z' },
      { version: 2, mediaType: 'text/html', sizeBytes: 9, createdAt: '2026-11-05T12:00:00Z' },
      { version: 1, mediaType: 'text/html', sizeBytes: 8, createdAt: '2026-11-01T00:00:00Z' },
    ],
    ...over,
  };
}

function renderViewer() {
  const props = { onBack: vi.fn(), onClose: vi.fn() };
  render(<ArtifactViewer artifactId="art-1" agentName="Quill" {...props} />);
  return props;
}

function openMenu() {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0, ctrlKey: false });
}

const writeText = vi.fn(async (_t: string) => {});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  for (const fn of Object.values(api)) vi.mocked(fn).mockReset();
  api.artifact.mockResolvedValue(detail());
  api.artifactToken.mockImplementation(async (_id, v, purpose) => ({
    url: `http://127.0.0.1:9091/${purpose === 'view' ? 'v' : 'd'}/tok-v${v}`,
    expiresAt: '2026-11-06T12:05:00Z',
  }));
  vi.mocked(saveFromContentOrigin).mockReset();
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  toastActions.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ArtifactViewer', () => {
  it('shows the name, the type, and the current version in the frame', async () => {
    renderViewer();
    expect(await screen.findByRole('heading', { name: 'Deal tracker' })).toBeTruthy();
    expect(screen.getByText('Web page · HTML')).toBeTruthy();
    const f = await screen.findByTitle('Deal tracker');
    expect(f.getAttribute('src')).toBe('http://127.0.0.1:9091/v/tok-v3');
    expect(api.artifactToken).toHaveBeenCalledWith('art-1', 3, 'view');
  });

  it('the version picker shows "v3 · 2 hr ago"; picking v1 offers Restore, which restores and reloads', async () => {
    renderViewer();
    const picker = await screen.findByRole('combobox', { name: 'Version' });
    expect(picker.textContent).toContain('v3 · 2 hr ago');
    expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull();

    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /^v1 · / }));
    // A fresh token for the picked version: the frame shows v1.
    await waitFor(() => expect(api.artifactToken).toHaveBeenCalledWith('art-1', 1, 'view'));
    expect((await screen.findByTitle('Deal tracker')).getAttribute('src')).toBe('http://127.0.0.1:9091/v/tok-v1');

    api.restoreArtifact.mockResolvedValue(detail({ currentVersion: 1 }));
    api.artifact.mockResolvedValue(detail({ currentVersion: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(api.restoreArtifact).toHaveBeenCalledWith('art-1', 1));
    await waitFor(() => expect(api.artifact).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull());
  });

  it('Download mints a download token and hands it to the browser', async () => {
    renderViewer();
    await screen.findByTitle('Deal tracker');
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(saveFromContentOrigin).toHaveBeenCalledWith('http://127.0.0.1:9091/d/tok-v3'));
    expect(api.artifactToken).toHaveBeenCalledWith('art-1', 3, 'download');
  });

  it('Copy link ensures the link once and copies <origin>/a/<code>', async () => {
    api.setArtifactLink.mockResolvedValue('A'.repeat(32));
    renderViewer();
    await screen.findByTitle('Deal tracker');
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/a/${'A'.repeat(32)}`));
    expect(api.setArtifactLink).toHaveBeenCalledTimes(1);
    expect(api.setArtifactLink).toHaveBeenCalledWith('art-1', 'ensure');
  });

  it('Copy link: when the browser refuses the clipboard, the link is shown to copy by hand', async () => {
    api.setArtifactLink.mockResolvedValue('A'.repeat(32));
    writeText.mockRejectedValueOnce(new DOMException('NotAllowedError'));
    const show = vi.spyOn(toastActions, 'show');
    const error = vi.spyOn(toastActions, 'error');
    renderViewer();
    await screen.findByTitle('Deal tracker');
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Your browser wouldn’t let us copy it — here’s the link to copy yourself.')).toBeTruthy();
    const field = within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Link' });
    expect(field.value).toBe(`${window.location.origin}/a/${'A'.repeat(32)}`);
    expect(field.readOnly).toBe(true);
    // The code never goes into a toast or the console.
    const said = JSON.stringify([show.mock.calls, error.mock.calls, vi.mocked(console.warn).mock.calls]);
    expect(said).not.toContain('A'.repeat(32));
  });

  it('Copy link starts a ClipboardItem write in the click, before the link exists', async () => {
    const items: Array<Record<string, Promise<Blob>>> = [];
    class FakeClipboardItem {
      constructor(data: Record<string, Promise<Blob>>) {
        items.push(data);
      }
    }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    const write = vi.fn(async (data: FakeClipboardItem[]) => {
      void data;
      await items[0]!['text/plain'];
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText, write }, configurable: true });
    let resolveCode!: (c: string) => void;
    api.setArtifactLink.mockReturnValue(new Promise<string | null>((r) => (resolveCode = r)));
    renderViewer();
    await screen.findByTitle('Deal tracker');
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    // Synchronously, in the gesture: the request is still out.
    expect(write).toHaveBeenCalledTimes(1);
    resolveCode('C'.repeat(32));
    const blob = (await items[0]!['text/plain'])!;
    // jsdom's Blob has no .text(); FileReader reads it.
    const text = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsText(blob);
    });
    expect(text).toBe(`${window.location.origin}/a/${'C'.repeat(32)}`);
    expect(writeText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a picked version saved as another type gets Download only, not a preview', async () => {
    api.artifact.mockResolvedValue(
      detail({
        versions: [
          { version: 3, mediaType: 'text/html', sizeBytes: 10, createdAt: '2026-11-06T10:00:00Z' },
          { version: 1, mediaType: 'application/vnd.ms-excel', sizeBytes: 8, createdAt: '2026-11-01T00:00:00Z' },
        ],
      }),
    );
    renderViewer();
    const picker = await screen.findByRole('combobox', { name: 'Version' });
    await screen.findByTitle('Deal tracker');
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /^v1 · / }));
    expect(await screen.findByText('We can’t preview this one yet')).toBeTruthy();
    expect(api.artifactToken).not.toHaveBeenCalledWith('art-1', 1, 'view');
  });

  it('the menu offers Rename, Turn off link / Get a new link only while on, and Delete with a confirm', async () => {
    renderViewer();
    await screen.findByTitle('Deal tracker');
    openMenu();
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
    // Link off: no link controls (the next test covers link on).
    expect(items).toEqual(['Rename…', 'Delete artifact…']);
  });

  it('with the link on: Turn off link confirms in plain words, then turns it off', async () => {
    api.artifact.mockResolvedValue(detail({ linkOn: true }));
    api.setArtifactLink.mockResolvedValue(null);
    renderViewer();
    await screen.findByTitle('Deal tracker');
    openMenu();
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent);
    expect(items).toEqual(['Rename…', 'Turn off link…', 'Get a new link…', 'Delete artifact…']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn off link…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Anyone using the old link will lose access right away\./)).toBeTruthy();
    expect(api.setArtifactLink).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off link' }));
    await waitFor(() => expect(api.setArtifactLink).toHaveBeenCalledWith('art-1', 'off'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    openMenu();
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual([
      'Rename…',
      'Delete artifact…',
    ]);
  });

  it('Get a new link confirms, rotates, and copies the new link', async () => {
    api.artifact.mockResolvedValue(detail({ linkOn: true }));
    api.setArtifactLink.mockResolvedValue('B'.repeat(32));
    renderViewer();
    await screen.findByTitle('Deal tracker');
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Get a new link…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Anyone using the old link will lose access right away\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Get a new link' }));
    await waitFor(() => expect(api.setArtifactLink).toHaveBeenCalledWith('art-1', 'rotate'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/a/${'B'.repeat(32)}`));
  });

  it('Get a new link: when the clipboard refuses, the new link is shown to copy by hand', async () => {
    api.artifact.mockResolvedValue(detail({ linkOn: true }));
    api.setArtifactLink.mockResolvedValue('B'.repeat(32));
    writeText.mockRejectedValueOnce(new DOMException('NotAllowedError'));
    renderViewer();
    await screen.findByTitle('Deal tracker');
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Get a new link…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Get a new link' }));
    const field = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Link' });
    expect(field.value).toBe(`${window.location.origin}/a/${'B'.repeat(32)}`);
    expect(api.setArtifactLink).toHaveBeenCalledWith('art-1', 'rotate');
  });

  it('Delete asks first, then deletes and goes back to the list', async () => {
    api.deleteArtifact.mockResolvedValue(undefined);
    const props = renderViewer();
    await screen.findByTitle('Deal tracker');
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete artifact…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete this artifact?')).toBeTruthy();
    expect(
      within(dialog).getByText('Its link stops working and every version is gone. This can’t be undone.'),
    ).toBeTruthy();
    expect(api.deleteArtifact).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete artifact' }));
    await waitFor(() => expect(api.deleteArtifact).toHaveBeenCalledWith('art-1'));
    await waitFor(() => expect(props.onBack).toHaveBeenCalled());
  });

  it('Rename saves the new name, and the hook’s 400 shows as a field error', async () => {
    api.renameArtifact.mockRejectedValueOnce(new WorkspaceApiError('/artifacts/art-1', 400));
    renderViewer();
    await screen.findByTitle('Deal tracker');
    openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const input = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(input, { target: { value: 'Bad name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/That name won’t work/)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');

    api.renameArtifact.mockResolvedValueOnce(detail({ title: 'Pipeline' }));
    fireEvent.change(input, { target: { value: 'Pipeline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.renameArtifact).toHaveBeenLastCalledWith('art-1', 'Pipeline'));
    expect(await screen.findByRole('heading', { name: 'Pipeline' })).toBeTruthy();
  });

  it('the viewer adds no window message listener', async () => {
    const spy = vi.spyOn(window, 'addEventListener');
    renderViewer();
    await screen.findByTitle('Deal tracker');
    expect(spy.mock.calls.map(([t]) => t)).not.toContain('message');
  });

  it('Back and ✕ go where they say', async () => {
    const props = renderViewer();
    await screen.findByTitle('Deal tracker');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('a missing artifact says so instead of a blank frame', async () => {
    api.artifact.mockRejectedValue(new WorkspaceApiError('/artifacts/art-1', 404));
    renderViewer();
    expect(await screen.findByText(/We couldn’t find this artifact/)).toBeTruthy();
    expect(api.artifactToken).not.toHaveBeenCalled();
  });
});
