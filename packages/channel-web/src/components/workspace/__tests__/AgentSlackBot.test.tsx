/**
 * An agent's Slack card (TASK-1167, TASK-1187). The wire client is mocked (its
 * requests are pinned in `lib/__tests__/agent-slack.test.ts`); the copy and
 * the error mapping are the real ones, so what a person reads is what ships.
 * So is the avatar and the hand-off to Slack, which are mocked because jsdom
 * has neither a canvas nor a page to leave.
 *
 * Radix in jsdom: a ⋯ opens on a press (`pointerDown`), not a click, and an
 * item runs only once the menu has closed, so a test awaits what it does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentSlackBot } from '../AgentSlackBot';
import { beforeNoon, freezeClock, thawClock } from '@/test-utils/time';
import {
  AgentSlackError,
  askSlackBotApproval,
  cancelSlackBot,
  cancelSlackBotRequest,
  claimAgentSlackBot,
  continueSlackBot,
  disconnectSlackBot,
  renameAgentSlackBot,
  replaceAgentSlackBotToken,
  requestSlackBot,
  setAgentSlackBotPicture,
  type AgentSlackBot as Bot,
} from '@/lib/agent-slack';
import { goToSlack } from '@/lib/slack-admin';
import { drawPickedSlackAvatar, renderSlackAvatar } from '@/lib/slack-avatar';
import { BOT_TOKEN_COPY } from '@/lib/slack-token-copy';
import { fakeConfigRefreshToken } from '@/test-utils/fake-slack-tokens';
import { slackCardText, slackCardWordsFound } from '@/test-utils/slack-card-words';

vi.mock('@/lib/agent-slack', async (original) => ({
  ...(await original<typeof import('@/lib/agent-slack')>()),
  requestSlackBot: vi.fn(),
  askSlackBotApproval: vi.fn(),
  cancelSlackBotRequest: vi.fn(),
  continueSlackBot: vi.fn(),
  cancelSlackBot: vi.fn(),
  disconnectSlackBot: vi.fn(),
  claimAgentSlackBot: vi.fn(),
  renameAgentSlackBot: vi.fn(),
  setAgentSlackBotPicture: vi.fn(),
  replaceAgentSlackBotToken: vi.fn(),
}));
vi.mock('@/lib/slack-avatar', () => ({ renderSlackAvatar: vi.fn(), drawPickedSlackAvatar: vi.fn() }));
vi.mock('@/lib/slack-admin', async (original) => ({
  ...(await original<typeof import('@/lib/slack-admin')>()),
  goToSlack: vi.fn(),
}));

const request = vi.mocked(requestSlackBot);
const continueIt = vi.mocked(continueSlackBot);
const cancel = vi.mocked(cancelSlackBot);
const ask = vi.mocked(askSlackBotApproval);
const cancelAsk = vi.mocked(cancelSlackBotRequest);
const disconnect = vi.mocked(disconnectSlackBot);
const claim = vi.mocked(claimAgentSlackBot);
const rename = vi.mocked(renameAgentSlackBot);
const setPicture = vi.mocked(setAgentSlackBotPicture);
const replaceToken = vi.mocked(replaceAgentSlackBotToken);
const draw = vi.mocked(drawPickedSlackAvatar);
const go = vi.mocked(goToSlack);
const avatar = vi.mocked(renderSlackAvatar);

const INSTALL_URL = 'https://slack.com/oauth/v2/authorize?client_id=1';
const NONE_NO_TOKEN: Bot = { state: 'none', configTokenStored: false };
const NONE_STORED: Bot = { state: 'none', configTokenStored: true };
const REQUESTED: Bot = { state: 'requested', botName: 'Quill Bot', requestedAt: beforeNoon(30 * 86_400_000) };
/** The bot's install id, as a manager's status carries it: the key its Disconnect takes. */
const BOT_ID = 'Hb7Kq2Lw8vNc5Xr1Bm7KdA';
const PENDING: Bot = { state: 'pending', botName: 'Quill Bot', approver: 'Ada Lovelace', canContinue: true, installId: BOT_ID };
const LIVE: Bot = {
  state: 'live',
  botName: 'Quill Bot',
  handle: 'quill_bot',
  approver: 'Ada Lovelace',
  needsClaim: false,
  approverGone: false,
  viewerIsApprover: false,
  installId: BOT_ID,
};
/** No cancel note, and nobody listening for one (the note's life across a re-read is `AgentSlack`'s, tested there). */
const QUIET = { leftOver: null, rebuilding: null, onCancelled: () => {}, onRebuilt: () => {}, onRequesting: () => {} };
/** The Live card's last line, for the bot called @quill_bot. */
const LIVE_HELP_LINE =
  'When @quill_bot needs an OK for something, it asks the person who mentioned it. For people outside the team, it asks the team admin who set @quill_bot up.';
/** The Not in Slack card's consent line, just above its help line: what adding it means for the manager. */
const ACCESS_LINE = 'When someone outside the team mentions it, it answers them with your access.';
/** The Not in Slack card's last line, for the agent called Quill. */
const HELP_LINE =
  'When Quill needs an OK for something, it asks the person who mentioned it. For people outside the team, it asks the team admin who set Quill up.';

function renderIt(bot: Bot, canManage = true, onChanged = vi.fn()) {
  render(
    <AgentSlackBot
      agentId="a1"
      agentName="Quill"
      bot={bot}
      canManage={canManage}
      {...QUIET}
      onChanged={onChanged}
    />,
  );
  return onChanged;
}

/** What the card says about the agent's memory (TASK-1203): by the agent's NAME, never the bot's @handle. */
const SHARED_LINE = 'What Quill hears is shared with anyone who talks to Quill, and Quill may bring it up elsewhere.';

const refusal = (status: number, code: string, reason: string | null = null) => new AgentSlackError(status, code, reason);

/** A call that answers only when the test says so: what the card shows while it is out. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The form opens on asking an admin when no token is stored: the install-it-myself path starts here. */
function chooseSelf() {
  fireEvent.click(screen.getByRole('button', { name: 'I can install Slack apps myself' }));
}

/** Fill the form the way a person does and press the button. */
function submit(botName?: string, token?: string) {
  if (botName !== undefined) fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: botName } });
  if (token !== undefined) fireEvent.change(screen.getByLabelText('Refresh token'), { target: { value: token } });
  fireEvent.click(screen.getByRole('button', { name: 'Add to Slack' }));
}

/** Open the ⋯ named "Actions for <name>". Radix opens it on a press, not a click. */
async function openMenu(name: string) {
  const trigger = await screen.findByRole('button', { name: `Actions for ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}

/** Pick an item from a ⋯. It runs once the menu has closed, so the caller awaits what it does. */
async function choose(menu: string, item: string) {
  fireEvent.click(within(await openMenu(menu)).getByRole('menuitem', { name: item }));
}

/** Each element comes after the one before it on the page. */
function expectInOrder(...els: Element[]) {
  for (let i = 1; i < els.length; i += 1) {
    expect(els[i - 1]!.compareDocumentPosition(els[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
}

beforeEach(() => {
  freezeClock();
  avatar.mockResolvedValue('UE5HQVZBVEFS');
  request.mockResolvedValue({ installUrl: INSTALL_URL, iconSet: true });
  continueIt.mockResolvedValue({ installUrl: INSTALL_URL });
  cancel.mockResolvedValue({ appDeleted: true });
  ask.mockResolvedValue(undefined);
  cancelAsk.mockResolvedValue(undefined);
  disconnect.mockResolvedValue({ appDeleted: true });
  claim.mockResolvedValue(undefined);
  replaceToken.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  thawClock();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('none', () => {
  it('a manager with no stored token: the card says Quill is not in Slack yet, the name is prefilled, and Add to Slack asks an admin', () => {
    renderIt(NONE_NO_TOKEN);
    const title = screen.getByRole('heading', { level: 3, name: "Quill isn't in Slack yet" });
    expect(screen.getByText('Add it to Slack, and people can mention it in channels.')).toBeInTheDocument();
    const name = screen.getByLabelText('Bot name');
    expect(name).toHaveValue('Quill');
    const add = screen.getByRole('button', { name: 'Add to Slack' });
    expect(add).toBeEnabled();
    expectInOrder(
      title,
      name,
      add,
      screen.getByText("We'll ask an admin to approve it."),
      screen.getByRole('button', { name: 'I can install Slack apps myself' }),
      screen.getByText(ACCESS_LINE),
      screen.getByText(HELP_LINE),
    );
    expect(screen.queryByLabelText('Refresh token')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('link', { name: "Slack's app settings" })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it("the manager's form says it before the bot exists, by the agent's name, first among its notes (TASK-1203)", () => {
    renderIt(NONE_NO_TOKEN);
    const memory = screen.getByText(SHARED_LINE);
    expectInOrder(
      screen.getByRole('button', { name: 'I can install Slack apps myself' }),
      memory,
      screen.getByText(ACCESS_LINE),
      screen.getByText(HELP_LINE),
    );
    expect(memory).toHaveClass('text-sm', 'text-muted-foreground');
    expect(slackCardWordsFound(slackCardText())).toEqual([]);
  });

  it('the channels lead carries no memory clause and no private-channel note (TASK-1203)', () => {
    render(
      <AgentSlackBot
        agentId="a1"
        agentName="Quill"
        bot={LIVE}
        canManage
        channels={[{ channelId: 'C1', name: 'help' }]}
        {...QUIET}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText('@quill_bot has answered in these channels.')).toBeInTheDocument();
    expect(screen.queryByText("Private channels aren't remembered.")).toBeNull();
    expect(screen.queryByText(/never in private ones/)).toBeNull();
  });

  it('"I can install Slack apps myself" shows the steps and the required token field, and "Ask an admin instead" goes back', () => {
    renderIt(NONE_NO_TOKEN);
    chooseSelf();
    expect(screen.getByRole('link', { name: "Slack's app settings" })).toHaveAttribute('href', 'https://api.slack.com/apps');
    expect(
      screen.getByText(/Paste the refresh token below\. We keep it for every Slack app you set up here, so you only do this once\./),
    ).toBeInTheDocument();
    const token = screen.getByLabelText('Refresh token');
    expect(token).toBeRequired();
    expect(token).toHaveAttribute('type', 'password');
    expect(screen.getByText('Starts with xoxe-')).toBeInTheDocument();
    expect(screen.getByLabelText('Bot name')).toHaveValue('Quill');
    expect(screen.getByRole('button', { name: 'Add to Slack' })).toBeEnabled();
    expect(screen.queryByText("We'll use the configuration token you gave us before.")).toBeNull();
    expect(screen.queryByText("We'll ask an admin to approve it.")).toBeNull();
    // The name first, then the steps and the field they lead to, then the button and the way back.
    expectInOrder(
      screen.getByLabelText('Bot name'),
      screen.getByRole('list'),
      token,
      screen.getByRole('button', { name: 'Add to Slack' }),
      screen.getByRole('button', { name: 'Ask an admin instead' }),
      screen.getByText(ACCESS_LINE),
      screen.getByText(HELP_LINE),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ask an admin instead' }));
    expect(screen.queryByLabelText('Refresh token')).toBeNull();
    expect(screen.queryByRole('link', { name: "Slack's app settings" })).toBeNull();
    expect(screen.getByText("We'll ask an admin to approve it.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I can install Slack apps myself' })).toBeInTheDocument();
  });

  it('switching ways keeps focus on the link, so a keyboard user stays where they were', () => {
    renderIt(NONE_NO_TOKEN);
    const link = screen.getByRole('button', { name: 'I can install Slack apps myself' });
    link.focus();
    fireEvent.click(link);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ask an admin instead' }));
    fireEvent.click(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'I can install Slack apps myself' }));
  });

  it('with a stored token there is no field and no steps, only the line saying it will be used, and "Ask an admin instead"', () => {
    renderIt(NONE_STORED);
    expect(screen.queryByLabelText('Refresh token')).toBeNull();
    expect(screen.queryByRole('link', { name: "Slack's app settings" })).toBeNull();
    expect(screen.getByText("We'll use the configuration token you gave us before.")).toBeInTheDocument();
    expect(screen.getByLabelText('Bot name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask an admin instead' })).toBeInTheDocument();
  });

  it('opens on asking an admin when no token is stored, and on the install-it-myself path when one is', () => {
    const { unmount } = render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={NONE_NO_TOKEN} canManage {...QUIET} onChanged={vi.fn()} />,
    );
    expect(screen.getByText("We'll ask an admin to approve it.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I can install Slack apps myself' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask an admin instead' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    unmount();
    renderIt(NONE_STORED);
    expect(screen.getByRole('button', { name: 'Ask an admin instead' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'I can install Slack apps myself' })).toBeNull();
    expect(screen.queryByText("We'll ask an admin to approve it.")).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('Add to Slack, by default, asks an admin and sends only the name', async () => {
    const onChanged = renderIt(NONE_NO_TOKEN);
    expect(screen.queryByLabelText('Refresh token')).toBeNull();
    expect(screen.queryByRole('link', { name: "Slack's app settings" })).toBeNull();
    fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: 'Quill Bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Slack' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith('a1', { botName: 'Quill Bot' });
    expect(Object.keys(ask.mock.calls[0]?.[1] ?? {})).toEqual(['botName']);
    expect(request).not.toHaveBeenCalled();
    expect(avatar).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });

  it('while an ask is out the button stays labelled and busy, and the link cannot be pressed', async () => {
    const out = deferred<void>();
    ask.mockReturnValueOnce(out.promise);
    const onChanged = renderIt(NONE_NO_TOKEN);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Slack' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to Slack' })).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByRole('button', { name: 'I can install Slack apps myself' })).toBeDisabled();
    out.resolve();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('a person with a stored token can still ask an admin instead, and nothing is sent but the name', async () => {
    const onChanged = renderIt(NONE_STORED);
    fireEvent.click(screen.getByRole('button', { name: 'Ask an admin instead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Slack' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith('a1', { botName: 'Quill' });
    expect(request).not.toHaveBeenCalled();
  });

  it('only the install-it-myself path says Slack has the final say', () => {
    renderIt(NONE_NO_TOKEN);
    const line = 'Slack has the final say: only someone allowed to install apps in your Slack workspace can add it.';
    expect(screen.queryByText(line)).toBeNull();
    chooseSelf();
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it('the link shows the steps, and the button still reads Add to Slack', () => {
    renderIt(NONE_NO_TOKEN);
    expect(screen.getByRole('button', { name: 'Add to Slack' })).toBeInTheDocument();
    chooseSelf();
    expect(screen.getByRole('list')).toHaveTextContent('Generate Token');
    expect(screen.getByLabelText('Refresh token')).toBeRequired();
    expect(screen.getAllByRole('button', { name: 'Add to Slack' })).toHaveLength(1);
  });

  it('a refused ask shows its line under the name field', async () => {
    ask.mockRejectedValueOnce(refusal(409, 'bot-name-taken'));
    renderIt(NONE_NO_TOKEN);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Slack' }));
    expect(await screen.findByText('Another Slack bot here already uses that name. Pick another.')).toBeInTheDocument();
    expect(screen.getByLabelText('Bot name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Add to Slack' })).toBeEnabled();
  });

  it('a stale ask re-reads the status and says nothing', async () => {
    ask.mockRejectedValueOnce(refusal(409, 'bot-requested'));
    const onChanged = renderIt(NONE_NO_TOKEN);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Slack' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a member sees that Quill is not in Slack yet, and that a team admin can add it', () => {
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={NONE_NO_TOKEN} canManage={false} {...QUIET} onChanged={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { level: 3, name: "Quill isn't in Slack yet" })).toBeInTheDocument();
    expect(screen.getByText('A team admin can add it.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Bot name')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    // The help line is for the person adding it.
    expect(screen.queryByText(HELP_LINE)).toBeNull();
  });

  it('the pasted token never reaches the page', async () => {
    const TOKEN = fakeConfigRefreshToken();
    const field = () => screen.getByLabelText('Refresh token') as HTMLInputElement;

    // Sent: the field is uncontrolled, so the paste is never a value attribute, and it is cleared as the request goes out.
    const sent = render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={NONE_NO_TOKEN} canManage {...QUIET} onChanged={vi.fn()} />,
    );
    chooseSelf();
    fireEvent.change(field(), { target: { value: TOKEN } });
    expect(field()).not.toHaveAttribute('value');
    expect(document.body.innerHTML).not.toContain(TOKEN);
    submit('Quill Bot');
    await waitFor(() => expect(go).toHaveBeenCalledWith(INSTALL_URL));
    expect(request).toHaveBeenCalledWith('a1', expect.objectContaining({ refreshToken: TOKEN }));
    expect(field().value).toBe('');
    expect(field()).not.toHaveAttribute('value');
    expect(document.body.innerHTML).not.toContain(TOKEN);
    sent.unmount();

    // Refused: the line shows, and neither it nor the field holds the paste.
    request.mockRejectedValueOnce(refusal(502, 'slack-refresh-token'));
    const refused = render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={NONE_NO_TOKEN} canManage {...QUIET} onChanged={vi.fn()} />,
    );
    chooseSelf();
    submit('Quill Bot', TOKEN);
    expect(
      await screen.findByText("Slack didn't accept the refresh token. Generate a new token and try again."),
    ).toBeInTheDocument();
    expect(field().value).toBe('');
    expect(field()).not.toHaveAttribute('value');
    expect(document.body.innerHTML).not.toContain(TOKEN);
    refused.unmount();

    // Pasted, then an admin asked after all: the field goes with its path, and only the name is sent.
    request.mockClear();
    const onChanged = renderIt(NONE_NO_TOKEN);
    chooseSelf();
    fireEvent.change(field(), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask an admin instead' }));
    expect(screen.queryByLabelText('Refresh token')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Slack' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith('a1', { botName: 'Quill' });
    expect(Object.keys(ask.mock.calls[0]?.[1] ?? {})).toEqual(['botName']);
    expect(request).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('with a stored token the request carries no refreshToken, and Slack is next', async () => {
    renderIt(NONE_STORED);
    submit('Quill Bot');
    await waitFor(() => expect(go).toHaveBeenCalledWith(INSTALL_URL));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('a1', { botName: 'Quill Bot', iconPng: 'UE5HQVZBVEFS' });
    expect(Object.keys(request.mock.calls[0]?.[1] ?? {})).not.toContain('refreshToken');
  });

  it('without one the paste is trimmed, sent as refreshToken, and cleared as the request goes out', async () => {
    renderIt(NONE_NO_TOKEN);
    chooseSelf();
    submit('Quill Bot', `  ${fakeConfigRefreshToken()}  `);
    const field = screen.getByLabelText('Refresh token') as HTMLInputElement;
    expect(field.value).toBe('');
    await waitFor(() => expect(go).toHaveBeenCalledWith(INSTALL_URL));
    expect(request).toHaveBeenCalledWith('a1', {
      botName: 'Quill Bot',
      refreshToken: fakeConfigRefreshToken(),
      iconPng: 'UE5HQVZBVEFS',
    });
  });

  it('no picture means no iconPng key at all', async () => {
    avatar.mockResolvedValue(null);
    renderIt(NONE_STORED);
    submit();
    await waitFor(() => expect(go).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith('a1', { botName: 'Quill' });
    expect(Object.keys(request.mock.calls[0]?.[1] ?? {})).toEqual(['botName']);
  });

  it('while it is going to Slack the button stays labelled and busy, and a second press sends nothing', async () => {
    renderIt(NONE_STORED);
    submit();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to Slack' })).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByRole('button', { name: 'Ask an admin instead' })).toBeDisabled();
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    fireEvent.submit(screen.getByLabelText('Bot name').closest('form') as HTMLFormElement);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a refused token that Slack no longer honours reveals the field with its line, and the next submit sends the paste', async () => {
    request.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    renderIt(NONE_STORED);
    submit('Quill Bot');
    const line =
      "The configuration token we kept for you stopped working. Generate a new one on Slack's app settings and paste it below.";
    expect(await screen.findByText(line)).toBeInTheDocument();
    const token = screen.getByLabelText('Refresh token');
    expect(token).toBeRequired();
    expect(token).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('link', { name: "Slack's app settings" })).toBeInTheDocument();
    expect(screen.queryByText("We'll use the configuration token you gave us before.")).toBeNull();
    expect(go).not.toHaveBeenCalled();

    fireEvent.change(token, { target: { value: fakeConfigRefreshToken('NEWPASTE') } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Slack' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith(INSTALL_URL));
    expect(request).toHaveBeenLastCalledWith('a1', {
      botName: 'Quill Bot',
      refreshToken: fakeConfigRefreshToken('NEWPASTE'),
      iconPng: 'UE5HQVZBVEFS',
    });
  });

  it.each([
    ['config-token-needed', 409, 'Paste a configuration token to continue.'],
    ['slack-token', 502, "Slack didn't accept the configuration token. Generate a new one and paste it below."],
  ])('%s reveals the token field and shows its own line under it', async (code, status, line) => {
    request.mockRejectedValueOnce(refusal(status, code));
    renderIt(NONE_STORED);
    submit();
    expect(await screen.findByText(line)).toBeInTheDocument();
    expect(screen.getByLabelText('Refresh token')).toBeInTheDocument();
  });

  it.each([
    ['bot-name-taken', 409, null, 'Another Slack bot here already uses that name. Pick another.'],
    ['invalid-bot-name', 400, 'too-long', 'Keep the name to 35 characters or fewer.'],
    ['invalid-bot-name', 400, 'reserved', 'Slack keeps that name for itself. Pick another.'],
    ['slack-name', 502, null, "Slack didn't accept that bot name. Try another."],
  ])('%s (%s) shows its line under the name field, and the token field stays as it was', async (code, status, reason, line) => {
    request.mockRejectedValueOnce(refusal(status, code, reason));
    renderIt(NONE_STORED);
    submit('Quill Bot');
    const message = await screen.findByText(line);
    expect(message).toBeInTheDocument();
    expect(screen.getByLabelText('Bot name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Bot name')).toHaveAttribute('aria-describedby', message.id);
    expect(screen.queryByLabelText('Refresh token')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add to Slack' })).toBeEnabled();
  });

  it('switching ways drops the old way\'s error: a form-level line, and a field line under the name', async () => {
    request.mockRejectedValueOnce(refusal(502, 'slack-unconfirmed'));
    renderIt(NONE_STORED);
    submit();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ask an admin instead' }));
    expect(screen.queryByRole('alert')).toBeNull();

    request.mockRejectedValueOnce(refusal(409, 'bot-name-taken'));
    fireEvent.click(screen.getByRole('button', { name: 'I can install Slack apps myself' }));
    submit('Quill Bot');
    expect(await screen.findByText('Another Slack bot here already uses that name. Pick another.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ask an admin instead' }));
    expect(screen.queryByText('Another Slack bot here already uses that name. Pick another.')).toBeNull();
    expect(screen.getByLabelText('Bot name')).not.toHaveAttribute('aria-invalid');
  });

  it.each([
    ['invalid-refresh-token', 400, "That doesn't look like a refresh token. It starts with xoxe-."],
    ['slack-refresh-token', 502, "Slack didn't accept the refresh token. Generate a new token and try again."],
  ])('%s shows its line under the token field', async (code, status, line) => {
    request.mockRejectedValueOnce(refusal(status, code));
    renderIt(NONE_NO_TOKEN);
    chooseSelf();
    submit('Quill Bot', fakeConfigRefreshToken());
    expect(await screen.findByText(line)).toBeInTheDocument();
    expect(screen.getByLabelText('Refresh token')).toHaveAttribute('aria-invalid', 'true');
    expect((screen.getByLabelText('Refresh token') as HTMLInputElement).value).toBe('');
  });

  it.each([
    ['no-workspace', 409, "Slack isn't connected yet. An admin connects it first."],
    ['public-origin-not-https', 409, "Our public address isn't https right now, so we can't update the Slack app. Whoever runs this server can fix that."],
    ['slack-error', 502, 'Something went wrong talking to Slack. Try again in a minute.'],
  ])('%s is a sentence above the button, never the code', async (code, status, line) => {
    request.mockRejectedValueOnce(refusal(status, code));
    renderIt(NONE_STORED);
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(line);
    expect(alert.textContent).not.toContain(code);
    expectInOrder(alert, screen.getByRole('button', { name: 'Add to Slack' }));
  });

  it.each([
    [409, 'bot-exists'],
    [409, 'not-pending'],
    [403, 'forbidden'],
    [404, 'not-found'],
  ])('a %s %s means what we drew is out of date: read it again, say nothing', async (status, code) => {
    request.mockRejectedValueOnce(refusal(status, code));
    const onChanged = renderIt(NONE_STORED);
    submit();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refusal never leaves the page stuck: the button is pressable again', async () => {
    request.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderIt(NONE_STORED);
    submit();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to Slack' })).toBeEnabled();
  });
});

describe('pending', () => {
  it('the person who started it sees where it stands, Continue in Slack, and Cancel request in the ⋯', async () => {
    renderIt(PENDING);
    expect(screen.getByRole('heading', { level: 3, name: 'Almost there: finish adding Quill Bot in Slack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue in Slack' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull();
    const menu = await openMenu('Quill Bot');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Cancel request']);
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('another manager sees who is finishing it, and can only cancel', async () => {
    renderIt({ ...PENDING, canContinue: false });
    expect(
      screen.getByRole('heading', { level: 3, name: 'Waiting for Ada Lovelace to finish adding Quill Bot in Slack' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue in Slack' })).toBeNull();
    const menu = await openMenu('Quill Bot');
    expect(within(menu).getByRole('menuitem', { name: 'Cancel request' })).toBeInTheDocument();
  });

  it('a member sees the card saying Quill is not in Slack yet, never the request', () => {
    render(<AgentSlackBot agentId="a1" agentName="Quill" bot={PENDING} canManage={false} {...QUIET} onChanged={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 3, name: "Quill isn't in Slack yet" })).toBeInTheDocument();
    expect(screen.getByText('A team admin can add it.')).toBeInTheDocument();
    expect(screen.queryByText(/Quill Bot|Ada Lovelace/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Continue asks for a fresh link and goes to Slack', async () => {
    renderIt(PENDING);
    fireEvent.click(screen.getByRole('button', { name: 'Continue in Slack' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith(INSTALL_URL));
    expect(continueIt).toHaveBeenCalledWith('a1');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('Cancel request takes the request back and then reads the status again', async () => {
    const onChanged = renderIt(PENDING);
    await choose('Quill Bot', 'Cancel request');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(cancel).toHaveBeenCalledWith('a1', BOT_ID);
    expect(go).not.toHaveBeenCalled();
  });

  it("Cancel posts the pending bot's id, and with no id (an older host) there is no ⋯ at all", () => {
    renderIt({ ...PENDING, installId: null });
    expect(screen.queryByRole('button', { name: 'Actions for Quill Bot' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue in Slack' })).toBeInTheDocument();
  });

  it('while the cancel is out, the ⋯ and Continue are disabled and the card says Cancelling…', async () => {
    const out = deferred<{ appDeleted: boolean }>();
    cancel.mockReturnValueOnce(out.promise);
    const onChanged = renderIt(PENDING);
    await choose('Quill Bot', 'Cancel request');
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Cancelling…');
    // The spinner is decoration: its own status role stays out of the way.
    expect(within(status).queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Actions for Quill Bot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue in Slack' })).toBeDisabled();
    expect(onChanged).not.toHaveBeenCalled();
    out.resolve({ appDeleted: true });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('not-approver says so in a sentence and leaves Continue and the ⋯ pressable', async () => {
    continueIt.mockRejectedValueOnce(refusal(403, 'not-approver'));
    const onChanged = renderIt(PENDING);
    fireEvent.click(screen.getByRole('button', { name: 'Continue in Slack' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the person who set this up can continue it in Slack.');
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue in Slack' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Actions for Quill Bot' })).toBeEnabled();
  });

  it('not-pending (someone got there first) reads the status again', async () => {
    cancel.mockRejectedValueOnce(refusal(409, 'not-pending'));
    const onChanged = renderIt(PENDING);
    await choose('Quill Bot', 'Cancel request');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  // The note's life across the status re-read (the section unmounts while it loads) is tested in AgentSlack.test.tsx.
  it.each([
    [true, true],
    [false, true],
    [false, false],
  ])(
    'a cancel hands what it said (appDeleted %s) and who made the app (the viewer: %s) up before reading the status again',
    async (appDeleted, canContinue) => {
      cancel.mockResolvedValueOnce({ appDeleted });
      const order: string[] = [];
      const onCancelled = vi.fn(() => order.push('cancelled'));
      const onChanged = vi.fn(() => order.push('changed'));
      render(
        <AgentSlackBot
          agentId="a1"
          agentName="Quill"
          bot={{ ...PENDING, canContinue }}
          canManage
          {...QUIET}
          onCancelled={onCancelled}
          onChanged={onChanged}
        />,
      );
      await choose('Quill Bot', 'Cancel request');
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(onCancelled).toHaveBeenCalledWith({
        how: 'cancelled',
        appDeleted,
        approverIsViewer: canContinue,
        approver: 'Ada Lovelace',
      });
      expect(order).toEqual(['cancelled', 'changed']);
    },
  );

  it('a failed cancel hands nothing up', async () => {
    cancel.mockRejectedValueOnce(refusal(500, 'internal'));
    const onCancelled = vi.fn();
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={PENDING} canManage {...QUIET} onCancelled={onCancelled} onChanged={vi.fn()} />,
    );
    await choose('Quill Bot', 'Cancel request');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("the form shows a left-over app's note above it, and asking for a new bot says so first", async () => {
    const onRequesting = vi.fn();
    render(
      <AgentSlackBot
        agentId="a1"
        agentName="Quill"
        bot={NONE_STORED}
        canManage
        {...QUIET}
        leftOver={{ how: 'cancelled', appDeleted: false, approverIsViewer: true, approver: 'Ada Lovelace' }}
        onRequesting={onRequesting}
        onChanged={vi.fn()}
      />,
    );
    const note = screen.getByText(/couldn.t confirm its Slack app was deleted/);
    expect(note).toHaveTextContent(
      "We cancelled the request, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete. Or delete it yourself: open it in Slack's app settings and click Delete App at the bottom of the page.",
    );
    expect(screen.getByRole('link', { name: "Slack's app settings" })).toHaveAttribute('href', 'https://api.slack.com/apps');
    expect(note.textContent).not.toMatch(/\bAX\b/);
    submit();
    await waitFor(() => expect(go).toHaveBeenCalledWith(INSTALL_URL));
    expect(onRequesting).toHaveBeenCalledTimes(1);
  });

  it("only the person who made the app is told to delete it themselves; anyone else is told who can", () => {
    render(
      <AgentSlackBot
        agentId="a1"
        agentName="Quill"
        bot={NONE_STORED}
        canManage
        {...QUIET}
        leftOver={{ how: 'cancelled', appDeleted: false, approverIsViewer: false, approver: 'Ada Lovelace' }}
        onChanged={vi.fn()}
      />,
    );
    const note = screen.getByText(/couldn.t confirm its Slack app was deleted/);
    expect(note).toHaveTextContent(
      "We cancelled the request, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete. Ada Lovelace set it up and can also delete it in Slack's app settings.",
    );
    expect(note).not.toHaveTextContent(/yourself/);
    // Slack's app page lists only your own apps: a link there would show this viewer nothing.
    expect(screen.queryByRole('link', { name: "Slack's app settings" })).toBeNull();
  });

  it('a cancel that failed says so, stops saying Cancelling…, and nothing is re-read', async () => {
    cancel.mockRejectedValueOnce(refusal(500, 'internal'));
    const onChanged = renderIt(PENDING);
    await choose('Quill Bot', 'Cancel request');
    // Our own failure, not Slack's: the plain line, which doesn't blame Slack.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong. Try again in a minute.');
    expect(alert).not.toHaveTextContent(/Slack/);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Actions for Quill Bot' })).toBeEnabled();
  });
});

describe('requested', () => {
  it('a manager sees the waiting line, when it was asked, and Cancel request in the ⋯', async () => {
    renderIt(REQUESTED);
    expect(screen.getByRole('heading', { level: 3, name: 'Waiting for an admin to approve Quill Bot' })).toBeInTheDocument();
    // 30 days before the frozen "now" (Nov 26): a plain date.
    expect(screen.getByText(`Asked Oct 27. Once an admin approves it, Quill Bot is ready to invite to channels.`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue in Slack' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull();
    const menu = await openMenu('Quill Bot');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Cancel request']);
  });

  it('a date we cannot read shows as it came', () => {
    renderIt({ ...REQUESTED, requestedAt: 'last week' });
    expect(screen.getByText('Asked last week. Once an admin approves it, Quill Bot is ready to invite to channels.')).toBeInTheDocument();
  });

  it('anyone else sees the card saying Quill is not in Slack yet, never the request', () => {
    render(<AgentSlackBot agentId="a1" agentName="Quill" bot={REQUESTED} canManage={false} {...QUIET} onChanged={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 3, name: "Quill isn't in Slack yet" })).toBeInTheDocument();
    expect(screen.getByText('A team admin can add it.')).toBeInTheDocument();
    expect(screen.queryByText(/Waiting|Asked /)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Cancel request cancels, saying so while it is out, then re-reads', async () => {
    const onChanged = renderIt(REQUESTED);
    await choose('Quill Bot', 'Cancel request');
    expect(await screen.findByRole('status')).toHaveTextContent('Cancelling…');
    expect(screen.getByRole('button', { name: 'Actions for Quill Bot' })).toBeDisabled();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(cancelAsk).toHaveBeenCalledWith('a1');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a cancel leaves no left-over note: no Slack app exists', async () => {
    const onCancelled = vi.fn();
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={REQUESTED} canManage {...QUIET} onCancelled={onCancelled} onChanged={vi.fn()} />,
    );
    await choose('Quill Bot', 'Cancel request');
    await waitFor(() => expect(cancelAsk).toHaveBeenCalled());
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it('a stale cancel re-reads', async () => {
    cancelAsk.mockRejectedValueOnce(refusal(409, 'not-requested'));
    const onChanged = renderIt(REQUESTED);
    await choose('Quill Bot', 'Cancel request');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed cancel says so, re-reads nothing, and can be tried again', async () => {
    cancelAsk.mockRejectedValueOnce(refusal(500, 'internal'));
    const onChanged = renderIt(REQUESTED);
    await choose('Quill Bot', 'Cancel request');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again in a minute.');
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Actions for Quill Bot' })).toBeEnabled();
    await choose('Quill Bot', 'Cancel request');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(cancelAsk).toHaveBeenCalledTimes(2);
  });
});

/** The Live card's own pieces, as the card is drawn for `canManage` (a member: no install id, as the server answers). */
const MEMBER_LIVE: Bot = { ...LIVE, installId: null };
const MINE: Bot = { ...LIVE, viewerIsApprover: true };
const TOKEN = fakeConfigRefreshToken('CARDREPLACESECRET');
const HANDLE_LINE = 'In any Slack channel, type /invite @quill_bot';
const CHANNELS = [
  { channelId: 'C1', name: 'help' },
  { channelId: 'C2', name: 'random' },
];

describe('live', () => {
  it('a manager sees @quill_bot is in Slack, how to invite it, the help line, and a ⋯ with Rename, Change picture and Remove from Slack', async () => {
    renderIt(LIVE);
    const title = screen.getByRole('heading', { name: '@quill_bot is in Slack' });
    expect(title).toBeInTheDocument();
    const card = screen.getByRole('region', { name: '@quill_bot is in Slack' });
    expect(card.querySelector('code')!.parentElement).toHaveTextContent(HANDLE_LINE);
    expect(card.querySelector('code')).toHaveTextContent('/invite @quill_bot');
    expect(within(card as HTMLElement).getByText(LIVE_HELP_LINE)).toBeInTheDocument();
    // Nobody reads who set it up.
    expect(screen.queryByText(/Set up by|You set it up/)).toBeNull();
    const menu = await openMenu('@quill_bot');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Rename',
      'Change picture',
      'Remove from Slack',
    ]);
  });

  it("a manager's Rename opens on the bot's name, even when the handle doesn't match it, and the title uses the handle", async () => {
    renderIt({ ...LIVE, handle: 'support_helper' } as Bot);
    expect(screen.getByRole('heading', { name: '@support_helper is in Slack' })).toBeInTheDocument();
    await choose('@support_helper', 'Rename');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Bot name')).toHaveValue('Quill Bot');
  });

  it('a member sees the card and the help line, and no ⋯', () => {
    renderIt(MEMBER_LIVE, false);
    expect(screen.getByRole('heading', { name: '@quill_bot is in Slack' })).toBeInTheDocument();
    expect(screen.getByText(LIVE_HELP_LINE)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Set up by|You set it up/)).toBeNull();
  });

  it('the Live card says what Quill hears is shared with anyone who talks to it, by the agent\'s name, beside the help line (TASK-1203)', () => {
    renderIt(LIVE, true);
    const memory = screen.getByText(SHARED_LINE);
    const help = screen.getByText(LIVE_HELP_LINE);
    expectInOrder(memory, help);
    expect(memory).toHaveClass('text-[12.5px]', 'text-muted-foreground');
    // Never the bot's @handle.
    expect(screen.queryByText(/What @quill_bot hears/)).toBeNull();
    expect(slackCardWordsFound(slackCardText())).toEqual([]);
  });

  it('the Live card says it to a member too (TASK-1203)', () => {
    renderIt(MEMBER_LIVE, false);
    expect(screen.getByText(SHARED_LINE)).toBeInTheDocument();
  });

  it('with no handle the title and the line name the bot', () => {
    renderIt({ ...LIVE, handle: null } as Bot);
    expect(screen.getByRole('heading', { name: 'Quill Bot is in Slack' })).toBeInTheDocument();
    expect(screen.getByText('In any Slack channel, type /invite and pick it.')).toBeInTheDocument();
    expect(screen.getByText(/When Quill Bot needs an OK/)).toBeInTheDocument();
  });

  it('with no install id to name (an older server) a manager has no Remove from Slack', async () => {
    renderIt(MEMBER_LIVE, true);
    const menu = await openMenu('@quill_bot');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Rename', 'Change picture']);
  });

  it('channels sit inside the card, under the invite line, and above the help line', () => {
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={LIVE} canManage channels={CHANNELS} {...QUIET} onChanged={vi.fn()} />,
    );
    const title = screen.getByRole('heading', { name: '@quill_bot is in Slack' });
    const card = screen.getByRole('region', { name: '@quill_bot is in Slack' });
    const invite = card.querySelector('code')!;
    const list = within(card).getByRole('list', { name: 'Channels @quill_bot has answered in' });
    const help = within(card).getByText(LIVE_HELP_LINE);
    expectInOrder(title, invite, list, help);
    expect(within(card).getByText('help')).toBeInTheDocument();
  });

  it('the card menu never locks the page', async () => {
    renderIt(LIVE);
    const menu = await openMenu('@quill_bot');
    expect(document.body.style.pointerEvents).not.toBe('none');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('Cancel in a dialog opened from the menu puts focus back on the ⋯', async () => {
    renderIt(LIVE);
    const trigger = screen.getByRole('button', { name: 'Actions for @quill_bot' });
    await choose('@quill_bot', 'Remove from Slack');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('Remove from Slack asks first: the bot leaves every channel, @handle stops working, its Slack app is deleted; Cancel sends nothing', async () => {
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={LIVE} canManage sharedConnected {...QUIET} onChanged={vi.fn()} />,
    );
    await choose('@quill_bot', 'Remove from Slack');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Remove @quill_bot from Slack?' })).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Quill Bot leaves every Slack channel it's in, and @quill_bot stops working. We'll delete its Slack app.",
      ),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/\bAX\b/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('with no handle the dialog names the bot and says mentioning it stops working', async () => {
    renderIt({ ...LIVE, handle: null } as Bot);
    await choose('Quill Bot', 'Remove from Slack');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Remove Quill Bot from Slack?' })).toBeInTheDocument();
    expect(
      within(dialog).getByText("Quill Bot leaves every Slack channel it's in, and mentioning it stops working. We'll delete its Slack app."),
    ).toBeInTheDocument();
  });

  it("confirming removes the bot the dialog showed, by its install id, hands up { how: 'disconnected', appDeleted, approverIsViewer: false, approver } and reads the status again", async () => {
    disconnect.mockResolvedValueOnce({ appDeleted: false });
    const order: string[] = [];
    const onCancelled = vi.fn(() => order.push('cancelled'));
    const onChanged = vi.fn(() => order.push('changed'));
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={LIVE} canManage {...QUIET} onCancelled={onCancelled} onChanged={onChanged} />,
    );
    await choose('@quill_bot', 'Remove from Slack');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith('a1', BOT_ID);
    expect(onCancelled).toHaveBeenCalledWith({
      how: 'disconnected',
      appDeleted: false,
      approverIsViewer: false,
      approver: 'Ada Lovelace',
      approverGone: false,
    });
    expect(order).toEqual(['cancelled', 'changed']);
  });

  it('no-bot (someone got there first) closes the dialog and reads the status again; a failure says so in the dialog and keeps the bot', async () => {
    disconnect.mockRejectedValueOnce(refusal(409, 'no-bot'));
    const onChanged = renderIt(LIVE);
    await choose('@quill_bot', 'Remove from Slack');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.style.pointerEvents).not.toBe('none');

    disconnect.mockRejectedValueOnce(refusal(500, 'internal'));
    await choose('@quill_bot', 'Remove from Slack');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Something went wrong. Try again in a minute.');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeEnabled();
  });

  it('a picture that lands says Slack has the new picture, with nothing read again, and opening any dialog clears it', async () => {
    setPicture.mockResolvedValueOnce(undefined);
    draw.mockResolvedValueOnce('UE5H');
    const onChanged = renderIt(LIVE);
    await choose('@quill_bot', 'Change picture');
    const dialog = await screen.findByRole('dialog');
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    fireEvent.change(within(dialog).getByLabelText('Image file'), { target: { files: [file] } });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save picture' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save picture' }));
    expect(await screen.findByText('Slack has the new picture.')).toBeInTheDocument();
    expect(setPicture).toHaveBeenCalledWith('a1', 'UE5H');
    expect(onChanged).not.toHaveBeenCalled();
    await choose('@quill_bot', 'Rename');
    await screen.findByRole('dialog');
    expect(screen.queryByText('Slack has the new picture.')).toBeNull();
  });

  it("a disconnect whose Slack app couldn't be deleted says so in its own words", () => {
    render(
      <AgentSlackBot
        agentId="a1"
        agentName="Quill"
        bot={NONE_STORED}
        canManage
        {...QUIET}
        leftOver={{ how: 'disconnected', appDeleted: false, approverIsViewer: false, approver: 'Ada Lovelace' }}
        onChanged={vi.fn()}
      />,
    );
    const note = screen.getByText(/couldn.t confirm its Slack app was deleted/);
    expect(note).toHaveTextContent(
      "We removed the bot from Slack, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete. Ada Lovelace set it up and can also delete it in Slack's app settings.",
    );
    expect(note).not.toHaveTextContent(/cancelled/);
  });
});

describe('live: problems, one action each', () => {
  const GONE: Bot = { ...LIVE, approverGone: true };
  const SET_UP_AGAIN = '@quill_bot needs to be set up again. The person who added it to Slack has left.';
  const OUTSIDERS =
    "People outside the team can't use @quill_bot right now, because the team admin who set it up isn't a team admin anymore.";

  it('nothing wrong: no problem row at all', () => {
    renderIt(LIVE);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('approver gone: a manager with Slack connected gets Set up again, one without Slack waits for it, a member is told a team admin can fix it', () => {
    const first = render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={GONE} canManage sharedConnected {...QUIET} onChanged={vi.fn()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(SET_UP_AGAIN);
    expect(screen.getByRole('status')).not.toHaveTextContent('once Slack is connected again');
    expect(within(screen.getByRole('status')).getByRole('button', { name: 'Set up again' })).toBeInTheDocument();
    first.unmount();
    const waiting = render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={GONE} canManage sharedConnected={false} {...QUIET} onChanged={vi.fn()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(`${SET_UP_AGAIN} You can do this here once Slack is connected again.`);
    expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull();
    waiting.unmount();
    for (const sharedConnected of [true, false]) {
      const member = render(
        <AgentSlackBot agentId="a1" agentName="Quill" bot={{ ...GONE, installId: null }} canManage={false} sharedConnected={sharedConnected} {...QUIET} onChanged={vi.fn()} />,
      );
      expect(screen.getByRole('status')).toHaveTextContent(`${SET_UP_AGAIN} A team admin can fix this.`);
      expect(within(screen.getByRole('status')).queryByRole('button')).toBeNull();
      member.unmount();
    }
  });

  it('approver gone shows alone: no Take over, no Reconnect', () => {
    renderIt({ ...LIVE, approverGone: true, needsClaim: true, viewerIsApprover: true } as Bot);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.queryByText(OUTSIDERS)).toBeNull();
  });

  it('Set up again asks first; confirming removes the shown id, then hands up the cancel, the bot it was, and a re-read', async () => {
    const order: string[] = [];
    const onCancelled = vi.fn(() => order.push('cancelled'));
    const onRebuilt = vi.fn(() => order.push('rebuilt'));
    const onChanged = vi.fn(() => order.push('changed'));
    render(
      <AgentSlackBot
        agentId="a1"
        agentName="Quill"
        bot={GONE}
        canManage
        sharedConnected
        {...QUIET}
        onCancelled={onCancelled}
        onRebuilt={onRebuilt}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set up again' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Set up @quill_bot again?' })).toBeInTheDocument();
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up again' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith('a1', BOT_ID);
    expect(onCancelled).toHaveBeenCalledWith({
      how: 'disconnected',
      appDeleted: true,
      approverIsViewer: false,
      approver: 'Ada Lovelace',
      approverGone: true,
    });
    expect(onRebuilt).toHaveBeenCalledWith({ botName: 'Quill Bot', handle: 'quill_bot' });
    expect(order).toEqual(['cancelled', 'rebuilt', 'changed']);
  });

  it('a stale Set up again closes the dialog and reads again; any other refusal is told in the dialog', async () => {
    disconnect.mockRejectedValueOnce(refusal(409, 'no-bot'));
    const onChanged = vi.fn();
    render(<AgentSlackBot agentId="a1" agentName="Quill" bot={GONE} canManage sharedConnected {...QUIET} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up again' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set up again' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    disconnect.mockRejectedValueOnce(refusal(500, 'internal'));
    fireEvent.click(screen.getByRole('button', { name: 'Set up again' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up again' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Something went wrong. Try again in a minute.');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('Take over: only a manager, only when it needs taking over, only with an install id', () => {
    const NEEDS: Bot = { ...LIVE, needsClaim: true };
    const cases: Array<[Bot, boolean, boolean]> = [
      [NEEDS, true, true],
      [NEEDS, false, false],
      [{ ...NEEDS, installId: null }, true, false],
      [LIVE, true, false],
    ];
    for (const [bot, canManage, shown] of cases) {
      const view = render(<AgentSlackBot agentId="a1" agentName="Quill" bot={bot} canManage={canManage} {...QUIET} onChanged={vi.fn()} />);
      expect(screen.queryByRole('button', { name: 'Take over' }) !== null).toBe(shown);
      view.unmount();
    }
  });

  it('needsClaim for a member: the sentence and "A team admin can fix this.", no button', () => {
    renderIt({ ...MEMBER_LIVE, needsClaim: true } as Bot, false);
    expect(screen.getByRole('status')).toHaveTextContent(`${OUTSIDERS} A team admin can fix this.`);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Take over asks first, posts the id the page showed, then reads the status again', async () => {
    const onChanged = renderIt({ ...LIVE, needsClaim: true });
    expect(screen.getByRole('status')).toHaveTextContent(OUTSIDERS);
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Take over @quill_bot?' })).toBeInTheDocument();
    expect(claim).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(claim).toHaveBeenCalledWith('a1', BOT_ID);
  });

  it('claim-not-needed closes the Take over dialog silently and reads again', async () => {
    claim.mockRejectedValueOnce(refusal(409, 'claim-not-needed'));
    const onChanged = renderIt({ ...LIVE, needsClaim: true });
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The one status left is the problem row itself: the dialog's was never shown.
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('the Remove dialog hands up the viewer as the approver, and whether the approver is gone', async () => {
    const onCancelled = vi.fn();
    const onChanged = vi.fn();
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={MINE} canManage {...QUIET} onCancelled={onCancelled} onChanged={onChanged} />,
    );
    await choose('@quill_bot', 'Remove from Slack');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onCancelled).toHaveBeenCalledWith({
      how: 'disconnected',
      appDeleted: true,
      approverIsViewer: true,
      approver: 'Ada Lovelace',
      approverGone: false,
    });
  });

  /** A rename the server refuses because the bot's Slack token stopped working; the dialog is closed after. */
  async function findDeadToken() {
    rename.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    await choose('@quill_bot', 'Rename');
    const dialog = await screen.findByRole('dialog');
    fireEvent.submit(within(dialog).getByLabelText('Bot name').closest('form')!);
    const told = await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    return told;
  }

  it('a dead token found by Rename: the person who set the bot up gets the row with Reconnect; a reconnect clears it and says the token was replaced', async () => {
    replaceToken.mockResolvedValueOnce(undefined);
    const onChanged = renderIt(MINE);
    // The status says nothing about the token: no row before a change finds it dead.
    expect(screen.queryByRole('status')).toBeNull();
    rename.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    await choose('@quill_bot', 'Rename');
    const renameDialog = await screen.findByRole('dialog');
    fireEvent.submit(within(renameDialog).getByLabelText('Bot name').closest('form')!);
    expect(await within(renameDialog).findByRole('alert')).toHaveTextContent(
      "Changes to @quill_bot can't reach Slack right now. Reconnect it, then try again.",
    );
    fireEvent.click(within(renameDialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = screen.getByRole('status');
    expect(row).toHaveTextContent("Changes to @quill_bot can't reach Slack right now.");
    expect(row).not.toHaveTextContent('Ask');
    fireEvent.click(within(row).getByRole('button', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace your Slack token' });
    fireEvent.change(within(dialog).getByLabelText('Refresh token'), { target: { value: TOKEN } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace token' }));
    expect(await screen.findByText(BOT_TOKEN_COPY.replaced('Quill Bot'))).toBeInTheDocument();
    expect(replaceToken).toHaveBeenCalledWith('a1', TOKEN);
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.queryByText("Changes to @quill_bot can't reach Slack right now.")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('a reconnect moves focus to the saved notice, not the page: the Reconnect button it came from is gone', async () => {
    replaceToken.mockResolvedValueOnce(undefined);
    renderIt(MINE);
    await findDeadToken();
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Reconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Replace your Slack token' });
    fireEvent.change(within(dialog).getByLabelText('Refresh token'), { target: { value: TOKEN } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace token' }));
    const text = await screen.findByText(BOT_TOKEN_COPY.replaced('Quill Bot'));
    // The confirmation is a status; the focusable frame around it takes focus.
    expect(text.closest('[role="status"]')).not.toBeNull();
    const frame = text.closest('[tabindex="-1"]');
    expect(frame).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(frame));
  });

  it('a dead token found by Change picture: another team admin is told whom to ask, with no button', async () => {
    setPicture.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    draw.mockResolvedValueOnce('UE5H');
    renderIt(LIVE);
    await choose('@quill_bot', 'Change picture');
    const dialog = await screen.findByRole('dialog');
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    fireEvent.change(within(dialog).getByLabelText('Image file'), { target: { files: [file] } });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save picture' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save picture' }));
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = screen.getByRole('status');
    expect(row).toHaveTextContent("Changes to @quill_bot can't reach Slack right now. Ask Ada Lovelace to reconnect it.");
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('a dead token with a token row and a Take over row: both show, the token row first', async () => {
    renderIt({ ...MINE, needsClaim: true } as Bot);
    await findDeadToken();
    const rows = screen.getAllByRole('status');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Changes to @quill_bot can't reach Slack right now.");
    expect(rows[1]).toHaveTextContent(OUTSIDERS);
  });

  it('approver gone shows alone even with a dead token found: one problem row, no token row, no Reconnect', async () => {
    renderIt({ ...LIVE, approverGone: true, viewerIsApprover: true } as Bot);
    await findDeadToken();
    const rows = screen.getAllByRole('status');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('needs to be set up again');
    expect(rows[0]).not.toHaveTextContent("can't reach Slack");
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  it('a member never sees a token row: there is no menu, so nothing can find the dead token', () => {
    renderIt(MEMBER_LIVE, false);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('none after a Rebuild (TASK-1173)', () => {
  const FROM = { botName: 'Quill Bot', handle: 'quill_bot' };
  const NOTICE =
    "@quill_bot was removed from Slack. Add it again below. It's a new bot in Slack, so invite it to each channel again.";

  it('offers the old name back, with the notice above the form', () => {
    render(<AgentSlackBot agentId="a1" agentName="Quill" bot={NONE_STORED} canManage {...QUIET} rebuilding={FROM} onChanged={vi.fn()} />);
    const notice = screen.getByText(NOTICE);
    expect(screen.getByLabelText('Bot name')).toHaveValue('Quill Bot');
    expect(notice.compareDocumentPosition(screen.getByLabelText('Bot name')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.textContent).not.toMatch(/\bAX\b/);
  });

  it('with no handle the notice names the bot', () => {
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={NONE_STORED} canManage {...QUIET} rebuilding={{ botName: 'Quill Bot', handle: null }} onChanged={vi.fn()} />,
    );
    expect(
      screen.getByText("Quill Bot was removed from Slack. Add it again below. It's a new bot in Slack, so invite it to each channel again."),
    ).toBeInTheDocument();
  });

  it('with nothing rebuilt there is no notice and the name is the agent', () => {
    render(<AgentSlackBot agentId="a1" agentName="Quill" bot={NONE_STORED} canManage {...QUIET} onChanged={vi.fn()} />);
    expect(screen.queryByText(/was removed from Slack/)).toBeNull();
    expect(screen.getByLabelText('Bot name')).toHaveValue('Quill');
  });

  it('the notice sits above the left-over note when Slack kept the old app', () => {
    render(
      <AgentSlackBot
        agentId="a1"
        agentName="Quill"
        bot={NONE_STORED}
        canManage
        {...QUIET}
        rebuilding={FROM}
        leftOver={{ how: 'disconnected', appDeleted: false, approverIsViewer: false, approver: 'Ada Lovelace' }}
        onChanged={vi.fn()}
      />,
    );
    const notice = screen.getByText(NOTICE);
    const note = screen.getByText(/couldn.t confirm its Slack app was deleted/);
    expect(notice.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a left-over note about a bot whose approver left doesn't send anyone to the person who left", () => {
    render(
      <AgentSlackBot
        agentId="a1"
        agentName="Quill"
        bot={NONE_STORED}
        canManage
        {...QUIET}
        leftOver={{ how: 'disconnected', appDeleted: false, approverIsViewer: false, approver: 'Ada Lovelace', approverGone: true }}
        onChanged={vi.fn()}
      />,
    );
    const note = screen.getByText(/couldn.t confirm its Slack app was deleted/);
    expect(note).toHaveTextContent(
      "We removed the bot from Slack, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete.",
    );
    expect(note).not.toHaveTextContent(/Ada Lovelace/);
    expect(note).not.toHaveTextContent(/set it up and can also delete/);
  });
});

// The card's words scan (no role, plumbing word or product name) is in AgentSlack.test.tsx.
