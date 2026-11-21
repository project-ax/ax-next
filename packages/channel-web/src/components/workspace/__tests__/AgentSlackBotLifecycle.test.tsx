/**
 * Rebuild and Claim, the two dialogs a live bot's needs-attention lines lead to
 * (TASK-1173). The wire client is mocked (its requests are pinned in
 * `lib/__tests__/agent-slack.test.ts`); the copy and the error mapping are the
 * real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ClaimBotDialog, RebuildBotDialog } from '../AgentSlackBotLifecycle';
import {
  AgentSlackError,
  claimAgentSlackBot,
  disconnectSlackBot,
  type AgentSlackBot as Bot,
} from '@/lib/agent-slack';

vi.mock('@/lib/agent-slack', async (original) => ({
  ...(await original<typeof import('@/lib/agent-slack')>()),
  claimAgentSlackBot: vi.fn(),
  disconnectSlackBot: vi.fn(),
}));

const disconnect = vi.mocked(disconnectSlackBot);
const claim = vi.mocked(claimAgentSlackBot);

const BOT_ID = 'Hb7Kq2Lw8vNc5Xr1Bm7KdA';
type Live = Extract<Bot, { state: 'live' }>;
const LIVE: Live = {
  state: 'live',
  botName: 'Quill Bot',
  handle: 'quill_bot',
  approver: 'Ada Lovelace',
  needsClaim: false,
  approverGone: true,
  viewerIsApprover: false,
  installId: BOT_ID,
};

const refusal = (status: number, code: string) => new AgentSlackError(status, code, null);

beforeEach(() => {
  disconnect.mockResolvedValue({ appDeleted: true });
  claim.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function renderRebuild(bot: Live = LIVE) {
  const calls = { onClose: vi.fn(), onCancelled: vi.fn(), onRebuilt: vi.fn(), onChanged: vi.fn() };
  render(<RebuildBotDialog open agentId="a1" bot={bot} installId={BOT_ID} {...calls} />);
  return calls;
}

function renderClaim(bot: Live = { ...LIVE, needsClaim: true, approverGone: false }) {
  const calls = { onClose: vi.fn(), onChanged: vi.fn() };
  render(<ClaimBotDialog open agentId="a1" bot={bot} installId={BOT_ID} {...calls} />);
  return calls;
}

describe('RebuildBotDialog', () => {
  it('says what a rebuild does, in the pinned words, and never writes AX', async () => {
    renderRebuild();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Rebuild @quill_bot?' })).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "We'll disconnect @quill_bot and delete its Slack app. Then you set up a new bot here. It gets a new @handle, so every channel needs /invite again. If Slack won't let us delete the old app, it may need deleting by hand in Slack's app settings.",
      ),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/\bAX\b/);
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Rebuild' })).toBeEnabled();
  });

  it('names the bot when it has no handle', async () => {
    renderRebuild({ ...LIVE, handle: null });
    expect(await screen.findByRole('heading', { name: 'Rebuild Quill Bot?' })).toBeInTheDocument();
  });

  it('Keep it sends nothing and closes', async () => {
    const { onClose } = renderRebuild();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep it' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('confirming disconnects the bot shown by its id, then says how it went, offers the name back, and reads again, in that order', async () => {
    disconnect.mockResolvedValueOnce({ appDeleted: false });
    const order: string[] = [];
    const onCancelled = vi.fn(() => order.push('cancelled'));
    const onRebuilt = vi.fn(() => order.push('rebuilt'));
    const onChanged = vi.fn(() => order.push('changed'));
    render(
      <RebuildBotDialog
        open
        agentId="a1"
        bot={LIVE}
        installId={BOT_ID}
        onClose={vi.fn()}
        onCancelled={onCancelled}
        onRebuilt={onRebuilt}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith('a1', BOT_ID);
    expect(onCancelled).toHaveBeenCalledWith({
      how: 'disconnected',
      appDeleted: false,
      approverIsViewer: false,
      approver: 'Ada Lovelace',
      approverGone: true,
    });
    expect(onRebuilt).toHaveBeenCalledWith({ botName: 'Quill Bot', handle: 'quill_bot' });
    expect(order).toEqual(['cancelled', 'rebuilt', 'changed']);
  });

  it('hands up the viewer as the approver when they set the bot up', async () => {
    const { onCancelled, onChanged } = renderRebuild({ ...LIVE, viewerIsApprover: true, approverGone: false });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onCancelled).toHaveBeenCalledWith(expect.objectContaining({ approverIsViewer: true, approverGone: false }));
  });

  it('busy face says Disconnecting… and a second press sends nothing', async () => {
    let finish!: (v: { appDeleted: boolean }) => void;
    disconnect.mockReturnValueOnce(new Promise((r) => (finish = r)));
    renderRebuild();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rebuild' }));
    const busy = await within(dialog).findByRole('button', { name: /Disconnecting…/ });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(disconnect).toHaveBeenCalledTimes(1);
    finish({ appDeleted: true });
  });

  it('a stale page (the bot is already gone) closes and reads again, with nothing handed up', async () => {
    disconnect.mockRejectedValueOnce(refusal(409, 'no-bot'));
    const { onClose, onCancelled, onRebuilt, onChanged } = renderRebuild();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCancelled).not.toHaveBeenCalled();
    expect(onRebuilt).not.toHaveBeenCalled();
  });

  it('any other refusal says so in the dialog and keeps the bot', async () => {
    disconnect.mockRejectedValueOnce(refusal(500, 'internal'));
    const { onCancelled, onRebuilt, onChanged } = renderRebuild();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rebuild' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Something went wrong. Try again in a minute.');
    expect(onCancelled).not.toHaveBeenCalled();
    expect(onRebuilt).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Rebuild' })).toBeEnabled();
  });
});

describe('ClaimBotDialog', () => {
  it('says what a claim does, in the pinned words, and never writes AX', async () => {
    renderClaim();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Claim @quill_bot?' })).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Right now @quill_bot answers only team members. Once you claim it, it answers people outside the team with your access, and anything it needs approved waits in your Today.',
      ),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/\bAX\b/);
    expect(within(dialog).getByRole('button', { name: 'Not now' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Claim it' })).toBeEnabled();
  });

  it('Not now sends nothing and closes', async () => {
    const { onClose } = renderClaim();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Not now' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it('Claim it posts the id the page showed, then reads the status again', async () => {
    const { onChanged } = renderClaim();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Claim it' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith('a1', BOT_ID);
  });

  it('busy face says Claiming… and a second press sends nothing', async () => {
    let finish!: () => void;
    claim.mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
    renderClaim();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Claim it' }));
    const busy = await within(dialog).findByRole('button', { name: /Claiming…/ });
    fireEvent.click(busy);
    expect(claim).toHaveBeenCalledTimes(1);
    finish();
  });

  it('claim-not-needed (someone else claimed it, or the requester is back) closes silently and reads again', async () => {
    claim.mockRejectedValueOnce(refusal(409, 'claim-not-needed'));
    const { onClose, onChanged } = renderClaim();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Claim it' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('any other refusal says the generic line in the dialog and reads nothing', async () => {
    claim.mockRejectedValueOnce(refusal(500, 'internal'));
    const { onChanged } = renderClaim();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Claim it' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Something went wrong. Try again in a minute.');
    expect(onChanged).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Claim it' })).toBeEnabled();
  });
});
