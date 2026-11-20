/**
 * The agent settings Slack section (TASK-1094). The wire client is mocked
 * here (its requests are pinned in `lib/__tests__/agent-slack.test.ts`); its
 * copy and error mapping are the real ones, so what a person reads is what
 * ships.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentSlack } from '../AgentSlack';
import {
  AgentSlackError,
  cancelSlackBot,
  cancelSlackBotRequest,
  connectSlackChannel,
  disconnectSlackChannel,
  fetchAgentSlack,
  fetchAvailableChannels,
  requestSlackBot,
  setSlackChannelRemember,
  type AgentSlackBot,
  type AgentSlackRead,
  type SlackChannelRow,
} from '@/lib/agent-slack';
import { renderSlackAvatar } from '@/lib/slack-avatar';

vi.mock('@/lib/agent-slack', async (original) => ({
  ...(await original<typeof import('@/lib/agent-slack')>()),
  fetchAgentSlack: vi.fn(),
  fetchAvailableChannels: vi.fn(),
  connectSlackChannel: vi.fn(),
  disconnectSlackChannel: vi.fn(),
  setSlackChannelRemember: vi.fn(),
  cancelSlackBot: vi.fn(),
  cancelSlackBotRequest: vi.fn(),
  requestSlackBot: vi.fn(),
}));
// jsdom has no canvas to draw the bot's picture on.
vi.mock('@/lib/slack-avatar', () => ({ renderSlackAvatar: vi.fn() }));

const fetchStatus = vi.mocked(fetchAgentSlack);
const fetchAvailable = vi.mocked(fetchAvailableChannels);
const connect = vi.mocked(connectSlackChannel);
const disconnect = vi.mocked(disconnectSlackChannel);
const remember = vi.mocked(setSlackChannelRemember);
const cancel = vi.mocked(cancelSlackBot);
const request = vi.mocked(requestSlackBot);
const avatar = vi.mocked(renderSlackAvatar);

const SUPPORT: SlackChannelRow = {
  channelId: 'C0SUPPORT1',
  name: 'support',
  remember: false,
  connectedBy: 'Ada Lovelace',
  needsReconnect: false,
  needsInvite: false,
};
const MOVED: SlackChannelRow = { ...SUPPORT, needsInvite: true };
const OPS: SlackChannelRow = { ...SUPPORT, channelId: 'C0OPS00001', name: 'ops', remember: true, needsReconnect: true };

const NO_BOT: AgentSlackBot = { state: 'none', configTokenStored: false };
const LIVE_BOT: AgentSlackBot = {
  state: 'live',
  botName: 'Quill',
  handle: 'quill',
  approver: 'Ada Lovelace',
  needsClaim: false,
};

function ready(channels: SlackChannelRow[], canManage = true, bot: AgentSlackBot = NO_BOT): AgentSlackRead {
  return { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage, channels, bot };
}

const AVAILABLE = {
  channels: [
    { channelId: 'C0SUPPORT1', name: 'support', connected: 'this-agent' as const },
    { channelId: 'C0SALES001', name: 'sales', connected: null },
    { channelId: 'C0OTHER001', name: 'billing', connected: 'other-agent' as const },
  ],
  truncated: false,
};

function renderIt(status: AgentSlackRead) {
  fetchStatus.mockResolvedValue(status);
  return render(<AgentSlack agentId="a1" agentName="Quill" />);
}

/** A fetch that answers only when the test says so: the loading face really paints in between. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function openPicker() {
  fireEvent.click(await screen.findByRole('combobox', { name: 'Connect a channel' }));
}

beforeEach(() => {
  fetchAvailable.mockResolvedValue(AVAILABLE);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the states', () => {
  it('an older host: one muted line', async () => {
    renderIt({ state: 'unavailable' });
    expect(await screen.findByText("Slack isn't available here.")).toBeInTheDocument();
  });

  it('no workspace: one plain line, no button', async () => {
    renderIt({ state: 'no-workspace', bot: NO_BOT });
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Its own Slack bot')).toBeNull();
  });

  it("no workspace, but the agent's own bot is live: the live line still shows", async () => {
    renderIt({ state: 'no-workspace', bot: LIVE_BOT });
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.getByText('@quill is live. Invite it to a channel with /invite @quill.')).toBeInTheDocument();
  });

  it('no workspace, with a pending request: it can still be cancelled (only a manager is told of it)', async () => {
    renderIt({
      state: 'no-workspace',
      bot: { state: 'pending', botName: 'Quill', approver: 'Ada Lovelace', canContinue: false },
    });
    expect(await screen.findByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue in Slack' })).toBeNull();
  });

  it('no workspace, with a request waiting for an AX admin: a manager can still cancel it', async () => {
    const cancelAsk = vi.mocked(cancelSlackBotRequest);
    cancelAsk.mockResolvedValue(undefined);
    renderIt({
      state: 'no-workspace',
      bot: { state: 'requested', botName: 'Quill Bot', requestedAt: '2026-11-20T10:00:00.000Z' },
    });
    expect(await screen.findByText('Waiting for an AX admin to approve Quill Bot.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(cancelAsk).toHaveBeenCalledWith('a1'));
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
  });

  it('a personal agent that answers direct messages: one line about the direct message', async () => {
    renderIt({ state: 'personal-agent', botName: 'canopy', answersDms: true });
    expect(await screen.findByText(/Quill is a personal agent.*direct message with canopy/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it("a personal agent that isn't the one a direct message reaches says so, without naming another agent", async () => {
    renderIt({ state: 'personal-agent', botName: 'canopy', answersDms: false });
    const line = await screen.findByText(/Quill is a personal agent, so it can't join channels/);
    expect(line).toHaveTextContent('A direct message to canopy');
    expect(line).toHaveTextContent('your first personal agent, not Quill');
    expect(line.textContent).not.toMatch(/answers in a direct message/);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a failed read offers a retry', async () => {
    fetchStatus.mockRejectedValueOnce(new Error('boom'));
    fetchStatus.mockResolvedValueOnce({ state: 'no-workspace', bot: NO_BOT });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AgentSlack agentId="a1" agentName="Quill" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/isn't connected to this workspace/)).toBeInTheDocument();
  });

  it('ready, empty, as a manager', async () => {
    renderIt(ready([]));
    expect(await screen.findByText("Quill isn't answering in any channels yet.")).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Connect a channel' })).toBeInTheDocument();
  });
});

describe("the agent's own bot, around the channel list", () => {
  const NOTICE =
    'These channels still need @quill: run /invite @quill in each one. A channel leaves this list once @quill answers there.';

  it('live: the channels it still needs are listed under one line that says to /invite it; the picker is gone', async () => {
    renderIt(ready([MOVED, { ...MOVED, channelId: 'C0OPS00001', name: 'ops' }], true, LIVE_BOT));
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Connected channels' });
    expect(within(list).getByText('support')).toBeInTheDocument();
    expect(within(list).getByText('ops')).toBeInTheDocument();
    expect(within(list).getAllByText('Run /invite @quill here.')).toHaveLength(2);
    expect(screen.queryByRole('combobox', { name: 'Connect a channel' })).toBeNull();
  });

  it('a channel it still needs has no memory switch, no "Connected by" and no Reconnect: only the hint and, for a manager, Disconnect', async () => {
    renderIt(ready([{ ...OPS, needsInvite: true }], true, LIVE_BOT));
    await screen.findByText('Run /invite @quill here.');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText(/Connected by/)).toBeNull();
    expect(screen.queryByText('Needs reconnecting')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.queryByText(/remembers what people with access/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('live with no handle: the lines name the bot instead', async () => {
    renderIt(ready([MOVED], true, { ...LIVE_BOT, handle: null }));
    expect(
      await screen.findByText(
        'These channels still need Quill: invite it to each one with /invite. A channel leaves this list once Quill answers there.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Invite Quill here with /invite.')).toBeInTheDocument();
  });

  it('a member reads the same notice and hint, with no Disconnect', async () => {
    renderIt(ready([MOVED], false, LIVE_BOT));
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByText('Run /invite @quill here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it.each([true, false])(
    'live, with no channel left to invite: no "no channels" line (manager: %s), and the live line still says how to invite it',
    async (canManage) => {
      renderIt(ready([], canManage, LIVE_BOT));
      expect(await screen.findByText('@quill is live. Invite it to a channel with /invite @quill.')).toBeInTheDocument();
      expect(screen.queryByText(/isn't answering in any channels yet/)).toBeNull();
      expect(screen.queryByText(/isn't connected to any Slack channels yet/)).toBeNull();
      expect(screen.queryByText(/still need/)).toBeNull();
    },
  );

  it('not live: the picker stays, and a row marked needsInvite is drawn as an ordinary row', async () => {
    renderIt(ready([MOVED]));
    expect(await screen.findByRole('combobox', { name: 'Connect a channel' })).toBeInTheDocument();
    expect(screen.queryByText(/still need/)).toBeNull();
    expect(screen.queryByText(/Run \/invite/)).toBeNull();
    expect(screen.getByRole('switch', { name: 'Let Quill remember this channel' })).toBeInTheDocument();
    expect(screen.getByText(/Connected by Ada Lovelace/)).toBeInTheDocument();
  });

  it("a manager sees the request form; a member sees nothing of the bot until it is live", async () => {
    const { unmount } = renderIt(ready([], true));
    // No token on file, so it opens on asking an AX admin.
    expect(await screen.findByRole('button', { name: 'Ask an AX admin' })).toBeInTheDocument();
    unmount();
    renderIt(ready([], false));
    await screen.findByText("Quill isn't connected to any Slack channels yet.");
    expect(screen.queryByText('Its own Slack bot')).toBeNull();
  });
});

describe("a cancelled bot request whose Slack app couldn't be deleted", () => {
  const PENDING_BOT: AgentSlackBot = { state: 'pending', botName: 'Quill Bot', approver: 'Ada Lovelace', canContinue: true };
  const NONE_STORED: AgentSlackBot = { state: 'none', configTokenStored: true };
  const LEFT_OVER = /couldn.t confirm its Slack app was deleted/;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    avatar.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Cancel, then hold the status re-read open until the loading face shows: the
   * note has to survive the whole section going away and coming back.
   */
  async function cancelThroughReRead(first: AgentSlackRead, after: AgentSlackRead, appDeleted = false) {
    const reRead = deferred<AgentSlackRead>();
    fetchStatus.mockResolvedValueOnce(first).mockReturnValueOnce(reRead.promise);
    cancel.mockResolvedValueOnce({ appDeleted });
    const view = render(<AgentSlack agentId="a1" agentName="Quill" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel request' }));
    expect(await screen.findByText('Loading Slack settings…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel request' })).toBeNull();
    reRead.resolve(after);
    return view;
  }

  it('ready: the note is above the request form once the status is read again', async () => {
    await cancelThroughReRead(ready([], true, PENDING_BOT), ready([], true, NONE_STORED));
    expect(await screen.findByRole('button', { name: 'Create the Slack bot' })).toBeInTheDocument();
    const note = screen.getByText(LEFT_OVER);
    expect(note).toHaveTextContent(
      "We cancelled the request, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete.",
    );
    // Above the form: the bot name field comes after it.
    expect(note.compareDocumentPosition(screen.getByLabelText('Bot name')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The viewer made the Slack app, so only they can delete it there.
    expect(note).toHaveTextContent(
      "Or delete it yourself: open it in Slack's app settings and click Delete App at the bottom of the page.",
    );
    expect(within(note).getByRole('link', { name: "Slack's app settings" })).toBeInTheDocument();
    expect(cancel).toHaveBeenCalledWith('a1');
    expect(note.textContent).not.toMatch(/\bAX\b/);
  });

  it('ready, cancelled by another manager: the note names the person who can delete the app', async () => {
    await cancelThroughReRead(ready([], true, { ...PENDING_BOT, canContinue: false }), ready([], true, NONE_STORED));
    const note = await screen.findByText(LEFT_OVER);
    expect(note).toHaveTextContent(
      "We cancelled the request, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete. Ada Lovelace set it up and can also delete it in Slack's app settings.",
    );
    expect(note).not.toHaveTextContent(/yourself/);
    expect(within(note).queryByRole('link')).toBeNull();
  });

  it('no workspace: the bot section goes with the request, but the note still shows', async () => {
    // Without the shared install nobody can continue, so the status never says the viewer is the approver.
    await cancelThroughReRead(
      { state: 'no-workspace', bot: { ...PENDING_BOT, canContinue: false } },
      { state: 'no-workspace', bot: { state: 'none', configTokenStored: false } },
    );
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.getByText(LEFT_OVER)).toHaveTextContent('Ada Lovelace set it up and can also delete it');
    expect(screen.queryByRole('button', { name: 'Create the Slack bot' })).toBeNull();
  });

  it('a cancel that deleted its Slack app leaves no note', async () => {
    await cancelThroughReRead(ready([], true, PENDING_BOT), ready([], true, NONE_STORED), true);
    expect(await screen.findByRole('button', { name: 'Create the Slack bot' })).toBeInTheDocument();
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });

  it('no workspace: a cancel that deleted its Slack app leaves no note either', async () => {
    // The no-workspace view shows the note on its own, with no bot section to hide it a second time.
    await cancelThroughReRead(
      { state: 'no-workspace', bot: { ...PENDING_BOT, canContinue: false } },
      { state: 'no-workspace', bot: { state: 'none', configTokenStored: false } },
      true,
    );
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });

  it('the note goes when another agent is shown', async () => {
    const { rerender } = await cancelThroughReRead(ready([], true, PENDING_BOT), ready([], true, NONE_STORED));
    expect(await screen.findByText(LEFT_OVER)).toBeInTheDocument();
    fetchStatus.mockResolvedValueOnce(ready([], true, NONE_STORED));
    rerender(<AgentSlack agentId="a2" agentName="Rook" />);
    await waitFor(() => expect(fetchStatus).toHaveBeenLastCalledWith('a2'));
    expect(await screen.findByRole('button', { name: 'Create the Slack bot' })).toBeInTheDocument();
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });

  it('the note goes when a new bot is asked for', async () => {
    request.mockRejectedValueOnce(new AgentSlackError(502, 'slack-error'));
    await cancelThroughReRead(ready([], true, PENDING_BOT), ready([], true, NONE_STORED));
    expect(await screen.findByText(LEFT_OVER)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create the Slack bot' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong talking to Slack.');
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });
});

describe('the list', () => {
  it('shows #name and who connected it, never an id', async () => {
    const { container } = renderIt(ready([SUPPORT]));
    const list = await screen.findByRole('list', { name: 'Connected channels' });
    expect(within(list).getByText('support')).toBeInTheDocument();
    expect(within(list).getByText('Connected by Ada Lovelace')).toBeInTheDocument();
    expect(container.textContent).not.toContain('C0SUPPORT1');
  });

  it('a manager sees the switch, Disconnect and the visibility note', async () => {
    renderIt(ready([SUPPORT]));
    expect(await screen.findByRole('switch', { name: 'Let Quill remember this channel' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    const note = screen.getByText(/Everyone in the channel can talk to Quill/);
    expect(note).toHaveTextContent("Its instructions and files can show up in its answers to anyone in the channel");
    expect(note.textContent).not.toMatch(/they can see its instructions/);
    expect(note).toHaveTextContent("approvals wait in that person's Today");
    // What an outsider says is never remembered, whatever the switch says.
    expect(note).toHaveTextContent('Quill never remembers what people without access say.');
  });

  it("the switch says what it covers: what people with access say, and never anyone else's words", async () => {
    renderIt(ready([SUPPORT]));
    expect(await screen.findByRole('switch', { name: 'Let Quill remember this channel' })).toHaveAccessibleDescription(
      'When this is on, Quill remembers what people with access to it say here. It never remembers what anyone else says.',
    );
  });

  it('a member reads the list: no switch, no Disconnect, no combobox', async () => {
    renderIt(ready([SUPPORT, OPS], false));
    const list = await screen.findByRole('list', { name: 'Connected channels' });
    expect(within(list).getByText('ops')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    // Only #ops remembers, and only what people with access say there.
    expect(
      screen.getAllByText('Quill remembers what people with access to it say here. It never remembers what anyone else says.'),
    ).toHaveLength(1);
    expect(screen.queryByText('Quill remembers this channel.')).toBeNull();
  });

  it('a member of an empty agent is told so', async () => {
    renderIt(ready([], false));
    expect(await screen.findByText("Quill isn't connected to any Slack channels yet.")).toBeInTheDocument();
  });
});

describe('connecting', () => {
  it('a manager picks a channel, it POSTs, and the row appears', async () => {
    connect.mockResolvedValueOnce({
      channel: { ...SUPPORT, channelId: 'C0SALES001', name: 'sales' },
      reconnected: false,
    });
    renderIt(ready([SUPPORT]));
    await openPicker();
    // The agent's own channel isn't offered again; another agent's is shown but disabled.
    expect(await screen.findByRole('option', { name: /#sales/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /#support/ })).toBeNull();
    const taken = screen.getByRole('option', { name: /#billing/ });
    expect(taken).toHaveAttribute('aria-disabled', 'true');
    expect(taken).toHaveTextContent('Connected to another agent');

    fireEvent.click(screen.getByRole('option', { name: /#sales/ }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith('a1', 'C0SALES001'));
    const list = await screen.findByRole('list', { name: 'Connected channels' });
    expect(await within(list).findByText('sales')).toBeInTheDocument();
    expect(within(list).getByText('support')).toBeInTheDocument();
  });

  it('a truncated list points at /ax connect in Slack', async () => {
    fetchAvailable.mockResolvedValueOnce({ ...AVAILABLE, truncated: true });
    renderIt(ready([]));
    await openPicker();
    expect(await screen.findByText(/In Slack, type \/ax connect in that channel/)).toBeInTheDocument();
  });

  it('needs-reconnect while listing shows the admin alert', async () => {
    fetchAvailable.mockRejectedValueOnce(new AgentSlackError(409, 'needs-reconnect'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderIt(ready([]));
    await openPicker();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Slack needs to be reconnected');
    expect(alert).toHaveTextContent('An admin can do it in Admin settings');
  });

  it.each([
    [new AgentSlackError(409, 'needs-reconnect'), /Slack needs to be reconnected/],
    [new AgentSlackError(409, 'channel-taken'), /already connected to another agent.*team admin of that agent's team/],
    [new AgentSlackError(422, 'channel-not-allowed', 'workspace-policy'), /doesn't let the bot join that channel.*Slack admin/],
    [new AgentSlackError(422, 'channel-not-allowed', 'not-public'), /private channel/],
    [new AgentSlackError(422, 'channel-not-allowed', 'archived'), /archived/],
    [new AgentSlackError(422, 'channel-not-allowed', 'shared'), /shared with another organization/],
    [new AgentSlackError(502, 'slack-error'), /Slack didn't answer/],
  ])('a refused connect says its own sentence: %#', async (err, text) => {
    connect.mockRejectedValueOnce(err);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderIt(ready([]));
    await openPicker();
    fireEvent.click(await screen.findByRole('option', { name: /#sales/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert.textContent).not.toMatch(/channel-taken|channel-not-allowed|slack-error|needs-reconnect|workspace-policy/);
    expect(screen.queryByRole('list', { name: 'Connected channels' })).toBeNull();
  });
});

describe('remember', () => {
  it('is never optimistic: disabled at its old position until the server confirms', async () => {
    let finish!: () => void;
    remember.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    renderIt(ready([SUPPORT]));
    const toggle = await screen.findByRole('switch', { name: 'Let Quill remember this channel' });
    fireEvent.click(toggle);
    await waitFor(() => expect(remember).toHaveBeenCalledWith('a1', 'C0SUPPORT1', true));
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    finish();
    await waitFor(() => expect(toggle).toBeChecked());
    expect(toggle).not.toBeDisabled();
  });

  it('a failed write leaves the switch where it was and says nothing changed', async () => {
    remember.mockRejectedValueOnce(new AgentSlackError(500, 'internal'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderIt(ready([SUPPORT]));
    const toggle = await screen.findByRole('switch', { name: 'Let Quill remember this channel' });
    fireEvent.click(toggle);
    expect(await screen.findByText("We couldn't change that, so nothing is different. Try again.")).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    expect(toggle).not.toBeDisabled();
  });
});

describe('a write on a stale picture re-reads the section', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not-connected'],
    [409, 'personal-agent'],
  ])('remember refused with %i re-reads, with no "try again" line', async (status, code) => {
    remember.mockRejectedValueOnce(new AgentSlackError(status, code));
    renderIt(ready([SUPPORT]));
    const toggle = await screen.findByRole('switch', { name: 'Let Quill remember this channel' });
    fetchStatus.mockResolvedValueOnce(ready([]));
    fireEvent.click(toggle);
    expect(await screen.findByText("Quill isn't answering in any channels yet.")).toBeInTheDocument();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/nothing is different/)).toBeNull();
  });

  it('disconnect refused with 403 re-reads and closes the dialog', async () => {
    disconnect.mockRejectedValueOnce(new AgentSlackError(403, 'forbidden'));
    renderIt(ready([SUPPORT]));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect #support?' });
    fetchStatus.mockResolvedValueOnce(ready([SUPPORT], false));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull());
    expect(screen.queryByText(/Try again/)).toBeNull();
  });

  it('connect refused with 409 own-bot (its bot went live meanwhile) re-reads, with no error line', async () => {
    connect.mockRejectedValueOnce(new AgentSlackError(409, 'own-bot'));
    renderIt(ready([]));
    await openPicker();
    fetchStatus.mockResolvedValueOnce(ready([], true, LIVE_BOT));
    fireEvent.click(await screen.findByRole('option', { name: /#sales/ }));
    expect(await screen.findByText('@quill is live. Invite it to a channel with /invite @quill.')).toBeInTheDocument();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a 5xx on remember keeps the "try again" line and does not re-read', async () => {
    remember.mockRejectedValueOnce(new AgentSlackError(502, 'slack-error'));
    renderIt(ready([SUPPORT]));
    fireEvent.click(await screen.findByRole('switch', { name: 'Let Quill remember this channel' }));
    expect(await screen.findByText(/nothing is different. Try again/)).toBeInTheDocument();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('connect refused with 404 re-reads', async () => {
    connect.mockRejectedValueOnce(new AgentSlackError(404, 'not-found'));
    renderIt(ready([]));
    await openPicker();
    fetchStatus.mockResolvedValueOnce({ state: 'unavailable' });
    fireEvent.click(await screen.findByRole('option', { name: /#sales/ }));
    expect(await screen.findByText("Slack isn't available here.")).toBeInTheDocument();
  });
});

describe('disconnecting', () => {
  async function openDialog() {
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    return screen.findByRole('dialog', { name: 'Disconnect #support?' });
  }

  it('asks first; keeping it connected sends nothing', async () => {
    renderIt(ready([SUPPORT]));
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep connected' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();
    expect(screen.getByText('support')).toBeInTheDocument();
  });

  it('confirming removes the row', async () => {
    disconnect.mockResolvedValueOnce({ removed: true });
    renderIt(ready([SUPPORT]));
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('a1', 'C0SUPPORT1'));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Connected channels' })).toBeNull());
    expect(await screen.findByText("Quill isn't answering in any channels yet.")).toBeInTheDocument();
  });

  it('a channel the bot still needs: the dialog says what Disconnect does then; confirming takes it off the list, and the line goes with the last one', async () => {
    disconnect.mockResolvedValueOnce({ removed: true });
    renderIt(ready([MOVED], true, LIVE_BOT));
    const dialog = await openDialog();
    expect(
      within(dialog).getByText(
        "We'll take #support off this list. The agent answers there only after its own bot is invited.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/connect it again any time/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('a1', 'C0SUPPORT1'));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Connected channels' })).toBeNull());
    expect(screen.queryByText(/still need/)).toBeNull();
    expect(screen.queryByText(/isn't answering in any channels yet/)).toBeNull();
  });

  it('a server failure keeps the dialog and the row, with a sentence', async () => {
    disconnect.mockRejectedValueOnce(new AgentSlackError(500, 'internal'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderIt(ready([SUPPORT]));
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await within(dialog).findByText('Something went wrong. Try again in a minute.')).toBeInTheDocument();
  });
});

describe('needs reconnecting', () => {
  it('a manager sees the badge and a Reconnect that connects again', async () => {
    connect.mockResolvedValueOnce({ channel: { ...OPS, needsReconnect: false }, reconnected: true });
    renderIt(ready([OPS]));
    expect(await screen.findByText('Needs reconnecting')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith('a1', 'C0OPS00001'));
    await waitFor(() => expect(screen.queryByText('Needs reconnecting')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  it('a member sees the badge and who can fix it, with no button', async () => {
    renderIt(ready([OPS], false));
    expect(await screen.findByText('Needs reconnecting')).toBeInTheDocument();
    expect(screen.getByText(/until a team admin reconnects it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });
});
