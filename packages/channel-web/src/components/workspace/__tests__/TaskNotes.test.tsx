/**
 * TaskNotes: the agent's notes on a task's page, shown on request and
 * clearable after a confirm (TASK-910).
 *
 * The notes are text a model wrote, and they go back to it at the task's next
 * check-in. An instruction injected through a ticket could persist that way,
 * so the page keeps them visible and clearable (design §7) and draws them as
 * text only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import { TaskNotes } from '../TaskNotes';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: { clearTaskNotes: vi.fn() },
  };
});

const clearMock = vi.mocked(workspaceApi.clearTaskNotes);

const NOTES = 'Ticket 1182 is waiting on finance.\nAsk again on Friday.';
const NOTES_PATH = '/tasks/a1/t1/notes';

function renderNotes(notes: string | null = NOTES) {
  const onCleared = vi.fn();
  const tree = (value: string | null) => (
    <dl>
      <TaskNotes agentId="a1" routineId="t1" agentName="Quill" notes={value} onCleared={onCleared} />
    </dl>
  );
  const view = render(tree(notes));
  return { ...view, onCleared, rerenderNotes: (next: string | null) => view.rerender(tree(next)) };
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

function showNotes() {
  fireEvent.click(screen.getByRole('button', { name: 'Show Quill’s notes' }));
}

/** Show the notes, press Clear notes, and hand back the confirm. */
function openConfirm(): HTMLElement {
  showNotes();
  fireEvent.click(screen.getByRole('button', { name: 'Clear notes' }));
  return screen.getByRole('dialog');
}

function confirmButton(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: /^(Clear notes|Clearing…)$/ });
}

/** Confirm, and wait for the dialog to close on a clear that went through. */
async function confirmCleared(dialog: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(confirmButton(dialog));
  return screen.findByText('Notes cleared.');
}

beforeEach(() => {
  clearMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('TaskNotes (TASK-910)', () => {
  it('keeps the notes folded away until asked, then shows them as written', () => {
    renderNotes();
    expect(screen.getByText('Quill’s notes')).toBeInTheDocument();
    expect(screen.queryByText(/Ticket 1182/)).toBeNull();

    const toggle = screen.getByRole('button', { name: 'Show Quill’s notes' });
    expect(toggle).toHaveTextContent(/^Show$/);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAccessibleDescription('(it keeps these for its next check-in)');
    expect(screen.queryByRole('button', { name: 'Clear notes' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent(/^Hide$/);
    expect(toggle).toHaveAccessibleName('Hide Quill’s notes');
    expect(screen.getByText(/Ticket 1182/).textContent).toBe(NOTES);
    expect(screen.getByRole('button', { name: 'Clear notes' })).toBeInTheDocument();
  });

  it('draws notes with markdown or HTML as plain text', () => {
    const written = '**Done** <b>3</b> [docs](https://x.test) <img src=x onerror=alert(1)>';
    const { container } = renderNotes(written);
    showNotes();
    expect(screen.getByText(written).textContent).toBe(written);
    expect(container.querySelector('strong, b, a, img')).toBeNull();
  });

  it('clears the notes only after the person confirms', async () => {
    clearMock.mockResolvedValueOnce({ cleared: true });
    const { onCleared } = renderNotes();
    const dialog = openConfirm();
    expect(clearMock).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('heading', { name: 'Clear Quill’s notes?' })).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(
      'Quill won’t see them at its next check-in. You can’t undo this.',
    );

    await confirmCleared(dialog);
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(clearMock).toHaveBeenCalledWith('a1', 't1');
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says Notes cleared. once, by the focus that lands on it, and keeps it through the re-read', async () => {
    clearMock.mockResolvedValueOnce({ cleared: true });
    const { rerenderNotes } = renderNotes();
    const outcome = await confirmCleared(openConfirm());
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    // Focus already reads it; a live region as well would say it twice.
    expect(outcome.closest('[role="status"], [aria-live]')).toBeNull();

    // The page reads the task again and the notes are gone. The line stays,
    // and so does the focus on it: the button that opened the confirm is gone.
    rerenderNotes(null);
    expect(screen.getByText('Notes cleared.')).toBe(outcome);
    expect(document.activeElement).toBe(outcome);
    expect(screen.getByText('None. It keeps notes here between check-ins.')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('a later check-in’s notes, even in the same words, take Notes cleared. away', async () => {
    clearMock.mockResolvedValueOnce({ cleared: true });
    const { rerenderNotes } = renderNotes();
    await confirmCleared(openConfirm());
    rerenderNotes(null);
    rerenderNotes(NOTES);
    expect(screen.queryByText('Notes cleared.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show Quill’s notes' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('Cancel leaves the notes alone', () => {
    const { onCleared } = renderNotes();
    const dialog = openConfirm();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(clearMock).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
    expect(screen.getByText(/Ticket 1182/).textContent).toBe(NOTES);
    expect(screen.queryByText('Notes cleared.')).toBeNull();
  });

  it('holds the confirm open while the clear is on its way', async () => {
    const d = deferred<{ cleared: true }>();
    clearMock.mockReturnValueOnce(d.promise);
    const { onCleared } = renderNotes();
    const dialog = openConfirm();
    fireEvent.click(confirmButton(dialog));

    const busy = within(dialog).getByRole('button', { name: 'Clearing…' });
    expect(busy).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(onCleared).not.toHaveBeenCalled();

    await act(async () => d.resolve({ cleared: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      what: 'a failure we can retry',
      failure: new WorkspaceApiError(NOTES_PATH, 500),
      says: 'We couldn’t clear the notes just now. Try again.',
      red: true,
      retry: true,
    },
    {
      what: 'a lost connection',
      failure: new TypeError('Failed to fetch'),
      says: 'We couldn’t clear the notes just now. Try again.',
      red: true,
      retry: true,
    },
    {
      // A session running out isn't a malfunction (`read-register.ts`,
      // `LoginPage`), and pressing again can't work until they sign in.
      what: 'an ended session',
      failure: new WorkspaceApiError(NOTES_PATH, 401),
      says: HTTP_SESSION_ENDED,
      red: false,
      retry: false,
    },
    {
      // The route answers 404 for a task that's gone or no longer theirs, and
      // no retry brings it back.
      what: 'a task that isn’t there any more',
      failure: new WorkspaceApiError(NOTES_PATH, 404),
      says: 'We couldn’t find this task any more. It may have been deleted.',
      red: true,
      retry: false,
    },
  ])('a clear that fails says so and keeps the dialog open: $what', async ({ failure, says, red, retry }) => {
    clearMock.mockRejectedValueOnce(failure);
    const { onCleared } = renderNotes();
    const dialog = openConfirm();
    fireEvent.click(confirmButton(dialog));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(says);
    if (red) expect(alert.className).toContain('destructive');
    else expect(alert.className).not.toContain('destructive');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(onCleared).not.toHaveBeenCalled();
    expect(screen.queryByText('Notes cleared.')).toBeNull();
    const again = within(dialog).getByRole('button', { name: 'Clear notes' });
    if (retry) expect(again).toBeEnabled();
    else expect(again).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('a failed clear can be tried again, and a confirm opened afresh starts clean', async () => {
    clearMock.mockRejectedValueOnce(new WorkspaceApiError(NOTES_PATH, 500));
    const { onCleared } = renderNotes();
    let dialog = openConfirm();
    fireEvent.click(confirmButton(dialog));
    await within(dialog).findByRole('alert');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear notes' }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('alert')).toBeNull();

    clearMock.mockResolvedValueOnce({ cleared: true });
    await confirmCleared(dialog);
    expect(clearMock).toHaveBeenCalledTimes(2);
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it('says there are no notes, with nothing to clear', () => {
    renderNotes(null);
    expect(screen.getByText('Quill’s notes')).toBeInTheDocument();
    expect(screen.getByText('None. It keeps notes here between check-ins.')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});
