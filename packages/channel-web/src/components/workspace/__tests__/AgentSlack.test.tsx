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
  disconnectSlackBot,
  fetchAgentSlack,
  requestSlackBot,
  setSlackBotChannelRemember,
  type AgentSlackBot,
  type AgentSlackRead,
  type BotChannelRow,
} from '@/lib/agent-slack';
import { renderSlackAvatar } from '@/lib/slack-avatar';

vi.mock('@/lib/agent-slack', async (original) => ({
  ...(await original<typeof import('@/lib/agent-slack')>()),
  fetchAgentSlack: vi.fn(),
  setSlackBotChannelRemember: vi.fn(),
  cancelSlackBot: vi.fn(),
  cancelSlackBotRequest: vi.fn(),
  disconnectSlackBot: vi.fn(),
  requestSlackBot: vi.fn(),
}));
// jsdom has no canvas to draw the bot's picture on.
vi.mock('@/lib/slack-avatar', () => ({ renderSlackAvatar: vi.fn() }));

const fetchStatus = vi.mocked(fetchAgentSlack);
const rememberBot = vi.mocked(setSlackBotChannelRemember);
const cancel = vi.mocked(cancelSlackBot);
const disconnectBot = vi.mocked(disconnectSlackBot);
const request = vi.mocked(requestSlackBot);
const avatar = vi.mocked(renderSlackAvatar);

/** The bot's install id, as a manager's status carries it: the key its Disconnect takes. */
const BOT_ID = 'Hb7Kq2Lw8vNc5Xr1Bm7KdA';
const NO_BOT: AgentSlackBot = { state: 'none', configTokenStored: false };
const LIVE_BOT: AgentSlackBot = {
  state: 'live',
  botName: 'Quill',
  handle: 'quill',
  approver: 'Ada Lovelace',
  needsClaim: false,
  approverGone: false,
  viewerIsApprover: false,
  installId: BOT_ID,
};

function ready(canManage = true, bot: AgentSlackBot = NO_BOT): AgentSlackRead {
  return { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage, bot };
}

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

afterEach(() => {
  vi.clearAllMocks();
});

describe('the states', () => {
  it('an older host: one muted line', async () => {
    renderIt({ state: 'unavailable' });
    expect(await screen.findByText("Slack isn't available here.")).toBeInTheDocument();
  });

  it('no workspace: one plain line, no button', async () => {
    renderIt({ state: 'no-workspace', canManage: false, bot: NO_BOT });
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Its own Slack bot')).toBeNull();
  });

  it("no workspace, but the agent's own bot is live: the live line still shows", async () => {
    renderIt({ state: 'no-workspace', canManage: false, bot: LIVE_BOT });
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.getByText('@quill is live. Invite it to a channel with /invite @quill.')).toBeInTheDocument();
  });

  it('no workspace, with a pending request: it can still be cancelled (only a manager is told of it)', async () => {
    renderIt({
      state: 'no-workspace',
      canManage: true,
      bot: { state: 'pending', botName: 'Quill', approver: 'Ada Lovelace', canContinue: false, installId: BOT_ID },
    });
    expect(await screen.findByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue in Slack' })).toBeNull();
  });

  it('no workspace, with a request waiting for an AX admin: a manager can still cancel it', async () => {
    const cancelAsk = vi.mocked(cancelSlackBotRequest);
    cancelAsk.mockResolvedValue(undefined);
    // A request reaches only those who manage the agent, so the server says they do (TASK-1172's `canManage`).
    renderIt({
      state: 'no-workspace',
      canManage: true,
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
    fetchStatus.mockResolvedValueOnce({ state: 'no-workspace', canManage: false, bot: NO_BOT });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AgentSlack agentId="a1" agentName="Quill" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/isn't connected to this workspace/)).toBeInTheDocument();
  });
});

describe("the agent's own bot, in the ready section", () => {
  it("shows the bot's channels and the bot card, and no picker or shared list", async () => {
    renderIt({
      state: 'ready',
      botName: 'canopy',
      workspaceName: 'Acme',
      canManage: true,
      bot: LIVE_BOT,
      botChannels: [{ channelId: 'C0BOTSUP01', name: 'help', remember: true }],
    });
    expect(await screen.findByText('@quill has answered in these channels.')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Channels its own bot has answered in' });
    expect(within(list).getByText('help')).toBeInTheDocument();
    expect(screen.getByText('@quill is live. Invite it to a channel with /invite @quill.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect bot' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Connected channels' })).toBeNull();
    for (const gone of [/Connect a channel/, /Connected channels/, /still need/, /Connected by/, /\/ax\b/]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /Reconnect/ })).toBeNull();
  });

  it.each(['none', 'requested', 'pending'] as const)(
    'a member who cannot manage the agent, with no live bot (%s), is told it is not in Slack yet rather than shown nothing',
    async (botState) => {
      const bot =
        botState === 'none'
          ? NO_BOT
          : ({ ...LIVE_BOT, state: botState } as unknown as AgentSlackBot);
      renderIt(ready(false, bot));
      expect(await screen.findByText("Quill isn't in Slack yet. A team admin can add it.")).toBeInTheDocument();
    },
  );

  it('a manager with no bot sees the setup form, not the "not in Slack yet" line', async () => {
    renderIt(ready(true, NO_BOT));
    await screen.findByRole('button', { name: /./ });
    expect(screen.queryByText(/isn't in Slack yet/)).toBeNull();
  });

  it.each([true, false])(
    'live, with no channel left to invite: no "no channels" line (manager: %s), and the live line still says how to invite it',
    async (canManage) => {
      renderIt(ready(canManage, LIVE_BOT));
      expect(await screen.findByText('@quill is live. Invite it to a channel with /invite @quill.')).toBeInTheDocument();
      expect(screen.queryByText(/isn't answering in any channels yet/)).toBeNull();
      expect(screen.queryByText(/isn't connected to any Slack channels yet/)).toBeNull();
      expect(screen.queryByText(/still need/)).toBeNull();
    },
  );

  it("a manager sees the request form; a member sees nothing of the bot until it is live", async () => {
    const { unmount } = renderIt(ready(true));
    // No token on file, so it opens on asking an AX admin.
    expect(await screen.findByRole('button', { name: 'Ask an AX admin' })).toBeInTheDocument();
    unmount();
    renderIt(ready(false));
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Loading Slack settings…')).toBeNull());
    expect(screen.queryByText('Its own Slack bot')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe("a cancelled bot request whose Slack app couldn't be deleted", () => {
  const PENDING_BOT: AgentSlackBot = {
    state: 'pending',
    botName: 'Quill Bot',
    approver: 'Ada Lovelace',
    canContinue: true,
    installId: BOT_ID,
  };
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
    await cancelThroughReRead(ready(true, PENDING_BOT), ready(true, NONE_STORED));
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
    expect(cancel).toHaveBeenCalledWith('a1', BOT_ID);
    expect(note.textContent).not.toMatch(/\bAX\b/);
  });

  it('ready, cancelled by another manager: the note names the person who can delete the app', async () => {
    await cancelThroughReRead(ready(true, { ...PENDING_BOT, canContinue: false }), ready(true, NONE_STORED));
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
      { state: 'no-workspace', canManage: true, bot: { ...PENDING_BOT, canContinue: false } },
      { state: 'no-workspace', canManage: false, bot: { state: 'none', configTokenStored: false } },
    );
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.getByText(LEFT_OVER)).toHaveTextContent('Ada Lovelace set it up and can also delete it');
    expect(screen.queryByRole('button', { name: 'Create the Slack bot' })).toBeNull();
  });

  it('a cancel that deleted its Slack app leaves no note', async () => {
    await cancelThroughReRead(ready(true, PENDING_BOT), ready(true, NONE_STORED), true);
    expect(await screen.findByRole('button', { name: 'Create the Slack bot' })).toBeInTheDocument();
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });

  it('no workspace: a cancel that deleted its Slack app leaves no note either', async () => {
    // The no-workspace view shows the note on its own, with no bot section to hide it a second time.
    await cancelThroughReRead(
      { state: 'no-workspace', canManage: true, bot: { ...PENDING_BOT, canContinue: false } },
      { state: 'no-workspace', canManage: false, bot: { state: 'none', configTokenStored: false } },
      true,
    );
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });

  it('the note goes when another agent is shown', async () => {
    const { rerender } = await cancelThroughReRead(ready(true, PENDING_BOT), ready(true, NONE_STORED));
    expect(await screen.findByText(LEFT_OVER)).toBeInTheDocument();
    fetchStatus.mockResolvedValueOnce(ready(true, NONE_STORED));
    rerender(<AgentSlack agentId="a2" agentName="Rook" />);
    await waitFor(() => expect(fetchStatus).toHaveBeenLastCalledWith('a2'));
    expect(await screen.findByRole('button', { name: 'Create the Slack bot' })).toBeInTheDocument();
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });

  it('the note goes when a new bot is asked for', async () => {
    request.mockRejectedValueOnce(new AgentSlackError(502, 'slack-error'));
    await cancelThroughReRead(ready(true, PENDING_BOT), ready(true, NONE_STORED));
    expect(await screen.findByText(LEFT_OVER)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create the Slack bot' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong talking to Slack.');
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });
});

describe("a team agent's own live bot", () => {
  const NONE_STORED: AgentSlackBot = { state: 'none', configTokenStored: true };
  const LEFT_OVER = /couldn.t confirm its Slack app was deleted/;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    avatar.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ready: a disconnect whose Slack app couldn't be deleted leaves the note above the request form once the status is read again", async () => {
    const reRead = deferred<AgentSlackRead>();
    fetchStatus.mockResolvedValueOnce(ready(true, LIVE_BOT)).mockReturnValueOnce(reRead.promise);
    disconnectBot.mockResolvedValueOnce({ appDeleted: false });
    render(<AgentSlack agentId="a1" agentName="Quill" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect bot' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Loading Slack settings…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect bot' })).toBeNull();
    reRead.resolve(ready(true, NONE_STORED));
    expect(await screen.findByRole('button', { name: 'Create the Slack bot' })).toBeInTheDocument();
    const note = screen.getByText(LEFT_OVER);
    expect(note).toHaveTextContent(
      "We disconnected the bot, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete. Ada Lovelace set it up and can also delete it in Slack's app settings.",
    );
    expect(note.compareDocumentPosition(screen.getByLabelText('Bot name')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(disconnectBot).toHaveBeenCalledWith('a1', BOT_ID);
  });

  it('a page drawn before its bot was disconnected and replaced: Disconnect names the bot it showed, and no-bot reads the status again, which shows the new one', async () => {
    // The server refuses: that bot is gone, and the agent's live bot is a newer one.
    const NEWER: AgentSlackBot = { ...LIVE_BOT, botName: 'Quill Two', handle: 'quill_two', installId: 'Nw2Kq2Lw8vNc5Xr1Bm7KdB' };
    disconnectBot.mockRejectedValueOnce(new AgentSlackError(409, 'no-bot'));
    fetchStatus.mockResolvedValueOnce(ready(true, LIVE_BOT)).mockResolvedValueOnce(ready(true, NEWER));
    render(<AgentSlack agentId="a1" agentName="Quill" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect @quill?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('@quill_two is live. Invite it to a channel with /invite @quill_two.')).toBeInTheDocument();
    expect(disconnectBot).toHaveBeenCalledTimes(1);
    expect(disconnectBot).toHaveBeenCalledWith('a1', BOT_ID);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("ready: a disconnect that deleted the Slack app leaves no note, and the dialog doesn't promise the shared bot back", async () => {
    disconnectBot.mockResolvedValueOnce({ appDeleted: true });
    fetchStatus.mockResolvedValueOnce(ready(true, LIVE_BOT)).mockResolvedValueOnce(ready(true, NONE_STORED));
    render(<AgentSlack agentId="a1" agentName="Quill" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect bot' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).not.toHaveTextContent(/The shared bot answers/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Create the Slack bot' })).toBeInTheDocument();
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });

  it('no workspace: a manager can disconnect a live bot (canManage from the server); a member sees no Disconnect bot', async () => {
    const { unmount } = renderIt({ state: 'no-workspace', canManage: true, bot: LIVE_BOT });
    expect(await screen.findByRole('button', { name: 'Disconnect bot' })).toBeInTheDocument();
    // Nothing on the shared bot to promise here: no channels are shown.
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect bot' }));
    expect(await screen.findByRole('dialog')).not.toHaveTextContent(/shared bot/);
    unmount();
    // As the server answers a member: no install id either.
    renderIt({ state: 'no-workspace', canManage: false, bot: { ...LIVE_BOT, installId: null } });
    expect(await screen.findByText('@quill is live. Invite it to a channel with /invite @quill.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect bot' })).toBeNull();
  });
});

describe('a rebuilt bot (TASK-1173)', () => {
  const GONE_BOT: AgentSlackBot = { ...LIVE_BOT, botName: 'Quill Bot', handle: 'quill_bot', approverGone: true };
  const NONE_STORED: AgentSlackBot = { state: 'none', configTokenStored: true };
  const LEFT_OVER = /couldn.t confirm its Slack app was deleted/;
  const NOTICE =
    '@quill_bot is disconnected. Set up its replacement below. It gets a new @handle, so invite it to each channel again.';

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    avatar.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Rebuild the gone-approver bot, holding the status re-read open until the loading face shows. */
  async function rebuildThroughReRead(appDeleted: boolean) {
    const reRead = deferred<AgentSlackRead>();
    fetchStatus.mockResolvedValueOnce(ready(true, GONE_BOT)).mockReturnValueOnce(reRead.promise);
    disconnectBot.mockResolvedValueOnce({ appDeleted });
    const view = render(<AgentSlack agentId="a1" agentName="Quill" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rebuild bot' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rebuild' }));
    expect(await screen.findByText('Loading Slack settings…')).toBeInTheDocument();
    reRead.resolve(ready(true, NONE_STORED));
    expect(await screen.findByRole('button', { name: 'Create the Slack bot' })).toBeInTheDocument();
    return view;
  }

  it('after a Rebuild the form is prefilled with the old name, under the notice, with no left-over note when the app was deleted', async () => {
    await rebuildThroughReRead(true);
    expect(disconnectBot).toHaveBeenCalledWith('a1', BOT_ID);
    const notice = screen.getByText(NOTICE);
    expect(screen.getByLabelText('Bot name')).toHaveValue('Quill Bot');
    expect(notice.compareDocumentPosition(screen.getByLabelText('Bot name')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });

  it("when Slack kept the old app, the left-over note follows the notice and doesn't name the person who left", async () => {
    await rebuildThroughReRead(false);
    const notice = screen.getByText(NOTICE);
    const note = screen.getByText(LEFT_OVER);
    expect(notice.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note).toHaveTextContent(
      "We disconnected the bot, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete.",
    );
    expect(note).not.toHaveTextContent(/Ada Lovelace/);
  });

  it('asking for a new bot clears the notice', async () => {
    request.mockRejectedValueOnce(new AgentSlackError(502, 'slack-error'));
    await rebuildThroughReRead(true);
    fireEvent.click(screen.getByRole('button', { name: 'Create the Slack bot' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong talking to Slack.');
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('another agent clears the notice and the prefill', async () => {
    const { rerender } = await rebuildThroughReRead(true);
    fetchStatus.mockResolvedValueOnce(ready(true, NONE_STORED));
    rerender(<AgentSlack agentId="a2" agentName="Rook" />);
    await waitFor(() => expect(fetchStatus).toHaveBeenLastCalledWith('a2'));
    expect(await screen.findByRole('button', { name: 'Create the Slack bot' })).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByLabelText('Bot name')).toHaveValue('Rook');
  });

  it('no workspace: a gone approver still gets the alert, with no Rebuild button (a request needs the shared app)', async () => {
    renderIt({ state: 'no-workspace', canManage: true, bot: GONE_BOT });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Quill Bot needs rebuilding. The person who set it up has left, so nobody can replace its Slack token any more. Once Slack is connected again, you can rebuild it here.',
    );
    expect(screen.queryByRole('button', { name: 'Rebuild bot' })).toBeNull();
  });
});

describe("the agent's own bot's channels (TASK-1180)", () => {
  const BOT_SUPPORT: BotChannelRow = { channelId: 'C0BOTSUP01', name: 'help', remember: true };
  const BOT_OPS: BotChannelRow = { channelId: 'C0BOTOPS01', name: 'ops-desk', remember: false };
  const withBotChannels = (read: AgentSlackRead, botChannels: BotChannelRow[]) =>
    ({ ...read, botChannels }) as AgentSlackRead;
  const botList = () => screen.findByRole('list', { name: 'Channels its own bot has answered in' });
  const NOTE =
    'When this is on, Quill remembers what people with access to it say here. It never remembers what anyone else says.';

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('live: the channels its own bot has answered in are listed under one line, each with a memory switch', async () => {
    renderIt(withBotChannels(ready(true, LIVE_BOT), [BOT_SUPPORT, BOT_OPS]));
    expect(await screen.findByText('@quill has answered in these channels.')).toBeInTheDocument();
    const list = await botList();
    expect(within(list).getByText('help')).toBeInTheDocument();
    expect(within(list).getByText('ops-desk')).toBeInTheDocument();
    const [first, second] = within(list).getAllByRole('switch', { name: 'Let Quill remember this channel' });
    expect(first).toBeChecked();
    expect(second).not.toBeChecked();
    expect(first).toHaveAccessibleDescription(NOTE);
    // No Disconnect and no "Connected by" on these rows.
    expect(within(list).queryByRole('button')).toBeNull();
    expect(within(list).queryByText(/Connected by/)).toBeNull();
  });

  it('a manager flips one: the switch holds its old place while the write is out, then lands', async () => {
    const write = deferred<void>();
    rememberBot.mockImplementationOnce(() => write.promise);
    renderIt(withBotChannels(ready(true, LIVE_BOT), [BOT_SUPPORT]));
    const toggle = within(await botList()).getByRole('switch', { name: 'Let Quill remember this channel' });
    fireEvent.click(toggle);
    await waitFor(() => expect(rememberBot).toHaveBeenCalledWith('a1', 'C0BOTSUP01', false));
    expect(toggle).toBeDisabled();
    expect(toggle).toBeChecked();
    write.resolve();
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(toggle).not.toBeDisabled();
  });

  it('a failed flip leaves the switch where it was and says nothing changed', async () => {
    rememberBot.mockRejectedValueOnce(new AgentSlackError(500, 'internal'));
    renderIt(withBotChannels(ready(true, LIVE_BOT), [BOT_SUPPORT]));
    const toggle = within(await botList()).getByRole('switch', { name: 'Let Quill remember this channel' });
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't change that, so nothing is different. Try again.");
    expect(toggle).toBeChecked();
    expect(toggle).not.toBeDisabled();
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not-connected'],
    [409, 'personal-agent'],
  ])('a refusal that says the page is stale (%i) reads the status again', async (status, code) => {
    rememberBot.mockRejectedValueOnce(new AgentSlackError(status, code));
    renderIt(withBotChannels(ready(true, LIVE_BOT), [BOT_SUPPORT]));
    const toggle = within(await botList()).getByRole('switch', { name: 'Let Quill remember this channel' });
    fetchStatus.mockResolvedValueOnce(ready(false, LIVE_BOT));
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Channels its own bot has answered in' })).toBeNull());
    expect(screen.queryByText(/nothing is different/)).toBeNull();
  });

  it('a member sees each channel, and the note only where memory is on; no switch', async () => {
    renderIt(withBotChannels(ready(false, LIVE_BOT), [BOT_SUPPORT, BOT_OPS]));
    const list = await botList();
    expect(within(list).getByText('help')).toBeInTheDocument();
    expect(within(list).getByText('ops-desk')).toBeInTheDocument();
    expect(within(list).queryByRole('switch')).toBeNull();
    expect(
      within(list).getAllByText(
        'Quill remembers what people with access to it say here. It never remembers what anyone else says.',
      ),
    ).toHaveLength(1);
  });

  it("with Slack not connected, a live bot's channels are still listed, and a manager can flip them", async () => {
    rememberBot.mockResolvedValueOnce();
    renderIt(withBotChannels({ state: 'no-workspace', canManage: true, bot: LIVE_BOT }, [BOT_OPS]));
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.getByText('@quill has answered in these channels.')).toBeInTheDocument();
    const toggle = within(await botList()).getByRole('switch', { name: 'Let Quill remember this channel' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(rememberBot).toHaveBeenCalledWith('a1', 'C0BOTOPS01', true));
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('no botChannels (an older host, or no live bot): no list', async () => {
    renderIt(ready(true, LIVE_BOT));
    await screen.findByText('@quill is live. Invite it to a channel with /invite @quill.');
    expect(screen.queryByText(/has answered in these channels/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Channels its own bot has answered in' })).toBeNull();
  });

  it('an empty botChannels draws nothing either', async () => {
    renderIt(withBotChannels(ready(true, LIVE_BOT), []));
    await screen.findByText('@quill is live. Invite it to a channel with /invite @quill.');
    expect(screen.queryByText(/has answered in these channels/)).toBeNull();
  });

  it('with no handle, the line names the bot', async () => {
    renderIt(withBotChannels(ready(true, { ...LIVE_BOT, handle: null }), [BOT_SUPPORT]));
    expect(await screen.findByText('Quill has answered in these channels.')).toBeInTheDocument();
  });

});
