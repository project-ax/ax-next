/**
 * TASK-353 — handing an agent a file from the thread composer.
 *
 * `AgentConversation` owns its own composer (it is not the `/` `Composer`, and
 * this surface mounts no `AssistantRuntimeProvider`, so chat's attachment
 * machinery is unreachable here), which is why the picker is pinned separately
 * from the home composer's.
 *
 * The assertions worth keeping honest are the NEGATIVE ones. A disabled Send
 * proves very little on its own: `disabled` stops a click and does nothing
 * whatsoever about the Enter key, which is how most people send. So every
 * blocked case drives BOTH paths and then asserts `onSend` was not called.
 */
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentConversation } from '../AgentConversation';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import {
  ATTACHMENT_ACCEPT,
  AttachmentUploadError,
  uploadAttachment,
  type AttachmentUploadResult,
} from '@/lib/attachment-upload';
import {
  ATTACHMENT_FAILED_UNSUPPORTED,
  ATTACHMENT_NEEDS_MESSAGE,
  ATTACHMENT_SEND_BLOCKED_FAILED,
} from '@/lib/workspace-attachments';
import { COMPOSER_HOLD_COPY } from '../decision-copy';
import { decisionFixture, resolvedFixture } from './decision-fixture';

/*
  Only the POST is faked. `ATTACHMENT_ACCEPT` stays real because the picker's
  `accept` hint is asserted below, and the error class stays real so the hook's
  `instanceof` narrowing is exercised rather than sidestepped.
*/
vi.mock('@/lib/attachment-upload', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/attachment-upload')>();
  return { ...actual, uploadAttachment: vi.fn() };
});

const upload = vi.mocked(uploadAttachment);

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

function props(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
): ComponentProps<typeof AgentConversation> {
  return {
    agent: quill,
    thread: [],
    decisions: [],
    readOnly: false,
    onSend: vi.fn(),
    onApprove: vi.fn(),
    onDismiss: vi.fn(),
    onUndo: vi.fn(),
    approvalRead: 'ok',
    onRetryApprovals: vi.fn(),
    /*
      TASK-351 routes open capability grants into this thread, and both props
      are REQUIRED on purpose — an agent whose grants failed to load must not
      be indistinguishable from one that asked for nothing. Nothing in this
      file is about grants, so it passes the honest empty answer rather than
      making them optional.
    */
    grants: [],
    onGrantResolved: vi.fn(),
    ...over,
  };
}

function renderConversation(
  over: Partial<ComponentProps<typeof AgentConversation>> = {},
) {
  return render(<AgentConversation {...props(over)} />);
}

function box() {
  return screen.getByPlaceholderText('Message Quill');
}

function sendButton() {
  return screen.getByRole('button', { name: 'Send' });
}

/**
 * The picker's `<input type="file">` is sr-only plumbing behind the paperclip
 * Button and is deliberately out of the accessibility tree, so there is no role
 * or label to reach it by — the DOM is the honest way in.
 */
function filePicker(): HTMLInputElement {
  const el = document.querySelector('input[type="file"]');
  if (el === null) throw new Error('the composer has no file picker');
  return el as HTMLInputElement;
}

function pickFile(name = 'notes.pdf') {
  fireEvent.change(filePicker(), {
    target: { files: [new File(['x'], name, { type: 'application/pdf' })] },
  });
}

function uploadedAs(attachmentId: string): AttachmentUploadResult {
  return {
    attachmentId,
    sizeBytes: 1,
    mediaType: 'application/pdf',
    displayName: 'notes.pdf',
    expiresAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * A held send says its reason twice on purpose: once as the line above the
 * field, and once in the sr-only live region. This asserts BOTH — that the
 * count is the two we meant, and that one of them is real, visible DOM text
 * rather than an announcement nobody looking at the screen would ever get.
 */
function saysOnceVisibly(sentence: string) {
  const said = screen.getAllByText(sentence);
  expect(said).toHaveLength(2);
  expect(said.some((n) => !n.classList.contains('sr-only'))).toBe(true);
}

/** This thread points at the fixture's open row (`d-marcus`). */
const threadFor = (decisionId: string) => [
  { kind: 'approval', id: `m-${decisionId}`, decisionId } as const,
];

beforeEach(() => {
  upload.mockReset();
});

describe('AgentConversation — attaching a file', () => {
  it('shows a chip for the picked file and sends its id with the message', async () => {
    upload.mockResolvedValue(uploadedAs('att-1'));
    const onSend = vi.fn();
    renderConversation({ onSend });

    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeTruthy();
    // The picker's hint is the server's allowlist, not a hand-typed second copy.
    expect(filePicker().accept).toBe(ATTACHMENT_ACCEPT);

    pickFile();
    expect(await screen.findByText('notes.pdf')).toBeTruthy();
    await screen.findByText('Ready to send');

    fireEvent.change(box(), { target: { value: 'have a look at this' } });
    fireEvent.click(sendButton());

    expect(onSend).toHaveBeenCalledWith('have a look at this', ['att-1']);
    // The chips go with the words: leaving them would put the same file on the
    // next message too.
    await waitFor(() => expect(screen.queryByText('notes.pdf')).toBeNull());
  });

  it('lets the approval hold speak first, and does not lose the file hold behind it', async () => {
    // Both holds can be true at once. The approval one is the more
    // consequential, so it takes the line above the field — but the attachment
    // hold is queued, not forgotten: it is still holding the send, and it says
    // so the moment the approval is answered.
    upload.mockRejectedValue(
      new AttachmentUploadError('unsupported-media-type', 'http', 415),
    );
    const onSend = vi.fn();
    const { rerender } = renderConversation({
      thread: [...threadFor('d-marcus')],
      decisions: [decisionFixture()],
      onSend,
    });

    pickFile();
    expect(await screen.findByText(ATTACHMENT_FAILED_UNSUPPORTED)).toBeTruthy();
    expect(screen.getByText(COMPOSER_HOLD_COPY)).toBeTruthy();
    expect(screen.queryByText(ATTACHMENT_SEND_BLOCKED_FAILED)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(
      'Your agent is waiting for your approval.',
    );

    rerender(
      <AgentConversation
        {...props({
          thread: [...threadFor('d-marcus')],
          decisions: [resolvedFixture('dismissed', { id: 'd-marcus' })],
          onSend,
        })}
      />,
    );

    // The approval is answered; the file is still broken.
    expect(screen.queryByText(COMPOSER_HOLD_COPY)).toBeNull();
    fireEvent.change(box(), { target: { value: 'have a look at this' } });
    saysOnceVisibly(ATTACHMENT_SEND_BLOCKED_FAILED);
    expect(sendButton()).toBeDisabled();

    fireEvent.click(sendButton());
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('holds the send when a file did not upload — click and Enter both', async () => {
    upload.mockRejectedValue(
      new AttachmentUploadError('unsupported-media-type', 'http', 415),
    );
    const onSend = vi.fn();
    renderConversation({ onSend });

    pickFile();
    expect(await screen.findByText(ATTACHMENT_FAILED_UNSUPPORTED)).toBeTruthy();
    // The server's own `{error}` string is never what the reader sees.
    expect(document.body.textContent).not.toContain('unsupported-media-type');

    fireEvent.change(box(), { target: { value: 'have a look at this' } });
    saysOnceVisibly(ATTACHMENT_SEND_BLOCKED_FAILED);
    expect(sendButton()).toBeDisabled();

    fireEvent.click(sendButton());
    fireEvent.keyDown(box(), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    // The field stays live — and the words stay in it — because typing is not
    // what is wrong here.
    expect(box()).not.toBeDisabled();
    expect(box()).toHaveValue('have a look at this');
  });

  it('sends plain text once the failed file is removed, with no id list at all', async () => {
    upload.mockRejectedValue(
      new AttachmentUploadError('unsupported-media-type', 'http', 415),
    );
    const onSend = vi.fn();
    renderConversation({ onSend });

    pickFile();
    await screen.findByText(ATTACHMENT_FAILED_UNSUPPORTED);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    fireEvent.change(box(), { target: { value: 'never mind the file' } });
    fireEvent.keyDown(box(), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('never mind the file');
    /*
      EXACTLY ONE ARGUMENT. An empty list and no list mean the same send, and
      the text-only path passes no list — which is what keeps every caller that
      predates attachments (and the hold suite next door) seeing the call they
      always saw.
    */
    expect(onSend.mock.calls.at(0)?.length).toBe(1);
    expect(onSend.mock.calls.at(0)?.[1]).toBeUndefined();
  });

  it('will not send a file with no message, and says why', async () => {
    // A picker with a dead Send and no explanation is the same silent failure
    // this card is about, one step earlier.
    upload.mockResolvedValue(uploadedAs('att-1'));
    const onSend = vi.fn();
    renderConversation({ onSend });

    pickFile();
    await screen.findByText('Ready to send');

    saysOnceVisibly(ATTACHMENT_NEEDS_MESSAGE);
    expect(sendButton()).toBeDisabled();

    fireEvent.click(sendButton());
    fireEvent.keyDown(box(), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
  });
});
