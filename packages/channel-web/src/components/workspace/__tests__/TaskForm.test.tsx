import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RoutineView } from '@ax/routines-contract';
import { RoutineEditor } from '@/components/routines/RoutineEditor';
import { routineApi, RoutineApiError } from '@/lib/routines';
import { routineFixture } from '@/components/routines/__tests__/routine-fixture';
import { schedulePreset, scheduleChip, hoursChip } from '../task-form-helpers';

vi.mock('@/lib/routines', async original => ({
  ...(await original<typeof import('@/lib/routines')>()),
  routineApi: { get: vi.fn(), create: vi.fn(), update: vi.fn(), getTaskReceiver: vi.fn(), replaceTaskReceiver: vi.fn(), getReceiver: vi.fn(), getReceiverAccess: vi.fn() },
}));
const task: RoutineView = { ...routineFixture, kind: 'stay-on-top', goodWhen: 'Nothing waits.' };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(routineApi.create).mockResolvedValue(task);
  vi.mocked(routineApi.update).mockResolvedValue(task);
  vi.mocked(routineApi.getTaskReceiver).mockResolvedValue({ url: '/webhooks/r', version: 'a'.repeat(64), legacyActive: false });
});
function create() {
  const onCancel = vi.fn();
  render(<RoutineEditor taskMode mode="create" agentId="a" agentName="Caveman" onSaved={vi.fn()} onCancel={onCancel} />);
  return { onCancel };
}
async function edit(view: RoutineView) {
  vi.mocked(routineApi.get).mockResolvedValue(view);
  const onCancel = vi.fn();
  render(<RoutineEditor taskMode mode="edit" agentId="a" agentName="Caveman" routine={view} onSaved={vi.fn()} onCancel={onCancel} />);
  await screen.findByDisplayValue(view.name);
  return { onCancel };
}
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const start = () => fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
// zod's built-ins and the contract's terse checks; none may reach the page.
const RAW = /String must contain|Expected|Required|Invalid|too_small|at least 1 character/;

describe('task form validation', () => {
  it('shows a plain error under each missing field on submit, links it, and focuses the first', async () => {
    create();
    expect(screen.queryByText('Give it a name.')).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Start task' });
    expect(button).toBeEnabled();
    start();
    const name = screen.getByLabelText('Name');
    expect(await screen.findByText('Give it a name.')).toBeVisible();
    expect(screen.getByText('Tell Caveman what to do.')).toBeVisible();
    expect(screen.getByText('Say how we’ll know this task is going well.')).toBeVisible();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Give it a name.');
    expect(screen.getByLabelText('What should Caveman do?')).toHaveAccessibleDescription('Tell Caveman what to do.');
    await waitFor(() => expect(name).toHaveFocus());
    expect(document.body.textContent).not.toMatch(RAW);
    expect(routineApi.create).not.toHaveBeenCalled();

    fill('Name', 'Queue');
    expect(screen.queryByText('Give it a name.')).not.toBeInTheDocument();
    start();
    await waitFor(() => expect(screen.getByLabelText('What should Caveman do?')).toHaveFocus());
    fill('What should Caveman do?', 'Answer easy questions.');
    fill('Going well when', 'Nothing waits a day.');
    start();
    await waitFor(() => expect(routineApi.create).toHaveBeenCalledOnce());
  });

  it('opens More options and focuses a problem hidden there, in plain words', async () => {
    create();
    fill('Name', 'Queue'); fill('What should Caveman do?', 'Answer.'); fill('Going well when', 'Calm.');
    fireEvent.click(screen.getByRole('button', { name: 'App updates: Off' }));
    fireEvent.click(screen.getByRole('switch', { name: 'When another app sends an update' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // Closing hands focus back to the chip a tick later.
    await waitFor(() => expect(screen.getByRole('button', { name: /^App updates: On/ })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fill('Address name', 'not a path');
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.queryByLabelText('Address name')).not.toBeInTheDocument();
    start();
    const address = await screen.findByLabelText('Address name');
    await waitFor(() => expect(address).toHaveFocus());
    expect(address).toHaveAccessibleDescription(expect.stringContaining('Use letters, numbers, dots, dashes and slashes'));
    expect(screen.getByRole('button', { name: 'More options' })).toHaveAttribute('aria-expanded', 'true');
    expect(document.body.textContent).not.toMatch(RAW);
    expect(routineApi.create).not.toHaveBeenCalled();
  });

  it('puts a chip’s problem under the chip row and focuses the chip', async () => {
    await edit({ ...task, activeHours: { start: '09:00', end: '17:00', tz: 'UTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Active hours: Every day 9am–5pm' }));
    fill('End', '09:00');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const chip = await screen.findByRole('button', { name: /^Active hours:/ });
    await waitFor(() => expect(chip).toHaveFocus());
    // aria-invalid isn't supported on buttons; the chip says it through its description.
    expect(chip).not.toHaveAttribute('aria-invalid');
    expect(chip).toHaveAccessibleDescription('Choose different start and end times for active hours.');
    fireEvent.click(chip);
    for (const edge of ['Start', 'End']) {
      expect(screen.getByLabelText(edge)).toHaveAccessibleDescription('Choose different start and end times for active hours.');
    }
    expect(routineApi.update).not.toHaveBeenCalled();
  });

  it('keeps focus on the first problem when a submit closes an open popover', async () => {
    create();
    fireEvent.click(screen.getByRole('button', { name: 'Active hours: Any time' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Only at certain hours' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Start task' }).closest('form')!);
    const name = screen.getByLabelText('Name');
    await waitFor(() => expect(name).toHaveFocus());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(name).toHaveFocus();
    expect(screen.queryByRole('switch', { name: 'Only at certain hours' })).not.toBeInTheDocument();
  });

  it('keeps a problem’s field on screen after the setting that showed it is cleared', async () => {
    create();
    fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
    fill('Name', 'Digest'); fill('What should Caveman do?', 'Send it.');
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fill('Quiet word (optional)', 'QUIET');
    fill('Treat replies this short as quiet', '-5');
    fill('Quiet word (optional)', '');
    expect(screen.queryByLabelText('Treat replies this short as quiet')).not.toBeInTheDocument();
    start();
    const length = await screen.findByLabelText('Treat replies this short as quiet');
    await waitFor(() => expect(length).toHaveFocus());
    expect(length).toHaveAttribute('aria-invalid', 'true');
    expect(length).toHaveAccessibleDescription(expect.stringContaining('Use a whole number from 0 to 65,536.'));
    expect(routineApi.create).not.toHaveBeenCalled();
  });

  it('shows a task’s shared conversation where it can be fixed', async () => {
    await edit({ ...task, conversation: 'shared' });
    fill('What should Caveman do?', 'Changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const memory = await screen.findByRole('group', { name: 'Memory between runs' });
    expect(memory).toHaveAccessibleDescription('A task starts a fresh conversation for each check-in.');
    await waitFor(() => expect(memory.contains(document.activeElement)).toBe(true));
    fireEvent.click(screen.getByRole('radio', { name: 'Start fresh each time' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(routineApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(routineApi.update).mock.calls[0]![0].patch).toStrictEqual({ promptBody: 'Changed.', conversation: 'per-fire' });
  });

  it('says a problem with no control of its own at the form, and focuses it', async () => {
    await edit({ ...routineFixture, goodWhen: 'Left over.' });
    fill('What should Caveman do?', 'Changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const problem = await screen.findByText('Only a task can say when it’s going well.');
    await waitFor(() => expect(problem).toHaveFocus());
    expect(routineApi.update).not.toHaveBeenCalled();
  });

  it('links an empty day selection to its problem inside the hours popover', async () => {
    await edit({ ...task, activeHours: { start: '09:00', end: '17:00', tz: 'UTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Active hours: Every day 9am–5pm' }));
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) fireEvent.click(screen.getByRole('button', { name: day }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Active hours:/ }));
    const days = screen.getByRole('group', { name: 'Active days' });
    expect(days).toHaveAttribute('aria-invalid', 'true');
    expect(days).toHaveAccessibleDescription(expect.stringContaining('Choose at least one day.'));
  });

  it('says a custom schedule’s problem once, linked from both its inputs', async () => {
    await edit({ ...task, schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fill('Cron expression', 'not a cron');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const words = /We couldn’t read that schedule/;
    await waitFor(() => expect(screen.getAllByText(words)).toHaveLength(1));
    expect(screen.getByLabelText('Cron expression')).toHaveAccessibleDescription(words);
    expect(screen.getByLabelText('Time zone')).toHaveAccessibleDescription(words);
  });

  it('gives the Interval input and its help their own ids', () => {
    create();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    const interval = screen.getByLabelText('Interval');
    expect(document.querySelectorAll(`[id="${interval.id}"]`)).toHaveLength(1);
    expect(interval).toHaveAccessibleDescription('A number and a unit: m for minutes, h for hours, d for days.');
  });

  it('names the kind toggle by its own label, with no stray hidden label', () => {
    create();
    expect(screen.getByRole('group', { name: 'Kind of task' })).toHaveAccessibleDescription('Keeps checking and fixing. Never finishes.');
    expect(screen.queryByText('Kind of task')).not.toBeInTheDocument();
  });

  it('closes without a write when Save has nothing to send', async () => {
    const { onCancel } = await edit(task);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(routineApi.update).not.toHaveBeenCalled();
  });
});

describe('task form chips and presets', () => {
  it('names each chip with its current value', async () => {
    create();
    expect(screen.getByRole('button', { name: 'How often: Every hour' })).toHaveTextContent('Every hour');
    expect(screen.getByRole('button', { name: 'App updates: Off' })).toBeVisible();
    const hours = screen.getByRole('button', { name: 'Active hours: Any time' });
    fireEvent.click(hours);
    fireEvent.click(screen.getByRole('switch', { name: 'Only at certain hours' }));
    expect(screen.getByRole('button', { name: 'Active hours: Every day 9am–5pm' })).toBeVisible();
    for (const day of ['Saturday', 'Sunday']) fireEvent.click(screen.getByRole('button', { name: day }));
    expect(screen.getByRole('button', { name: 'Active hours: Weekdays 9am–5pm' })).toBeVisible();
  });

  it('describes the selected kind in one line and offers Repeat its faster presets only', async () => {
    create();
    expect(screen.getByText('Keeps checking and fixing. Never finishes.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'How often: Every hour' }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Every' }), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: '5 min' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: '15 min' }));
    expect(screen.getByRole('button', { name: 'How often: Every 15 min' })).toBeVisible();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
    expect(screen.getByText('Does the same job on a schedule.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'How often: Every 15 min' }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Every' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: '1 min' }));
    expect(screen.getByRole('button', { name: 'How often: Every minute' })).toBeVisible();
    fill('Name', 'Ping'); fill('What should Caveman do?', 'Ping.');
    start();
    await waitFor(() => expect(routineApi.create).toHaveBeenCalledOnce());
    expect(vi.mocked(routineApi.create).mock.calls[0]![0].definition.schedule).toStrictEqual({ kind: 'interval', every: '1m' });
  });

  it('shows a saved cron that equals a preset as that preset, and leaves it untouched on save', async () => {
    await edit({ ...task, schedule: { kind: 'cron', expr: '*/15 * * * *', tz: 'UTC' } });
    expect(screen.getByRole('button', { name: 'How often: Every 15 min' })).toBeVisible();
    fill('What should Caveman do?', 'Only the brief changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(routineApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(routineApi.update).mock.calls[0]![0].patch).toStrictEqual({ promptBody: 'Only the brief changed.' });
  });

  it('shows another cron as a custom schedule and replaces it only when a preset is picked', async () => {
    await edit({ ...task, schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'How often: Custom schedule' }));
    const every = screen.getByRole('combobox', { name: 'Every' });
    expect(every).toHaveTextContent('Custom schedule…');
    fireEvent.keyDown(every, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: '30 min' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(routineApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(routineApi.update).mock.calls[0]![0].patch).toStrictEqual({ schedule: { kind: 'interval', every: '30m' } });
  });

  it('survives a cleared Interval: How often shows no choice instead of an empty option', () => {
    create();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fill('Interval', '');
    fireEvent.click(screen.getByRole('button', { name: /^How often:/ }));
    const every = screen.getByRole('combobox', { name: 'Every' });
    expect(every).toHaveTextContent('Choose how often');
    fireEvent.keyDown(every, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['15 min', '30 min', '1 hour', '2 hours', '1 day', '1 week', 'Custom schedule…']);
    fireEvent.click(screen.getByRole('option', { name: '30 min' }));
    expect(screen.getByLabelText('Interval')).toHaveValue('30m');
  });

  it('shows a preset-equal cron’s time zone problem under More options, where the time zone is', async () => {
    await edit({ ...task, schedule: { kind: 'cron', expr: '*/15 * * * *', tz: 'Mars/Olympus' } });
    fill('What should Caveman do?', 'Changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const zone = await screen.findByLabelText('Time zone');
    expect(zone).toHaveAccessibleDescription(expect.stringContaining('Use a time zone name, like America/New_York.'));
    expect(screen.getByRole('button', { name: 'How often: Every 15 min' })).not.toHaveAccessibleDescription();
    expect(routineApi.update).not.toHaveBeenCalled();
  });

  it('maps equal presets both ways', () => {
    expect(schedulePreset({ kind: 'interval', every: '60m' }, 'stay-on-top')).toBe('1h');
    expect(schedulePreset({ kind: 'interval', every: '45m' }, 'stay-on-top')).toBeNull();
    expect(schedulePreset({ kind: 'cron', expr: '0 */2 * * *', tz: 'UTC' }, 'get-done')).toBe('2h');
    expect(schedulePreset({ kind: 'cron', expr: '0 */5 * * * *', tz: 'UTC' }, 'repeat')).toBe('5m');
    // A task never runs every 5 minutes, so that cron stays custom there.
    expect(schedulePreset({ kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' }, 'stay-on-top')).toBeNull();
    expect(schedulePreset({ kind: 'cron', expr: '*/15 * * 1 *', tz: 'UTC' }, 'stay-on-top')).toBeNull();
    expect(scheduleChip({ kind: 'interval', every: '45m' }, 'stay-on-top')).toBe('Every 45 min');
    expect(scheduleChip(null, 'repeat')).toBe('No schedule');
    expect(hoursChip({ start: '22:00', end: '06:30', tz: 'UTC', days: ['sat', 'sun'] })).toBe('Weekends 10pm–6:30am');
  });
});

describe('task form More options', () => {
  it('holds the schedule, note and Start right away for a task, and no quiet settings', () => {
    create();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.getByRole('radio', { name: 'Custom schedule' })).toBeVisible();
    expect(screen.getByLabelText('Note for you (optional)')).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Start right away' })).toBeChecked();
    expect(screen.queryByLabelText('Quiet word (optional)')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Memory between runs' })).not.toBeInTheDocument();
  });

  it('holds Repeat’s memory, quiet reply and app settings, and saves them in the same shape', async () => {
    create();
    fireEvent.click(screen.getByRole('radio', { name: 'Repeat' }));
    fill('Name', 'Digest'); fill('What should Caveman do?', 'Send the digest.');
    fireEvent.click(screen.getByRole('button', { name: 'App updates: Off' }));
    fireEvent.click(screen.getByRole('switch', { name: 'When another app sends an update' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Keep one running conversation' }));
    expect(screen.queryByLabelText('Treat replies this short as quiet')).not.toBeInTheDocument();
    fill('Quiet word (optional)', 'NOTHING_NEW');
    expect(screen.getByLabelText('Quiet word (optional)')).toHaveAccessibleDescription(/starts or ends with this word/);
    fill('Treat replies this short as quiet', '40');
    fill('Address name', '/digest');
    fill('Only these kinds of updates', 'push, release');
    fireEvent.click(screen.getByRole('switch', { name: 'Verify signature' }));
    fill('Note for you (optional)', 'Mine.');
    fireEvent.click(screen.getByRole('switch', { name: 'Start right away' }));
    start();
    await waitFor(() => expect(routineApi.create).toHaveBeenCalledOnce());
    expect(vi.mocked(routineApi.create).mock.calls[0]![0].definition).toStrictEqual({
      name: 'Digest', description: 'Mine.', promptBody: 'Send the digest.', enabled: false,
      schedule: { kind: 'interval', every: '1h' },
      webhook: { kind: 'webhook', path: '/digest', events: ['push', 'release'], hmac: { header: 'X-Hub-Signature-256', algorithm: 'sha256', prefix: 'sha256=' } },
      activeHours: null, silenceToken: 'NOTHING_NEW', silenceMaxChars: 40, conversation: 'shared', kind: 'repeat', goodWhen: null,
    });
  });

  it('hides Start right away on edit, where Pause and Resume live on the task page', async () => {
    await edit(task);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.getByLabelText('Note for you (optional)')).toHaveValue(task.description);
    expect(screen.queryByRole('switch', { name: 'Start right away' })).not.toBeInTheDocument();
  });
});

describe('task form save refusals', () => {
  // Every code the host can refuse a save with, in a task's words, never Settings' "routine" copy.
  it.each([
    ['validation', 'We couldn’t save these settings. Check them and try again.'],
    ['revision-conflict', 'This task changed while you had it open. Reload it to get the latest, then make your change again.'],
    ['webhook-path-conflict', 'Another task already uses that address name. Choose a different one.'],
    ['request-conflict', 'We couldn’t match this save to your earlier try. Close this and make the change again.'],
    ['approval-required', 'This change needs someone’s approval before it takes effect.'],
    ['not-found', 'This task isn’t available anymore. It may have been deleted.'],
    ['forbidden', 'You don’t have permission to change this task.'],
    ['busy', 'This task is busy with a run. Try again when it finishes.'],
    ['disabled', 'This task is paused. Resume it, then try again.'],
    ['cleanup-pending', 'We’re still removing this task’s old signing secret. Try again in a moment.'],
    ['unavailable', 'We couldn’t reach tasks just now. Try again in a moment.'],
  ])('says %s in task words', async (code, words) => {
    vi.mocked(routineApi.update).mockRejectedValue(new RoutineApiError(409, code));
    await edit(task);
    fill('What should Caveman do?', 'Changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(words)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/routine/i);
  });

  it('opens More options and focuses the field the host refused', async () => {
    vi.mocked(routineApi.update).mockRejectedValue(new RoutineApiError(400, 'validation', 'webhook.path'));
    await edit({ ...task, webhook: { kind: 'webhook', path: '/updates' } });
    fill('What should Caveman do?', 'Changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('We couldn’t save one of these settings. Check the marked one and try again.')).toBeVisible();
    const address = await screen.findByLabelText('Address name');
    await waitFor(() => expect(address).toHaveFocus());
    expect(address).toHaveAttribute('aria-invalid', 'true');
  });

  it('promises no mark when the host names no field we show', async () => {
    vi.mocked(routineApi.update).mockRejectedValue(new RoutineApiError(400, 'validation', 'input'));
    await edit(task);
    fill('What should Caveman do?', 'Changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('We couldn’t save these settings. Check them and try again.')).toBeVisible();
    expect(screen.queryByText(/marked/)).not.toBeInTheDocument();
  });

  it('keeps the reload offer on a conflict', async () => {
    vi.mocked(routineApi.update).mockRejectedValue(new RoutineApiError(409, 'revision-conflict'));
    await edit(task);
    fill('What should Caveman do?', 'Changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Reload and discard my changes' })).toBeVisible();
  });

  it('marks the address name when another task already uses it', async () => {
    vi.mocked(routineApi.update).mockRejectedValue(new RoutineApiError(409, 'webhook-path-conflict', 'webhook.path'));
    await edit({ ...task, webhook: { kind: 'webhook', path: '/taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fill('Address name', '/also-taken');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const address = screen.getByLabelText('Address name');
    await waitFor(() => expect(address).toHaveAttribute('aria-invalid', 'true'));
    expect(address).toHaveAccessibleDescription(expect.stringContaining('Another task already uses that address name. Choose a different one.'));
  });

  it('says a failure that wasn’t the host’s answer plainly, without its text', async () => {
    vi.mocked(routineApi.update).mockRejectedValue(new Error('socket hang up at 10.0.0.4'));
    await edit(task);
    fill('What should Caveman do?', 'Changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('We couldn’t save this task. Try again.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry save' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/socket|routine/i);
  });
});
