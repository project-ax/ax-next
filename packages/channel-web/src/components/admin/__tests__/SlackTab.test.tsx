/**
 * Admin › Slack (TASK-1093). The wire client is mocked here (its own requests
 * are pinned in `src/__tests__/admin-slack.test.tsx`); its copy and error
 * mapping are the real ones, so what an admin reads is what ships.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SlackTab } from '../SlackTab';
import { beforeNoon, byVisibleText, freezeClock } from '@/test-utils/time';
import { renderSlackAvatar } from '@/lib/slack-avatar';
import { fetchSlackBotRequests } from '@/lib/slack-bot-requests';
import {
  SlackAdminError,
  connectSlack,
  disconnectSlack,
  fetchSlackStatus,
  forgetLeftoverSlackApp,
  goToSlack,
  renameSlackBot,
  replaceSlackConfigToken,
  resumeSlackInstall,
  SLACK_ERROR_COPY,
  type SlackStatusRead,
} from '@/lib/slack-admin';
import { disconnectTeamBot, fetchSlackBots } from '@/lib/slack-bots-admin';
import { CONFIG_ACCESS_PREFIX, CONFIG_REFRESH_PREFIX, fakeConfigAccessToken, fakeConfigRefreshToken } from '@/test-utils/fake-slack-tokens';

vi.mock('@/lib/slack-admin', async (original) => ({
  ...(await original<typeof import('@/lib/slack-admin')>()),
  fetchSlackStatus: vi.fn(),
  connectSlack: vi.fn(),
  resumeSlackInstall: vi.fn(),
  disconnectSlack: vi.fn(),
  renameSlackBot: vi.fn(),
  replaceSlackConfigToken: vi.fn(),
  forgetLeftoverSlackApp: vi.fn(),
  goToSlack: vi.fn(),
}));

vi.mock('@/lib/slack-avatar', () => ({ renderSlackAvatar: vi.fn() }));
// Bot requests have their own tests (SlackBotRequests.test.tsx); here the list is empty unless a test says otherwise.
vi.mock('@/lib/slack-bot-requests', async (original) => ({
  ...(await original<typeof import('@/lib/slack-bot-requests')>()),
  fetchSlackBotRequests: vi.fn(),
}));

// The team bots card (TASK-1172) reads its own list; its own tests are in SlackBotsCard.test.tsx.
vi.mock('@/lib/slack-bots-admin', async (original) => ({
  ...(await original<typeof import('@/lib/slack-bots-admin')>()),
  fetchSlackBots: vi.fn(),
  disconnectTeamBot: vi.fn(),
}));

const INSTALL_URL = 'https://slack.com/oauth/v2/authorize?client_id=1.2&state=ab';
// Distinctive, so a leak into the page is easy to spot.
const ACCESS = fakeConfigAccessToken();
const REFRESH = fakeConfigRefreshToken();
// 30 days before the frozen "now" (Nov 26): far enough back to read as a plain date.
const CONNECTED_AT = beforeNoon(30 * 86_400_000);
const CONNECTED_DATE = 'Oct 27';

const NOT_CONNECTED: SlackStatusRead = { state: 'not-connected', defaultBotName: 'canopy', canConnect: true, leftoverApps: [] };
const NO_HTTPS: SlackStatusRead = {
  state: 'not-connected',
  defaultBotName: 'canopy',
  canConnect: false,
  leftoverApps: [],
};
const LEFT = { botName: 'canopy', appId: 'A0CHZPVDJHX' };
const LEFT_2 = { botName: 'canopy', appId: 'A0CHHCT1Z8X' };
const PENDING: SlackStatusRead = {
  state: 'pending',
  botName: 'canopy',
  connectedBy: 'Ada Admin',
  connectedAt: CONNECTED_AT,
  leftoverApps: [],
};
const CONNECTED: SlackStatusRead = {
  state: 'connected',
  botName: 'canopy',
  workspaceName: 'Canopy Works',
  connectedBy: 'Ada Admin',
  connectedAt: CONNECTED_AT,
  leftoverApps: [],
};
/** The note's last sentence where no Connect will try again (pending, connected). */
const BY_HAND_ONE = 'To delete it, open it and click Delete App at the bottom of the page.';
const BY_HAND_SEVERAL = 'To delete one, open it and click Delete App at the bottom of the page.';

const status = vi.mocked(fetchSlackStatus);
const connect = vi.mocked(connectSlack);
const resume = vi.mocked(resumeSlackInstall);
const disconnect = vi.mocked(disconnectSlack);
const rename = vi.mocked(renameSlackBot);
const replace = vi.mocked(replaceSlackConfigToken);
const forget = vi.mocked(forgetLeftoverSlackApp);
const navigate = vi.mocked(goToSlack);

/** The leftover note: the alert holding its first sentence. */
async function leftoverNote(several = false): Promise<HTMLElement> {
  const first = await screen.findByText(
    several
      ? "We couldn't confirm these Slack apps were deleted, so they may still be on Slack:"
      : "We couldn't confirm this Slack app was deleted, so it may still be on Slack:",
  );
  return first.closest('[role="status"]') as HTMLElement;
}

beforeEach(() => {
  freezeClock();
  vi.resetAllMocks();
  vi.mocked(renderSlackAvatar).mockResolvedValue('AVATARB64');
  vi.mocked(fetchSlackBotRequests).mockResolvedValue({ requests: [], truncated: false, configTokenStored: false });
  vi.mocked(fetchSlackBots).mockResolvedValue({ state: 'ready', bots: [] });
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
  it('connected: lists the bot requests under the connected card, and only there', async () => {
    vi.mocked(fetchSlackBotRequests).mockResolvedValue({
      requests: [
        {
          requestId: 'AAAAAAAAAAAAAAAAAAAAAA',
          botName: 'Quill Bot',
          agentName: 'Quill',
          teamName: 'Support',
          requestedBy: 'Ada Lovelace',
          requestedAt: CONNECTED_AT,
        },
      ],
      truncated: false,
      configTokenStored: true,
    });
    renderTab(CONNECTED);
    expect(await screen.findByText('Quill Bot for Quill · Support')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Bot requests' })).toBeInTheDocument();
    expect(screen.getByText('Connected to Canopy Works')).toBeInTheDocument();
  });

  it('not connected: asks for no bot requests', async () => {
    renderTab(NOT_CONNECTED);
    await screen.findByRole('button', { name: 'Connect' });
    expect(fetchSlackBotRequests).not.toHaveBeenCalled();
    expect(screen.queryByText('Bot requests')).toBeNull();
  });

  it('shows a placeholder while it reads, then the state', async () => {
    let resolve!: (s: SlackStatusRead) => void;
    status.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<SlackTab />);
    expect(screen.getByText('Loading Slack settings…')).toBeInTheDocument();
    resolve(CONNECTED);
    expect(await screen.findByText('Connected to Canopy Works')).toBeInTheDocument();
    expect(screen.queryByText('Loading Slack settings…')).toBeNull();
  });

  it('unavailable: says Slack is not set up here, and offers nothing', async () => {
    renderTab({ state: 'unavailable' });
    expect(await screen.findByText("Slack isn't set up on this server.")).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('not connected, no public https address: says why, and where it is set; no form', async () => {
    renderTab(NO_HTTPS);
    const alert = (await screen.findByText(/Slack needs a public https address to reach this server/)).closest('[role="status"]') as HTMLElement;
    expect(alert).toHaveTextContent('Slack needs a public https address to reach this server');
    expect(alert).toHaveTextContent('onboarding.publicBaseUrl');
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.queryByLabelText(/access token/i)).toBeNull();
  });

  it("not connected, with a Slack app we couldn't delete: names it, links to its own settings page, and still offers Connect", async () => {
    renderTab({ ...NOT_CONNECTED, leftoverApps: [LEFT] });
    const first = await screen.findByText("We couldn't confirm this Slack app was deleted, so it may still be on Slack:");
    const alert = first.closest('[role="status"]') as HTMLElement;
    expect(alert).toHaveTextContent(
      "We'll try again the next time you connect. To delete it yourself, open it and click Delete App at the bottom of the page.",
    );
    const link = within(alert).getByRole('link', { name: 'canopy' });
    expect(link).toHaveAttribute('href', 'https://api.slack.com/apps/A0CHZPVDJHX');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('several apps: each listed and linked to its own page, even with the same name', async () => {
    renderTab({ ...NOT_CONNECTED, leftoverApps: [LEFT, LEFT_2] });
    const first = await screen.findByText("We couldn't confirm these Slack apps were deleted, so they may still be on Slack:");
    const alert = first.closest('[role="status"]') as HTMLElement;
    expect(alert).toHaveTextContent(
      "We'll try again the next time you connect. To delete one yourself, open it and click Delete App at the bottom of the page.",
    );
    const links = within(alert).getAllByRole('link', { name: 'canopy' });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', expect.stringMatching(/A0CHZPVDJHX$/));
    expect(links[1]).toHaveAttribute('href', expect.stringMatching(/A0CHHCT1Z8X$/));
  });

  it('no public https address: the note shows above the https explainer', async () => {
    renderTab({ ...NO_HTTPS, leftoverApps: [LEFT] });
    await screen.findByText(/Slack needs a public https address to reach this server/);
    const alerts = screen.getAllByRole('status').filter((n) => n.textContent !== '' && !n.hasAttribute('aria-busy'));
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent("We couldn't confirm this Slack app was deleted");
    expect(alerts[1]).toHaveTextContent('Slack needs a public https address to reach this server');
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it("pending, with a Slack app Connect couldn't delete: still names it, linked to its own page, and still offers Continue in Slack", async () => {
    renderTab({ ...PENDING, leftoverApps: [LEFT] });
    const alert = await leftoverNote();
    const link = within(alert).getByRole('link', { name: 'canopy' });
    expect(link).toHaveAttribute('href', 'https://api.slack.com/apps/A0CHZPVDJHX');
    // Continue in Slack doesn't try again, so the note promises nothing.
    expect(alert).toHaveTextContent(BY_HAND_ONE);
    expect(alert).not.toHaveTextContent(/try again/);
    expect(screen.getByRole('button', { name: 'Continue in Slack' })).toBeInTheDocument();
  });

  it("connected, with a Slack app Connect couldn't delete: names it above the card, and says only the admin can delete it now", async () => {
    // Allow lands the admin here straight after a Connect whose delete failed.
    renderTab({ ...CONNECTED, leftoverApps: [LEFT] });
    const alert = await leftoverNote();
    expect(within(alert).getByRole('link', { name: 'canopy' })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps/A0CHZPVDJHX',
    );
    expect(alert).toHaveTextContent(BY_HAND_ONE);
    expect(alert).not.toHaveTextContent(/try again/);
    const card = screen.getByRole('heading', { level: 2, name: 'Connected to Canopy Works' });
    // The note comes first on the page.
    expect(alert.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('connected, with several: the plural, still without a promise to try again', async () => {
    renderTab({ ...CONNECTED, leftoverApps: [LEFT, LEFT_2] });
    const alert = await leftoverNote(true);
    expect(alert).toHaveTextContent(BY_HAND_SEVERAL);
    expect(alert).not.toHaveTextContent(/try again/);
    expect(within(alert).getAllByRole('link', { name: 'canopy' })).toHaveLength(2);
  });

  it('nothing left over: no note', async () => {
    renderTab(NOT_CONNECTED);
    await screen.findByRole('button', { name: 'Connect' });
    expect(screen.queryByText(/couldn't confirm/)).toBeNull();
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
    expect(screen.getByText(byVisibleText(`Started by Ada Admin ${CONNECTED_DATE}. Bot name: canopy.`))).toBeInTheDocument();
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
    expect(screen.getByText(byVisibleText(`Added by Ada Admin ${CONNECTED_DATE}`))).toBeInTheDocument();
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

describe('I deleted it', () => {
  const button = (alert: HTMLElement, app: { botName: string; appId: string }) =>
    within(alert).getByRole('button', { name: `I deleted it: ${app.botName} (${app.appId})` });

  it('each app has its own button, named for that app even when two share a name', async () => {
    renderTab({ ...NOT_CONNECTED, leftoverApps: [LEFT, LEFT_2] });
    const alert = await leftoverNote(true);
    for (const app of [LEFT, LEFT_2]) {
      expect(button(alert, app)).toHaveTextContent('I deleted it');
      expect(button(alert, app)).toBeEnabled();
    }
    expect(forget).not.toHaveBeenCalled();
  });

  it.each<[string, SlackStatusRead, SlackStatusRead]>([
    ['not connected', { ...NOT_CONNECTED, leftoverApps: [LEFT, LEFT_2] }, { ...NOT_CONNECTED, leftoverApps: [LEFT] }],
    ['pending', { ...PENDING, leftoverApps: [LEFT, LEFT_2] }, { ...PENDING, leftoverApps: [LEFT] }],
    ['connected', { ...CONNECTED, leftoverApps: [LEFT, LEFT_2] }, { ...CONNECTED, leftoverApps: [LEFT] }],
  ])('%s: sends that app id, then reads the tab again, and the app is gone from the note', async (_label, before, after) => {
    forget.mockResolvedValueOnce(undefined);
    renderTab(before, after);
    fireEvent.click(button(await leftoverNote(true), LEFT_2));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledWith('A0CHHCT1Z8X');
    const alert = await leftoverNote();
    expect(within(alert).getAllByRole('link')).toHaveLength(1);
    expect(within(alert).getByRole('link', { name: 'canopy' })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps/A0CHZPVDJHX',
    );
    // The one left can still be cleared.
    expect(button(alert, LEFT)).toBeEnabled();
  });

  it('the last one cleared: the note goes', async () => {
    forget.mockResolvedValueOnce(undefined);
    renderTab({ ...CONNECTED, leftoverApps: [LEFT] }, CONNECTED);
    fireEvent.click(button(await leftoverNote(), LEFT));
    expect(await screen.findByRole('heading', { level: 2, name: 'Connected to Canopy Works' })).toBeInTheDocument();
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/couldn't confirm/)).toBeNull();
  });

  it('is one request at a time: every button in the note waits while the server answers', async () => {
    let finish!: () => void;
    forget.mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
    renderTab({ ...NOT_CONNECTED, leftoverApps: [LEFT, LEFT_2] }, NOT_CONNECTED);
    const alert = await leftoverNote(true);
    fireEvent.click(button(alert, LEFT));
    await waitFor(() => expect(button(alert, LEFT)).toHaveAttribute('aria-busy', 'true'));
    expect(button(alert, LEFT_2)).toBeDisabled();
    fireEvent.click(button(alert, LEFT));
    fireEvent.click(button(alert, LEFT_2));
    expect(forget).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('a failure says so under the note, never the raw code; nothing is read again, and it can be tried again', async () => {
    forget.mockRejectedValueOnce(new SlackAdminError(500, 'internal'));
    renderTab({ ...CONNECTED, leftoverApps: [LEFT] });
    const alert = await leftoverNote();
    fireEvent.click(button(alert, LEFT));
    // The route never calls Slack, so the message mustn't blame it.
    const error = await screen.findByText("We couldn't update that list just now. Try again in a minute.");
    expect(error.textContent).not.toContain('Slack');
    expect(alert).not.toContainElement(error);
    expect(document.body.textContent).not.toContain('internal');
    expect(status).toHaveBeenCalledTimes(1);
    expect(button(alert, LEFT)).toBeEnabled();

    // A second try that works clears the message and reads again.
    forget.mockResolvedValueOnce(undefined);
    status.mockResolvedValueOnce(CONNECTED);
    fireEvent.click(button(alert, LEFT));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/couldn't update that list/)).toBeNull());
    expect(forget).toHaveBeenCalledTimes(2);
  });
});

describe('Connect', () => {
  it('posts the pasted tokens (trimmed) and the name, then hands the page to Slack', async () => {
    connect.mockResolvedValueOnce({ installUrl: INSTALL_URL });
    renderTab(NOT_CONNECTED);
    await fillAndConnect({ access: `  ${ACCESS}\n`, refresh: ` ${REFRESH} `, name: 'Canopy Bot' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(INSTALL_URL));
    expect(connect).toHaveBeenCalledWith({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      botName: 'Canopy Bot',
      iconPng: 'AVATARB64',
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expectNoSecretsOnPage();
  });

  it('with no picture to send, Connect still goes, without iconPng', async () => {
    vi.mocked(renderSlackAvatar).mockResolvedValue(null);
    connect.mockResolvedValueOnce({ installUrl: INSTALL_URL });
    renderTab(NOT_CONNECTED);
    await fillAndConnect();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(INSTALL_URL));
    expect(Object.keys(connect.mock.calls[0]![0]).sort()).toEqual(['accessToken', 'botName', 'refreshToken']);
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
    const busy = screen.getByRole('button', { name: 'Connect' });
    await waitFor(() => expect(busy).toHaveAttribute('aria-busy', 'true'));
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

  it('bot-name-taken (an agent\'s own bot has the name): the message sits under the name field', async () => {
    const message = 'Another Slack bot here already uses that name. Pick another.';
    connect.mockRejectedValueOnce(new SlackAdminError(409, 'bot-name-taken'));
    renderTab(NOT_CONNECTED);
    await fillAndConnect();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(input(/bot name/i)).toHaveAttribute('aria-invalid', 'true');
    expect(input(/bot name/i)).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['slack-token', "Slack didn't accept the access token. Generate a new pair and paste both again."],
    ['slack-refresh-token', "Slack didn't accept the refresh token. Generate a new token and try again."],
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

  it('a Connect refused for want of https re-reads into the https explainer, not the Rename sentence', async () => {
    connect.mockRejectedValueOnce(new SlackAdminError(409, 'public-origin-not-https'));
    renderTab(NOT_CONNECTED, NO_HTTPS);
    await fillAndConnect();
    expect(await screen.findByText(/Slack needs a public https address to reach this server/)).toBeInTheDocument();
    expect(status).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/can't update the Slack app/)).not.toBeInTheDocument();
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
    disconnect.mockResolvedValueOnce({ appDeleted: true, tokenKept: false });
    renderTab(PENDING, NOT_CONNECTED);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop connecting Slack?' });
    expect(dialog).toHaveTextContent("We'll delete the Slack app we started. You can connect again any time.");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop connecting' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/One more step that Slack doesn't let us do/)).toBeInTheDocument();
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
      "The bot leaves Slack, and people can't message their own agents there anymore. Team agents' own bots stay in their channels. Conversations stay here.",
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('then tells the admin to Revoke the token on Slack’s page, and shows the form again', async () => {
    disconnect.mockResolvedValueOnce({ appDeleted: true, tokenKept: false });
    renderTab(CONNECTED, NOT_CONNECTED);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    const note = await screen.findByText(/One more step that Slack doesn't let us do/);
    const alert = note.closest('[role="status"]') as HTMLElement;
    expect(alert).toHaveTextContent(
      "Slack is disconnected. One more step that Slack doesn't let us do: on Slack's app settings, under Your App Configuration Tokens, whoever generated the token clicks Revoke.",
    );
    expect(within(alert).getByRole('link', { name: "Slack's app settings" })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps',
    );
    expect(alert).not.toHaveTextContent("We couldn't remove the Slack app itself.");
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('when a team agent’s own bot still needs the token, the note says not to revoke it', async () => {
    disconnect.mockResolvedValueOnce({ appDeleted: true, tokenKept: true });
    renderTab(CONNECTED, NOT_CONNECTED);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    const note = await screen.findByText(/Don't revoke the configuration token/);
    const alert = note.closest('[role="status"]') as HTMLElement;
    expect(alert).toHaveTextContent(
      "Slack is disconnected. Don't revoke the configuration token on Slack's app settings yet: other Slack apps made with it still use it, like a team agent's own bot.",
    );
    expect(within(alert).getByRole('link', { name: "Slack's app settings" })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps',
    );
    expect(alert).not.toHaveTextContent('clicks Revoke');
    expect(screen.queryByText(/One more step that Slack doesn't let us do/)).toBeNull();
  });

  it('if the Slack app could not be deleted, the re-read names it with its own link, and the Revoke note says nothing more', async () => {
    disconnect.mockResolvedValueOnce({ appDeleted: false, tokenKept: false });
    renderTab(CONNECTED, { ...NOT_CONNECTED, leftoverApps: [LEFT] });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    const note = await screen.findByText(/One more step that Slack doesn't let us do/);
    expect(note.closest('[role="status"]')).not.toHaveTextContent("We couldn't remove the Slack app itself.");
    const left = await screen.findByText(/We couldn't confirm this Slack app was deleted/);
    expect(left.closest('[role="status"]')).toHaveTextContent('canopy');
    expect(screen.getByRole('link', { name: 'canopy' })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps/A0CHZPVDJHX',
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
    expect(screen.queryByText(/One more step that Slack doesn't let us do/)).toBeNull();
    expect(status).toHaveBeenCalledTimes(1);
  });
});

describe('Rename', () => {
  const GENERIC = 'Something went wrong talking to Slack. Try again in a minute.';

  async function openDialog() {
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    return screen.findByRole('dialog', { name: 'Rename the bot' });
  }
  function nameInput(dialog: HTMLElement): HTMLInputElement {
    return within(dialog).getByLabelText('Bot name') as HTMLInputElement;
  }
  function submit(dialog: HTMLElement, value: string) {
    fireEvent.change(nameInput(dialog), { target: { value } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
  }

  it('the connected card shows the name with a Rename button; the dialog opens with that name filled in', async () => {
    renderTab(CONNECTED);
    expect(await screen.findByText('canopy')).toBeInTheDocument();
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent('Only the name changes. Conversations keep working.');
    expect(within(dialog).getByText('The name people see in Slack.')).toBeInTheDocument();
    expect(nameInput(dialog).value).toBe('canopy');
  });

  it('Rename sends the name as typed, then says what Slack shows now and reads the tab again', async () => {
    rename.mockResolvedValueOnce({ botName: 'Ada Helper' });
    renderTab(CONNECTED, { ...CONNECTED, botName: 'Ada Helper' });
    const dialog = await openDialog();
    submit(dialog, '  Ada   Helper ');
    expect(rename).toHaveBeenCalledWith('  Ada   Helper ');
    expect(await screen.findByText('Renamed. People in Slack now see the bot as Ada Helper.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(status).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Ada Helper')).toBeInTheDocument();
  });

  it.each([
    [new SlackAdminError(400, 'invalid-bot-name', 'reserved'), 'Slack keeps that name for itself. Pick another.'],
    [new SlackAdminError(502, 'slack-name'), "Slack didn't accept that bot name. Try another."],
  ])('a name Slack can\'t use stays in the dialog, under the field (%#)', async (err, message) => {
    rename.mockRejectedValueOnce(err);
    renderTab(CONNECTED);
    const dialog = await openDialog();
    // The pointer was on the button, not the field, when Slack said no.
    within(dialog).getByRole('button', { name: 'Cancel' }).focus();
    submit(dialog, 'Slackbot');
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    const field = nameInput(dialog);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(expect.stringContaining(message));
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getByRole('dialog', { name: 'Rename the bot' })).toBeInTheDocument();
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('a configuration token Slack no longer accepts says what to do, in the dialog', async () => {
    rename.mockRejectedValueOnce(new SlackAdminError(502, 'slack-config-token'));
    renderTab(CONNECTED);
    const dialog = await openDialog();
    submit(dialog, 'Ada Helper');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(SLACK_ERROR_COPY['slack-config-token']);
    expect(alert).toHaveTextContent(
      "We can't use the configuration token we have for this Slack app, so we couldn't rename the bot. Replace the token with one from someone who can manage this Slack app, then try again.",
    );
    expect(document.body.textContent).not.toContain('slack-config-token');
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('a rename refused for want of an https address says so, instead of refreshing in a loop', async () => {
    rename.mockRejectedValueOnce(new SlackAdminError(409, 'public-origin-not-https'));
    renderTab(CONNECTED);
    const dialog = await openDialog();
    submit(dialog, 'Ada Helper');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      "Our public address isn't https right now, so we can't update the Slack app. Whoever runs this server can fix that.",
    );
    expect(document.body.textContent).not.toContain('public-origin-not-https');
    expect(document.body.textContent).not.toContain('This changed while you were here');
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('an app Slack no longer has says to disconnect and connect again, in the dialog', async () => {
    rename.mockRejectedValueOnce(new SlackAdminError(502, 'slack-app-gone'));
    renderTab(CONNECTED);
    const dialog = await openDialog();
    submit(dialog, 'Ada Helper');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(SLACK_ERROR_COPY['slack-app-gone']);
    expect(alert).not.toHaveTextContent(GENERIC);
    expect(document.body.textContent).not.toContain('slack-app-gone');
    expect(status).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a server error', new SlackAdminError(500, 'internal')],
    ['a network failure', new TypeError('Failed to fetch')],
  ])('other trouble reads as the generic sentence and changes nothing (%s)', async (_label, err) => {
    rename.mockRejectedValueOnce(err);
    renderTab(CONNECTED);
    const dialog = await openDialog();
    submit(dialog, 'Ada Helper');
    expect(await within(dialog).findByText(GENERIC)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Failed to fetch');
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('someone else disconnected meanwhile: it refreshes and says so', async () => {
    rename.mockRejectedValueOnce(new SlackAdminError(409, 'not-connected'));
    renderTab(CONNECTED, NOT_CONNECTED);
    const dialog = await openDialog();
    submit(dialog, 'Ada Helper');
    expect(await screen.findByText("This changed while you were here, so we've refreshed it.")).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is one request at a time: Rename and Cancel wait while Slack answers', async () => {
    let finish!: (v: { botName: string }) => void;
    rename.mockReturnValueOnce(new Promise((r) => (finish = r)));
    renderTab(CONNECTED, { ...CONNECTED, botName: 'Ada Helper' });
    const dialog = await openDialog();
    fireEvent.change(nameInput(dialog), { target: { value: 'Ada Helper' } });
    const go = within(dialog).getByRole('button', { name: 'Rename' });
    fireEvent.click(go);
    const busy = within(dialog).getByRole('button', { name: 'Rename' });
    await waitFor(() => expect(busy).toHaveAttribute('aria-busy', 'true'));
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Rename the bot' })).toBeInTheDocument();
    finish({ botName: 'Ada Helper' });
    expect(await screen.findByText('Renamed. People in Slack now see the bot as Ada Helper.')).toBeInTheDocument();
  });

  it('Cancel closes without a request, and opening again starts from the current name', async () => {
    rename.mockRejectedValueOnce(new SlackAdminError(500, 'internal'));
    renderTab(CONNECTED);
    let dialog = await openDialog();
    fireEvent.change(nameInput(dialog), { target: { value: 'Half typed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rename).not.toHaveBeenCalled();
    dialog = await openDialog();
    expect(nameInput(dialog).value).toBe('canopy');

    // An error left behind by a failed try doesn't survive a close either.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByText(GENERIC)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await openDialog();
    expect(within(dialog).queryByText(GENERIC)).toBeNull();
    expect(nameInput(dialog).value).toBe('canopy');
  });
});

describe('Replace the configuration token', () => {
  const GENERIC = 'Something went wrong talking to Slack. Try again in a minute.';
  const NOT_MANAGER =
    "Slack says that token can't manage this Slack app. Paste a refresh token from someone who can manage it, in the same Slack workspace.";

  async function openDialog() {
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    return screen.findByRole('dialog', { name: 'Replace the configuration token' });
  }
  function tokenInput(dialog: HTMLElement): HTMLInputElement {
    return within(dialog).getByLabelText('Refresh token') as HTMLInputElement;
  }
  function submit(dialog: HTMLElement, value = REFRESH) {
    fireEvent.change(tokenInput(dialog), { target: { value } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace token' }));
  }

  it('the connected card shows who added the token and when, with Replace; the dialog asks for one refresh token from someone who can manage the app', async () => {
    renderTab(CONNECTED);
    expect(await screen.findByText(byVisibleText(`Added by Ada Admin ${CONNECTED_DATE}`))).toBeInTheDocument();
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent(
      'Do this when the token we have stops working, or when whoever generated it is leaving. Conversations keep working.',
    );
    const steps = within(dialog).getAllByRole('listitem');
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent(
      "Open Slack's app settings. Under Your App Configuration Tokens, click Generate Token for this workspace. The token has to come from someone who can manage this Slack app.",
    );
    expect(within(steps[0]!).getByRole('link', { name: "Slack's app settings" })).toHaveAttribute(
      'href',
      'https://api.slack.com/apps',
    );
    expect(steps[1]).toHaveTextContent(
      'Paste its refresh token below. We keep it encrypted, and nobody can read it back.',
    );
    const field = tokenInput(dialog);
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('id', 'slack-replace-refresh-token');
    expect(within(dialog).getByText('Starts with xoxe-')).toBeInTheDocument();
    expect(within(dialog).getAllByLabelText(/token/i)).toHaveLength(1);
    expect(within(dialog).queryByLabelText(/access token/i)).toBeNull();
  });

  it('Replace sends the pasted refresh token, trimmed; the field is empty as the request goes out and the token is never on the page; then the dialog closes, the notice says the token now serves every app that person made, and the tab reads again', async () => {
    let finish!: () => void;
    replace.mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
    renderTab(CONNECTED, CONNECTED);
    const dialog = await openDialog();
    submit(dialog, `  ${REFRESH} `);
    expect(replace).toHaveBeenCalledWith(REFRESH);
    expect(tokenInput(dialog).value).toBe('');
    expect(document.body.innerHTML).not.toContain(REFRESH);
    finish();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const note = (await screen.findByText(/Token replaced\./)).closest('[role="status"]') as HTMLElement;
    expect(note).toHaveTextContent(
      "Token replaced. We now use it for this Slack app and for every other Slack app the same person made through AX. Don't revoke the token you just pasted: that's the one we use now.",
    );
    // Slack allows one token per person, so the old one was revoked before this
    // one existed: nothing left to retire, and no link to send anyone off to.
    expect(within(note).queryByRole('link')).toBeNull();
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(document.body.innerHTML).not.toContain(REFRESH);
  });

  it.each([
    [new SlackAdminError(502, 'slack-refresh-token'), "Slack didn't accept the refresh token. Generate a new token and try again."],
    [new SlackAdminError(502, 'slack-not-app-manager'), NOT_MANAGER],
  ])("a token Slack refuses, or one that can't manage this app, says so in the dialog, never the raw code; the field is empty and focused (%#)", async (err, message) => {
    replace.mockRejectedValueOnce(err);
    renderTab(CONNECTED);
    const dialog = await openDialog();
    within(dialog).getByRole('button', { name: 'Cancel' }).focus();
    submit(dialog);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(document.body.textContent).not.toContain(err.code);
    expect(tokenInput(dialog).value).toBe('');
    await waitFor(() => expect(tokenInput(dialog)).toHaveFocus());
    expect(document.body.innerHTML).not.toContain(REFRESH);
    expect(status).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Token replaced/)).toBeNull();
    expect(document.body.innerHTML).not.toContain(REFRESH);
  });

  it('a malformed token shows under the field', async () => {
    replace.mockRejectedValueOnce(new SlackAdminError(400, 'invalid-refresh-token'));
    renderTab(CONNECTED);
    const dialog = await openDialog();
    within(dialog).getByRole('button', { name: 'Cancel' }).focus();
    submit(dialog, ACCESS);
    const message = `That doesn't look like a refresh token. It starts with ${CONFIG_REFRESH_PREFIX}.`;
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    const field = tokenInput(dialog);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(expect.stringContaining(message));
    await waitFor(() => expect(field).toHaveFocus());
    expect(document.body.innerHTML).not.toContain(ACCESS);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('other trouble reads as the generic sentence and changes nothing', async () => {
    replace.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderTab(CONNECTED);
    const dialog = await openDialog();
    submit(dialog);
    expect(await within(dialog).findByText(GENERIC)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Failed to fetch');
    expect(document.body.innerHTML).not.toContain(REFRESH);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('refused for want of https: says so in the dialog instead of refreshing in a loop', async () => {
    replace.mockRejectedValueOnce(new SlackAdminError(409, 'public-origin-not-https'));
    renderTab(CONNECTED);
    const dialog = await openDialog();
    submit(dialog);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      "Our public address isn't https right now, so we can't update the Slack app. Whoever runs this server can fix that.",
    );
    expect(document.body.textContent).not.toContain('public-origin-not-https');
    expect(document.body.textContent).not.toContain('This changed while you were here');
    expect(document.body.innerHTML).not.toContain(REFRESH);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('someone else disconnected meanwhile: it refreshes and says so', async () => {
    replace.mockRejectedValueOnce(new SlackAdminError(409, 'not-connected'));
    renderTab(CONNECTED, NOT_CONNECTED);
    const dialog = await openDialog();
    submit(dialog);
    expect(await screen.findByText("This changed while you were here, so we've refreshed it.")).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/Token replaced/)).toBeNull();
  });

  it('is one request at a time: Replace token and Cancel wait while Slack answers', async () => {
    let finish!: () => void;
    replace.mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
    renderTab(CONNECTED, CONNECTED);
    const dialog = await openDialog();
    fireEvent.change(tokenInput(dialog), { target: { value: REFRESH } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace token' }));
    const busy = within(dialog).getByRole('button', { name: 'Replace token' });
    await waitFor(() => expect(busy).toHaveAttribute('aria-busy', 'true'));
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Replace the configuration token' })).toBeInTheDocument();
    finish();
    expect(await screen.findByText(/Token replaced\./)).toBeInTheDocument();
  });

  it('Cancel closes without a request; opening again starts with an empty field', async () => {
    renderTab(CONNECTED);
    let dialog = await openDialog();
    fireEvent.change(tokenInput(dialog), { target: { value: 'half-pasted' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(replace).not.toHaveBeenCalled();
    dialog = await openDialog();
    expect(tokenInput(dialog).value).toBe('');
  });
});

describe("Team agents' own bots", () => {
  const BOT = {
    installId: 'U2FsZXNCb3RJbnN0YWxsMQ',
    botName: 'Sales Desk',
    handle: 'salesdesk',
    approver: 'Sam Sales',
    state: 'live' as const,
    addedAt: CONNECTED_AT,
    viewerIsApprover: false,
  };

  it('the team bots card sits below the status, outlives the status re-read its disconnect asks for, and keeps its note', async () => {
    let reRead!: (s: SlackStatusRead) => void;
    status.mockResolvedValueOnce(CONNECTED).mockReturnValueOnce(new Promise<SlackStatusRead>((r) => (reRead = r)));
    vi.mocked(fetchSlackBots)
      .mockReset()
      .mockResolvedValueOnce({ state: 'ready', bots: [BOT] })
      .mockResolvedValueOnce({ state: 'ready', bots: [] });
    vi.mocked(disconnectTeamBot).mockResolvedValueOnce({ appDeleted: false });
    render(<SlackTab />);

    const connected = await screen.findByText('Connected to Canopy Works');
    const cardTitle = await screen.findByRole('heading', { level: 2, name: "Team agents' own bots" });
    expect(connected.compareDocumentPosition(cardTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Slack is connected, so the dialog says the shared bot answers again.
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Sales Desk' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).not.toHaveTextContent('The shared bot answers');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    // The tab reads its status again; the card is outside that and keeps its note.
    expect(await screen.findByText('Loading Slack settings…')).toBeInTheDocument();
    const note = await screen.findByText(
      "Sales Desk is disconnected, but we couldn't confirm its Slack app was deleted. It's listed above, with the Slack apps we couldn't delete.",
    );
    expect(vi.mocked(disconnectTeamBot)).toHaveBeenCalledWith(BOT.installId);
    reRead(CONNECTED);
    expect(await screen.findByText('Connected to Canopy Works')).toBeInTheDocument();
    expect(note).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: "Team agents' own bots" })).toBeNull();
  });
});
