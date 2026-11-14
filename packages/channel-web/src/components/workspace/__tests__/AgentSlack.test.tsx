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
  connectSlackChannel,
  disconnectSlackChannel,
  fetchAgentSlack,
  fetchAvailableChannels,
  setSlackChannelRemember,
  type AgentSlackRead,
  type SlackChannelRow,
} from '@/lib/agent-slack';

vi.mock('@/lib/agent-slack', async (original) => ({
  ...(await original<typeof import('@/lib/agent-slack')>()),
  fetchAgentSlack: vi.fn(),
  fetchAvailableChannels: vi.fn(),
  connectSlackChannel: vi.fn(),
  disconnectSlackChannel: vi.fn(),
  setSlackChannelRemember: vi.fn(),
}));

const fetchStatus = vi.mocked(fetchAgentSlack);
const fetchAvailable = vi.mocked(fetchAvailableChannels);
const connect = vi.mocked(connectSlackChannel);
const disconnect = vi.mocked(disconnectSlackChannel);
const remember = vi.mocked(setSlackChannelRemember);

const SUPPORT: SlackChannelRow = {
  channelId: 'C0SUPPORT1',
  name: 'support',
  remember: false,
  connectedBy: 'Ada Lovelace',
  needsReconnect: false,
};
const OPS: SlackChannelRow = { ...SUPPORT, channelId: 'C0OPS00001', name: 'ops', remember: true, needsReconnect: true };

function ready(channels: SlackChannelRow[], canManage = true): AgentSlackRead {
  return { state: 'ready', botName: 'canopy', workspaceName: 'Acme', canManage, channels };
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
    renderIt({ state: 'no-workspace' });
    expect(await screen.findByText(/Slack isn't connected to this workspace yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
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
    fetchStatus.mockResolvedValueOnce({ state: 'no-workspace' });
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
  });

  it('a member reads the list: no switch, no Disconnect, no combobox', async () => {
    renderIt(ready([SUPPORT, OPS], false));
    const list = await screen.findByRole('list', { name: 'Connected channels' });
    expect(within(list).getByText('ops')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Quill remembers this channel.')).toBeInTheDocument();
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
