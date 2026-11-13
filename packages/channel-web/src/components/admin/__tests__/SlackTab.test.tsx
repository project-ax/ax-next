/**
 * Admin › Slack (TASK-1093). The wire client is mocked here (its own requests
 * are pinned in `src/__tests__/admin-slack.test.tsx`); its copy and error
 * mapping are the real ones, so what an admin reads is what ships.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SlackTab } from '../SlackTab';
import {
  SlackAdminError,
  connectSlack,
  disconnectSlack,
  fetchSlackStatus,
  goToSlack,
  resumeSlackInstall,
  type SlackStatusRead,
} from '@/lib/slack-admin';
import { CONFIG_ACCESS_PREFIX, CONFIG_REFRESH_PREFIX, fakeConfigAccessToken, fakeConfigRefreshToken } from '@/test-utils/fake-slack-tokens';

vi.mock('@/lib/slack-admin', async (original) => ({
  ...(await original<typeof import('@/lib/slack-admin')>()),
  fetchSlackStatus: vi.fn(),
  connectSlack: vi.fn(),
  resumeSlackInstall: vi.fn(),
  disconnectSlack: vi.fn(),
  goToSlack: vi.fn(),
}));

const INSTALL_URL = 'https://slack.com/oauth/v2/authorize?client_id=1.2&state=ab';
// Distinctive, so a leak into the page is easy to spot.
const ACCESS = fakeConfigAccessToken();
const REFRESH = fakeConfigRefreshToken();
const CONNECTED_AT = '2026-11-13T12:00:00.000Z';
const CONNECTED_DATE = new Date(CONNECTED_AT).toLocaleDateString(undefined, { dateStyle: 'medium' });

const NOT_CONNECTED: SlackStatusRead = { state: 'not-connected', defaultBotName: 'canopy', canConnect: true };
const NO_HTTPS: SlackStatusRead = { state: 'not-connected', defaultBotName: 'canopy', canConnect: false };
const PENDING: SlackStatusRead = {
  state: 'pending',
  botName: 'canopy',
  connectedBy: 'Ada Admin',
  connectedAt: CONNECTED_AT,
};
const CONNECTED: SlackStatusRead = {
  state: 'connected',
  botName: 'canopy',
  workspaceName: 'Canopy Works',
  connectedBy: 'Ada Admin',
  connectedAt: CONNECTED_AT,
};

const status = vi.mocked(fetchSlackStatus);
const connect = vi.mocked(connectSlack);
const resume = vi.mocked(resumeSlackInstall);
const disconnect = vi.mocked(disconnectSlack);
const navigate = vi.mocked(goToSlack);

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

function renderTab(...reads: SlackStatusRead[]) {
  for (const r of reads) status.mockResolvedValueOnce(r);
  return render(<SlackTab />);
}

function input(label: RegExp): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

async function fillAndConnect(o: { access?: string; refresh?: string; name?: string } = {}) {
  await screen.findByRole('button', { name: 'Connect' });
  fireEvent.change(input(/access token/i), { target: { value: o.access ?? ACCESS } });
  fireEvent.change(input(/refresh token/i), { target: { value: o.refresh ?? REFRESH } });
  if (o.name !== undefined) fireEvent.change(input(/bot name/i), { target: { value: o.name } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
}

/** Nothing pasted is left anywhere on the page: not in an input, not in the markup. */
function expectNoSecretsOnPage() {
  expect(input(/access token/i).value).toBe('');
  expect(input(/refresh token/i).value).toBe('');
  expect(document.body.innerHTML).not.toContain('PASTEDACCESSSECRET');
  expect(document.body.innerHTML).not.toContain('PASTEDREFRESHSECRET');
}

describe('SlackTab states', () => {
  it('shows a placeholder while it reads, then the state', async () => {
    let resolve!: (s: SlackStatusRead) => void;
    status.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<SlackTab />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading Slack settings');
    resolve(CONNECTED);
    expect(await screen.findByText('Connected to Canopy Works')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('unavailable: says Slack is not set up here, and offers nothing', async () => {
    renderTab({ state: 'unavailable' });
    expect(await screen.findByText("Slack isn't set up on this server.")).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('not connected, no public https address: says why, and where it is set; no form', async () => {
    renderTab(NO_HTTPS);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Slack needs a public https address to reach this server');
    expect(alert).toHaveTextContent('onboarding.publicBaseUrl');
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.queryByLabelText(/access token/i)).toBeNull();
  });

  it('not connected: the three steps, the privacy note, write-only token fields and a prefilled name', async () => {
    renderTab(NOT_CONNECTED);
    expect(await screen.findByRole('heading', { level: 2, name: 'Connect a Slack workspace' })).toBeInTheDocument();
    const steps = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent(
      "Open Slack's app settings. Under Your App Configuration Tokens, click Generate Token for your workspace.",
    );
    expect(steps[1]).toHaveTextContent(
      'Paste both values below. We keep only the refresh token, encrypted, and nobody can read it back.',
    );
    expect(steps[2]).toHaveTextContent("Pick the bot's name and click Connect. Slack will ask you to Allow it.");
    const link = within(steps[0]!).getByRole('link', { name: "Slack's app settings" });
    expect(link).toHaveAttribute('href', 'https://api.slack.com/apps');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(
      screen.getByText("Slack keeps a copy of everything the agent says there, under your workspace's retention rules."),
    ).toBeInTheDocument();

    for (const label of [/access token/i, /refresh token/i]) {
      expect(input(label)).toHaveAttribute('type', 'password');
      expect(input(label)).toHaveAttribute('autocomplete', 'off');
      // A password field invites a password manager to save what's pasted:
      // 1Password, LastPass and Bitwarden each skip a field marked this way.
      expect(input(label)).toHaveAttribute('data-1p-ignore');
      expect(input(label)).toHaveAttribute('data-lpignore', 'true');
      expect(input(label)).toHaveAttribute('data-bwignore');
      expect(input(label).value).toBe('');
    }
    expect(input(/bot name/i).value).toBe('canopy');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('pending: almost there, who started it, Continue in Slack and Cancel', async () => {
    renderTab(PENDING);
    expect(await screen.findByText('Almost there: finish installing the bot in Slack.')).toBeInTheDocument();
    expect(screen.getByText(`Started by Ada Admin on ${CONNECTED_DATE}. Bot name: canopy.`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue in Slack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/refresh token/i)).toBeNull();
  });

  it('connected: the workspace, the bot, whose token and when, and Disconnect', async () => {
    renderTab(CONNECTED);
    expect(await screen.findByRole('heading', { level: 2, name: 'Connected to Canopy Works' })).toBeInTheDocument();
    expect(screen.getByText('Bot name')).toBeInTheDocument();
    expect(screen.getByText('canopy')).toBeInTheDocument();
    expect(screen.getByText('Configuration token')).toBeInTheDocument();
    expect(screen.getByText(`Added by Ada Admin on ${CONNECTED_DATE}`)).toBeInTheDocument();
    expect(screen.getByText('People can now DM the bot to talk to their own agent.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    // The token itself is never shown, and never asked for again.
    expect(screen.queryByLabelText(/token/i)).toBeNull();
  });

  it('connected with no workspace name still reads as a sentence', async () => {
    renderTab({ ...CONNECTED, workspaceName: '' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Connected to Slack' })).toBeInTheDocument();
  });

  it('a read that fails says so and can be tried again', async () => {
    status.mockRejectedValueOnce(new Error('boom'));
    status.mockResolvedValueOnce(CONNECTED);
    render(<SlackTab />);
    expect(await screen.findByText("We couldn't load your Slack settings.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Connected to Canopy Works')).toBeInTheDocument();
  });
});

describe('Connect', () => {
  it('posts the pasted tokens (trimmed) and the name, then hands the page to Slack', async () => {
    connect.mockResolvedValueOnce({ installUrl: INSTALL_URL });
    renderTab(NOT_CONNECTED);
    await fillAndConnect({ access: `  ${ACCESS}\n`, refresh: ` ${REFRESH} `, name: 'Canopy Bot' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(INSTALL_URL));
    expect(connect).toHaveBeenCalledWith({ accessToken: ACCESS, refreshToken: REFRESH, botName: 'Canopy Bot' });
    expect(connect).toHaveBeenCalledTimes(1);
    expectNoSecretsOnPage();
  });

  it('sends the suggested name when the admin leaves it alone', async () => {
    connect.mockResolvedValueOnce({ installUrl: INSTALL_URL });
    renderTab(NOT_CONNECTED);
    await fillAndConnect();
    await waitFor(() => expect(connect).toHaveBeenCalled());
    expect(connect.mock.calls[0]![0].botName).toBe('canopy');
  });

  it('is one request at a time: the button waits while Slack answers', async () => {
    let finish!: (v: { installUrl: string }) => void;
    connect.mockReturnValueOnce(new Promise((r) => (finish = r)));
    renderTab(NOT_CONNECTED);
    await fillAndConnect();
    const busy = await screen.findByRole('button', { name: /Connecting/ });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(connect).toHaveBeenCalledTimes(1);
    finish({ installUrl: INSTALL_URL });
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['invalid-access-token', null, /access token/i, `That doesn't look like an access token. It starts with ${CONFIG_ACCESS_PREFIX}.`],
    ['invalid-refresh-token', null, /refresh token/i, `That doesn't look like a refresh token. It starts with ${CONFIG_REFRESH_PREFIX}.`],
    ['invalid-bot-name', 'reserved', /bot name/i, 'Slack keeps that name for itself. Pick another.'],
    ['slack-name', null, /bot name/i, "Slack didn't accept that bot name. Try another."],
  ] as const)('%s: the message sits under the field it is about', async (code, reason, label, message) => {
    connect.mockRejectedValueOnce(new SlackAdminError(code.startsWith('slack') ? 502 : 400, code, reason));
    renderTab(NOT_CONNECTED);
    await fillAndConnect();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(input(label)).toHaveAttribute('aria-invalid', 'true');
    expect(input(label)).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(navigate).not.toHaveBeenCalled();
    expectNoSecretsOnPage();
  });

  it.each([
    ['slack-token', "Slack didn't accept the access token. Generate a new pair and paste both again."],
    [
      'slack-unconfirmed',
      "Slack didn't give us a clear answer, so a Slack app may have been created anyway. Check api.slack.com/apps and delete it before you try again.",
    ],
    ['slack-error', 'Something went wrong talking to Slack. Try again in a minute.'],
    ['internal', 'Something went wrong talking to Slack. Try again in a minute.'],
  ])('%s: the message is shown above the button, never the raw code', async (code, message) => {
    connect.mockRejectedValueOnce(new SlackAdminError(502, code));
    renderTab(NOT_CONNECTED);
    await fillAndConnect();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(code);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
    expectNoSecretsOnPage();
  });

  it('a network failure reads the same as any other trouble', async () => {
    connect.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderTab(NOT_CONNECTED);
    await fillAndConnect();
    expect(await screen.findByText('Something went wrong talking to Slack. Try again in a minute.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });

  it('someone else connected meanwhile: it refreshes and says so', async () => {
    connect.mockRejectedValueOnce(new SlackAdminError(409, 'already-connected'));
    renderTab(NOT_CONNECTED, CONNECTED);
    await fillAndConnect();
    expect(await screen.findByText('Connected to Canopy Works')).toBeInTheDocument();
    expect(screen.getByText("This changed while you were here, so we've refreshed it.")).toBeInTheDocument();
    expect(status).toHaveBeenCalledTimes(2);
  });
});

describe('Pending', () => {
  it('Continue in Slack mints a fresh link and goes there', async () => {
    resume.mockResolvedValueOnce({ installUrl: INSTALL_URL });
    renderTab(PENDING);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue in Slack' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(INSTALL_URL));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('Continue in Slack failing says so and stays put', async () => {
    resume.mockRejectedValueOnce(new SlackAdminError(500, 'internal'));
    renderTab(PENDING);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue in Slack' }));
    expect(await screen.findByText('Something went wrong talking to Slack. Try again in a minute.')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Cancel asks first, in words about an unfinished install, then removes it and says what is left to do', async () => {
    disconnect.mockResolvedValueOnce({ appDeleted: true });
    renderTab(PENDING, NOT_CONNECTED);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop connecting Slack?' });
    expect(dialog).toHaveTextContent("We'll delete the Slack app we started. You can connect again any time.");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop connecting' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/One more step only you can do/)).toBeInTheDocument();
  });
});

describe('Disconnect', () => {
  async function openDialog() {
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    return screen.findByRole('dialog', { name: 'Disconnect Slack?' });
  }

  it('asks first; keeping it connected sends nothing', async () => {
    renderTab(CONNECTED);
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent(
      "The bot leaves Slack and people can't reach their agents there. Their conversations stay here.",
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep connected' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('then tells the admin to Revoke the token on Slack’s page, and shows the form again', async () => {
    disconnect.mockResolvedValueOnce({ appDeleted: true });
    renderTab(CONNECTED, NOT_CONNECTED);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    const note = await screen.findByText(/One more step only you can do/);
    const alert = note.closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent(
      "Slack is disconnected. One more step only you can do: on Slack's app settings, under Your App Configuration Tokens, click Revoke. Slack doesn't let us do that part.",
    );
    expect(within(alert).getByRole('link', { name: "Slack's app settings" })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps',
    );
    expect(alert).not.toHaveTextContent("We couldn't remove the Slack app itself.");
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('if the Slack app could not be deleted, says to delete it on the same page', async () => {
    disconnect.mockResolvedValueOnce({ appDeleted: false });
    renderTab(CONNECTED, NOT_CONNECTED);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    const note = await screen.findByText(/One more step only you can do/);
    expect(note.closest('[role="alert"]')).toHaveTextContent(
      "We couldn't remove the Slack app itself. Delete it on the same page.",
    );
  });

  it('a failed disconnect says so in the dialog and changes nothing', async () => {
    disconnect.mockRejectedValueOnce(new SlackAdminError(500, 'internal'));
    renderTab(CONNECTED);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(
      await within(dialog).findByText('Something went wrong talking to Slack. Try again in a minute.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/One more step only you can do/)).toBeNull();
    expect(status).toHaveBeenCalledTimes(1);
  });
});
