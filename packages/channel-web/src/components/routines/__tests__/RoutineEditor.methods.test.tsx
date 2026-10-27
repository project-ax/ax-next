import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Profiler, useLayoutEffect } from 'react';
import { RoutineEditor } from '../RoutineEditor';
import { routineFixture } from './routine-fixture';

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), create: vi.fn(), access: vi.fn(), receiver: vi.fn(), replace: vi.fn(), shared: vi.fn() }));
vi.mock('@/lib/routines', async original => ({
  ...(await original<typeof import('@/lib/routines')>()),
  routineApi: { get: mocks.get, update: mocks.update, create: mocks.create, getReceiverAccess: mocks.access, getReceiver: mocks.shared, getTaskReceiver: mocks.receiver, replaceTaskReceiver: mocks.replace },
}));
const schedule = { kind: 'interval' as const, every: '1h' };
const webhook = { kind: 'webhook' as const, path: '/original', events: ['push'], hmac: { header: 'X-Signature', algorithm: 'sha256' as const, prefix: 'sha256=' } };
function view() {
  const value = { ...routineFixture, schedule, webhook };
  Reflect.deleteProperty(value, 'trigger');
  return value;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue(view());
  mocks.update.mockResolvedValue(view());
  mocks.create.mockResolvedValue(view());
  mocks.access.mockResolvedValue({ allowed: true });
  mocks.receiver.mockResolvedValue({ url: '/webhooks/original-bearer', version: 'a'.repeat(64), legacyActive: true });
});

describe('app signature settings', () => {
  it('marks an invalid custom header and keeps Save off', async () => {
    await edit();
    fireEvent.click(screen.getByRole('button', { name: 'Optional settings' }));
    fireEvent.change(screen.getByLabelText('Signature header'), { target: { value: 'not a header' } });
    expect(screen.getByLabelText('Signature header')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
  it.each(['Stripe', 'Slack', 'Zendesk'])('reloads %s and preserves it when only the brief changes', async label => {
    mocks.get.mockResolvedValue({ ...view(), webhook: { ...webhook, hmac: { app: label.toLowerCase() } } });
    await edit();
    fireEvent.click(screen.getByRole('button', { name: 'Optional settings' }));
    expect(screen.getByRole('radio', { name: label })).toBeChecked();
    expect(screen.queryByLabelText('Signature header')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What should Caveman do?'), { target: { value: 'Only the brief changed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ patch: { promptBody: 'Only the brief changed.' } })));
  });
  it('preserves a custom header/algorithm/prefix draft when switching apps', async () => {
    await edit();
    fireEvent.click(screen.getByRole('button', { name: 'Optional settings' }));
    fireEvent.change(screen.getByLabelText('Signature header'), { target: { value: 'Private-Signature' } });
    fireEvent.click(screen.getByRole('radio', { name: 'SHA1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Slack' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }));
    expect(screen.getByLabelText('Signature header')).toHaveValue('Private-Signature');
    expect(screen.getByRole('radio', { name: 'SHA1' })).toBeChecked();
    expect(screen.getByLabelText('Signature prefix')).toHaveValue('sha256=');
  });
  it.each(['Stripe', 'Slack', 'Zendesk'])('saves the complete %s protocol', async label => {
    const app = label.toLowerCase();
    await edit();
    fireEvent.click(screen.getByRole('button', { name: 'Optional settings' }));
    fireEvent.click(screen.getByRole('radio', { name: label }));
    expect(screen.queryByLabelText('Signature header')).not.toBeInTheDocument();
    expect(screen.getByText(/timestamp more than five minutes/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ patch: {
      webhook: { ...webhook, hmac: { app } },
    } })));
  });
});
async function edit() {
  const result = render(<RoutineEditor mode="edit" agentId="a" agentName="Caveman" routine={view()} onSaved={vi.fn()} onCancel={vi.fn()} />);
  await screen.findByDisplayValue(routineFixture.name);
  return result;
}

describe('independent routine methods in the existing editor', () => {
  it('loads both methods and changes only the schedule without losing webhook configuration', async () => {
    await edit();
    expect(screen.getByRole('checkbox', { name: 'On a schedule' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'When another app sends an update' })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Interval'), { target: { value: '2h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ patch: { schedule: { kind: 'interval', every: '2h' } } })));
  });

  it('removes a schedule while preserving the configured webhook and its signature settings', async () => {
    await edit();
    fireEvent.click(screen.getByRole('checkbox', { name: 'On a schedule' }));
    expect(screen.getByRole('checkbox', { name: 'When another app sends an update' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ patch: { schedule: null } })));
  });

  it('retains webhook drafts across off and on without changing the schedule', async () => {
    await edit();
    const updates = screen.getByRole('checkbox', { name: 'When another app sends an update' });
    fireEvent.click(updates);
    fireEvent.click(updates);
    expect(screen.getByLabelText('Webhook path')).toHaveValue('/original');
    expect(screen.getByLabelText('Events (comma-separated)')).toHaveValue('push');
    fireEvent.click(screen.getByRole('button', { name: 'Optional settings' }));
    expect(screen.getByLabelText('Signature header')).toHaveValue('X-Signature');
    expect(screen.getByLabelText('Signature prefix')).toHaveValue('sha256=');
    fireEvent.change(screen.getByLabelText('What should Caveman do?'), { target: { value: 'Updated instructions.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ patch: { promptBody: 'Updated instructions.' } })));
  });

  it('prevents saving a repeat job with neither wake method', async () => {
    await edit();
    fireEvent.click(screen.getByRole('checkbox', { name: 'On a schedule' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'When another app sends an update' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('keeps task schedules on and does not offer app updates before the task inbox exists', async () => {
    const task = { ...view(), kind: 'stay-on-top' as const, goodWhen: 'Nothing waits.', webhook: null };
    mocks.get.mockResolvedValue(task);
    render(<RoutineEditor mode="edit" agentId="a" agentName="Caveman" routine={task} onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByDisplayValue('Nothing waits.');
    expect(screen.getByRole('checkbox', { name: 'On a schedule' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'On a schedule' })).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: 'When another app sends an update' })).not.toBeInTheDocument();
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.receiver).not.toHaveBeenCalled();
  });

  it('marks a newly authored fast cron invalid while allowing an unchanged legacy cron edit', async () => {
    mocks.get.mockResolvedValue({ ...view(), schedule: { kind: 'cron', expr: '*/10 * * * * *', tz: 'UTC' } });
    await edit();
    fireEvent.change(screen.getByLabelText('What should Caveman do?'), { target: { value: 'Only the brief changed.' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '*/20 * * * * *' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByLabelText('Cron expression')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/60 seconds/)).toBeVisible();
  });
});

describe('private task address controls', () => {
  it('waits for Save when adding app updates to an existing scheduled job', async () => {
    mocks.get.mockResolvedValue({ ...view(), webhook: null });
    await edit();
    fireEvent.click(screen.getByRole('checkbox', { name: 'When another app sends an update' }));
    expect(screen.getByText('Save this task to get its own webhook address.')).toBeVisible();
    expect(mocks.receiver).not.toHaveBeenCalled();
  });
  it('waits for task creation before obtaining any address', async () => {
    render(<RoutineEditor mode="create" agentId="a" agentName="Caveman" onSaved={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'When another app sends an update' }));
    expect(screen.getByText('Save this task to get its own webhook address.')).toBeVisible();
    expect(mocks.receiver).not.toHaveBeenCalled();
    expect(mocks.shared).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it('lets a task owner obtain their task address without shared agent-token authority', async () => {
    mocks.access.mockResolvedValue({ allowed: false });
    await edit();
    expect((await screen.findByLabelText('Webhook URL') as HTMLInputElement).value).toContain('original-bearer');
    expect(mocks.receiver).toHaveBeenCalledWith({ agentId: 'a', routineId: routineFixture.routineId });
    expect(mocks.shared).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
    expect(screen.getByText(/Existing app addresses still work/)).toBeVisible();
  });
  it('does not obtain another owner’s address even when their task can be stopped', async () => {
    mocks.get.mockResolvedValue({ ...view(), ownedByCaller: false, permissions: { edit: false, stop: true, fire: false, manageSecret: false } });
    await edit();
    expect(mocks.receiver).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument();
  });
  it('keeps the draft on read failure and retries without exposing backend details', async () => {
    mocks.receiver.mockRejectedValueOnce(new Error('private backend details'));
    await edit();
    fireEvent.change(screen.getByLabelText('Webhook path'), { target: { value: '/draft' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry app setup' }));
    expect((await screen.findByLabelText('Webhook URL') as HTMLInputElement).value).toContain('/draft');
    expect(screen.queryByText(/private backend/)).not.toBeInTheDocument();
    expect(mocks.receiver).toHaveBeenCalledTimes(2);
  });
  it('confirms replacement, scopes it to the task and presents the new address', async () => {
    mocks.replace.mockResolvedValue({ url: '/webhooks/new-bearer', version: 'b'.repeat(64), legacyActive: false });
    await edit();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace address' }));
    expect(mocks.replace).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Replace this task’s address?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace address' }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ agentId: 'a', routineId: routineFixture.routineId }, 'a'.repeat(64)));
    await waitFor(() => expect(screen.getByLabelText('Webhook URL')).toHaveValue(`${window.location.origin}/webhooks/new-bearer/original`));
    expect(screen.queryByText(/Existing app addresses still work/)).not.toBeInTheDocument();
  });
  it('hides a possibly replaced address after a lost response and reads current state before another replacement', async () => {
    mocks.replace.mockRejectedValue(new Error('response lost'));
    await edit();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace address' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Replace address' }));
    const retry = await screen.findByRole('button', { name: 'Retry app setup' });
    expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument();
    mocks.receiver.mockResolvedValue({ url: '/webhooks/landed-bearer', version: 'b'.repeat(64), legacyActive: false });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByLabelText('Webhook URL')).toHaveValue(`${window.location.origin}/webhooks/landed-bearer/original`));
    expect(mocks.replace).toHaveBeenCalledTimes(1);
  });
  it('never commits an earlier task’s bearer after changing the selected task on the same agent', async () => {
    const commits: Array<{ task: string; url: string }> = [];
    let selected = routineFixture.routineId;
    function Probe() {
      useLayoutEffect(() => { commits.push({ task: selected, url: (screen.queryByLabelText('Webhook URL') as HTMLInputElement | null)?.value ?? '' }); });
      return null;
    }
    const props = { mode: 'edit' as const, agentId: 'a', agentName: 'Caveman', onSaved: vi.fn(), onCancel: vi.fn() };
    const form = () => <Profiler id="addresses" onRender={() => {}}><RoutineEditor {...props} routine={{ routineId: selected }} /><Probe /></Profiler>;
    const result = render(form());
    await screen.findByLabelText('Webhook URL');
    selected = 'different-task';
    mocks.get.mockResolvedValue({ ...view(), routineId: selected });
    mocks.receiver.mockResolvedValue({ url: '/webhooks/different-bearer', version: 'c'.repeat(64), legacyActive: false });
    result.rerender(form());
    await waitFor(() => expect(screen.getByLabelText('Webhook URL')).toHaveValue(`${window.location.origin}/webhooks/different-bearer/original`));
    for (const commit of commits.filter(x => x.task === selected)) expect(commit.url).not.toContain('original-bearer');
  });
});
