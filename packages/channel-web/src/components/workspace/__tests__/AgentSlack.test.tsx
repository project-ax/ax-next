/**
 * The agent settings Slack section (TASK-1094). The wire client is mocked
 * here (its requests are pinned in `lib/__tests__/agent-slack.test.ts`); its
 * copy and error mapping are the real ones, so what a person reads is what
 * ships.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentSlack } from '../AgentSlack';
import {
  AGENT_SLACK_DM_COPY as DM,
  AgentSlackError,
  chooseSlackDmAgent,
  cancelSlackBot,
  cancelSlackBotRequest,
  disconnectSlackBot,
  fetchAgentSlack,
  renameAgentSlackBot,
  requestSlackBot,
  type AgentSlackBot,
  type AgentSlackRead,
  type BotChannelRow,
} from '@/lib/agent-slack';
import { renderSlackAvatar } from '@/lib/slack-avatar';
import { slackCardText, slackCardWordsFound } from '@/test-utils/slack-card-words';

vi.mock('@/lib/agent-slack', async (original) => ({
  ...(await original<typeof import('@/lib/agent-slack')>()),
  fetchAgentSlack: vi.fn(),
  chooseSlackDmAgent: vi.fn(),
  cancelSlackBot: vi.fn(),
  cancelSlackBotRequest: vi.fn(),
  disconnectSlackBot: vi.fn(),
  requestSlackBot: vi.fn(),
  claimAgentSlackBot: vi.fn(),
  renameAgentSlackBot: vi.fn(),
  setAgentSlackBotPicture: vi.fn(),
  replaceAgentSlackBotToken: vi.fn(),
}));
// jsdom has no canvas to draw the bot's picture on.
vi.mock('@/lib/slack-avatar', () => ({ renderSlackAvatar: vi.fn(), drawPickedSlackAvatar: vi.fn() }));

const fetchStatus = vi.mocked(fetchAgentSlack);
const cancel = vi.mocked(cancelSlackBot);
const disconnectBot = vi.mocked(disconnectSlackBot);
const request = vi.mocked(requestSlackBot);
const avatar = vi.mocked(renderSlackAvatar);
const rename = vi.mocked(renameAgentSlackBot);
const choose_dm = vi.mocked(chooseSlackDmAgent);

/** The bot's install id, as a manager's status carries it: the key its Remove from Slack takes. */
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

async function openMenu(name: string) {
  const trigger = await screen.findByRole('button', { name: `Actions for ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}

/** Pick an item from a ⋯. It runs once the menu has closed, so the caller awaits what it does. */
async function choose(menu: string, item: string) {
  fireEvent.click(within(await openMenu(menu)).getByRole('menuitem', { name: item }));
}

/** The live card's title, once it is drawn. */
const liveTitle = (who: string) => screen.findByRole('heading', { level: 3, name: `${who} is in Slack` });

afterEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued `mockResolvedValueOnce` values; reset these two so one test's leftovers can't answer the next.
  fetchStatus.mockReset();
  choose_dm.mockReset();
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
    // No bot card: nothing can be asked for while Slack isn't connected.
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it("no workspace, but the agent's own bot is live: the live card still shows", async () => {
    renderIt({ state: 'no-workspace', canManage: false, bot: LIVE_BOT });
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(await liveTitle('@quill')).toBeInTheDocument();
  });

  it('no workspace, with a pending request: it can still be cancelled (only a manager is told of it)', async () => {
    cancel.mockResolvedValueOnce({ appDeleted: true });
    renderIt({
      state: 'no-workspace',
      canManage: true,
      bot: { state: 'pending', botName: 'Quill', approver: 'Ada Lovelace', canContinue: false, installId: BOT_ID },
    });
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Waiting for Ada Lovelace to finish adding Quill in Slack' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue in Slack' })).toBeNull();
    fireEvent.click(within(await openMenu('Quill')).getByRole('menuitem', { name: 'Cancel request' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('a1', BOT_ID));
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
  });

  it('no workspace, with a request waiting for an admin: a manager can still cancel it', async () => {
    const cancelAsk = vi.mocked(cancelSlackBotRequest);
    cancelAsk.mockResolvedValue(undefined);
    // A request reaches only those who manage the agent, so the server says they do (TASK-1172's `canManage`).
    renderIt({
      state: 'no-workspace',
      canManage: true,
      bot: { state: 'requested', botName: 'Quill Bot', requestedAt: '2026-11-20T10:00:00.000Z' },
    });
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Waiting for an admin to approve Quill Bot' }),
    ).toBeInTheDocument();
    fireEvent.click(within(await openMenu('Quill Bot')).getByRole('menuitem', { name: 'Cancel request' }));
    await waitFor(() => expect(cancelAsk).toHaveBeenCalledWith('a1'));
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
  });

  it('a personal agent that answers direct messages: one line about the direct message, no button', async () => {
    renderIt({ state: 'personal-agent', botName: 'canopy', answersDms: true, dmAgentName: null });
    expect(await screen.findByText(/Quill is a personal agent.*direct message with canopy/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(slackCardWordsFound(slackCardText())).toEqual([]);
  });

  it('names the agent that answers, and offers this one', async () => {
    renderIt({ state: 'personal-agent', botName: 'canopy', answersDms: false, dmAgentName: 'Sprout' });
    expect(await screen.findByText(DM.goesTo('canopy', 'Sprout'))).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: DM.useInstead('Quill') })).toBeEnabled();
    expect(slackCardWordsFound(slackCardText())).toEqual([]);
  });

  it('two agents with one name read as "your other" and "this"', async () => {
    renderIt({ state: 'personal-agent', botName: 'canopy', answersDms: false, dmAgentName: ' quill ' });
    expect(await screen.findByText(DM.goesTo('canopy', DM.yourOther('quill')))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: DM.useInstead(DM.thisOne('Quill')) })).toBeInTheDocument();
    expect(slackCardWordsFound(slackCardText())).toEqual([]);
  });

  it('a server that names no agent shows the old kind of line and no button', async () => {
    renderIt({ state: 'personal-agent', botName: 'canopy', answersDms: false, dmAgentName: null });
    expect(await screen.findByText(DM.goesElsewhere('Quill', 'canopy'))).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(slackCardWordsFound(slackCardText())).toEqual([]);
  });

  it('an empty name from a mock that skipped the parser is no name', async () => {
    renderIt({ state: 'personal-agent', botName: 'canopy', answersDms: false, dmAgentName: '' });
    expect(await screen.findByText(DM.goesElsewhere('Quill', 'canopy'))).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  describe('the switch', () => {
    const elsewhere: AgentSlackRead = { state: 'personal-agent', botName: 'canopy', answersDms: false, dmAgentName: 'Sprout' };
    const here: AgentSlackRead = { state: 'personal-agent', botName: 'canopy', answersDms: true, dmAgentName: null };

    it('Use Quill instead switches, reads again, and says new messages go to Quill', async () => {
      fetchStatus.mockResolvedValueOnce(elsewhere).mockResolvedValueOnce(here);
      choose_dm.mockResolvedValue(undefined);
      render(<AgentSlack agentId="a1" agentName="Quill" />);
      fireEvent.click(await screen.findByRole('button', { name: DM.useInstead('Quill') }));
      const note = await screen.findByText(DM.switched('canopy', 'Quill', 'Sprout'));
      expect(choose_dm).toHaveBeenCalledTimes(1);
      expect(choose_dm).toHaveBeenCalledWith('a1');
      expect(fetchStatus).toHaveBeenCalledTimes(2);
      expect(document.activeElement).not.toBeNull();
      expect(note.closest('[role="alert"]')?.contains(document.activeElement)).toBe(true);
      expect(screen.queryByRole('button')).toBeNull();
      // Today's sentence still stands under it.
      expect(screen.getByText(DM.answersHere('Quill', 'canopy'))).toBeInTheDocument();
      expect(slackCardWordsFound(slackCardText())).toEqual([]);
    });

    it('while it switches, the button is disabled and two clicks before it re-renders send one request', async () => {
      const gate = deferred<void>();
      choose_dm.mockReturnValue(gate.promise);
      fetchStatus.mockResolvedValueOnce(elsewhere).mockResolvedValueOnce(here);
      render(<AgentSlack agentId="a1" agentName="Quill" />);
      const button = await screen.findByRole('button', { name: DM.useInstead('Quill') });
      // Two clicks before React renders the button disabled: only the in-flight ref stands between them.
      // (Separate fireEvent calls each flush their own render, so the second would hit a disabled button.)
      act(() => {
        button.click();
        button.click();
      });
      expect(choose_dm).toHaveBeenCalledTimes(1);
      const busy = await screen.findByRole('button', { name: DM.switching });
      expect(busy).toBeDisabled();
      fireEvent.click(busy);
      expect(choose_dm).toHaveBeenCalledTimes(1);
      gate.resolve();
      await screen.findByText(DM.switched('canopy', 'Quill', 'Sprout'));
      expect(choose_dm).toHaveBeenCalledTimes(1);
    });

    it('a failed switch says nothing changed and keeps the button', async () => {
      choose_dm.mockRejectedValue(new AgentSlackError(500, 'internal'));
      fetchStatus.mockResolvedValue(elsewhere);
      render(<AgentSlack agentId="a1" agentName="Quill" />);
      fireEvent.click(await screen.findByRole('button', { name: DM.useInstead('Quill') }));
      expect(await screen.findByText(DM.notSwitched)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: DM.useInstead('Quill') })).toBeEnabled();
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(slackCardWordsFound(slackCardText())).toEqual([]);
    });

    it('an out-of-date page reads again instead', async () => {
      choose_dm.mockRejectedValue(new AgentSlackError(404, 'not-found'));
      fetchStatus.mockResolvedValue(elsewhere);
      render(<AgentSlack agentId="a1" agentName="Quill" />);
      fireEvent.click(await screen.findByRole('button', { name: DM.useInstead('Quill') }));
      await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
      await screen.findByRole('button', { name: DM.useInstead('Quill') });
      expect(screen.queryByText(DM.notSwitched)).toBeNull();
    });

    it('a switch that landed, with a re-read that fails, still says it switched, above the load error', async () => {
      fetchStatus.mockResolvedValueOnce(elsewhere).mockRejectedValueOnce(new Error('boom'));
      choose_dm.mockResolvedValue(undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(<AgentSlack agentId="a1" agentName="Quill" />);
      fireEvent.click(await screen.findByRole('button', { name: DM.useInstead('Quill') }));
      expect(await screen.findByText(DM.switched('canopy', 'Quill', 'Sprout'))).toBeInTheDocument();
      expect(screen.getByText("We couldn't load the Slack settings.")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it("another agent's page doesn't show the confirmation", async () => {
      fetchStatus.mockResolvedValueOnce(elsewhere).mockResolvedValueOnce(here).mockResolvedValue(here);
      choose_dm.mockResolvedValue(undefined);
      const { rerender } = render(<AgentSlack agentId="a1" agentName="Quill" />);
      fireEvent.click(await screen.findByRole('button', { name: DM.useInstead('Quill') }));
      await screen.findByText(DM.switched('canopy', 'Quill', 'Sprout'));
      rerender(<AgentSlack agentId="a2" agentName="Fern" />);
      await screen.findByText(DM.answersHere('Fern', 'canopy'));
      expect(screen.queryByText(DM.switched('canopy', 'Quill', 'Sprout'))).toBeNull();
    });
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
  it("shows the bot's channels inside the bot card, and no picker or shared list", async () => {
    renderIt({
      state: 'ready',
      botName: 'canopy',
      workspaceName: 'Acme',
      canManage: true,
      bot: LIVE_BOT,
      botChannels: [{ channelId: 'C0BOTSUP01', name: 'help' }],
    });
    const heading = await liveTitle('@quill');
    const card = heading.closest('[data-slot="card"]') as HTMLElement;
    expect(
      within(card).getByText('@quill has answered in these channels.'),
    ).toBeInTheDocument();
    const list = within(card).getByRole('list', { name: 'Channels @quill has answered in' });
    expect(within(list).getByText('help')).toBeInTheDocument();
    expect(card.querySelector('[data-slot="card-description"]')).toHaveTextContent('In any Slack channel, type /invite @quill');
    // The only button on the card is a ⋯ or two: nothing hangs outside the menus.
    const menu = await openMenu('@quill');
    expect(within(menu).getByRole('menuitem', { name: 'Remove from Slack' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Connected channels' })).toBeNull();
    for (const gone of [/Connect a channel/, /Connected channels/, /still need/, /Connected by/, /\/ax\b/]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  });

  it.each(['none', 'requested', 'pending'] as const)(
    'a member who cannot manage the agent, with no live bot (%s), is told it is not in Slack yet rather than shown nothing',
    async (botState) => {
      const bot =
        botState === 'none'
          ? NO_BOT
          : ({ ...LIVE_BOT, state: botState } as unknown as AgentSlackBot);
      renderIt(ready(false, bot));
      expect(await screen.findByRole('heading', { level: 3, name: "Quill isn't in Slack yet" })).toBeInTheDocument();
      expect(screen.getByText('A team admin can add it.')).toBeInTheDocument();
      expect(screen.queryByRole('button')).toBeNull();
    },
  );

  it('a manager with no bot sees Add to Slack, not "A team admin can add it."', async () => {
    renderIt(ready(true, NO_BOT));
    // No token on file, so it opens on asking an admin.
    expect(await screen.findByRole('button', { name: 'Add to Slack' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: "Quill isn't in Slack yet" })).toBeInTheDocument();
    expect(screen.getByText("We'll ask an admin to approve it.")).toBeInTheDocument();
    expect(screen.queryByText('A team admin can add it.')).toBeNull();
  });

  it.each([true, false])(
    'live, with no channel left to invite: no "no channels" line (manager: %s), and the live line still says how to invite it',
    async (canManage) => {
      renderIt(ready(canManage, LIVE_BOT));
      expect(await liveTitle('@quill')).toBeInTheDocument();
      expect(screen.getByText('In any Slack channel, type', { exact: false })).toBeInTheDocument();
      expect(screen.queryByText(/isn't answering in any channels yet/)).toBeNull();
      expect(screen.queryByText(/isn't connected to any Slack channels yet/)).toBeNull();
      expect(screen.queryByText(/still need/)).toBeNull();
    },
  );

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
    fireEvent.click(within(await openMenu('Quill Bot')).getByRole('menuitem', { name: 'Cancel request' }));
    expect(await screen.findByText('Loading Slack settings…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Quill Bot' })).toBeNull();
    reRead.resolve(after);
    return view;
  }

  it('ready: the note is above the request form once the status is read again', async () => {
    await cancelThroughReRead(ready(true, PENDING_BOT), ready(true, NONE_STORED));
    expect(await screen.findByRole('button', { name: 'Add to Slack' })).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Add to Slack' })).toBeNull();
  });

  it('a cancel that deleted its Slack app leaves no note', async () => {
    await cancelThroughReRead(ready(true, PENDING_BOT), ready(true, NONE_STORED), true);
    expect(await screen.findByRole('button', { name: 'Add to Slack' })).toBeInTheDocument();
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
    expect(await screen.findByRole('button', { name: 'Add to Slack' })).toBeInTheDocument();
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });

  it('the note goes when a new bot is asked for', async () => {
    request.mockRejectedValueOnce(new AgentSlackError(502, 'slack-error'));
    await cancelThroughReRead(ready(true, PENDING_BOT), ready(true, NONE_STORED));
    expect(await screen.findByText(LEFT_OVER)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to Slack' }));
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
    await choose('@quill', 'Remove from Slack');
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Loading Slack settings…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for @quill' })).toBeNull();
    reRead.resolve(ready(true, NONE_STORED));
    expect(await screen.findByRole('button', { name: 'Add to Slack' })).toBeInTheDocument();
    const note = screen.getByText(LEFT_OVER);
    expect(note).toHaveTextContent(
      "We removed the bot from Slack, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete. Ada Lovelace set it up and can also delete it in Slack's app settings.",
    );
    expect(note.compareDocumentPosition(screen.getByLabelText('Bot name')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(disconnectBot).toHaveBeenCalledWith('a1', BOT_ID);
  });

  it('a page drawn before its bot was removed and replaced: Remove names the bot it showed, and no-bot reads the status again, which shows the new one', async () => {
    // The server refuses: that bot is gone, and the agent's live bot is a newer one.
    const NEWER: AgentSlackBot = { ...LIVE_BOT, botName: 'Quill Two', handle: 'quill_two', installId: 'Nw2Kq2Lw8vNc5Xr1Bm7KdB' };
    disconnectBot.mockRejectedValueOnce(new AgentSlackError(409, 'no-bot'));
    fetchStatus.mockResolvedValueOnce(ready(true, LIVE_BOT)).mockResolvedValueOnce(ready(true, NEWER));
    render(<AgentSlack agentId="a1" agentName="Quill" />);
    await choose('@quill', 'Remove from Slack');
    const dialog = await screen.findByRole('dialog', { name: 'Remove @quill from Slack?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await liveTitle('@quill_two')).toBeInTheDocument();
    expect(disconnectBot).toHaveBeenCalledTimes(1);
    expect(disconnectBot).toHaveBeenCalledWith('a1', BOT_ID);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("ready: a removal that deleted the Slack app leaves no note, and the dialog doesn't promise the shared bot back", async () => {
    disconnectBot.mockResolvedValueOnce({ appDeleted: true });
    fetchStatus.mockResolvedValueOnce(ready(true, LIVE_BOT)).mockResolvedValueOnce(ready(true, NONE_STORED));
    render(<AgentSlack agentId="a1" agentName="Quill" />);
    await choose('@quill', 'Remove from Slack');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).not.toHaveTextContent(/The shared bot answers/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('button', { name: 'Add to Slack' })).toBeInTheDocument();
    expect(screen.queryByText(LEFT_OVER)).toBeNull();
  });

  it('no workspace: a manager can remove a live bot (canManage from the server); a member has no ⋯', async () => {
    const { unmount } = renderIt({ state: 'no-workspace', canManage: true, bot: LIVE_BOT });
    expect(await liveTitle('@quill')).toBeInTheDocument();
    // Nothing on the shared bot to promise here: no channels are shown.
    await choose('@quill', 'Remove from Slack');
    expect(await screen.findByRole('dialog')).not.toHaveTextContent(/shared bot/);
    unmount();
    // As the server answers a member: no install id either.
    renderIt({ state: 'no-workspace', canManage: false, bot: { ...LIVE_BOT, installId: null } });
    expect(await liveTitle('@quill')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for @quill' })).toBeNull();
  });
});

describe('a bot set up again (TASK-1173)', () => {
  const GONE_BOT: AgentSlackBot = { ...LIVE_BOT, botName: 'Quill Bot', handle: 'quill_bot', approverGone: true };
  const NONE_STORED: AgentSlackBot = { state: 'none', configTokenStored: true };
  const LEFT_OVER = /couldn.t confirm its Slack app was deleted/;
  const NOTICE =
    "@quill_bot was removed from Slack. Add it again below. It's a new bot in Slack, so invite it to each channel again.";

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    avatar.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Set the gone-approver bot up again, holding the status re-read open until the loading face shows. */
  async function rebuildThroughReRead(appDeleted: boolean) {
    const reRead = deferred<AgentSlackRead>();
    fetchStatus.mockResolvedValueOnce(ready(true, GONE_BOT)).mockReturnValueOnce(reRead.promise);
    disconnectBot.mockResolvedValueOnce({ appDeleted });
    const view = render(<AgentSlack agentId="a1" agentName="Quill" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up again' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set up again' }));
    expect(await screen.findByText('Loading Slack settings…')).toBeInTheDocument();
    reRead.resolve(ready(true, NONE_STORED));
    expect(await screen.findByRole('button', { name: 'Add to Slack' })).toBeInTheDocument();
    return view;
  }

  it('after Set up again the form is prefilled with the old name, under the notice, with no left-over note when the app was deleted', async () => {
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
      "We removed the bot from Slack, but we couldn't confirm its Slack app was deleted, so it may still be on Slack. An admin can find it in Admin › Slack, under the apps we couldn't delete.",
    );
    expect(note).not.toHaveTextContent(/Ada Lovelace/);
  });

  it('asking for a new bot clears the notice', async () => {
    request.mockRejectedValueOnce(new AgentSlackError(502, 'slack-error'));
    await rebuildThroughReRead(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add to Slack' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong talking to Slack.');
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('another agent clears the notice and the prefill', async () => {
    const { rerender } = await rebuildThroughReRead(true);
    fetchStatus.mockResolvedValueOnce(ready(true, NONE_STORED));
    rerender(<AgentSlack agentId="a2" agentName="Rook" />);
    await waitFor(() => expect(fetchStatus).toHaveBeenLastCalledWith('a2'));
    expect(await screen.findByRole('button', { name: 'Add to Slack' })).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByLabelText('Bot name')).toHaveValue('Rook');
  });

  it('no workspace: a gone approver still gets the alert, with no Set up again button (a request needs the shared app)', async () => {
    renderIt({ state: 'no-workspace', canManage: true, bot: GONE_BOT });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '@quill_bot needs to be set up again. The person who added it to Slack has left. You can do this here once Slack is connected again.',
    );
    expect(screen.queryByRole('button', { name: 'Set up again' })).toBeNull();
  });
});

describe("what the agent hears is shared with anyone who talks to it (TASK-1203, TASK-1209)", () => {
  const SHARED = 'What Quill hears is shared with anyone who talks to Quill, and Quill may bring it up elsewhere.';

  it("a manager's form says it by the agent's name", async () => {
    renderIt(ready(true, NO_BOT));
    await screen.findByRole('button', { name: 'Add to Slack' });
    expect(screen.getByText(SHARED)).toBeInTheDocument();
  });

  it("the live card says it by the agent's name, not the bot's @handle", async () => {
    renderIt(ready(true, LIVE_BOT));
    await liveTitle('@quill');
    expect(screen.getByText(SHARED)).toBeInTheDocument();
    expect(screen.queryByText(/What @quill hears/)).toBeNull();
  });

  it('with Slack not connected, a live bot still says it', async () => {
    renderIt({ state: 'no-workspace', canManage: true, bot: LIVE_BOT });
    await liveTitle('@quill');
    expect(screen.getByText(SHARED)).toBeInTheDocument();
  });
});

describe("the agent's own bot's channels (TASK-1180, TASK-1187)", () => {
  const BOT_SUPPORT: BotChannelRow = { channelId: 'C0BOTSUP01', name: 'help' };
  const BOT_OPS: BotChannelRow = { channelId: 'C0BOTOPS01', name: 'ops-desk' };
  // What a host one deploy behind still sends (TASK-1202 removed the switch): the SPA must ignore `remember`.
  const LEGACY_OFF = { channelId: 'C0BOTOFF01', name: 'quiet-room', remember: false } as BotChannelRow;
  const withBotChannels = (read: AgentSlackRead, botChannels: BotChannelRow[]) =>
    ({ ...read, botChannels }) as AgentSlackRead;
  const botList = () => screen.findByRole('list', { name: 'Channels @quill has answered in' });
  const LEAD = '@quill has answered in these channels.';

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('live: the channels it has answered in are listed under one line, and none carries a memory setting', async () => {
    renderIt(withBotChannels(ready(true, LIVE_BOT), [BOT_SUPPORT, BOT_OPS]));
    expect(await screen.findByText(LEAD)).toBeInTheDocument();
    const list = await botList();
    expect(within(list).getByText('help')).toBeInTheDocument();
    expect(within(list).getByText('ops-desk')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).queryByRole('switch')).toBeNull();
    expect(within(list).queryByText(/Connected by/)).toBeNull();
  });

  // TASK-1202: the per-channel memory switch is gone, so a row has nothing to change: no ⋯ for anyone, and no
  // "Not remembered" badge, even for a row a host one deploy behind still sends with `remember: false`.
  it.each([
    ['a manager', true],
    ['a member', false],
  ] as const)('%s sees a public channel row with no ⋯ and no "Not remembered", whatever the payload says', async (_who, canManage) => {
    renderIt(withBotChannels(ready(canManage, LIVE_BOT), [BOT_SUPPORT, LEGACY_OFF]));
    const list = await botList();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('quiet-room')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for #help' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for #quiet-room' })).toBeNull();
    expect(within(list).queryByRole('button')).toBeNull();
    expect(within(list).queryByRole('menuitem')).toBeNull();
    expect(within(list).queryByText('Not remembered')).toBeNull();
    expect(slackCardWordsFound(slackCardText(list))).toEqual([]);
  });

  // TASK-1203: a private channel is remembered like any other, so its row says nothing about privacy. A host one
  // deploy behind still sends `isPrivate`: the SPA ignores it.
  it.each([
    ['a manager', true],
    ['a member', false],
  ] as const)("%s sees a private-flagged row drawn like the rest: no note, no ⋯", async (_who, canManage) => {
    const privateRoom = { channelId: 'C0BOTPRV01', name: 'leads', isPrivate: true } as BotChannelRow;
    renderIt(withBotChannels(ready(canManage, LIVE_BOT), [privateRoom, BOT_SUPPORT]));
    const list = await botList();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText("Private channels aren't remembered.")).toBeNull();
    expect(screen.queryByText(/never in private ones/)).toBeNull();
    expect(within(list).queryByRole('button')).toBeNull();
  });

  it("with Slack not connected, a live bot's channels are still listed", async () => {
    renderIt(withBotChannels({ state: 'no-workspace', canManage: true, bot: LIVE_BOT }, [BOT_OPS]));
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.getByText(LEAD)).toBeInTheDocument();
    const list = await botList();
    expect(within(list).getByText('ops-desk')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for #ops-desk' })).toBeNull();
  });

  it('no botChannels (an older host, or no live bot): no list', async () => {
    renderIt(ready(true, LIVE_BOT));
    await liveTitle('@quill');
    expect(screen.queryByText(/has answered in these channels/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Channels @quill has answered in' })).toBeNull();
  });

  it('an empty botChannels draws nothing either', async () => {
    renderIt(withBotChannels(ready(true, LIVE_BOT), []));
    await liveTitle('@quill');
    expect(screen.queryByText(/has answered in these channels/)).toBeNull();
  });

  it('with no handle, the line names the bot', async () => {
    renderIt(withBotChannels(ready(true, { ...LIVE_BOT, handle: null }), [BOT_SUPPORT]));
    expect(await screen.findByText('Quill has answered in these channels.')).toBeInTheDocument();
  });
});

/**
 * Design §4b.2: the card never names a role, the plumbing or the product. Each
 * view is scanned as a person reads it, every aria-label included. The
 * install-it-myself path is the one exception, so no scan here opens it.
 */
describe('words (TASK-1187): no plumbing word and no product name on the card', () => {
  const REQUESTED_BOT: AgentSlackBot = { state: 'requested', botName: 'Quill Bot', requestedAt: '2026-11-20T10:00:00.000Z' };
  const pendingBot = (canContinue: boolean): AgentSlackBot => ({
    state: 'pending',
    botName: 'Quill Bot',
    approver: 'Ada Lovelace',
    canContinue,
    installId: BOT_ID,
  });
  const expectClean = () => expect(slackCardWordsFound(slackCardText())).toEqual([]);

  it('a manager with no bot and no stored token', async () => {
    renderIt(ready(true, NO_BOT));
    await screen.findByRole('button', { name: 'Add to Slack' });
    expectClean();
  });

  it('a manager with a stored token, once they choose to ask an admin', async () => {
    renderIt(ready(true, { state: 'none', configTokenStored: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ask an admin instead' }));
    await screen.findByText("We'll ask an admin to approve it.");
    expectClean();
  });

  it('a member, with no bot', async () => {
    renderIt(ready(false, NO_BOT));
    await screen.findByText('A team admin can add it.');
    expectClean();
  });

  it('a manager waiting for an admin, and again with its menu open', async () => {
    renderIt(ready(true, REQUESTED_BOT));
    await screen.findByRole('heading', { level: 3, name: 'Waiting for an admin to approve Quill Bot' });
    expectClean();
    await openMenu('Quill Bot');
    expectClean();
  });

  it.each([true, false])('pending (the viewer finishes it in Slack: %s), and again with its menu open', async (canContinue) => {
    renderIt(ready(true, pendingBot(canContinue)));
    await screen.findByRole('button', { name: 'Actions for Quill Bot' });
    expectClean();
    await openMenu('Quill Bot');
    expectClean();
  });

  it('no workspace: a manager waiting for an admin', async () => {
    renderIt({ state: 'no-workspace', canManage: true, bot: REQUESTED_BOT });
    await screen.findByRole('heading', { level: 3, name: 'Waiting for an admin to approve Quill Bot' });
    expectClean();
  });

  describe('the live card', () => {
    const channels = (read: AgentSlackRead) => ({ ...read, botChannels: [BOT_HELP, BOT_OPS] }) as AgentSlackRead;
    const BOT_HELP: BotChannelRow = { channelId: 'C0BOTSUP01', name: 'help' };
    const BOT_OPS: BotChannelRow = { channelId: 'C0BOTOPS01', name: 'ops-desk' };
    const dismiss = async (menu: HTMLElement) => {
      fireEvent.keyDown(menu, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    };

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('a manager with channels, with the card menu open', async () => {
      renderIt(channels(ready(true, LIVE_BOT)));
      await liveTitle('@quill');
      expectClean();
      const cardMenu = await openMenu('@quill');
      expectClean();
      await dismiss(cardMenu);
    });

    it('a member', async () => {
      renderIt(channels(ready(false, { ...LIVE_BOT, installId: null })));
      await liveTitle('@quill');
      expectClean();
    });

    it.each([
      ['a manager, Slack connected', ready(true, { ...LIVE_BOT, approverGone: true })],
      ['a manager, no Slack workspace', { state: 'no-workspace', canManage: true, bot: { ...LIVE_BOT, approverGone: true } } as AgentSlackRead],
      ['a member', ready(false, { ...LIVE_BOT, approverGone: true, installId: null })],
    ])('the set-up-again row: %s', async (_, status) => {
      renderIt(status);
      await screen.findByRole('alert');
      expectClean();
    });

    it.each([
      ['a manager', ready(true, { ...LIVE_BOT, needsClaim: true })],
      ['a member', ready(false, { ...LIVE_BOT, needsClaim: true, installId: null })],
    ])('the take-over row: %s', async (_, status) => {
      renderIt(status);
      await screen.findByRole('alert');
      expectClean();
    });

    it.each([
      ['the person who set it up', { ...LIVE_BOT, viewerIsApprover: true }],
      ['another admin', LIVE_BOT],
    ])('the dead-token row, found by Rename: %s', async (_, bot) => {
      rename.mockRejectedValueOnce(new AgentSlackError(502, 'slack-config-token'));
      renderIt(ready(true, bot));
      await choose('@quill', 'Rename');
      const dialog = await screen.findByRole('dialog');
      fireEvent.submit(within(dialog).getByLabelText('Bot name').closest('form')!);
      await within(dialog).findByRole('alert');
      expectClean();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expectClean();
    });

    // The Reconnect dialog is the documented exception (it is the install-it-myself path's token dialog), so no scan opens it.
    it.each([
      ['Rename', LIVE_BOT, 'Rename', 'Cancel'],
      ['Change picture', LIVE_BOT, 'Change picture', 'Cancel'],
      ['Remove from Slack', LIVE_BOT, 'Remove from Slack', 'Cancel'],
    ])('the %s dialog', async (_, bot, item, decline) => {
      renderIt(ready(true, bot));
      await choose('@quill', item);
      const dialog = await screen.findByRole('dialog');
      expectClean();
      fireEvent.click(within(dialog).getByRole('button', { name: decline }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('the Set up again and Take over dialogs', async () => {
      const { unmount } = renderIt(ready(true, { ...LIVE_BOT, approverGone: true }));
      fireEvent.click(await screen.findByRole('button', { name: 'Set up again' }));
      const first = await screen.findByRole('dialog');
      expectClean();
      fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      unmount();
      renderIt(ready(true, { ...LIVE_BOT, needsClaim: true }));
      fireEvent.click(await screen.findByRole('button', { name: 'Take over' }));
      const second = await screen.findByRole('dialog');
      expectClean();
      fireEvent.click(within(second).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('the form after Set up again, with the removed notice and the left-over note', async () => {
      const reRead = deferred<AgentSlackRead>();
      fetchStatus.mockResolvedValueOnce(ready(true, { ...LIVE_BOT, approverGone: true })).mockReturnValueOnce(reRead.promise);
      disconnectBot.mockResolvedValueOnce({ appDeleted: false });
      render(<AgentSlack agentId="a1" agentName="Quill" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Set up again' }));
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set up again' }));
      await screen.findByText('Loading Slack settings…');
      reRead.resolve(ready(true, { state: 'none', configTokenStored: false }));
      await screen.findByText(/was removed from Slack/);
      await screen.findByText(/couldn.t confirm its Slack app was deleted/);
      expectClean();
    });
  });

  it('the install-it-myself path is the one place the token words show', async () => {
    renderIt(ready(true, NO_BOT));
    fireEvent.click(await screen.findByRole('button', { name: 'I can install Slack apps myself' }));
    await screen.findByLabelText('Refresh token');
    expect(slackCardWordsFound(slackCardText())).not.toEqual([]);
  });
});
