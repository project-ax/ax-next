/**
 * TaskReplyBox: the reply box on a task's own page (TASK-931).
 *
 * Driven through the real component with only `sendTaskReply` mocked, so each
 * case is what the person would see. The copy is asserted verbatim because it
 * is decided (TASK-931 plan, Task 7), and its apostrophes are U+2019.
 */
import { createRef, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { WorkspaceApiError, WorkspaceShapeError, workspaceApi } from '@/lib/workspace-api';
import type { TaskReplyCheckIn } from '@/lib/workspace-types';
import { TaskReplyBox } from '../TaskReplyBox';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { sendTaskReply: vi.fn() } };
});

const sendMock = vi.mocked(workspaceApi.sendTaskReply);

const UNCONFIRMED =
  'We couldn’t confirm your reply was sent. Try again, and it won’t be sent twice.';
const NOT_FOUND = 'We couldn’t find this task any more. It may have been deleted.';
const AS_WRITTEN = 'We couldn’t send that reply as written. Change it and try again.';

function renderBox(
  over: Partial<{
    enabled: boolean;
    canStart: boolean;
    onSent: (c: TaskReplyCheckIn) => void;
    inputRef: Ref<HTMLTextAreaElement>;
  }> = {},
) {
  const onSent = over.onSent ?? vi.fn();
  render(
    <>
      <button type="button">Elsewhere</button>
      <TaskReplyBox
        agentId="a1"
        routineId="t1"
        agentName="Quill"
        enabled={over.enabled ?? true}
        canStart={over.canStart ?? true}
        onSent={onSent}
        {...(over.inputRef === undefined ? {} : { inputRef: over.inputRef })}
      />
    </>,
  );
  return { onSent };
}

const box = () => screen.getByLabelText('Reply to Quill about this task') as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });

/** Types, presses Send, and lets the answer land. */
async function send(text: string) {
  type(text);
  fireEvent.click(sendButton());
  await waitFor(() => expect(box().readOnly).toBe(false));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  sendMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('TaskReplyBox — what it says', () => {
  it('labels the box with the agent and the task', () => {
    renderBox();
    expect(screen.getByLabelText('Reply to Quill about this task')).toBe(box());
  });

  it.each<[string, { enabled: boolean; canStart: boolean }, string]>([
    [
      'enabled and can start',
      { enabled: true, canStart: true },
      'Quill reads your replies every time it checks in. Sending one starts a check-in now.',
    ],
    [
      'enabled, cannot start',
      { enabled: true, canStart: false },
      'Quill reads your replies every time it checks in.',
    ],
    [
      'paused, can start',
      { enabled: false, canStart: true },
      'It’s paused, so Quill will read this once you resume it.',
    ],
    [
      'paused, cannot start',
      { enabled: false, canStart: false },
      'It’s paused, so Quill will read this once it’s resumed.',
    ],
  ])('helper line when %s', (_label, props, line) => {
    renderBox(props);
    const helper = screen.getByText(line);
    expect(box().getAttribute('aria-describedby')).toContain(helper.id);
  });
});

describe('TaskReplyBox — sending', () => {
  it('waits for something to send', () => {
    renderBox();
    expect(sendButton().disabled).toBe(true);
    type('   ');
    expect(sendButton().disabled).toBe(true);
    type('Hi');
    expect(sendButton().disabled).toBe(false);
  });

  it('sends the text, clears the box and says the check-in started', async () => {
    sendMock.mockResolvedValue({ checkIn: 'started' });
    const { onSent } = renderBox();
    expect(screen.getByRole('status').textContent).toBe('');
    await send('Refunds under $100 are fine.');
    expect(sendMock).toHaveBeenCalledWith('a1', 't1', {
      text: 'Refunds under $100 are fine.',
      requestId: expect.any(String),
    });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledWith('started');
    expect(box().value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('Sent. Quill started checking in.');
  });

  it.each<[TaskReplyCheckIn, string]>([
    ['replayed', 'Sent. Quill started checking in.'],
    ['paused', 'Sent. Quill will read it when you resume the task.'],
    ['not-allowed', 'Sent. Quill will read it at its next check-in.'],
  ])('says what %s means', async (checkIn, line) => {
    sendMock.mockResolvedValue({ checkIn });
    const { onSent } = renderBox();
    await send('Hi');
    expect(onSent).toHaveBeenCalledWith(checkIn);
    expect(screen.getByRole('status').textContent).toBe(line);
  });

  it('not-allowed on a paused task says it will be read once the task is resumed', async () => {
    sendMock.mockResolvedValue({ checkIn: 'not-allowed' });
    renderBox({ enabled: false, canStart: false });
    await send('Hi');
    expect(screen.getByRole('status').textContent).toBe(
      'Sent. Quill will read it once the task is resumed.',
    );
  });

  it('typing again clears the sent line', async () => {
    sendMock.mockResolvedValue({ checkIn: 'started' });
    renderBox();
    await send('Hi');
    type('Another');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('Ctrl+Enter and Cmd+Enter send; Enter alone does not, nor while composing', async () => {
    sendMock.mockResolvedValue({ checkIn: 'started' });
    renderBox();
    type('One');
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(sendMock).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(box().value).toBe(''));
    type('Two');
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
  });

  it('Ctrl+Enter with nothing to send sends nothing', () => {
    renderBox();
    type('  ');
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('the text can’t change while it sends', async () => {
    const d = deferred<{ checkIn: TaskReplyCheckIn }>();
    sendMock.mockReturnValue(d.promise);
    renderBox();
    type('Hi');
    fireEvent.click(sendButton());
    await waitFor(() => expect(box().readOnly).toBe(true));
    expect(sendButton().disabled).toBe(true);
    await act(async () => d.resolve({ checkIn: 'started' }));
    expect(box().readOnly).toBe(false);
  });

  it('sends once when pressed twice before the answer', async () => {
    const d = deferred<{ checkIn: TaskReplyCheckIn }>();
    sendMock.mockReturnValue(d.promise);
    renderBox();
    type('Hi');
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    await act(async () => d.resolve({ checkIn: 'started' }));
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('TaskReplyBox — the request id', () => {
  it.each<[string, () => unknown]>([
    ['a 503', () => new WorkspaceApiError('/x', 503)],
    ['a 408', () => new WorkspaceApiError('/x', 408)],
    ['a 429', () => new WorkspaceApiError('/x', 429)],
    ['a network failure', () => new TypeError('Failed to fetch')],
    ['an answer it couldn’t read', () => new WorkspaceShapeError('/x')],
  ])('an unconfirmed send (%s) keeps its id for the same text, so a retry can’t store it twice', async (_l, fail) => {
    sendMock.mockRejectedValueOnce(fail()).mockResolvedValueOnce({ checkIn: 'started' });
    const { onSent } = renderBox();
    await send('Hi');
    expect(screen.getByRole('alert').textContent).toBe(UNCONFIRMED);
    expect(box().value).toBe('Hi');
    expect(onSent).not.toHaveBeenCalled();
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[1]![2].requestId).toBe(sendMock.mock.calls[0]![2].requestId);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an edited text after an unconfirmed send is a new reply', async () => {
    sendMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 503))
      .mockResolvedValueOnce({ checkIn: 'started' });
    renderBox();
    await send('Refunds under $100 are fine');
    type('Refunds under $100 are fine.');
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock.mock.calls[1]![2].requestId).not.toBe(sendMock.mock.calls[0]![2].requestId);
    expect(sendMock.mock.calls[1]![2].text).toBe('Refunds under $100 are fine.');
  });

  it('a refusal drops the id, and says so in its own words', async () => {
    sendMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 400))
      .mockResolvedValueOnce({ checkIn: 'started' });
    renderBox();
    await send('Hi');
    expect(screen.getByRole('alert').textContent).toBe(AS_WRITTEN);
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock.mock.calls[1]![2].requestId).not.toBe(sendMock.mock.calls[0]![2].requestId);
  });

  it('a success drops the id, so the next reply is a new one', async () => {
    sendMock.mockResolvedValue({ checkIn: 'started' });
    renderBox();
    await send('Same words');
    await send('Same words');
    expect(sendMock.mock.calls[1]![2].requestId).not.toBe(sendMock.mock.calls[0]![2].requestId);
  });
});

describe('TaskReplyBox — when it can’t send', () => {
  it.each<[number, string]>([
    [404, NOT_FOUND],
    [403, NOT_FOUND],
    [401, HTTP_SESSION_ENDED],
    [400, AS_WRITTEN],
    [422, AS_WRITTEN],
  ])('a %s reads in its own words', async (status, line) => {
    sendMock.mockRejectedValue(new WorkspaceApiError('/x', status));
    renderBox();
    await send('Hi');
    expect(screen.getByRole('alert').textContent).toBe(line);
    expect(box().value).toBe('Hi');
  });

  it('typing clears the error', async () => {
    sendMock.mockRejectedValue(new WorkspaceApiError('/x', 404));
    renderBox();
    await send('Hi');
    type('Hi!');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('checks the text the way the host does before sending', () => {
    renderBox();
    type('x'.repeat(2001));
    fireEvent.click(sendButton());
    expect(screen.getByRole('alert').textContent).toBe('A reply can be up to 2,000 characters.');
    expect(box().getAttribute('aria-invalid')).toBe('true');
    expect(sendMock).not.toHaveBeenCalled();

    type(`ab${String.fromCodePoint(0x200b)}cd`);
    fireEvent.click(sendButton());
    expect(screen.getByRole('alert').textContent).toBe(
      'A reply can’t contain invisible characters (U+200B at character 3).',
    );
    expect(sendMock).not.toHaveBeenCalled();

    type('fine');
    expect(box().getAttribute('aria-invalid')).toBeNull();
  });
});

describe('TaskReplyBox — focus', () => {
  it.each<[string, () => void]>([
    ['success', () => sendMock.mockResolvedValue({ checkIn: 'started' })],
    ['failure', () => sendMock.mockRejectedValue(new WorkspaceApiError('/x', 503))],
  ])('after a clicked Send settles (%s), focus is back in the box', async (_l, arrange) => {
    arrange();
    renderBox();
    type('Hi');
    sendButton().focus();
    fireEvent.click(sendButton());
    await waitFor(() => expect(box().readOnly).toBe(false));
    expect(document.activeElement).toBe(box());
  });

  it('focus someone moved elsewhere meanwhile stays there', async () => {
    const d = deferred<{ checkIn: TaskReplyCheckIn }>();
    sendMock.mockReturnValue(d.promise);
    renderBox();
    type('Hi');
    sendButton().focus();
    fireEvent.click(sendButton());
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await act(async () => d.resolve({ checkIn: 'started' }));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('inputRef reaches the textarea', () => {
    const ref = createRef<HTMLTextAreaElement>();
    renderBox({ inputRef: ref });
    expect(ref.current).toBe(box());
  });
});
