import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Profiler, useLayoutEffect } from 'react';
import { RoutineEditor } from '../RoutineEditor';
import { routineFixture } from './routine-fixture';

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), create: vi.fn(), access: vi.fn(), receiver: vi.fn() }));
vi.mock('@/lib/routines', async original => ({
  ...(await original<typeof import('@/lib/routines')>()),
  routineApi: { get: mocks.get, update: mocks.update, create: mocks.create, getReceiverAccess: mocks.access, getReceiver: mocks.receiver },
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
  mocks.receiver.mockResolvedValue({ url: '/webhooks/original-bearer' });
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

describe('receiver capability is separate from owning a routine', () => {
  it('does not reuse an old address while re-enabling updates waits for fresh permission', async () => {
    const committedUrls: Array<string | null> = [];
    render(<Profiler id="receiver" onRender={() => {
      const input = screen.queryByLabelText('Webhook URL') as HTMLInputElement | null;
      committedUrls.push(input?.value ?? null);
    }}><RoutineEditor mode="create" agentId="a" agentName="Caveman" onSaved={vi.fn()} onCancel={vi.fn()} /></Profiler>);
    const updates = screen.getByRole('checkbox', { name: 'When another app sends an update' });
    fireEvent.click(updates);
    expect((await screen.findByLabelText('Webhook URL') as HTMLInputElement).value).toContain('original-bearer');
    fireEvent.click(updates);
    committedUrls.length = 0;
    mocks.access.mockResolvedValue({ allowed: false });
    fireEvent.click(updates);
    expect(committedUrls.length).toBeGreaterThan(0);
    for (const url of committedUrls) expect(url ?? '').not.toContain('original-bearer');
    await screen.findByText(/administrator.*connect.*app updates/i);
    expect(mocks.receiver).toHaveBeenCalledTimes(1);
  });

  it('never commits a previously resolved receiver URL under a different agent before effects clear it', async () => {
    mocks.access.mockImplementation((agentId: string) => Promise.resolve({ allowed: agentId === 'a' }));
    const commits: Array<{ agentId: string; url: string | null }> = [];
    function CommitProbe({ agentId }: { agentId: string }) {
      // Layout effects observe the committed DOM before the editor's passive cleanup.
      useLayoutEffect(() => {
        const input = screen.queryByLabelText('Webhook URL') as HTMLInputElement | null;
        commits.push({ agentId, url: input?.value ?? null });
      }, [agentId]);
      return null;
    }
    const props = { mode: 'create' as const, agentName: 'Caveman', onSaved: vi.fn(), onCancel: vi.fn() };
    const form = (agentId: string) => <><RoutineEditor {...props} agentId={agentId} /><CommitProbe agentId={agentId} /></>;
    const result = render(form('a'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'When another app sends an update' }));
    const originalUrl = await screen.findByLabelText('Webhook URL') as HTMLInputElement;
    expect(originalUrl.value).toContain('original-bearer');
    result.rerender(form('b'));
    const nextAgentCommits = commits.filter(commit => commit.agentId === 'b');
    expect(nextAgentCommits.length).toBeGreaterThan(0);
    for (const commit of nextAgentCommits) expect(commit.url ?? '').not.toContain('original-bearer');
    await screen.findByText(/administrator.*connect.*app updates/i);
    expect(mocks.receiver).toHaveBeenCalledTimes(1);
  });

  it('does not obtain a bearer for a member denied agent-wide receiver access', async () => {
    mocks.access.mockResolvedValue({ allowed: false });
    await edit();
    await screen.findByText(/administrator.*connect.*app updates/i);
    expect(mocks.receiver).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument();
  });

  it('treats an access lookup fault as unavailable, preserves the draft and allows retry', async () => {
    mocks.access.mockRejectedValueOnce(new Error('private backend details'));
    await edit();
    const retry = await screen.findByRole('button', { name: 'Retry app setup' });
    expect(mocks.receiver).not.toHaveBeenCalled();
    expect(screen.queryByText(/private backend/)).not.toBeInTheDocument();
    fireEvent.click(retry);
    await screen.findByLabelText('Webhook URL');
    expect(mocks.access).toHaveBeenCalledTimes(2);
    expect(mocks.receiver).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Webhook path')).toHaveValue('/original');
  });

  it('does not request a URL when a previously pending allowed answer arrives after unmount', async () => {
    let finish!: (value: { allowed: boolean }) => void;
    mocks.access.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const result = await edit();
    await waitFor(() => expect(mocks.access).toHaveBeenCalledOnce());
    result.unmount();
    finish({ allowed: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.receiver).not.toHaveBeenCalled();
  });

  it('ignores an allowed answer from the previous agent after the create form changes agents', async () => {
    let finish!: (value: { allowed: boolean }) => void;
    mocks.access.mockImplementation((agentId: string) => agentId === 'a'
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ allowed: false }));
    const props = { mode: 'create' as const, agentName: 'Caveman', onSaved: vi.fn(), onCancel: vi.fn() };
    const result = render(<RoutineEditor {...props} agentId="a" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'When another app sends an update' }));
    await waitFor(() => expect(mocks.access).toHaveBeenCalledWith('a'));
    result.rerender(<RoutineEditor {...props} agentId="b" />);
    await screen.findByText(/administrator.*connect.*app updates/i);
    finish({ allowed: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.receiver).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument();
  });
});
