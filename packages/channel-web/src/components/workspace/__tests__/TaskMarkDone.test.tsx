/**
 * TaskMarkDone: Mark done's press and its confirmation (TASK-950).
 *
 * A small harness wires a button to `useMarkDone` and shows the confirmation
 * when it is open, so each case is what the person would see. The copy is
 * asserted verbatim, with U+2019 apostrophes.
 */
import { useLayoutEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { WorkspaceApiError, WorkspaceShapeError, workspaceApi } from '@/lib/workspace-api';
import {
  MARK_DONE_NOT_ALLOWED,
  MarkDoneConfirmation,
  markDoneFailure,
  untickedLine,
  useMarkDone,
} from '../TaskMarkDone';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { completeTask: vi.fn() } };
});

const completeMock = vi.mocked(workspaceApi.completeTask);

const UNCONFIRMED =
  'We couldn’t confirm the task was marked done. Try again, and it won’t happen twice.';
/** The claim the harness shows, by its report's time. */
const CLAIM = '2026-10-23T10:00:00.000Z';

/** The task as the harness shows it: not done, and claimed, unless a case says otherwise. */
interface Shown {
  doneAt: string | null;
  claim: string | null;
}

function Harness({
  unticked,
  onDone,
  doneAt = null,
  claim = CLAIM,
}: { unticked: number; onDone: () => void } & Partial<Shown>) {
  const m = useMarkDone({ agentId: 'a1', routineId: 't1', doneAt, claim, unticked, onDone });
  return (
    <div>
      <button type="button" onClick={m.press} disabled={m.busy}>
        Mark done
      </button>
      {m.confirming && (
        <MarkDoneConfirmation
          unticked={unticked}
          primary
          busy={m.busy}
          onConfirm={m.confirm}
          onCancel={m.cancel}
        />
      )}
      {m.failure !== null && (
        <p data-testid="failure" data-register={m.failure.register}>
          {m.failure.text}
        </p>
      )}
    </div>
  );
}

/** The harness with the page's refs wired: `buttonRef` on Mark done, `controlsRef` on what holds it. */
function FocusHarness({ unticked, doneAt = null, claim = CLAIM }: { unticked: number } & Partial<Shown>) {
  const m = useMarkDone({ agentId: 'a1', routineId: 't1', doneAt, claim, unticked, onDone: () => {} });
  return (
    <div>
      <button type="button">Elsewhere</button>
      <div ref={m.controlsRef}>
        {m.confirming ? (
          <MarkDoneConfirmation
            unticked={unticked}
            primary
            busy={m.busy}
            onConfirm={m.confirm}
            onCancel={m.cancel}
          />
        ) : (
          <button ref={m.buttonRef} type="button" onClick={m.press} disabled={m.busy}>
            Mark done
          </button>
        )}
      </div>
    </div>
  );
}

const press = () => fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));

beforeEach(() => {
  completeMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('untickedLine', () => {
  it('speaks in number', () => {
    expect(untickedLine(1)).toBe('1 step isn’t ticked. It’ll stay on the task as it is.');
    expect(untickedLine(3)).toBe('3 steps aren’t ticked. They’ll stay on the task as they are.');
  });
});

describe('useMarkDone', () => {
  it('finishes on the first press when nothing is unticked', async () => {
    completeMock.mockResolvedValue({ done: true });
    const onDone = vi.fn();
    render(<Harness unticked={0} onDone={onDone} />);
    press();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledWith('a1', 't1', { requestId: expect.any(String) });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    [1, '1 step isn’t ticked. It’ll stay on the task as it is.'],
    [2, '2 steps aren’t ticked. They’ll stay on the task as they are.'],
  ])('asks first with %i unticked', async (n, line) => {
    completeMock.mockResolvedValue({ done: true });
    const onDone = vi.fn();
    render(<Harness unticked={n} onDone={onDone} />);
    press();
    expect(screen.getByRole('alert').textContent).toContain(line);
    expect(completeMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();

    press();
    fireEvent.click(screen.getByRole('button', { name: 'Mark done anyway' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('takes focus on the confirmation’s first button', () => {
    render(<Harness unticked={2} onDone={() => {}} />);
    press();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mark done anyway' }));
  });

  it('keeps its request id across a failure nobody answered, and starts afresh after an answer', async () => {
    completeMock
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 503))
      .mockResolvedValueOnce({ done: true })
      .mockRejectedValueOnce(new WorkspaceApiError('/x', 403))
      .mockResolvedValueOnce({ done: true });
    const onDone = vi.fn();
    render(<Harness unticked={0} onDone={onDone} />);
    press();
    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    press();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(completeMock.mock.calls[1]![2].requestId).toBe(completeMock.mock.calls[0]![2].requestId);
    expect(screen.queryByTestId('failure')).toBeNull();

    // A success dropped the id, so the next press is a new one; a 403 is an answer, so it drops too.
    press();
    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    press();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    const ids = completeMock.mock.calls.map((c) => c[2].requestId);
    expect(ids[2]).not.toBe(ids[1]);
    expect(ids[3]).not.toBe(ids[2]);
  });

  // The harness button is disabled while busy, so a click can't prove the
  // guard. Calling the hook's functions back to back, in one tick, does: they
  // are what a double-tap or a held key reaches before React re-renders.
  it('sends once when press is called twice before the answer', async () => {
    let resolve!: (v: { done: true }) => void;
    completeMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const onDone = vi.fn();
    const { result } = renderHook(() =>
      useMarkDone({ agentId: 'a1', routineId: 't1', doneAt: null, claim: CLAIM, unticked: 0, onDone }),
    );
    act(() => {
      result.current.press();
      result.current.press();
    });
    expect(completeMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ done: true }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('sends once when confirm is called twice before the answer, and cancel waits', async () => {
    let resolve!: (v: { done: true }) => void;
    completeMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const onDone = vi.fn();
    const { result } = renderHook(() =>
      useMarkDone({ agentId: 'a1', routineId: 't1', doneAt: null, claim: CLAIM, unticked: 2, onDone }),
    );
    act(() => result.current.press());
    expect(result.current.confirming).toBe(true);
    act(() => {
      result.current.confirm();
      result.current.confirm();
      result.current.cancel();
    });
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(result.current.confirming).toBe(true);
    await act(async () => resolve({ done: true }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.confirming).toBe(false);
  });

  /** Reads the page in every commit it renders in, before any effect of that commit can change it. */
  function Probe({ seen }: { seen: string[] }) {
    useLayoutEffect(() => {
      seen.push(document.body.textContent ?? '');
    });
    return null;
  }

  // A press answers the task as it was shown. When the page shows it in another state, the old
  // press's failure and question go before that state is ever on screen: a question that opened
  // there would take focus, and its Mark done anyway is one Enter from finishing the task.
  it.each<[string, Shown]>([
    ['marked done', { doneAt: '2026-10-23T11:00:00.000Z', claim: null }],
    ['with a newer claim', { doneAt: null, claim: '2026-10-23T11:00:00.000Z' }],
    ['no longer claimed', { doneAt: null, claim: null }],
  ])('the task shown %s never commits the old press’s failure or question', async (_, next) => {
    completeMock.mockRejectedValue(new WorkspaceApiError('/x', 502));
    const seen: string[] = [];
    const ui = (shown: Shown) => (
      <>
        <Harness unticked={2} onDone={() => {}} {...shown} />
        <Probe seen={seen} />
      </>
    );
    const view = render(ui({ doneAt: null, claim: CLAIM }));
    press();
    fireEvent.click(screen.getByRole('button', { name: 'Mark done anyway' }));
    await waitFor(() => expect(screen.getByTestId('failure').textContent).toBe(UNCONFIRMED));
    seen.length = 0;
    view.rerender(ui(next));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).not.toContain(UNCONFIRMED);
    expect(seen[0]).not.toContain('Mark done anyway');
    expect(screen.queryByTestId('failure')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark done anyway' })).toBeNull();
  });

  it('keeps its request id while the task shows the same claim, and starts afresh for another', async () => {
    completeMock.mockRejectedValue(new WorkspaceApiError('/x', 502));
    const view = render(<Harness unticked={0} onDone={() => {}} />);
    press();
    await waitFor(() => expect(screen.getByTestId('failure')).toBeTruthy());
    // A read of the same claim: nothing changed on screen, so a retry is the same request.
    view.rerender(<Harness unticked={0} onDone={() => {}} claim={CLAIM} />);
    expect(screen.getByTestId('failure').textContent).toBe(UNCONFIRMED);
    press();
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark done' })).toBeEnabled());
    expect(completeMock.mock.calls[1]![2].requestId).toBe(completeMock.mock.calls[0]![2].requestId);
    // A newer claim is another question.
    view.rerender(<Harness unticked={0} onDone={() => {}} claim="2026-10-23T11:00:00.000Z" />);
    expect(screen.queryByTestId('failure')).toBeNull();
    press();
    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(3));
    expect(completeMock.mock.calls[2]![2].requestId).not.toBe(completeMock.mock.calls[0]![2].requestId);
  });

  // TASK-949's boxes sit above the question, so a step can be ticked while it is open.
  it('closes the question once every step is ticked, and the next press finishes', async () => {
    completeMock.mockResolvedValue({ done: true });
    const onDone = vi.fn();
    const view = render(<Harness unticked={2} onDone={onDone} />);
    press();
    view.rerender(<Harness unticked={1} onDone={onDone} />);
    expect(screen.getByRole('alert').textContent).toContain('1 step isn’t ticked. It’ll stay on the task as it is.');
    view.rerender(<Harness unticked={0} onDone={onDone} />);
    expect(screen.queryByRole('button', { name: 'Mark done anyway' })).toBeNull();
    expect(screen.queryByText(/ticked/)).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
    press();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  // A read that closes the question (the last step ticked elsewhere, or another claim) takes away the button focus
  // was on; focus goes back to Mark done rather than `<body>`, unless the person had moved on.
  it.each<[string, Partial<Shown> & { unticked: number }]>([
    ['every step ticked', { unticked: 0 }],
    ['another claim', { unticked: 2, claim: '2026-10-23T11:00:00.000Z' }],
  ])('a read that closes the question (%s) puts focus back on Mark done', (_what, next) => {
    const view = render(<FocusHarness unticked={2} />);
    press();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mark done anyway' }));
    view.rerender(<FocusHarness {...next} />);
    expect(screen.queryByRole('button', { name: 'Mark done anyway' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mark done' }));
  });

  it('a read that closes the question leaves focus alone when the person moved on', () => {
    const view = render(<FocusHarness unticked={2} />);
    press();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => elsewhere.focus());
    view.rerender(<FocusHarness unticked={0} />);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('shows the failure and keeps the confirmation open for a retry', async () => {
    completeMock.mockRejectedValue(new WorkspaceApiError('/x', 500));
    render(<Harness unticked={2} onDone={() => {}} />);
    press();
    fireEvent.click(screen.getByRole('button', { name: 'Mark done anyway' }));
    await waitFor(() => expect(screen.getByTestId('failure').textContent).toBe(UNCONFIRMED));
    expect(screen.getByRole('button', { name: 'Mark done anyway' })).toBeTruthy();
  });

  it.each<[string, unknown, string, string]>([
    ['401', new WorkspaceApiError('/x', 401), HTTP_SESSION_ENDED, 'default'],
    ['403', new WorkspaceApiError('/x', 403), MARK_DONE_NOT_ALLOWED, 'destructive'],
    [
      '404',
      new WorkspaceApiError('/x', 404),
      'We couldn’t find this task any more. It may have been deleted.',
      'destructive',
    ],
    ['0', new WorkspaceApiError('/x', 0), UNCONFIRMED, 'destructive'],
    ['500', new WorkspaceApiError('/x', 500), UNCONFIRMED, 'destructive'],
    ['a shape error', new WorkspaceShapeError('/x'), UNCONFIRMED, 'destructive'],
    [
      '409',
      new WorkspaceApiError('/x', 409),
      'We couldn’t mark this task done just now. Try again.',
      'destructive',
    ],
  ])('failure words and register: %s', (_l, e, text, register) => {
    expect(markDoneFailure(e)).toEqual({ text, register });
  });

  it('says why a manager-less person can’t', () => {
    expect(MARK_DONE_NOT_ALLOWED).toBe(
      'You can’t mark this task done, because you no longer manage this agent’s tasks.',
    );
  });
});

describe('MarkDoneConfirmation', () => {
  it.each([true, false])('primary %s names its buttons', (primary) => {
    render(
      <MarkDoneConfirmation
        unticked={2}
        primary={primary}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Mark done anyway' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('disables the buttons while busy', () => {
    render(<MarkDoneConfirmation unticked={1} primary busy onConfirm={() => {}} onCancel={() => {}} />);
    expect(
      (screen.getByRole('button', { name: 'Mark done anyway' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
