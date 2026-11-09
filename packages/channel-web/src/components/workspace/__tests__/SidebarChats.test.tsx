/**
 * The sidebar's chat list: New chat, title-only Search, and each chat's ⋮
 * menu. Moved here from the agent's right-hand rail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { conversationControls } from '@/lib/conversation-controls';
import type { SidebarChatList } from '@/lib/sidebar-chats';
import { SidebarChats } from '../SidebarChats';

vi.mock('@/lib/conversation-controls', () => ({
  conversationControls: {
    create: vi.fn(),
    rename: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    export: vi.fn(async () => {}),
  },
}));

const renameMock = vi.mocked(conversationControls.rename);
const deleteMock = vi.mocked(conversationControls.delete);

const recent = new Date().toISOString();
function chats(over: Partial<SidebarChatList> = {}): SidebarChatList {
  return {
    agentId: 'a1',
    chats: [
      { id: 'c-live', title: 'Plan the offsite', lastActivityAt: recent },
      { id: 'c-launch', title: 'Launch checklist', lastActivityAt: recent },
      { id: 'c-vendor', title: 'Vendor review', lastActivityAt: recent },
    ],
    openId: 'c-live',
    busy: false,
    ...over,
  };
}

function renderChats(over: Partial<React.ComponentProps<typeof SidebarChats>> = {}) {
  const props = {
    agentId: 'a1',
    chats: chats(),
    error: false,
    showSelection: true,
    onOpen: vi.fn(),
    onNew: vi.fn(),
    onChanged: vi.fn(),
    ...over,
  };
  return { ...render(<SidebarChats {...props} />), props };
}

function openRowMenu(title: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Options for ${title}` }), {
    button: 0,
    ctrlKey: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SidebarChats — the list', () => {
  it('names every chat by its title — the latest one too — and opens them', () => {
    const { props } = renderChats();
    expect(screen.queryByText(/Current conversation/)).toBeNull();
    const names = screen.getAllByRole('listitem').map((li) => li.querySelector('button')?.textContent);
    expect(names).toEqual(['Plan the offsite', 'Launch checklist', 'Vendor review']);
    fireEvent.click(screen.getByRole('button', { name: 'Plan the offsite' }));
    expect(props.onOpen).toHaveBeenLastCalledWith('c-live');
    fireEvent.click(screen.getByRole('button', { name: 'Vendor review' }));
    expect(props.onOpen).toHaveBeenLastCalledWith('c-vendor');
  });

  it('draws titles only — no dates and no "Now" beside them', () => {
    renderChats();
    const list = screen.getByRole('list');
    for (const title of ['Launch checklist', 'Vendor review']) {
      const row = screen.getByRole('button', { name: title });
      expect(row).not.toHaveAttribute('aria-describedby');
      expect(row.textContent).toBe(title);
    }
    expect(list.textContent).not.toMatch(/\bNow\b/);
  });

  it('marks the open chat only when asked to show the selection', () => {
    const { unmount } = renderChats({ chats: chats({ openId: 'c-vendor' }) });
    expect(screen.getByRole('button', { name: 'Vendor review' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Plan the offsite' })).not.toHaveAttribute('aria-current');
    unmount();
    renderChats({ chats: chats({ openId: 'c-vendor' }), showSelection: false });
    expect(screen.getByRole('button', { name: 'Vendor review' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Plan the offsite' })).not.toHaveAttribute('aria-current');
  });

  it('says so when the chats could not be read', () => {
    renderChats({ chats: null, error: true });
    expect(screen.getByText('We couldn’t load these chats just now.')).toBeTruthy();
  });

  it('holds chat switches while a turn is streaming', () => {
    renderChats({ chats: chats({ busy: true }) });
    expect(screen.getByRole('button', { name: 'Vendor review' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();
  });
});

describe('SidebarChats — New chat', () => {
  it('starts a chat', async () => {
    const { props } = renderChats();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(props.onNew).toHaveBeenCalledTimes(1));
  });
});

describe('SidebarChats — Search (titles only)', () => {
  it('filters every chat by title, the latest one included', () => {
    renderChats();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const box = screen.getByRole('searchbox', { name: 'Search chats by title' });
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: 'VENDOR' } });
    expect(screen.getByRole('button', { name: 'Vendor review' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Launch checklist' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Plan the offsite' })).toBeNull();
    fireEvent.change(box, { target: { value: 'offsite' } });
    expect(screen.getByRole('button', { name: 'Plan the offsite' })).toBeTruthy();
  });

  it('says so when no title matches', () => {
    renderChats();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zebra' } });
    expect(screen.getByRole('status')).toHaveTextContent('No chat titles match “zebra”.');
  });

  it('Escape closes the box, clears the query and puts focus back on Search', async () => {
    renderChats();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'vendor' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Launch checklist' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search' })).toHaveFocus());
  });

  it('the close button does the same', () => {
    renderChats();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('starts already open when asked (the collapsed rail’s Search)', () => {
    renderChats({ startSearching: true });
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });

  it('a search for one agent does not carry over to the next', () => {
    const { props, rerender } = renderChats();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'vendor' } });
    rerender(<SidebarChats {...props} agentId="a2" chats={chats({ agentId: 'a2' })} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Launch checklist' })).toBeTruthy();
  });
});

describe('SidebarChats — each chat’s ⋮ menu', () => {
  it('uses the vertical three-dot icon', () => {
    renderChats();
    const trigger = screen.getByRole('button', { name: 'Options for Vendor review' });
    expect(trigger.querySelector('svg')?.getAttribute('class')).toMatch(/ellipsis-vertical/);
  });

  // A modal menu here leaves the page unclickable after its dialog removes the
  // trigger (production, 2026-10-19; #998).
  it('never locks the page', async () => {
    renderChats();
    openRowMenu('Launch checklist');
    expect(await screen.findAllByRole('menuitem')).not.toHaveLength(0);
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('renames a chat', async () => {
    const { props } = renderChats();
    openRowMenu('Vendor review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByLabelText('Name');
    fireEvent.change(input, { target: { value: '  Vendor review v2 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(renameMock).toHaveBeenCalledWith('c-vendor', 'Vendor review v2'));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
  });

  it('deleting the open chat sends the view to the latest one left', async () => {
    const { props } = renderChats({ chats: chats({ openId: 'c-vendor' }) });
    openRowMenu('Vendor review');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('c-vendor'));
    await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith(null));
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('deleting another chat leaves the open one alone', async () => {
    const { props } = renderChats({ chats: chats({ openId: 'c-vendor' }) });
    openRowMenu('Launch checklist');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('c-launch'));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the reason when the delete fails', async () => {
    deleteMock.mockRejectedValueOnce(new Error('500'));
    renderChats();
    openRowMenu('Launch checklist');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('We couldn’t finish that just now. Please try again.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Delete conversation?' })).toBeTruthy();
  });
});
