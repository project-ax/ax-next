import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HomeComposer } from '../HomeComposer';
import { ATTACHMENT_NEEDS_MESSAGE } from '@/lib/workspace-attachments';
import { workspaceApi, type WorkspaceAgent } from '@/lib/workspace-api';
import {
  ATTACHMENT_ACCEPT,
  AttachmentUploadError,
  uploadAttachment,
  type AttachmentUploadResult,
} from '@/lib/attachment-upload';
import {
  ATTACHMENT_FAILED_UNSUPPORTED,
  ATTACHMENT_SEND_BLOCKED_FAILED,
} from '@/lib/workspace-attachments';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@/lib/workspace-api',
  );
  return { ...actual, workspaceApi: { route: vi.fn() } };
});

/*
  Only the POST is faked. `ATTACHMENT_ACCEPT` stays real because the picker's
  `accept` hint is one of the things asserted below, and `attachmentRefBlock`
  stays real because `workspace-api` builds the wire block with it.
*/
vi.mock('@/lib/attachment-upload', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/attachment-upload')>();
  return { ...actual, uploadAttachment: vi.fn() };
});

const routeMock = vi.mocked(workspaceApi.route);
const upload = vi.mocked(uploadAttachment);

const agents: WorkspaceAgent[] = [
  {
    id: 'scheduler',
    name: 'Scheduler',
    state: 'waiting',
    now: null,
    counter: null,
    startedAt: null,
    stoppedReason: null,
  },
];

function setup() {
  const onSend = vi.fn();
  render(<HomeComposer agents={agents} onSend={onSend} />);
  return { onSend };
}

/**
 * Radix's DropdownMenuTrigger opens on pointerdown, and jsdom's `click` does not
 * synthesize one — a plain click leaves the menu closed and the failure looks
 * like a missing menu item rather than an unopened menu.
 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
}

/**
 * The placeholder names the picked agent, so match on the shape rather than on
 * one phrasing of it.
 */
function composer(): HTMLElement {
  return screen.getByPlaceholderText(/^Ask /);
}

function ask(text: string) {
  const input = composer();
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
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

function sendButton() {
  return screen.getByRole('button', { name: 'Send' });
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

beforeEach(() => {
  routeMock.mockReset();
  upload.mockReset();
});

describe('Auto routing', () => {
  it('confirms before dispatching, however confident the route is', async () => {
    // No opt-out: a confident route is still a routing decision the human gets
    // to see before an agent starts acting on their request.
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'it is about your calendar',
      confident: true,
    });
    const { onSend } = setup();

    ask('find me 30 minutes with Marcus');

    expect(await screen.findByText(/Auto picked/)).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('says so plainly when it cannot tell', async () => {
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'nothing in it pointed anywhere in particular',
      confident: false,
    });
    const { onSend } = setup();

    ask('can you look into that thing from yesterday');

    expect(await screen.findByText(/Auto is not sure/)).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('dispatches on confirmation', async () => {
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'it is about your calendar',
      confident: true,
    });
    const { onSend } = setup();

    ask('find me 30 minutes with Marcus');
    fireEvent.click(await screen.findByRole('button', { name: /Send to Scheduler/ }));

    expect(onSend).toHaveBeenCalledWith(
      'scheduler',
      'find me 30 minutes with Marcus',
    );
  });

  it('promises nothing in the placeholder', () => {
    // The old placeholder suggested "find me 30 minutes with Marcus", which
    // presumes a scheduler, a calendar grant and a person named Marcus. A
    // brand-new agent has none of the three.
    setup();
    const placeholder = composer().getAttribute('placeholder') ?? '';
    expect(placeholder).not.toMatch(/Marcus/);
    expect(placeholder).not.toMatch(/30 minutes/);
    expect(placeholder).toMatch(/say hi/);
  });

  it('never routes at all when an agent was picked explicitly', async () => {
    const { onSend } = setup();

    openMenu(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Scheduler/ }));
    ask('keep Thursdays clear');

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('scheduler', 'keep Thursdays clear'),
    );
    expect(routeMock).not.toHaveBeenCalled();
  });
});

/**
 * The composer used to `await` both the routing call and the send with no
 * catch. A 503 rejected an unhandled promise, nothing rendered, and the draft
 * had already been cleared — the user's words were simply gone.
 */
describe('when the send does not go through', () => {
  it('keeps the draft and says so when routing fails', async () => {
    routeMock.mockRejectedValue(new Error('workspace /route → 503'));
    const { onSend } = setup();

    ask('please look at the roof quote');

    expect(
      await screen.findByText(/could not work out which agent/i),
    ).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    // The words survive. Retyping them is the one outcome we cannot ship.
    expect((composer() as HTMLInputElement).value).toBe(
      'please look at the roof quote',
    );
  });

  it('keeps the draft and says so when the send itself fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('send message → 500'));
    render(<HomeComposer agents={agents} onSend={onSend} />);

    // Pick the agent explicitly so the send is the only call in play.
    openMenu(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Scheduler/ }));
    ask('draft the reply to Dana');

    expect(await screen.findByText(/could not get that to/i)).toBeTruthy();
    expect((composer() as HTMLInputElement).value).toBe('draft the reply to Dana');
  });

  it('keeps the draft when the send fails after an Auto confirmation', async () => {
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'it is about your calendar',
      confident: true,
    });
    const onSend = vi.fn().mockRejectedValue(new Error('send message → 500'));
    render(<HomeComposer agents={agents} onSend={onSend} />);

    ask('find me a slot on Thursday');
    fireEvent.click(await screen.findByRole('button', { name: /Send to Scheduler/ }));

    expect(await screen.findByText(/could not get that to/i)).toBeTruthy();
    expect((composer() as HTMLInputElement).value).toBe('find me a slot on Thursday');
  });

  it('clears the draft once the send resolves', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<HomeComposer agents={agents} onSend={onSend} />);

    openMenu(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Scheduler/ }));
    ask('keep Thursdays clear');

    await waitFor(() => expect((composer() as HTMLInputElement).value).toBe(''));
  });
});


/**
 * TASK-353 — handing an agent a file from the home composer.
 *
 * The card this closes is "a user cannot give an agent a file from the
 * workspace". Everything below the UI shipped first: the uploader, the hook,
 * the chip, `sendMessage`'s `attachmentIds`. What was missing was the last
 * mile — a picker, chips, and a send that refuses to quietly drop the file.
 *
 * The assertions worth keeping honest are the NEGATIVE ones. A disabled Send
 * proves nothing on its own: `disabled` stops a click and does nothing at all
 * about the Enter key, which is how most people send. So every blocked case
 * drives BOTH paths and then asserts `onSend` was not called.
 */
describe('attaching a file', () => {
  it('shows a chip for the picked file and sends its id with the message', async () => {
    upload.mockResolvedValue(uploadedAs('att-1'));
    const { onSend } = setup();

    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeTruthy();
    // The picker's hint is the server's allowlist, not a hand-typed second copy.
    expect(filePicker().accept).toBe(ATTACHMENT_ACCEPT);

    pickFile();
    expect(await screen.findByText('notes.pdf')).toBeTruthy();
    await screen.findByText('Ready to send');

    openMenu(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Scheduler/ }));
    ask('have a look at this');

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('scheduler', 'have a look at this', [
        'att-1',
      ]),
    );
    // The chips go with the words once the send resolves — otherwise the same
    // file rides along on the next message too.
    await waitFor(() => expect(screen.queryByText('notes.pdf')).toBeNull());
  });

  it('carries the file through the Auto confirmation step', async () => {
    // The file has to survive the "Send to X" step, which is a second render
    // and a different button from the one the person picked the file next to.
    routeMock.mockResolvedValue({
      agentId: 'scheduler',
      agentName: 'Scheduler',
      why: 'it is about your calendar',
      confident: true,
    });
    upload.mockResolvedValue(uploadedAs('att-1'));
    const { onSend } = setup();

    pickFile();
    await screen.findByText('Ready to send');
    ask('can you read this quote');

    fireEvent.click(
      await screen.findByRole('button', { name: /Send to Scheduler/ }),
    );

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        'scheduler',
        'can you read this quote',
        ['att-1'],
      ),
    );
  });

  it('holds the send when a file did not upload — click and Enter both', async () => {
    upload.mockRejectedValue(
      new AttachmentUploadError('unsupported-media-type', 'http', 415),
    );
    const { onSend } = setup();

    pickFile();
    expect(await screen.findByText(ATTACHMENT_FAILED_UNSUPPORTED)).toBeTruthy();
    // The server's own `{error}` string is never what the reader sees.
    expect(document.body.textContent).not.toContain('unsupported-media-type');

    // Explicit agent, so an unheld send would reach `onSend` directly rather
    // than stopping at the Auto proposal for unrelated reasons.
    openMenu(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Scheduler/ }));
    fireEvent.change(composer(), { target: { value: 'have a look at this' } });

    saysOnceVisibly(ATTACHMENT_SEND_BLOCKED_FAILED);
    expect(sendButton()).toBeDisabled();

    fireEvent.click(sendButton());
    fireEvent.keyDown(composer(), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(routeMock).not.toHaveBeenCalled();
    // And the words are still there for after they deal with the file.
    expect((composer() as HTMLInputElement).value).toBe('have a look at this');
  });

  it('sends plain text once the failed file is removed, with no id list at all', async () => {
    upload.mockRejectedValue(
      new AttachmentUploadError('unsupported-media-type', 'http', 415),
    );
    const { onSend } = setup();

    pickFile();
    await screen.findByText(ATTACHMENT_FAILED_UNSUPPORTED);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    openMenu(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Scheduler/ }));
    ask('never mind the file');

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith('scheduler', 'never mind the file'),
    );
    /*
      EXACTLY TWO ARGUMENTS. An empty list and no list mean the same send, and
      the text-only path passes no list — which is what keeps every caller that
      predates attachments (and the tests above) seeing the call they always
      saw.
    */
    expect(onSend.mock.calls.at(0)?.length).toBe(2);
    expect(onSend.mock.calls.at(0)?.[2]).toBeUndefined();
  });

  it('will not send a file with no message, and says why', async () => {
    // A picker with a dead Send and no explanation is the same silent failure
    // this card is about, one step earlier.
    upload.mockResolvedValue(uploadedAs('att-1'));
    const { onSend } = setup();

    pickFile();
    await screen.findByText('Ready to send');

    saysOnceVisibly(ATTACHMENT_NEEDS_MESSAGE);
    expect(sendButton()).toBeDisabled();

    fireEvent.click(sendButton());
    fireEvent.keyDown(composer(), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
  });
});
