/**
 * Rename, Change picture and (for the person who set the bot up) Replace token
 * on an agent's live Slack bot (TASK-1171, TASK-1173). The wire client and the
 * browser's drawing are mocked (their requests and drawing are pinned in
 * `lib/__tests__`); the copy and the error mapping are the real ones, so what a
 * person reads is what ships. The token dialog's own promises (write-only, one
 * request at a time) are pinned in `slack/__tests__/BotTokenReplaceDialog.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BotChanges } from '../AgentSlackBotChanges';
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

function renderIt(bot: Live = LIVE) {
  const onChanged = vi.fn();
  render(<BotChanges agentId="a1" bot={bot} onChanged={onChanged} />);
  return onChanged;
}

function openRename() {
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  return screen.getByLabelText('Bot name') as HTMLInputElement;
}

function typeName(input: HTMLInputElement, name: string) {
  fireEvent.change(input, { target: { value: name } });
}

/** Open the picture dialog and pick a file that draws as `png` (null: the browser can't draw it). */
async function pick(png: string | null) {
  draw.mockResolvedValueOnce(png);
  fireEvent.click(screen.getByRole('button', { name: 'Change picture' }));
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

describe('the bot row', () => {
  it("shows the bot's name with Rename, and a Change picture button", () => {
    renderIt();
    expect(screen.getByText('Bot name')).toBeInTheDocument();
    expect(screen.getByText('Quill Bot')).toBeInTheDocument();
    expect(screen.getByText('Picture')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Change picture' })).toBeEnabled();
  });
});

describe('Rename', () => {
  it('opens on the current name; saving sends the typed name, closes the dialog, then reads the status again', async () => {
    rename.mockResolvedValueOnce({ botName: 'Quill Desk' });
    const onChanged = renderIt();
    const input = openRename();
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
      const onChanged = renderIt();
      const input = openRename();
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

  it('a token Slack refuses names the approver, and nothing is re-read', async () => {
    rename.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    const onChanged = renderIt();
    fireEvent.submit(openRename().closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent("This bot's Slack token needs replacing by Ada Lovelace.");
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'not-live'],
    [403, 'forbidden'],
    [404, 'not-found'],
  ])('a stale refusal (%s %s) closes the dialog and reads the status again', async (status, code) => {
    rename.mockRejectedValueOnce(refusal(status, code));
    const onChanged = renderIt();
    fireEvent.submit(openRename().closest('form')!);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("while Slack answers, Escape doesn't close the dialog and the button reads Renaming…", async () => {
    let settle: (v: { botName: string }) => void = () => {};
    rename.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    const onChanged = renderIt();
    fireEvent.submit(openRename().closest('form')!);
    expect(await screen.findByRole('button', { name: 'Renaming…' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    settle({ botName: 'Quill Bot' });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel closes without sending, and reopening starts from the current name again', async () => {
    renderIt();
    typeName(openRename(), 'Typed then dropped');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(openRename().value).toBe('Quill Bot');
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('Change picture', () => {
  it('picking an image shows what Slack will get; saving sends exactly that PNG and says Slack has it, without re-reading', async () => {
    setPicture.mockResolvedValueOnce(undefined);
    const onChanged = renderIt();
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Slack has the new picture.');
    expect(setPicture).toHaveBeenCalledWith('a1', 'UE5H');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Save picture is off until an image is picked, and opening a dialog clears the old notice', async () => {
    setPicture.mockResolvedValueOnce(undefined);
    renderIt();
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    await screen.findByText(AGENT_SLACK_BOT_CHANGE_COPY.pictureChanged);
    fireEvent.click(screen.getByRole('button', { name: 'Change picture' }));
    expect(screen.queryByText(AGENT_SLACK_BOT_CHANGE_COPY.pictureChanged)).toBeNull();
    expect(screen.getByRole('button', { name: 'Save picture' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose an image' })).toBeInTheDocument();
  });

  it("an image the browser can't draw says so, and Save stays off", async () => {
    renderIt();
    await pick(null);
    expect(await screen.findByText(AGENT_SLACK_BOT_CHANGE_COPY.badPicture)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save picture' })).toBeDisabled();
    expect(screen.queryByAltText('The new picture')).toBeNull();
    expect(setPicture).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'invalid-icon', AGENT_SLACK_BOT_CHANGE_COPY.badPicture],
    [502, 'slack-config-token', "This bot's Slack token needs replacing by Ada Lovelace."],
    [502, 'slack-app-gone', AGENT_SLACK_BOT_CHANGE_COPY.appGone],
    [502, 'slack-error', SLACK_ERROR_COPY.generic],
  ])('a refused picture (%s %s) says why and stays open', async (status, code, line) => {
    setPicture.mockRejectedValueOnce(refusal(status, code));
    const onChanged = renderIt();
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(line);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a stale refusal closes the dialog and reads the status again', async () => {
    setPicture.mockRejectedValueOnce(refusal(409, 'not-live'));
    const onChanged = renderIt();
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("while Slack answers, Escape doesn't close the dialog and the button reads Saving…", async () => {
    let settle: () => void = () => {};
    setPicture.mockReturnValueOnce(new Promise<void>((resolve) => (settle = resolve)));
    renderIt();
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
const REPLACED =
  "Token replaced. We now use it for Quill Bot and every other Slack app you set up here. Don't revoke the token you just pasted: it's the one we use now.";

function openReplace(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
  return screen.getByRole('dialog', { name: 'Replace your Slack token' });
}

function pasteAndSubmit(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('Refresh token'), { target: { value: TOKEN } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Replace token' }));
}

describe('Slack token: Replace, for the person who set the bot up (TASK-1173)', () => {
  it.each([
    ['a team admin who did not set it up', LIVE],
    ['anyone, once the person who set it up has left', ORPHANED],
  ])('%s gets no Slack token row', (_, bot) => {
    renderIt(bot);
    expect(screen.queryByText('Slack token')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace token' })).toBeNull();
  });

  it('the person who set it up gets a Slack token row whose Replace token opens the dialog for this bot', () => {
    renderIt(MINE);
    expect(screen.getByText('Slack token').tagName).toBe('DT');
    const dialog = openReplace();
    expect(dialog).toHaveAccessibleDescription(
      'Do this when the configuration token we have for you stops working. Quill Bot stays in its channels, and nobody has to invite it again.',
    );
    expect(replaceToken).not.toHaveBeenCalled();
  });

  it('a replace sends the pasted token for this agent; the dialog closes and the notice says the token now serves every Slack app they set up, with nothing read again', async () => {
    replaceToken.mockResolvedValueOnce(undefined);
    const onChanged = renderIt(MINE);
    pasteAndSubmit(openReplace());
    const notice = await screen.findByText(REPLACED);
    expect(notice.closest('[role="alert"]')).not.toBeNull();
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
      const onChanged = renderIt(MINE);
      const dialog = openReplace();
      pasteAndSubmit(dialog);
      const shown = await within(dialog).findByText(line);
      expect(shown.closest(where === 'field' ? '[data-slot="field-error"]' : '[role="alert"]')).not.toBeNull();
      expect(screen.getByRole('dialog', { name: 'Replace your Slack token' })).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(code);
      expect(document.body.textContent).not.toMatch(/\bAX\b/);
      expect(screen.queryByText(REPLACED)).toBeNull();
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
      const onChanged = renderIt(MINE);
      pasteAndSubmit(openReplace());
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(REPLACED)).toBeNull();
    },
  );

  it.each(['Rename', 'Change picture', 'Replace token'])('opening %s clears the replaced notice', async (opener) => {
    replaceToken.mockResolvedValueOnce(undefined);
    renderIt(MINE);
    pasteAndSubmit(openReplace());
    await screen.findByText(REPLACED);
    fireEvent.click(screen.getByRole('button', { name: opener }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(REPLACED)).toBeNull();
  });

  it('opening Replace token clears the picture notice', async () => {
    setPicture.mockResolvedValueOnce(undefined);
    renderIt(MINE);
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    await screen.findByText(AGENT_SLACK_BOT_CHANGE_COPY.pictureChanged);
    openReplace();
    expect(screen.queryByText(AGENT_SLACK_BOT_CHANGE_COPY.pictureChanged)).toBeNull();
  });
});

describe('a dead token: Rename and Change picture say who can fix it (TASK-1173)', () => {
  it.each([
    ['the viewer set the bot up', MINE, 'Your Slack token stopped working. Replace it under Slack token, then try again.'],
    [
      'the person who set it up has left',
      ORPHANED,
      "This bot's Slack token stopped working, and the person who set it up has left. Rebuild the bot to change it.",
    ],
    ['someone else set it up', LIVE, "This bot's Slack token needs replacing by Ada Lovelace."],
  ])('%s', async (_, bot, line) => {
    rename.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    setPicture.mockRejectedValueOnce(refusal(502, 'slack-config-token'));
    const onChanged = renderIt(bot);
    fireEvent.submit(openRename().closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(line);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await pick('UE5H');
    fireEvent.click(screen.getByRole('button', { name: 'Save picture' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(line);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('words', () => {
  it('never writes the product name: the rows the person who set the bot up sees, and the open token dialog', () => {
    renderIt(MINE);
    expect(document.body.textContent).not.toMatch(/\bAX\b/);
    openReplace();
    expect(document.body.textContent).not.toMatch(/\bAX\b/);
  });
});
