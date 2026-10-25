/**
 * TaskFinishDate: a get-done task's "Finish by" line and its date field, on the
 * task's own page (TASK-951).
 *
 * Driven through the real component with only `setTaskFinishBy` mocked, so each
 * case is what the person would see. The copy is asserted verbatim because it
 * is decided (TASK-951 plan, Task 6), and its apostrophes are U+2019. The
 * component sits in a small wrapper that keeps `finishBy` in state, as TaskPage
 * does through `applyAnswer`; without it, the focus after Save and after
 * Remove date would never find the button that replaces the field.
 *
 * jsdom reads a date input as browsers do: a value no calendar has reads back
 * as '', and a past date is kept. So "Pick a real date." reaches the component
 * only through the host's 400, which the status cases drive.
 *
 * The browser sits in Los Angeles for the whole file (`process.env.TZ`, read
 * live), so the zone each save sends with its date is known whatever zone the
 * runner is in (TASK-955).
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ROUTINE_FINISH_BY_LATEST } from '@ax/routines-contract';
import { HTTP_SESSION_ENDED } from '@/lib/http';
import { finishByLine } from '@/lib/task-finish-by';
import { WorkspaceApiError, workspaceApi } from '@/lib/workspace-api';
import type { TaskFinishBy } from '@/lib/workspace-types';
import { TaskFinishDate } from '../TaskFinishDate';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { setTaskFinishBy: vi.fn() } };
});

const setMock = vi.mocked(workspaceApi.setTaskFinishBy);

const FB: TaskFinishBy = { date: '2026-11-14', daysLeft: 9 };
const NOT_FOUND = 'We couldn’t find this task any more. It may have been deleted.';
const UNCONFIRMED = 'We couldn’t save that date. Try again.';

function Harness({
  initial,
  onSaved,
}: {
  initial: TaskFinishBy | null;
  onSaved: (finishBy: TaskFinishBy | null) => void;
}) {
  const [finishBy, setFinishBy] = useState(initial);
  return (
    <>
      <button type="button">Elsewhere</button>
      <TaskFinishDate
        agentId="a1"
        routineId="t1"
        agentName="Caveman"
        finishBy={finishBy}
        onSaved={(next) => {
          setFinishBy(next);
          onSaved(next);
        }}
      />
    </>
  );
}

function renderField(initial: TaskFinishBy | null) {
  const onSaved = vi.fn();
  render(<Harness initial={initial} onSaved={onSaved} />);
  return { onSaved };
}

const field = () => screen.getByLabelText('Finish by') as HTMLInputElement;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const pick = (value: string) => fireEvent.change(field(), { target: { value } });

let savedTz: string | undefined;
beforeEach(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  setMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 5, 12));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe('TaskFinishDate — what it shows', () => {
  it('shows the date and the days left, with Change described by that line', () => {
    renderField(FB);
    const line = finishByLine(FB);
    expect(screen.getByText(line)).toBeTruthy();
    const described = button('Change').getAttribute('aria-describedby');
    expect(described).not.toBeNull();
    expect(document.getElementById(described!)?.textContent).toContain(line);
    expect(screen.queryByLabelText('Finish by')).toBeNull();
  });

  it('offers Add a finish date when there is none, and no Remove date in its field', () => {
    renderField(null);
    expect(screen.queryByText(/Finish by/)).toBeNull();
    fireEvent.click(button('Add a finish date'));
    expect(screen.queryByRole('button', { name: 'Remove date' })).toBeNull();
    expect(button('Save')).toBeTruthy();
    expect(button('Cancel')).toBeTruthy();
  });
});

describe('TaskFinishDate — setting and removing', () => {
  it('adds a date: the field opens focused, saves once, and hands focus back', async () => {
    setMock.mockResolvedValueOnce({ finishBy: FB });
    const { onSaved } = renderField(null);
    fireEvent.click(button('Add a finish date'));
    expect(document.activeElement).toBe(field());
    expect(field().type).toBe('date');
    expect(field().min).toBe('2026-11-05');
    // The newest date the host takes, so the picker doesn't offer one it would refuse.
    expect(field().max).toBe(ROUTINE_FINISH_BY_LATEST);
    expect(
      screen.getByText('Caveman will tell you if the steps left won’t fit.').id,
    ).not.toBe('');
    pick('2026-11-14');
    fireEvent.click(button('Save'));
    // Wait for the field to go, not for onSaved: onSaved runs before React commits the
    // close, and the focus check below is only meaningful once that commit has landed.
    await waitFor(() => expect(screen.queryByLabelText('Finish by')).toBeNull());
    expect(onSaved).toHaveBeenCalledWith(FB);
    expect(setMock).toHaveBeenCalledTimes(1);
    // With the browser's own zone, which the host counts in when the task has none (TASK-955).
    expect(setMock).toHaveBeenCalledWith('a1', 't1', '2026-11-14', 'America/Los_Angeles');
    expect(document.activeElement).toBe(button('Change'));
  });

  it('changes and removes a date', async () => {
    setMock.mockResolvedValueOnce({ finishBy: null });
    const { onSaved } = renderField(FB);
    fireEvent.click(button('Change'));
    expect(field().value).toBe('2026-11-14');
    fireEvent.click(button('Remove date'));
    await waitFor(() => expect(screen.queryByLabelText('Finish by')).toBeNull());
    expect(onSaved).toHaveBeenCalledWith(null);
    // No date, so no zone: the host clears both.
    expect(setMock).toHaveBeenCalledWith('a1', 't1', null, null);
    expect(document.activeElement).toBe(button('Add a finish date'));
  });

  it('a browser that can’t tell its zone still saves the date, with none (TASK-955)', async () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...real.call(this), timeZone: 'Etc/Unknown' };
    });
    setMock.mockResolvedValueOnce({ finishBy: FB });
    const { onSaved } = renderField(null);
    fireEvent.click(button('Add a finish date'));
    pick('2026-11-14');
    fireEvent.click(button('Save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(FB));
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith('a1', 't1', '2026-11-14', null);
  });

  // TASK-960. The answer to a save lands outside any event, so React commits it on a
  // later task, and an effect that runs after paint left focus on <body> for a frame
  // once the field was gone: a key pressed then went nowhere, and the test above
  // flaked when its check landed in that frame. Watching the DOM pins the moment the
  // field goes, which no amount of waiting can: focus must already be on the button.
  it.each<[string, TaskFinishBy | null, string, string]>([
    ['Save', null, 'Add a finish date', 'Change'],
    ['Remove date', FB, 'Change', 'Add a finish date'],
  ])('%s hands focus back in the same commit that closes the field', async (press, initial, opener, after) => {
    setMock.mockResolvedValueOnce({ finishBy: initial === null ? FB : null });
    renderField(initial);
    fireEvent.click(button(opener));
    if (initial === null) pick('2026-11-14');
    const seen: { focused: Element | null }[] = [];
    const watch = new MutationObserver(() => {
      if (seen.length === 0 && screen.queryByLabelText('Finish by') === null) {
        seen.push({ focused: document.activeElement });
      }
    });
    watch.observe(document.body, { childList: true, subtree: true });
    try {
      fireEvent.click(button(press));
      await waitFor(() => expect(seen).toHaveLength(1));
    } finally {
      watch.disconnect();
    }
    expect(seen[0]?.focused).toBe(button(after));
  });

  it('shows Save working while it sends, and sends nothing twice', async () => {
    let resolve!: (v: { finishBy: TaskFinishBy | null }) => void;
    setMock.mockReturnValueOnce(new Promise((res) => (resolve = res)));
    renderField(null);
    fireEvent.click(button('Add a finish date'));
    pick('2026-11-14');
    fireEvent.click(button('Save'));
    expect(button('Save').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    fireEvent.click(button('Save'));
    await act(async () => resolve({ finishBy: FB }));
    expect(setMock).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string]>([
    ['a day that has gone', '2026-11-04'],
    ['nothing at all', ''],
  ])('refuses %s with no request', (_label, value) => {
    renderField(null);
    fireEvent.click(button('Add a finish date'));
    pick(value);
    fireEvent.click(button('Save'));
    expect(screen.getByText('Pick today or a later date.')).toBeTruthy();
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(setMock).not.toHaveBeenCalled();
  });

  it('Cancel and Escape close the field with no request, and focus goes back', () => {
    renderField(FB);
    fireEvent.click(button('Change'));
    pick('2026-11-20');
    fireEvent.click(button('Cancel'));
    expect(screen.queryByLabelText('Finish by')).toBeNull();
    expect(document.activeElement).toBe(button('Change'));
    expect(screen.getByText(finishByLine(FB))).toBeTruthy();

    fireEvent.click(button('Change'));
    expect(field().value).toBe('2026-11-14');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByLabelText('Finish by')).toBeNull();
    expect(document.activeElement).toBe(button('Change'));
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('TaskFinishDate — when the host says no', () => {
  it.each<[number, string, boolean]>([
    [404, NOT_FOUND, true],
    [403, NOT_FOUND, true],
    [400, 'Pick a real date.', false],
    [401, HTTP_SESSION_ENDED, true],
    [500, UNCONFIRMED, false],
    [429, UNCONFIRMED, false],
    [409, UNCONFIRMED, false],
  ])('a %i says %s', async (status, line, dead) => {
    setMock.mockRejectedValueOnce(new WorkspaceApiError('/p', status));
    renderField(FB);
    fireEvent.click(button('Change'));
    pick('2026-11-20');
    fireEvent.click(button('Save'));
    await screen.findByText(line);
    expect(setMock).toHaveBeenCalledTimes(1);
    // Pressing again can't fix a task that is gone or a session that ended.
    expect(button('Save').disabled).toBe(dead);
    expect(button('Remove date').disabled).toBe(dead);
    expect(button('Cancel').disabled).toBe(false);
    expect(field().getAttribute('aria-invalid')).toBe(status === 400 ? 'true' : null);
  });

  it('a save nobody could confirm says so, and pressing Save again sends the same date', async () => {
    setMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    setMock.mockResolvedValueOnce({ finishBy: FB });
    const { onSaved } = renderField(null);
    fireEvent.click(button('Add a finish date'));
    pick('2026-11-14');
    fireEvent.click(button('Save'));
    await screen.findByText(UNCONFIRMED);
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(button('Save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(FB));
    expect(setMock).toHaveBeenCalledTimes(2);
    expect(setMock.mock.calls.map((c) => c[2])).toEqual(['2026-11-14', '2026-11-14']);
  });

  it.each<[number, string]>([
    [404, NOT_FOUND],
    [401, HTTP_SESSION_ENDED],
  ])('keeps a %i refusal on screen after Cancel, and no longer offers to change the date', async (status, line) => {
    setMock.mockRejectedValueOnce(new WorkspaceApiError('/p', status));
    renderField(FB);
    fireEvent.click(button('Change'));
    fireEvent.click(button('Save'));
    await screen.findByText(line);
    fireEvent.click(button('Cancel'));
    expect(screen.queryByLabelText('Finish by')).toBeNull();
    expect(screen.getByText(line)).toBeTruthy();
    expect(button('Change').disabled).toBe(true);
    // A disabled button can't take focus, so the message does.
    expect(document.activeElement).toBe(screen.getByText(line));
  });

  it.each<[number, string]>([
    [404, NOT_FOUND],
    [401, HTTP_SESSION_ENDED],
  ])('puts focus on the %i refusal when Escape closes the field', async (status, line) => {
    setMock.mockRejectedValueOnce(new WorkspaceApiError('/p', status));
    renderField(FB);
    fireEvent.click(button('Change'));
    fireEvent.click(button('Save'));
    await screen.findByText(line);
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByLabelText('Finish by')).toBeNull();
    expect(document.activeElement).toBe(screen.getByText(line));
  });

  it('keeps a gone task gone when the date was never set: Add a finish date goes disabled too', async () => {
    setMock.mockRejectedValueOnce(new WorkspaceApiError('/p', 404));
    renderField(null);
    fireEvent.click(button('Add a finish date'));
    pick('2026-11-14');
    fireEvent.click(button('Save'));
    await screen.findByText(NOT_FOUND);
    fireEvent.click(button('Cancel'));
    expect(screen.getByText(NOT_FOUND)).toBeTruthy();
    expect(button('Add a finish date').disabled).toBe(true);
  });

  it('drops a refusal that pressing again could fix when the field is cancelled', async () => {
    setMock.mockRejectedValueOnce(new WorkspaceApiError('/p', 500));
    renderField(FB);
    fireEvent.click(button('Change'));
    fireEvent.click(button('Save'));
    await screen.findByText(UNCONFIRMED);
    fireEvent.click(button('Cancel'));
    expect(screen.queryByText(UNCONFIRMED)).toBeNull();
    expect(button('Change').disabled).toBe(false);
  });

  it('clears an old refusal when the person picks another date', async () => {
    setMock.mockRejectedValueOnce(new WorkspaceApiError('/p', 400));
    renderField(null);
    fireEvent.click(button('Add a finish date'));
    pick('2026-11-14');
    fireEvent.click(button('Save'));
    await screen.findByText('Pick a real date.');
    pick('2026-11-15');
    expect(screen.queryByText('Pick a real date.')).toBeNull();
  });
});
