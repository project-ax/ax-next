/**
 * The dialogs on an agent's live Slack card (TASK-1171, TASK-1173, TASK-1187):
 * Rename and Change picture (from the card's ⋯), and Reconnect (the shared
 * token dialog, from the card's problem row). Each is rendered here through a
 * small Harness that owns `open`, as the card does. The wire client and the
 * browser's drawing are mocked (their requests and drawing are pinned in
 * `lib/__tests__`); the copy and the error mapping are the real ones, so what a
 * person reads is what ships. The token dialog's own promises (write-only, one
 * request at a time) are pinned in `slack/__tests__/BotTokenReplaceDialog.test.tsx`.
 * The card's own wiring (the ⋯, the problem row, the saved notice) is pinned in
 * `AgentSlackBot.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PictureDialog, ReconnectDialog, RenameDialog } from '../AgentSlackBotChanges';
import {
  AGENT_SLACK_BOT_CHANGE_COPY,
  AGENT_SLACK_COPY,
  AgentSlackError,
  renameAgentSlackBot,
  replaceAgentSlackBotToken,
  setAgentSlackBotPicture,
  type AgentSlackBot as Bot,
} from '@/lib/agent-slack';
import { SLACK_ERROR_COPY } from '@/lib/slack-admin';
import { drawPickedSlackAvatar } from '@/lib/slack-avatar';
import { BOT_NAME_COPY, SLACK_TOKEN_COPY } from '@/lib/slack-token-copy';
import { fakeConfigRefreshToken } from '@/test-utils/fake-slack-tokens';
import { slackCardText, slackCardWordsFound } from '@/test-utils/slack-card-words';

vi.mock('@/lib/agent-slack', async (original) => ({
  ...(await original<typeof import('@/lib/agent-slack')>()),
  renameAgentSlackBot: vi.fn(),
  replaceAgentSlackBotToken: vi.fn(),
  setAgentSlackBotPicture: vi.fn(),
}));
vi.mock('@/lib/slack-avatar', () => ({ drawPickedSlackAvatar: vi.fn() }));

const rename = vi.mocked(renameAgentSlackBot);
const replaceToken = vi.mocked(replaceAgentSlackBotToken);
const setPicture = vi.mocked(setAgentSlackBotPicture);
const draw = vi.mocked(drawPickedSlackAvatar);

type Live = Extract<Bot, { state: 'live' }>;

const LIVE: Live = {
  state: 'live',
  botName: 'Quill Bot',
  handle: 'quill_bot',
  approver: 'Ada Lovelace',
  needsClaim: false,
  approverGone: false,
  viewerIsApprover: false,
  installId: 'Hb7Kq2Lw8vNc5Xr1Bm7KdA',
};

const refusal = (status: number, code: string, reason: string | null = null) => new AgentSlackError(status, code, reason);

/** The same bot, as the person who set it up sees it. */
const MINE: Live = { ...LIVE, viewerIsApprover: true };
/** The same bot after the person who set it up left. */
const ORPHANED: Live = { ...LIVE, approver: 'A teammate', approverGone: true };

type Which = 'rename' | 'picture' | 'reconnect';
interface Calls {
  onChanged: Mock<() => void>;
  onSaved: Mock<() => void>;
  onTokenDead: Mock<() => void>;
  onReconnected: Mock<() => void>;
}

/** Owns `open`, as the card does, and has an Open button to reopen the dialog once it closes. */
function Harness({ which, bot, calls }: { which: Which; bot: Live; calls: Calls }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {which === 'rename' && (
        <RenameDialog
          open={open}
          onOpenChange={setOpen}
          agentId="a1"
          bot={bot}
          onTokenDead={calls.onTokenDead}
          onChanged={calls.onChanged}
        />
      )}
      {which === 'picture' && (
        <PictureDialog
          open={open}
          onOpenChange={setOpen}
          agentId="a1"
          bot={bot}
          onTokenDead={calls.onTokenDead}
          onSaved={calls.onSaved}
          onChanged={calls.onChanged}
        />
      )}
      {which === 'reconnect' && (
        <ReconnectDialog
          open={open}
          onOpenChange={setOpen}
          agentId="a1"
          bot={bot}
          onReconnected={calls.onReconnected}
          onStale={calls.onChanged}
        />
      )}
    </>
  );
}

function renderIt(which: Which, bot: Live = LIVE): Calls {
  const calls: Calls = { onChanged: vi.fn(), onSaved: vi.fn(), onTokenDead: vi.fn(), onReconnected: vi.fn() };
  render(<Harness which={which} bot={bot} calls={calls} />);
  return calls;
}

/** Reopen the dialog once it has closed. */
function reopen() {
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
}

function nameInput() {
  return screen.getByLabelText('Bot name') as HTMLInputElement;
}

function typeName(input: HTMLInputElement, name: string) {
  fireEvent.change(input, { target: { value: name } });
}

/** Pick a file in the open picture dialog that draws as `png` (null: the browser can't draw it). */
async function pick(png: string | null) {
  draw.mockResolvedValueOnce(png);
  const file = new File(['x'], 'logo.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('Image file'), { target: { files: [file] } });
  await waitFor(() => expect(draw).toHaveBeenCalledTimes(1));
  // The drawing was asked for; wait until its result is what the dialog shows,
  // so a click on Save can't land before the picture is in state.
  if (png === null) await screen.findByText(AGENT_SLACK_BOT_CHANGE_COPY.badPicture);
  else await waitFor(() => expect(screen.getByRole('button', { name: 'Save picture' })).toBeEnabled());
}

beforeEach(() => {
  // reset, not clear: a queued `*Once` value from a failed test must not leak into the next.
  // The mocks have no default implementations; each test queues what it needs.
  vi.resetAllMocks();
});

describe('Rename', () => {
  it('opens on the current name; saving sends the typed name, closes the dialog, then reads the status again', async () => {
    rename.mockResolvedValueOnce({ botName: 'Quill Desk' });
    const { onChanged } = renderIt('rename');
    const input = nameInput();
    expect(screen.getByRole('dialog')).toHaveTextContent('Rename the bot');
    expect(
      screen.getByText("Only the name changes. It stays in the channels it's in, and nobody has to invite it again."),
    ).toBeInTheDocument();
    expect(screen.getByText('The name people see in Slack.')).toBeInTheDocument();
    expect(input.value).toBe('Quill Bot');
    typeName(input, 'Quill Desk');
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(rename).toHaveBeenCalledWith('a1', 'Quill Desk');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['invalid-bot-name', 400, 'too-long', BOT_NAME_COPY['too-long']],
    ['bot-name-taken', 409, null, SLACK_TOKEN_COPY['bot-name-taken']],
  ])(
    'a refused name (%s) stays in the dialog under the field, and focus returns to it',
    async (code, status, reason, line) => {
      rename.mockRejectedValueOnce(refusal(status, code, reason));
      const { onChanged } = renderIt('rename');
      const input = nameInput();
      typeName(input, 'Other');
      fireEvent.submit(input.closest('form')!);
      const error = await screen.findByText(line as string);
      expect(error.closest('[data-slot="field-error"]')).not.toBeNull();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await waitFor(() => expect(input).toHaveFocus());
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(onChanged).not.toHaveBeenCalled();
    },
  );

  it('a token Slack refuses says what to do and who can, tells the card once, and nothing is re-read', async () => {
    rename.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    const { onChanged, onTokenDead } = renderIt('rename');
    fireEvent.submit(nameInput().closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Changes to @quill_bot can't reach Slack right now. Ask Ada Lovelace to reconnect it.",
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onTokenDead).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a refused name does not tell the card the token is dead', async () => {
    rename.mockRejectedValueOnce(refusal(409, 'bot-name-taken'));
    const { onTokenDead } = renderIt('rename');
    fireEvent.submit(nameInput().closest('form')!);
    await screen.findByText(SLACK_TOKEN_COPY['bot-name-taken']);
    expect(onTokenDead).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'not-live'],
    [403, 'forbidden'],
    [404, 'not-found'],
  ])('a stale refusal (%s %s) closes the dialog and reads the status again', async (status, code) => {
    rename.mockRejectedValueOnce(refusal(status, code));
    const { onChanged } = renderIt('rename');
    fireEvent.submit(nameInput().closest('form')!);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("while Slack answers, Escape doesn't close the dialog and the button reads Renaming…", async () => {
    let settle: (v: { botName: string }) => void = () => {};
    rename.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    const { onChanged } = renderIt('rename');
    fireEvent.submit(nameInput().closest('form')!);
    expect(await screen.findByRole('button', { name: 'Renaming…' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    settle({ botName: 'Quill Bot' });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel closes without sending, and reopening starts from the current name again', async () => {
    renderIt('rename');
    typeName(nameInput(), 'Typed then dropped');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    reopen();
    expect(nameInput().value).toBe('Quill Bot');
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('Change picture', () => {
  it('picking an image shows what Slack will get; saving sends exactly that PNG and tells the card, without re-reading', async () => {
    setPicture.mockResolvedValueOnce(undefined);
    const { onChanged, onSaved } = renderIt('picture');
    await pick('UE5H');
    expect(screen.getByRole('dialog')).toHaveTextContent("Change the bot's picture");
    // The hidden file input is not a Tab stop; the visible button opens it.
    expect(screen.getByLabelText('Image file')).toHaveAttribute('tabindex', '-1');
    expect(
      screen.getByText("Pick an image from your computer. We'll center it on a white square for Slack."),
    ).toBeInTheDocument();
    const img = await screen.findByAltText('The new picture');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,UE5H');
    expect(screen.getByRole('button', { name: 'Choose another' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(setPicture).toHaveBeenCalledWith('a1', 'UE5H');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Save picture is off until an image is picked, and a reopened dialog starts empty', async () => {
    setPicture.mockResolvedValueOnce(undefined);
    renderIt('picture');
    expect(screen.getByRole('button', { name: 'Save picture' })).toBeDisabled();
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    reopen();
    expect(screen.getByRole('button', { name: 'Save picture' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose an image' })).toBeInTheDocument();
  });

  it("an image the browser can't draw says so, and Save stays off", async () => {
    renderIt('picture');
    await pick(null);
    expect(await screen.findByText(AGENT_SLACK_BOT_CHANGE_COPY.badPicture)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save picture' })).toBeDisabled();
    expect(screen.queryByAltText('The new picture')).toBeNull();
    expect(setPicture).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'invalid-icon', AGENT_SLACK_BOT_CHANGE_COPY.badPicture],
    [502, 'slack-config-token', "Changes to @quill_bot can't reach Slack right now. Ask Ada Lovelace to reconnect it."],
    [502, 'slack-app-gone', AGENT_SLACK_BOT_CHANGE_COPY.appGone],
    [502, 'slack-error', SLACK_ERROR_COPY.generic],
  ])('a refused picture (%s %s) says why and stays open', async (status, code, line) => {
    setPicture.mockRejectedValueOnce(refusal(status, code));
    const { onChanged } = renderIt('picture');
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(line);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a stale refusal closes the dialog and reads the status again', async () => {
    setPicture.mockRejectedValueOnce(refusal(409, 'not-live'));
    const { onChanged } = renderIt('picture');
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("while Slack answers, Escape doesn't close the dialog and the button reads Saving…", async () => {
    let settle: () => void = () => {};
    setPicture.mockReturnValueOnce(new Promise<void>((resolve) => (settle = resolve)));
    renderIt('picture');
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    settle();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

const TOKEN = fakeConfigRefreshToken('APPROVERPASTESECRET');

function openReplace(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Replace your Slack token' });
}

function pasteAndSubmit(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('Refresh token'), { target: { value: TOKEN } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Replace token' }));
}

describe('ReconnectDialog (TASK-1173, TASK-1187)', () => {
  it('opens the shared token dialog for this bot', () => {
    renderIt('reconnect', MINE);
    const dialog = openReplace();
    expect(dialog).toHaveAccessibleDescription(
      'Do this when the configuration token we have for you stops working. Quill Bot stays in its channels, and nobody has to invite it again.',
    );
    expect(replaceToken).not.toHaveBeenCalled();
  });

  it('a replace sends the pasted token for this agent, closes the dialog and tells the card, with nothing read again', async () => {
    replaceToken.mockResolvedValueOnce(undefined);
    const { onChanged, onReconnected } = renderIt('reconnect', MINE);
    pasteAndSubmit(openReplace());
    await waitFor(() => expect(onReconnected).toHaveBeenCalledTimes(1));
    expect(replaceToken).toHaveBeenCalledTimes(1);
    expect(replaceToken).toHaveBeenCalledWith('a1', TOKEN);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it.each([
    [400, 'invalid-refresh-token', 'field', SLACK_TOKEN_COPY['invalid-refresh-token']],
    [502, 'slack-refresh-token', 'field', SLACK_TOKEN_COPY['slack-refresh-token']],
    [
      502,
      'slack-not-app-manager',
      'field',
      "Slack says that token can't manage this bot. Only the person who set a bot up can replace its token, with a new token of their own from this Slack workspace.",
    ],
    [409, 'public-origin-not-https', 'alert', SLACK_ERROR_COPY['public-origin-not-https']],
    [502, 'slack-error', 'alert', SLACK_ERROR_COPY.generic],
    [500, 'internal', 'alert', AGENT_SLACK_COPY.generic],
  ])(
    'a refused replace (%s %s) says why in the dialog, never the raw code, and nothing is read again',
    async (status, code, where, line) => {
      replaceToken.mockRejectedValueOnce(refusal(status, code));
      const { onChanged, onReconnected } = renderIt('reconnect', MINE);
      const dialog = openReplace();
      pasteAndSubmit(dialog);
      const shown = await within(dialog).findByText(line);
      expect(shown.closest(where === 'field' ? '[data-slot="field-error"]' : '[role="alert"]')).not.toBeNull();
      expect(screen.getByRole('dialog', { name: 'Replace your Slack token' })).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(code);
      expect(document.body.textContent).not.toMatch(/\bAX\b/);
      expect(onReconnected).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();
      expect(document.body.innerHTML).not.toContain(TOKEN);
    },
  );

  it.each([
    [403, 'not-approver'],
    [409, 'not-live'],
    [403, 'forbidden'],
    [404, 'not-found'],
  ])(
    'a refusal that says the page is out of date (%s %s) closes the dialog and reads the status again',
    async (status, code) => {
      replaceToken.mockRejectedValueOnce(refusal(status, code));
      const { onChanged, onReconnected } = renderIt('reconnect', MINE);
      pasteAndSubmit(openReplace());
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(onReconnected).not.toHaveBeenCalled();
    },
  );

});

describe('a dead token: Rename and Change picture say what to do and who can, and tell the card (TASK-1187)', () => {
  it.each([
    ['the viewer set the bot up', MINE, "Changes to @quill_bot can't reach Slack right now. Reconnect it, then try again."],
    ['the person who set it up has left', ORPHANED, '@quill_bot needs to be set up again before it can be changed.'],
    ['someone else set it up', LIVE, "Changes to @quill_bot can't reach Slack right now. Ask Ada Lovelace to reconnect it."],
  ])('%s', async (_, bot, line) => {
    rename.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    setPicture.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    const renamed = renderIt('rename', bot);
    fireEvent.submit(nameInput().closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(line);
    expect(renamed.onTokenDead).toHaveBeenCalledTimes(1);
    expect(renamed.onChanged).not.toHaveBeenCalled();
    cleanup();
    const pictured = renderIt('picture', bot);
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(line);
    expect(pictured.onTokenDead).toHaveBeenCalledTimes(1);
    expect(pictured.onChanged).not.toHaveBeenCalled();
  });
});
describe('words', () => {
  it('Rename and Change picture, each with a refusal showing, never write a forbidden word', async () => {
    rename.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    renderIt('rename', MINE);
    fireEvent.submit(nameInput().closest('form')!);
    await screen.findByRole('alert');
    expect(slackCardWordsFound(slackCardText())).toEqual([]);
    cleanup();
    setPicture.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    renderIt('picture', ORPHANED);
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    await screen.findByRole('alert');
    expect(slackCardWordsFound(slackCardText())).toEqual([]);
  });
});
