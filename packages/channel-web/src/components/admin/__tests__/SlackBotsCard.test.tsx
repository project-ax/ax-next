/**
 * Admin › Slack's "Team agents' own bots" card (TASK-1172). The wire client is
 * mocked (its requests are pinned in `lib/__tests__/slack-bots-admin.test.ts`);
 * the copy and the refusal mapping are the real ones, so what an admin reads
 * is what ships.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SlackBotsCard } from '../SlackBotsCard';
import { RequestTimeoutError } from '@/lib/http';
import { SlackAdminError } from '@/lib/slack-admin';
import { fakeConfigRefreshToken } from '@/test-utils/fake-slack-tokens';
import {
  disconnectTeamBot,
  fetchSlackBots,
  replaceTeamBotToken,
  type AdminSlackBot,
  type SlackBotsRead,
} from '@/lib/slack-bots-admin';

vi.mock('@/lib/slack-bots-admin', async (original) => ({
  ...(await original<typeof import('@/lib/slack-bots-admin')>()),
  fetchSlackBots: vi.fn(),
  disconnectTeamBot: vi.fn(),
  replaceTeamBotToken: vi.fn(),
}));

const list = vi.mocked(fetchSlackBots);
const disconnect = vi.mocked(disconnectTeamBot);
const replaceToken = vi.mocked(replaceTeamBotToken);

const ADDED = '2026-11-19T10:00:00.000Z';
const ADDED_TEXT = new Date(ADDED).toLocaleDateString(undefined, { dateStyle: 'medium' });
const PENDING: AdminSlackBot = {
  installId: 'U3VwcG9ydEJvdEluc3RhbG',
  botName: 'Support Bot',
  handle: null,
  approver: 'Grace Hopper',
  state: 'pending',
  addedAt: ADDED,
  viewerIsApprover: false,
};
const LIVE: AdminSlackBot = {
  installId: 'U2FsZXNCb3RJbnN0YWxsMQ',
  botName: 'Sales Desk',
  handle: 'salesdesk',
  approver: 'Sam Sales',
  state: 'live',
  addedAt: ADDED,
  viewerIsApprover: false,
};
const ORPHAN: AdminSlackBot = { ...LIVE, approver: null };
const MINE: AdminSlackBot = { ...LIVE, approver: 'Vinay Pulim', viewerIsApprover: true };
const MINE_PENDING: AdminSlackBot = { ...PENDING, viewerIsApprover: true };

const ready = (...bots: AdminSlackBot[]): SlackBotsRead => ({ state: 'ready', bots });

function renderCard(read: SlackBotsRead, onAppsChanged = vi.fn()) {
  list.mockResolvedValueOnce(read);
  render(<SlackBotsCard onAppsChanged={onAppsChanged} />);
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
    expect(screen.queryByText('Needs rebuilding')).toBeNull();
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
        'When the person who set up a bot has left, nobody can replace its Slack token any more, so it needs rebuilding: disconnect it here, and a team admin of its agent can set up a new one.',
      ),
    ).toBeInTheDocument();
  });

  it('a live bot whose approver is gone says "Needs rebuilding" in its Status; a pending one, or one with an approver, does not', async () => {
    renderCard(
      ready(ORPHAN, { ...LIVE, installId: 'T3RoZXJCb3RJbnN0YWxsMg', botName: 'Other Bot' }, { ...PENDING, approver: null }),
    );
    await screen.findByRole('table');
    const orphan = rowOf('Sales Desk');
    expect(within(orphan).getByText('Needs rebuilding')).toBeInTheDocument();
    expect(within(orphan).queryByText('Live')).toBeNull();
    expect(screen.getAllByText('Needs rebuilding')).toHaveLength(1);
    expect(within(rowOf('Other Bot')).getByText('Live')).toBeInTheDocument();
    expect(within(rowOf('Support Bot')).getByText('Not finished')).toBeInTheDocument();
  });

  it('while the first read is in flight a placeholder says it is loading, so a slow read is not "no bots"', async () => {
    let answer: (read: SlackBotsRead) => void = () => {};
    list.mockReturnValueOnce(new Promise<SlackBotsRead>((resolve) => (answer = resolve)));
    render(<SlackBotsCard onAppsChanged={vi.fn()} />);
    expect(screen.getByText("Loading the team agents' own bots")).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    answer(ready(LIVE));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByText("Loading the team agents' own bots")).toBeNull();
  });

  it('no bots, or a server without the route: nothing at all once the read is back', async () => {
    list.mockResolvedValueOnce(ready());
    const first = render(<SlackBotsCard onAppsChanged={vi.fn()} />);
    await waitFor(() => expect(first.container).toBeEmptyDOMElement());
    first.unmount();

    list.mockResolvedValueOnce({ state: 'unavailable' });
    const second = render(<SlackBotsCard onAppsChanged={vi.fn()} />);
    await waitFor(() => expect(second.container).toBeEmptyDOMElement());
  });

  it('a read that times out ends the placeholder in the same alert, with Try again', async () => {
    list.mockRejectedValueOnce(new RequestTimeoutError('/admin/slack/bots', 8000));
    render(<SlackBotsCard onAppsChanged={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load the team agents' own bots.");
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText("Loading the team agents' own bots")).toBeNull();
  });

  it('a failed read says so, with Try again', async () => {
    list.mockRejectedValueOnce(new SlackAdminError(200, 'bad-response'));
    list.mockResolvedValueOnce(ready(LIVE));
    render(<SlackBotsCard onAppsChanged={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load the team agents' own bots.");
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Disconnect', () => {
  it("asks first, in words for a live bot or an unfinished one; Keep it sends nothing", async () => {
    renderCard(ready(PENDING, LIVE));
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Disconnect Sales Desk?' })).toBeInTheDocument();
    expect(
      within(dialog).getByText("Sales Desk leaves every Slack channel it's in, and mentioning it stops working. We'll delete its Slack app."),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Support Bot' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Stop setting up Support Bot?' })).toBeInTheDocument();
    expect(
      within(dialog).getByText("We'll delete the Slack app that was started for it. A team admin can ask for a bot again any time."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Stop setting up' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/\bAX\b/);
  });

  it('the Disconnect dialog does not say the shared bot answers again (it no longer reaches channels)', async () => {
    renderCard(ready(LIVE));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).not.toHaveTextContent(/shared bot/i);
    expect(dialog).not.toHaveTextContent('The shared bot answers');
  });

  it('confirming disconnects by install id, reads the list again and tells the tab its apps changed', async () => {
    list.mockResolvedValueOnce(ready(PENDING, LIVE));
    list.mockResolvedValueOnce(ready(PENDING));
    const onAppsChanged = vi.fn();
    render(<SlackBotsCard onAppsChanged={onAppsChanged} />);
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
    render(<SlackBotsCard onAppsChanged={vi.fn()} />);
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

  it("no-bot (someone got there first) closes the dialog, reads the list again and tells the tab, whose leftover apps may have changed too", async () => {
    disconnect.mockRejectedValueOnce(new SlackAdminError(409, 'no-bot'));
    list.mockResolvedValueOnce(ready(LIVE));
    list.mockResolvedValueOnce(ready());
    const onAppsChanged = vi.fn();
    render(<SlackBotsCard onAppsChanged={onAppsChanged} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onAppsChanged).toHaveBeenCalledTimes(1);
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

const TOKEN = fakeConfigRefreshToken('ADMINREPLACESECRET');
const REPLACED =
  "Token replaced. We now use it for Sales Desk and every other Slack app you set up here. Don't revoke the token you just pasted: it's the one we use now.";

function openReplace(botName = 'Sales Desk'): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: `Replace token for ${botName}` }));
  return screen.getByRole('dialog', { name: 'Replace your Slack token' });
}

function pasteAndSubmit(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('Refresh token'), { target: { value: TOKEN } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Replace token' }));
}

describe('Replace token, for the bots the viewer set up (TASK-1173)', () => {
  it('shows Replace token only on live rows the viewer set up, before Disconnect', async () => {
    renderCard(
      ready(
        MINE,
        { ...LIVE, installId: 'T3RoZXJCb3RJbnN0YWxsMg', botName: 'Other Bot' },
        MINE_PENDING,
        { ...ORPHAN, installId: 'T3JwaGFuQm90SW5zdGFsbDM', botName: 'Orphan Bot' },
      ),
    );
    await screen.findByRole('table');
    const mine = rowOf('Sales Desk');
    const buttons = within(mine).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Replace token for Sales Desk',
      'Disconnect Sales Desk',
    ]);
    expect(within(mine).getByRole('button', { name: 'Replace token for Sales Desk' })).toHaveTextContent('Replace token');
    expect(screen.queryByRole('button', { name: 'Replace token for Other Bot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace token for Support Bot' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Replace token for/ })).toHaveLength(1);
  });

  it('a replace posts the install id and the pasted token, closes the dialog and says the token replaced; the token is never drawn', async () => {
    replaceToken.mockResolvedValueOnce(undefined);
    renderCard(ready(MINE));
    await screen.findByRole('table');
    pasteAndSubmit(openReplace());
    expect(await screen.findByText(REPLACED)).toBeInTheDocument();
    expect(replaceToken).toHaveBeenCalledWith(MINE.installId, TOKEN);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    // Nothing changed in the list, so it is not read again.
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('a refused replace says why in the dialog and keeps it open', async () => {
    replaceToken.mockRejectedValueOnce(new SlackAdminError(502, 'slack-not-app-manager'));
    renderCard(ready(MINE));
    await screen.findByRole('table');
    const dialog = openReplace();
    pasteAndSubmit(dialog);
    await waitFor(() => expect(replaceToken).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByText(/can't manage this bot/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Replace your Slack token' })).toBeInTheDocument();
    expect(screen.queryByText(REPLACED)).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, 'not-approver'],
    [409, 'not-live'],
    [409, 'no-bot'],
  ])('a stale replace (%s %s) closes the dialog and reads the list again, with nothing said', async (status, code) => {
    replaceToken.mockRejectedValueOnce(new SlackAdminError(status, code));
    list.mockResolvedValueOnce(ready(MINE));
    list.mockResolvedValueOnce(ready(ORPHAN));
    const onAppsChanged = vi.fn();
    render(<SlackBotsCard onAppsChanged={onAppsChanged} />);
    await screen.findByRole('table');
    pasteAndSubmit(openReplace());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Needs rebuilding')).toBeInTheDocument();
    expect(screen.queryByText(REPLACED)).toBeNull();
    expect(onAppsChanged).toHaveBeenCalledTimes(1);
  });
});

describe('a bot that needs rebuilding', () => {
  it("its Disconnect dialog says how it gets rebuilt; no other row's does", async () => {
    const sentence =
      "Its approver has left, so this is how it gets rebuilt: once it's disconnected, a team admin of its agent sets up a new one from the agent's settings, and every channel needs /invite again.";
    renderCard(ready(ORPHAN, { ...LIVE, installId: 'T3RoZXJCb3RJbnN0YWxsMg', botName: 'Other Bot' }, { ...PENDING, approver: null }));
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(sentence);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Other Bot' }));
    dialog = await screen.findByRole('dialog');
    expect(dialog).not.toHaveTextContent(/approver has left/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Support Bot' }));
    expect(await screen.findByRole('dialog')).not.toHaveTextContent(/approver has left/);
  });
});

describe('words', () => {
  it('never writes the product name in a sentence', async () => {
    renderCard(ready(PENDING, ORPHAN));
    await screen.findByRole('table');
    expect(document.body.textContent).not.toMatch(/\bAX\b/);
  });
});
