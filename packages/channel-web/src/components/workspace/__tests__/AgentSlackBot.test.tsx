/**
 * "Its own Slack bot" in an agent's Slack settings (TASK-1167). The wire client
 * is mocked (its requests are pinned in `lib/__tests__/agent-slack.test.ts`);
 * the copy and the error mapping are the real ones, so what a person reads is
 * what ships. So is the avatar and the hand-off to Slack, which are mocked
 * because jsdom has neither a canvas nor a page to leave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentSlackBot } from '../AgentSlackBot';
import {
  AgentSlackError,
  cancelSlackBot,
  continueSlackBot,
  disconnectSlackBot,
  requestSlackBot,
  type AgentSlackBot as Bot,
} from '@/lib/agent-slack';
import { goToSlack } from '@/lib/slack-admin';
import { renderSlackAvatar } from '@/lib/slack-avatar';
import { fakeConfigRefreshToken } from '@/test-utils/fake-slack-tokens';

vi.mock('@/lib/agent-slack', async (original) => ({
  ...(await original<typeof import('@/lib/agent-slack')>()),
  requestSlackBot: vi.fn(),
  continueSlackBot: vi.fn(),
  cancelSlackBot: vi.fn(),
  disconnectSlackBot: vi.fn(),
}));
vi.mock('@/lib/slack-avatar', () => ({ renderSlackAvatar: vi.fn() }));
vi.mock('@/lib/slack-admin', async (original) => ({
  ...(await original<typeof import('@/lib/slack-admin')>()),
  goToSlack: vi.fn(),
}));

const request = vi.mocked(requestSlackBot);
const continueIt = vi.mocked(continueSlackBot);
const cancel = vi.mocked(cancelSlackBot);
const disconnect = vi.mocked(disconnectSlackBot);
const go = vi.mocked(goToSlack);
const avatar = vi.mocked(renderSlackAvatar);

const INSTALL_URL = 'https://slack.com/oauth/v2/authorize?client_id=1';
const NONE_NO_TOKEN: Bot = { state: 'none', configTokenStored: false };
const NONE_STORED: Bot = { state: 'none', configTokenStored: true };
const PENDING: Bot = { state: 'pending', botName: 'Quill Bot', approver: 'Ada Lovelace', canContinue: true };
const LIVE: Bot = { state: 'live', botName: 'Quill Bot', handle: 'quill_bot', approver: 'Ada Lovelace', needsClaim: false };
/** No cancel note, and nobody listening for one (the note's life across a re-read is `AgentSlack`'s, tested there). */
const QUIET = { leftOver: null, onCancelled: () => {}, onRequesting: () => {} };

function renderIt(bot: Bot, canManage = true, onChanged = vi.fn()) {
  render(<AgentSlackBot agentId="a1" agentName="Quill" bot={bot} canManage={canManage} {...QUIET} onChanged={onChanged} />);
  return onChanged;
}

const refusal = (status: number, code: string, reason: string | null = null) => new AgentSlackError(status, code, reason);

/** Fill the form the way a person does and press the button. */
function submit(botName?: string, token?: string) {
  if (botName !== undefined) fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: botName } });
  if (token !== undefined) fireEvent.change(screen.getByLabelText('Refresh token'), { target: { value: token } });
  fireEvent.click(screen.getByRole('button', { name: 'Create the Slack bot' }));
}

beforeEach(() => {
  avatar.mockResolvedValue('UE5HQVZBVEFS');
  request.mockResolvedValue({ installUrl: INSTALL_URL, iconSet: true });
  continueIt.mockResolvedValue({ installUrl: INSTALL_URL });
  cancel.mockResolvedValue({ appDeleted: true });
  disconnect.mockResolvedValue({ appDeleted: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('none', () => {
  it('a manager with no stored token sees the steps, the token field (required), the name and the button', () => {
    renderIt(NONE_NO_TOKEN);
    expect(screen.getByRole('heading', { level: 3, name: 'Its own Slack bot' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Give Quill its own name in Slack. People mention it directly, and you add it to a channel with /invite. When someone outside the team mentions it, it answers them with your access. You need to be able to install apps in Slack.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Slack's app settings" })).toHaveAttribute('href', 'https://api.slack.com/apps');
    expect(
      screen.getByText(/Paste the refresh token below\. We keep it for every Slack app you set up here, so you only do this once\./),
    ).toBeInTheDocument();
    const token = screen.getByLabelText('Refresh token');
    expect(token).toBeRequired();
    expect(token).toHaveAttribute('type', 'password');
    expect(screen.getByText('Starts with xoxe-')).toBeInTheDocument();
    expect(screen.getByLabelText('Bot name')).toHaveValue('Quill');
    expect(screen.getByRole('button', { name: 'Create the Slack bot' })).toBeEnabled();
    expect(screen.queryByText("We'll use the configuration token you gave us before.")).toBeNull();
  });

  it('with a stored token there is no field and no steps, only the line saying it will be used', () => {
    renderIt(NONE_STORED);
    expect(screen.queryByLabelText('Refresh token')).toBeNull();
    expect(screen.queryByRole('link', { name: "Slack's app settings" })).toBeNull();
    expect(screen.getByText("We'll use the configuration token you gave us before.")).toBeInTheDocument();
    expect(screen.getByLabelText('Bot name')).toBeInTheDocument();
  });

  it('a member sees nothing', () => {
    const { container } = render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={NONE_NO_TOKEN} canManage={false} {...QUIET} onChanged={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
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

  it('while it is going to Slack the button is busy and a second press sends nothing', async () => {
    renderIt(NONE_STORED);
    submit();
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();
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
    fireEvent.click(screen.getByRole('button', { name: 'Create the Slack bot' }));
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
    expect(screen.getByRole('button', { name: 'Create the Slack bot' })).toBeEnabled();
  });

  it.each([
    ['invalid-refresh-token', 400, "That doesn't look like a refresh token. It starts with xoxe-."],
    ['slack-refresh-token', 502, "Slack didn't accept the refresh token. Generate a new token and try again."],
  ])('%s shows its line under the token field', async (code, status, line) => {
    request.mockRejectedValueOnce(refusal(status, code));
    renderIt(NONE_NO_TOKEN);
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
    expect(screen.getByRole('button', { name: 'Create the Slack bot' })).toBeEnabled();
  });
});

describe('pending', () => {
  it('the person who started it sees where it stands, Continue in Slack and Cancel request', () => {
    renderIt(PENDING);
    expect(screen.getByText('Almost there: finish adding Quill Bot in Slack.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue in Slack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
  });

  it('another manager sees who is finishing it, and can only cancel', () => {
    renderIt({ ...PENDING, canContinue: false });
    expect(screen.getByText('Ada Lovelace is finishing this in Slack.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue in Slack' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
  });

  it('a member never sees a pending request', () => {
    const { container } = render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={PENDING} canManage={false} {...QUIET} onChanged={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('Continue asks for a fresh link and goes to Slack', async () => {
    renderIt(PENDING);
    fireEvent.click(screen.getByRole('button', { name: 'Continue in Slack' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith(INSTALL_URL));
    expect(continueIt).toHaveBeenCalledWith('a1');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('Cancel takes the request back and then reads the status again', async () => {
    const onChanged = renderIt(PENDING);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(cancel).toHaveBeenCalledWith('a1');
    expect(go).not.toHaveBeenCalled();
  });

  it("not-approver says so in a sentence and leaves the buttons pressable", async () => {
    continueIt.mockRejectedValueOnce(refusal(403, 'not-approver'));
    const onChanged = renderIt(PENDING);
    fireEvent.click(screen.getByRole('button', { name: 'Continue in Slack' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the person who set this up can continue it in Slack.');
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue in Slack' })).toBeEnabled();
  });

  it('not-pending (someone got there first) reads the status again', async () => {
    cancel.mockRejectedValueOnce(refusal(409, 'not-pending'));
    const onChanged = renderIt(PENDING);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
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
    expect(document.body.textContent).not.toMatch(/\bAX\b/);
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

  it('a cancel that failed says so and nothing is re-read', async () => {
    cancel.mockRejectedValueOnce(refusal(500, 'internal'));
    const onChanged = renderIt(PENDING);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    // Our own failure, not Slack's: the plain line, which doesn't blame Slack.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong. Try again in a minute.');
    expect(alert).not.toHaveTextContent(/Slack/);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('live', () => {
  it('a manager sees the handle, how to invite it, and who set it up', () => {
    renderIt(LIVE);
    expect(screen.getByText('@quill_bot is live. Invite it to a channel with /invite @quill_bot.')).toBeInTheDocument();
    expect(screen.getByText('Set up by Ada Lovelace.')).toBeInTheDocument();
    expect(screen.queryByText(/needs a team admin to claim it/)).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('a member sees the live line but not who set it up', () => {
    renderIt(LIVE, false);
    expect(screen.getByText('@quill_bot is live. Invite it to a channel with /invite @quill_bot.')).toBeInTheDocument();
    expect(screen.queryByText(/Set up by/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('with no handle the line names the bot', () => {
    renderIt({ ...LIVE, handle: null });
    expect(screen.getByText('Quill Bot is live. Invite it to a channel with /invite.')).toBeInTheDocument();
  });

  it('a bot that needs claiming says so to everyone who sees it', () => {
    const line = 'Quill Bot needs a team admin to claim it. Until then it answers team members only.';
    const { unmount } = render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={{ ...LIVE, needsClaim: true }} canManage {...QUIET} onChanged={vi.fn()} />,
    );
    expect(screen.getByText(line)).toBeInTheDocument();
    unmount();
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={{ ...LIVE, needsClaim: true }} canManage={false} {...QUIET} onChanged={vi.fn()} />,
    );
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it('a manager sees Disconnect bot; a member does not', () => {
    const { unmount } = render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={LIVE} canManage {...QUIET} onChanged={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Disconnect bot' })).toBeEnabled();
    unmount();
    render(<AgentSlackBot agentId="a1" agentName="Quill" bot={LIVE} canManage={false} {...QUIET} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Disconnect bot' })).toBeNull();
  });

  it('Disconnect bot asks first: the dialog says the bot leaves every channel, @handle stops working, its Slack app is deleted, and the shared bot answers again; Keep it sends nothing', async () => {
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={LIVE} canManage sharedChannels {...QUIET} onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect bot' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Disconnect @quill_bot?' })).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Quill Bot leaves every Slack channel it's in, and @quill_bot stops working. We'll delete its Slack app. The shared bot answers for Quill again in the channels it was connected to before.",
      ),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/\bAX\b/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('with no handle the dialog names the bot and says mentioning it stops working; without shared channels it promises nothing about the shared bot', async () => {
    renderIt({ ...LIVE, handle: null });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect bot' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Disconnect Quill Bot?' })).toBeInTheDocument();
    expect(
      within(dialog).getByText("Quill Bot leaves every Slack channel it's in, and mentioning it stops working. We'll delete its Slack app."),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/shared bot/);
  });

  it("confirming disconnects, hands up { how: 'disconnected', appDeleted, approverIsViewer: false, approver } and reads the status again", async () => {
    disconnect.mockResolvedValueOnce({ appDeleted: false });
    const order: string[] = [];
    const onCancelled = vi.fn(() => order.push('cancelled'));
    const onChanged = vi.fn(() => order.push('changed'));
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={LIVE} canManage {...QUIET} onCancelled={onCancelled} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect bot' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith('a1');
    expect(onCancelled).toHaveBeenCalledWith({
      how: 'disconnected',
      appDeleted: false,
      approverIsViewer: false,
      approver: 'Ada Lovelace',
    });
    expect(order).toEqual(['cancelled', 'changed']);
  });

  it('no-bot (someone got there first) closes the dialog and reads the status again; a failure says so in the dialog and keeps the bot', async () => {
    disconnect.mockRejectedValueOnce(refusal(409, 'no-bot'));
    const onChanged = renderIt(LIVE);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect bot' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    disconnect.mockRejectedValueOnce(refusal(500, 'internal'));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect bot' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Something went wrong. Try again in a minute.');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('button', { name: 'Disconnect' })).toBeEnabled();
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
      "We disconnected the bot, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete. Ada Lovelace set it up and can also delete it in Slack's app settings.",
    );
    expect(note).not.toHaveTextContent(/cancelled/);
  });
});

describe('words', () => {
  it('never writes the product name in a sentence', () => {
    const { container } = render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={NONE_NO_TOKEN} canManage {...QUIET} onChanged={vi.fn()} />,
    );
    expect(container.textContent).not.toMatch(/\bAX\b/);
  });

  it('never writes the product name in a sentence, the open Disconnect dialog included', async () => {
    render(
      <AgentSlackBot agentId="a1" agentName="Quill" bot={LIVE} canManage sharedChannels {...QUIET} onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect bot' }));
    await screen.findByRole('dialog');
    expect(document.body.textContent).not.toMatch(/\bAX\b/);
  });
});
