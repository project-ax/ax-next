/**
 * Rename and Change picture on an agent's live Slack bot (TASK-1171). The wire
 * client and the browser's drawing are mocked (their requests and drawing are
 * pinned in `lib/__tests__`); the copy and the error mapping are the real ones,
 * so what a person reads is what ships.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BotChanges } from '../AgentSlackBotChanges';
import {
  AGENT_SLACK_BOT_CHANGE_COPY,
  AgentSlackError,
  renameAgentSlackBot,
  setAgentSlackBotPicture,
  type AgentSlackBot as Bot,
} from '@/lib/agent-slack';
import { SLACK_ERROR_COPY } from '@/lib/slack-admin';
import { drawPickedSlackAvatar } from '@/lib/slack-avatar';
import { BOT_NAME_COPY, SLACK_TOKEN_COPY } from '@/lib/slack-token-copy';

vi.mock('@/lib/agent-slack', async (original) => ({
  ...(await original<typeof import('@/lib/agent-slack')>()),
  renameAgentSlackBot: vi.fn(),
  setAgentSlackBotPicture: vi.fn(),
}));
vi.mock('@/lib/slack-avatar', () => ({ drawPickedSlackAvatar: vi.fn() }));

const rename = vi.mocked(renameAgentSlackBot);
const setPicture = vi.mocked(setAgentSlackBotPicture);
const draw = vi.mocked(drawPickedSlackAvatar);

const LIVE: Extract<Bot, { state: 'live' }> = {
  state: 'live',
  botName: 'Quill Bot',
  handle: 'quill_bot',
  approver: 'Ada Lovelace',
  needsClaim: false,
  installId: 'Hb7Kq2Lw8vNc5Xr1Bm7KdA',
};

const refusal = (status: number, code: string, reason: string | null = null) => new AgentSlackError(status, code, reason);

function renderIt() {
  const onChanged = vi.fn();
  render(<BotChanges agentId="a1" bot={LIVE} onChanged={onChanged} />);
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
}

beforeEach(() => {
  vi.clearAllMocks();
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
