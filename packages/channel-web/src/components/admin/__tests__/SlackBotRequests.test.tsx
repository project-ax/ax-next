/**
 * Bot requests in Admin › Slack (TASK-1169). The wire client is mocked (its
 * requests are pinned in `lib/__tests__/slack-bot-requests.test.ts`); the copy
 * and the error mapping are the real ones, so what an admin reads is what
 * ships. So is the avatar and the hand-off to Slack, mocked because jsdom has
 * neither a canvas nor a page to leave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SlackBotRequests } from '../SlackBotRequests';
import {
  approveSlackBotRequest,
  declineSlackBotRequest,
  fetchSlackBotRequests,
  type SlackBotRequest,
  type SlackBotRequestList,
} from '@/lib/slack-bot-requests';
import { SlackAdminError, goToSlack } from '@/lib/slack-admin';
import { renderSlackAvatar } from '@/lib/slack-avatar';
import { fakeConfigRefreshToken } from '@/test-utils/fake-slack-tokens';

vi.mock('@/lib/slack-bot-requests', async (original) => ({
  ...(await original<typeof import('@/lib/slack-bot-requests')>()),
  fetchSlackBotRequests: vi.fn(),
  approveSlackBotRequest: vi.fn(),
  declineSlackBotRequest: vi.fn(),
}));
vi.mock('@/lib/slack-avatar', () => ({ renderSlackAvatar: vi.fn() }));
vi.mock('@/lib/slack-admin', async (original) => ({
  ...(await original<typeof import('@/lib/slack-admin')>()),
  goToSlack: vi.fn(),
}));

const list = vi.mocked(fetchSlackBotRequests);
const approve = vi.mocked(approveSlackBotRequest);
const decline = vi.mocked(declineSlackBotRequest);
const go = vi.mocked(goToSlack);
const avatar = vi.mocked(renderSlackAvatar);

const INSTALL_URL = 'https://slack.com/oauth/v2/authorize?client_id=1';
const ASKED_AT = '2026-11-20T10:00:00.000Z';
const ASKED_DATE = new Date(ASKED_AT).toLocaleDateString(undefined, { dateStyle: 'medium' });
const QUILL: SlackBotRequest = {
  requestId: 'AAAAAAAAAAAAAAAAAAAAAA',
  botName: 'Quill Bot',
  agentName: 'Quill',
  teamName: 'Support',
  requestedBy: 'Ada Lovelace',
  requestedAt: ASKED_AT,
};
const ROOK: SlackBotRequest = {
  requestId: 'BBBBBBBBBBBBBBBBBBBBBB',
  botName: 'Rook Bot',
  agentName: 'Rook',
  teamName: null,
  requestedBy: 'Grace Hopper',
  requestedAt: ASKED_AT,
};
const withToken = (...requests: SlackBotRequest[]): SlackBotRequestList => ({
  requests,
  truncated: false,
  configTokenStored: true,
});
const noToken = (...requests: SlackBotRequest[]): SlackBotRequestList => ({
  requests,
  truncated: false,
  configTokenStored: false,
});

const refusal = (status: number, code: string) => new SlackAdminError(status, code);

/** Open the Approve dialog for the one row that names `botName`. */
async function openApprove(botName = 'Quill Bot') {
  const row = (await screen.findByText(new RegExp(`^${botName} for `))).closest('li') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: `Approve ${botName}` }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  avatar.mockResolvedValue('UE5HQVZBVEFS');
  approve.mockResolvedValue({ installUrl: INSTALL_URL });
  decline.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('the list', () => {
  it('shows each request with its names and date', async () => {
    list.mockResolvedValue(withToken(QUILL, ROOK));
    render(<SlackBotRequests />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Bot requests' })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Team admins asked for their agent's own Slack bot. Approving creates it with your Slack configuration token, so you'll be the one who can change or delete it later.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Quill Bot for Quill · Support')).toBeInTheDocument();
    expect(screen.getByText(`Asked by Ada Lovelace on ${ASKED_DATE}.`)).toBeInTheDocument();
    // No team name, no dot.
    expect(screen.getByText('Rook Bot for Rook')).toBeInTheDocument();
    expect(screen.getByText(`Asked by Grace Hopper on ${ASKED_DATE}.`)).toBeInTheDocument();
    // Each row's buttons name their bot, so a screen reader can tell them apart; the text on screen is unchanged.
    expect(screen.getByRole('button', { name: 'Approve Quill Bot' })).toHaveTextContent('Approve…');
    expect(screen.getByRole('button', { name: 'Approve Rook Bot' })).toHaveTextContent('Approve…');
    expect(screen.getByRole('button', { name: 'Decline Quill Bot' })).toHaveTextContent('Decline');
    expect(screen.getByRole('button', { name: 'Decline Rook Bot' })).toHaveTextContent('Decline');
    expect(screen.getAllByRole('button', { name: /^(Approve|Decline) / })).toHaveLength(4);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('says when more requests are waiting than are listed, and only then', async () => {
    const MORE = 'There are more requests waiting. Approve or decline these to see the rest.';
    list.mockResolvedValue({ ...withToken(QUILL, ROOK), truncated: true });
    const { unmount } = render(<SlackBotRequests />);
    expect(await screen.findByText(MORE)).toBeInTheDocument();
    unmount();

    list.mockResolvedValue(withToken(QUILL, ROOK));
    render(<SlackBotRequests />);
    await screen.findByText('Quill Bot for Quill · Support');
    expect(screen.queryByText(MORE)).toBeNull();
  });

  it('renders nothing with no requests, and nothing while it loads', async () => {
    list.mockResolvedValue(withToken());
    const { container } = render(<SlackBotRequests />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('a load error offers Try again, and Try again reads it again', async () => {
    list.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(withToken(QUILL));
    render(<SlackBotRequests />);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load bot requests.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Quill Bot for Quill · Support')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('Approve', () => {
  it('with a stored token shows no token field, and says the stored one will be used', async () => {
    list.mockResolvedValue(withToken(QUILL));
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    expect(within(dialog).getByText('Approve Quill Bot')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "We'll create the bot in Slack with your configuration token, then take you to Slack to click Allow. When someone outside the team mentions it, it answers with Ada Lovelace's access.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Refresh token')).toBeNull();
    expect(within(dialog).queryByRole('link', { name: "Slack's app settings" })).toBeNull();
    expect(within(dialog).getByText("We'll use the configuration token you gave us before.")).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Approve and open Slack' })).toBeEnabled();
  });

  it('without one the field shows, is a required password field, and the steps come with it', async () => {
    list.mockResolvedValue(noToken(QUILL));
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    const token = within(dialog).getByLabelText('Refresh token');
    expect(token).toBeRequired();
    expect(token).toHaveAttribute('type', 'password');
    expect(within(dialog).getByText('Starts with xoxe-')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: "Slack's app settings" })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps',
    );
    expect(within(dialog).queryByText("We'll use the configuration token you gave us before.")).toBeNull();
  });

  it('with a stored token the request carries no refreshToken, and Slack is next', async () => {
    list.mockResolvedValue(withToken(QUILL));
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open Slack' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith(INSTALL_URL));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(QUILL.requestId, { iconPng: 'UE5HQVZBVEFS' });
    expect(Object.keys(approve.mock.calls[0]?.[1] ?? {})).not.toContain('refreshToken');
  });

  it('submit sends the pasted token (trimmed) and the picture, empties the field, and goes to Slack', async () => {
    list.mockResolvedValue(noToken(QUILL));
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    const token = within(dialog).getByLabelText('Refresh token') as HTMLInputElement;
    fireEvent.change(token, { target: { value: `  ${fakeConfigRefreshToken()}  ` } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open Slack' }));
    // Write-only: gone from the page as the request goes out.
    expect(token.value).toBe('');
    await waitFor(() => expect(go).toHaveBeenCalledWith(INSTALL_URL));
    expect(approve).toHaveBeenCalledWith(QUILL.requestId, {
      refreshToken: fakeConfigRefreshToken(),
      iconPng: 'UE5HQVZBVEFS',
    });
    expect(document.body.innerHTML).not.toContain(fakeConfigRefreshToken());
    // The page is leaving, so it stays busy.
    expect(within(dialog).getByRole('button', { name: 'Creating…' })).toBeDisabled();
  });

  it('no picture means no iconPng key at all', async () => {
    avatar.mockResolvedValue(null);
    list.mockResolvedValue(withToken(QUILL));
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open Slack' }));
    await waitFor(() => expect(go).toHaveBeenCalled());
    expect(approve).toHaveBeenCalledWith(QUILL.requestId, {});
  });

  it('a second press while it works sends nothing', async () => {
    list.mockResolvedValue(withToken(QUILL));
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open Slack' }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('reveals the token field after slack-config-token, with its line, and the next submit sends the paste', async () => {
    approve.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    list.mockResolvedValue(withToken(QUILL));
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open Slack' }));
    const line =
      "The configuration token we kept for you stopped working. Generate a new one on Slack's app settings and paste it below.";
    expect(await within(dialog).findByText(line)).toBeInTheDocument();
    const token = within(dialog).getByLabelText('Refresh token');
    expect(token).toBeRequired();
    expect(token).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).queryByText("We'll use the configuration token you gave us before.")).toBeNull();
    expect(go).not.toHaveBeenCalled();
    // The request stays listed.
    expect(screen.getByText('Quill Bot for Quill · Support')).toBeInTheDocument();

    fireEvent.change(token, { target: { value: fakeConfigRefreshToken('NEWPASTE') } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open Slack' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith(INSTALL_URL));
    expect(approve).toHaveBeenLastCalledWith(QUILL.requestId, {
      refreshToken: fakeConfigRefreshToken('NEWPASTE'),
      iconPng: 'UE5HQVZBVEFS',
    });
  });

  it.each([
    ['requester-not-admin', 409, "The person who asked is no longer an admin of that agent's team, so this can't be approved. Decline it instead."],
    ['agent-gone', 409, "That agent was deleted, so there's nothing to approve. Decline the request."],
    ['bot-name-taken', 409, 'Another Slack bot here already uses that name. Decline this request, and the team can ask again with another name.'],
    ['no-workspace', 409, "Slack isn't connected right now, so bots can't be approved."],
    ['slack-error', 502, 'Something went wrong talking to Slack. Try again in a minute.'],
  ])('%s is a sentence in the dialog, never the code, and the dialog stays open', async (code, status, line) => {
    approve.mockRejectedValueOnce(refusal(status, code));
    list.mockResolvedValue(withToken(QUILL));
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open Slack' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(line);
    expect(alert.textContent).not.toContain(code);
    expect(within(dialog).getByRole('button', { name: 'Approve and open Slack' })).toBeEnabled();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('a refused token that is badly formed says so under the field, and the field stays', async () => {
    approve.mockRejectedValueOnce(refusal(400, 'invalid-refresh-token'));
    list.mockResolvedValue(noToken(QUILL));
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    fireEvent.change(within(dialog).getByLabelText('Refresh token'), { target: { value: 'nope' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open Slack' }));
    expect(await within(dialog).findByText("That doesn't look like a refresh token. It starts with xoxe-.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Refresh token')).toHaveAttribute('aria-invalid', 'true');
  });

  it.each([
    [404, 'not-found'],
    [409, 'bot-exists'],
  ])('a stale %s %s closes the dialog, says it changed and reads the list again', async (status, code) => {
    approve.mockRejectedValueOnce(refusal(status, code));
    list.mockResolvedValueOnce(withToken(QUILL)).mockResolvedValueOnce(withToken(ROOK));
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open Slack' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Rook Bot for Rook')).toBeInTheDocument();
    expect(screen.queryByText('Quill Bot for Quill · Support')).toBeNull();
    expect(screen.getByText("This changed while you were here, so we've refreshed it.")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a stale answer that empties the list still says it changed', async () => {
    approve.mockRejectedValueOnce(refusal(404, 'not-found'));
    list.mockResolvedValueOnce(withToken(QUILL)).mockResolvedValueOnce(withToken());
    render(<SlackBotRequests />);
    const dialog = await openApprove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and open Slack' }));
    expect(await screen.findByText("This changed while you were here, so we've refreshed it.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve Quill Bot' })).toBeNull();
  });

  it('Cancel closes it without sending anything, and the next opening starts empty', async () => {
    list.mockResolvedValue(noToken(QUILL));
    render(<SlackBotRequests />);
    let dialog = await openApprove();
    fireEvent.change(within(dialog).getByLabelText('Refresh token'), { target: { value: fakeConfigRefreshToken() } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(approve).not.toHaveBeenCalled();
    dialog = await openApprove();
    expect((within(dialog).getByLabelText('Refresh token') as HTMLInputElement).value).toBe('');
  });
});

describe('Decline', () => {
  it('declines that request and reads the list again', async () => {
    list.mockResolvedValueOnce(withToken(QUILL, ROOK)).mockResolvedValueOnce(withToken(ROOK));
    render(<SlackBotRequests />);
    const row = (await screen.findByText('Quill Bot for Quill · Support')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Decline Quill Bot' }));
    expect(await within(row).findByRole('button', { name: 'Declining…' })).toBeDisabled();
    await waitFor(() => expect(screen.queryByText('Quill Bot for Quill · Support')).toBeNull());
    expect(decline).toHaveBeenCalledWith(QUILL.requestId);
    expect(decline).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Rook Bot for Rook')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('the last decline leaves nothing on the page', async () => {
    list.mockResolvedValueOnce(withToken(QUILL)).mockResolvedValueOnce(withToken());
    const { container } = render(<SlackBotRequests />);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline Quill Bot' }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('a failed decline says so on its row, and the row stays', async () => {
    decline.mockRejectedValueOnce(refusal(500, 'internal'));
    list.mockResolvedValue(withToken(QUILL, ROOK));
    render(<SlackBotRequests />);
    const row = (await screen.findByText('Quill Bot for Quill · Support')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Decline Quill Bot' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      "We couldn't decline that just now. Try again in a minute.",
    );
    expect(within(row).getByRole('button', { name: 'Decline Quill Bot' })).toBeEnabled();
    const other = screen.getByText('Rook Bot for Rook').closest('li') as HTMLElement;
    expect(within(other).queryByRole('alert')).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('a decline of a request that is already gone says it changed and reads again', async () => {
    decline.mockRejectedValueOnce(refusal(404, 'not-found'));
    list.mockResolvedValueOnce(withToken(QUILL, ROOK)).mockResolvedValueOnce(withToken(ROOK));
    render(<SlackBotRequests />);
    const row = (await screen.findByText('Quill Bot for Quill · Support')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Decline Quill Bot' }));
    expect(await screen.findByText("This changed while you were here, so we've refreshed it.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Quill Bot for Quill · Support')).toBeNull());
  });
});
