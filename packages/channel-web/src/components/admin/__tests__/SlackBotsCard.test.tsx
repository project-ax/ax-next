/**
 * Admin › Slack's "Team agents' own bots" card (TASK-1172). The wire client is
 * mocked (its requests are pinned in `lib/__tests__/slack-bots-admin.test.ts`);
 * the copy and the refusal mapping are the real ones, so what an admin reads
 * is what ships.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SlackBotsCard } from '../SlackBotsCard';
import { SlackAdminError } from '@/lib/slack-admin';
import {
  disconnectTeamBot,
  fetchSlackBots,
  type AdminSlackBot,
  type SlackBotsRead,
} from '@/lib/slack-bots-admin';

vi.mock('@/lib/slack-bots-admin', async (original) => ({
  ...(await original<typeof import('@/lib/slack-bots-admin')>()),
  fetchSlackBots: vi.fn(),
  disconnectTeamBot: vi.fn(),
}));

const list = vi.mocked(fetchSlackBots);
const disconnect = vi.mocked(disconnectTeamBot);

const ADDED = '2026-11-19T10:00:00.000Z';
const ADDED_TEXT = new Date(ADDED).toLocaleDateString(undefined, { dateStyle: 'medium' });
const PENDING: AdminSlackBot = {
  installId: 'U3VwcG9ydEJvdEluc3RhbG',
  botName: 'Support Bot',
  handle: null,
  approver: 'Grace Hopper',
  state: 'pending',
  addedAt: ADDED,
};
const LIVE: AdminSlackBot = {
  installId: 'U2FsZXNCb3RJbnN0YWxsMQ',
  botName: 'Sales Desk',
  handle: 'salesdesk',
  approver: 'Sam Sales',
  state: 'live',
  addedAt: ADDED,
};
const ORPHAN: AdminSlackBot = { ...LIVE, approver: null };

const ready = (...bots: AdminSlackBot[]): SlackBotsRead => ({ state: 'ready', bots });

function renderCard(read: SlackBotsRead, sharedConnected = true, onAppsChanged = vi.fn()) {
  list.mockResolvedValueOnce(read);
  render(<SlackBotsCard sharedConnected={sharedConnected} onAppsChanged={onAppsChanged} />);
  return onAppsChanged;
}

function rowOf(botName: string): HTMLElement {
  return screen.getByRole('row', { name: new RegExp(botName) });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  disconnect.mockResolvedValue({ appDeleted: true });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('the list', () => {
  it("lists each bot: its name, @handle, who set it up, when it was added, and whether it's live or not finished", async () => {
    renderCard(ready(PENDING, LIVE));
    expect(await screen.findByRole('heading', { level: 2, name: "Team agents' own bots" })).toBeInTheDocument();
    expect(
      screen.getByText(
        'A team admin can give a team agent its own bot. Only the person who set one up can change its Slack app.',
      ),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: "Team agents' own bots" });
    for (const name of ['Bot', 'Set up by', 'Added', 'Status', 'Actions']) {
      expect(within(table).getByRole('columnheader', { name })).toBeInTheDocument();
    }
    const pending = rowOf('Support Bot');
    expect(within(pending).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(pending).getByText(ADDED_TEXT)).toBeInTheDocument();
    expect(within(pending).getByText('Not finished')).toBeInTheDocument();
    expect(within(pending).queryByText(/^@/)).toBeNull();
    const live = rowOf('Sales Desk');
    expect(within(live).getByText('@salesdesk')).toBeInTheDocument();
    expect(within(live).getByText('Sam Sales')).toBeInTheDocument();
    expect(within(live).getByText('Live')).toBeInTheDocument();
    expect(within(live).getByRole('button', { name: 'Disconnect Sales Desk' })).toHaveTextContent('Disconnect');
    // Nobody has left: no line about it.
    expect(screen.queryByText(/has left/)).toBeNull();
    // An install id is how we find a bot, not something to read.
    expect(document.body.textContent).not.toContain(LIVE.installId);
  });

  it('an approver auth no longer has is marked "A former member", with the line saying what that means', async () => {
    renderCard(ready(ORPHAN, PENDING));
    await screen.findByRole('table');
    expect(within(rowOf('Sales Desk')).getByText('A former member')).toBeInTheDocument();
    expect(within(rowOf('Support Bot')).queryByText('A former member')).toBeNull();
    expect(
      screen.getByText(
        'When the person who set up a bot has left, nobody can change its Slack app any more. Disconnect it, and a team admin can set up a new one.',
      ),
    ).toBeInTheDocument();
  });

  it('no bots, or a server without the route: nothing at all', async () => {
    list.mockResolvedValueOnce(ready());
    const first = render(<SlackBotsCard sharedConnected onAppsChanged={vi.fn()} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();

    list.mockResolvedValueOnce({ state: 'unavailable' });
    const second = render(<SlackBotsCard sharedConnected onAppsChanged={vi.fn()} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });

  it('a failed read says so, with Try again', async () => {
    list.mockRejectedValueOnce(new SlackAdminError(200, 'bad-response'));
    list.mockResolvedValueOnce(ready(LIVE));
    render(<SlackBotsCard sharedConnected onAppsChanged={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load the team agents' own bots.");
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Disconnect', () => {
  it("asks first, in words for a live bot or an unfinished one; Keep it sends nothing", async () => {
    renderCard(ready(PENDING, LIVE), false);
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Disconnect Sales Desk?' })).toBeInTheDocument();
    expect(
      within(dialog).getByText("Sales Desk leaves every Slack channel it's in, and mentioning it stops working. We'll delete its Slack app."),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Support Bot' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Stop setting up Support Bot?' })).toBeInTheDocument();
    expect(
      within(dialog).getByText("We'll delete the Slack app that was started for it. A team admin can ask for a bot again any time."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Stop setting up' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep going' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/\bAX\b/);
  });

  it('the shared-bot sentence shows only while Slack is connected', async () => {
    const sentence = 'The shared bot answers for its agent again in any channel it was connected to before.';
    renderCard(ready(LIVE), true);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(sentence);
  });

  it('without the shared app connected the dialog promises nothing about the shared bot', async () => {
    renderCard(ready(LIVE), false);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    expect(await screen.findByRole('dialog')).not.toHaveTextContent(/shared bot/);
  });

  it('confirming disconnects by install id, reads the list again and tells the tab its apps changed', async () => {
    list.mockResolvedValueOnce(ready(PENDING, LIVE));
    list.mockResolvedValueOnce(ready(PENDING));
    const onAppsChanged = vi.fn();
    render(<SlackBotsCard sharedConnected onAppsChanged={onAppsChanged} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(onAppsChanged).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith(LIVE.installId);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Sales Desk')).toBeNull();
    expect(screen.getByText('Support Bot')).toBeInTheDocument();
    // Its Slack app is gone, so there is nothing to say.
    expect(screen.queryByText(/couldn.t confirm/)).toBeNull();
  });

  it("a disconnect whose Slack app couldn't be deleted says so in the card", async () => {
    disconnect.mockResolvedValueOnce({ appDeleted: false });
    list.mockResolvedValueOnce(ready(LIVE));
    list.mockResolvedValueOnce(ready());
    render(<SlackBotsCard sharedConnected onAppsChanged={vi.fn()} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    // It outlives the read that finds no bots left.
    const note = await screen.findByText(
      "Sales Desk is disconnected, but we couldn't confirm its Slack app was deleted. It's listed above, with the Slack apps we couldn't delete.",
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(note).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('no-bot (someone got there first) closes the dialog and reads the list again; a failure says so in the dialog', async () => {
    disconnect.mockRejectedValueOnce(new SlackAdminError(409, 'no-bot'));
    list.mockResolvedValueOnce(ready(LIVE));
    list.mockResolvedValueOnce(ready());
    const onAppsChanged = vi.fn();
    render(<SlackBotsCard sharedConnected onAppsChanged={onAppsChanged} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onAppsChanged).not.toHaveBeenCalled();
  });

  it('a failure says so in the dialog and keeps the bot', async () => {
    disconnect.mockRejectedValueOnce(new SlackAdminError(500, 'internal'));
    renderCard(ready(LIVE));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Something went wrong. Try again in a minute.');
    expect(within(dialog).getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('words', () => {
  it('never writes the product name in a sentence', async () => {
    renderCard(ready(PENDING, ORPHAN));
    await screen.findByRole('table');
    expect(document.body.textContent).not.toMatch(/\bAX\b/);
  });
});
