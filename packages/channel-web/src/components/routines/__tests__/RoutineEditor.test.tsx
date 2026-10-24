import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RoutineEditor, DefaultRoutineEditor } from '../RoutineEditor';
import { routineApi, RoutineApiError } from '@/lib/routines';
import { routineFixture as row } from './routine-fixture';
import { editableDefinition } from '@ax/routines-contract';
vi.mock('@/lib/routines', async (original) => ({
  ...(await original<typeof import('@/lib/routines')>()),
  routineApi: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    getReceiver: vi.fn(),
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(routineApi.get).mockResolvedValue(row);
  vi.mocked(routineApi.create).mockResolvedValue(row);
  vi.mocked(routineApi.update).mockResolvedValue(row);
  vi.mocked(routineApi.getReceiver).mockResolvedValue({
    url: '/webhooks/test-receiver',
  });
});
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function edit() {
  render(
    <RoutineEditor
      mode="edit"
      agentId="a"
      agentName="Caveman"
      routine={row}
      onSaved={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}
describe('structured routine form', () => {
  it('explains the administrator, owner and edit restrictions to a member configuring HMAC', async () => {
    const memberRow = { ...row, trigger: { kind: 'webhook' as const, path: '/member' }, permissions: { edit: true, stop: true, fire: true, manageSecret: true } };
    vi.mocked(routineApi.get).mockResolvedValue(memberRow);
    render(<RoutineEditor mode="edit" agentId="a" agentName="Caveman" routine={memberRow} onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByDisplayValue(row.name);
    fireEvent.click(screen.getByRole('button', { name: 'Optional settings' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Verify HMAC signature' }));
    expect(screen.getByText(/Only an administrator who owns this routine and has routine edit permission/)).toBeVisible();
    expect(screen.getByText(/Without a saved secret, signed deliveries are rejected/)).toBeVisible();
    expect(screen.queryByLabelText('Webhook HMAC secret')).not.toBeInTheDocument();
  });
  it('creates canonical definitions with Enabled and multiline prompts, without filename or markdown controls', async () => {
    const saved = vi.fn();
    render(
      <RoutineEditor
        mode="create"
        agentId="a"
        agentName="Caveman"
        onSaved={saved}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Create routine' }),
    ).toBeDisabled();
    fill('Name', 'Human readable name');
    fill('Description', 'Description');
    fill('What should Caveman do?', 'line one\nline two');
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create routine' }));
    await waitFor(() =>
      expect(routineApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'a',
          requestId: expect.any(String),
          definition: expect.objectContaining({
            name: 'Human readable name',
            enabled: false,
            promptBody: 'line one\nline two',
          }),
        }),
      ),
    );
    expect(
      screen.queryByLabelText(/filename|raw routine|markdown/i),
    ).not.toBeInTheDocument();
    expect(saved).toHaveBeenCalledTimes(1);
  });
  describe('a stay-on-top task (TASK-906)', () => {
    const task = {
      ...row,
      kind: 'stay-on-top' as const,
      goodWhen: 'Inbox at zero.',
      trigger: { kind: 'interval' as const, every: '1h' },
    };
    beforeEach(() => {
      vi.mocked(routineApi.get).mockResolvedValue(task);
    });
    it("keeps a task's kind and goodWhen when Settings edits its instructions (TASK-906)", async () => {
      edit();
      await screen.findByDisplayValue(row.name);
      fill('What should Caveman do?', 'Answer the easy ones.');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(routineApi.update).toHaveBeenCalledWith({
          agentId: 'a',
          routineId: task.routineId,
          requestId: expect.any(String),
          expectedRevision: task.revision,
          patch: { promptBody: 'Answer the easy ones.' },
        }),
      );
    });
    it('explains the check-in floor and blocks Save for a task under 15 minutes', async () => {
      edit();
      await screen.findByDisplayValue(row.name);
      fill('Interval', '5m');
      expect(
        screen.getByText('Check-ins need to be at least 15 minutes apart.'),
      ).toBeVisible();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
    it("explains that a task can't run from a webhook and blocks Save", async () => {
      edit();
      await screen.findByDisplayValue(row.name);
      fireEvent.click(screen.getByRole('radio', { name: 'Webhook' }));
      expect(
        screen.getByText(
          'A task checks in on a schedule, not from an update from another app.',
        ),
      ).toBeVisible();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });
  it('fresh-reads edits and sends only changed fields, including nullable clears and complete nested replacements', async () => {
    vi.mocked(routineApi.get).mockResolvedValue({
      ...row,
      silenceToken: 'quiet',
      activeHours: { start: '09:00', end: '17:00', tz: 'UTC' },
    });
    edit();
    await screen.findByDisplayValue(row.name);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Optional settings' }));
    fill('Silence token', '');
    fireEvent.click(screen.getByRole('switch', { name: 'Active hours' }));
    fill('Interval', '2h');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(routineApi.update).toHaveBeenCalledWith({
        agentId: 'a',
        routineId: row.routineId,
        expectedRevision: row.revision,
        requestId: expect.any(String),
        patch: {
          silenceToken: null,
          activeHours: null,
          trigger: { kind: 'interval', every: '2h' },
        },
      }),
    );
  });
  it('keeps conflict input and offers explicit reload', async () => {
    vi.mocked(routineApi.update).mockRejectedValue(
      new RoutineApiError(409, 'revision-conflict'),
    );
    edit();
    await screen.findByDisplayValue(row.name);
    fill('Name', 'My draft');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'This routine changed. Refresh it before saving.',
      ),
    ).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveValue('My draft');
    expect(
      screen.getByRole('button', { name: 'Reload and discard my changes' }),
    ).toBeVisible();
  });
  it('retains one exact logical operation for transport retries and guards double-clicks', async () => {
    vi.mocked(routineApi.update)
      .mockRejectedValueOnce(new RoutineApiError(0))
      .mockResolvedValue(row);
    edit();
    await screen.findByDisplayValue(row.name);
    fill('Name', 'Retry draft');
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    fireEvent.click(save);
    await screen.findByRole('button', { name: 'Retry save' });
    expect(routineApi.update).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Name')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(routineApi.update).toHaveBeenCalledTimes(2));
    expect(vi.mocked(routineApi.update).mock.calls[0]).toEqual(
      vi.mocked(routineApi.update).mock.calls[1],
    );
  });
  it('edits webhook events, HMAC, quiet fields and conversation; disables active hours and derives an inactive absolute URL', async () => {
    render(
      <RoutineEditor
        mode="create"
        agentId="a"
        agentName="Caveman"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fill('Name', 'Webhook');
    fireEvent.click(screen.getByRole('radio', { name: 'Webhook' }));
    expect(screen.getByRole('radio', { name: 'Webhook' })).toHaveAttribute(
      'data-state',
      'on',
    );
    expect(screen.getByRole('radio', { name: 'Schedule' })).toHaveAttribute(
      'data-state',
      'off',
    );
    expect(screen.getByRole('radio', { name: 'Interval' })).toHaveAttribute(
      'data-state',
      'off',
    );
    fill('Webhook path', '/changed');
    expect(
      await screen.findByDisplayValue(
        `${window.location.origin}/webhooks/test-receiver/changed`,
      ),
    ).toBeVisible();
    expect(
      screen.getByText('Preview only — inactive until Create routine.'),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Optional settings' }));
    expect(screen.getByRole('switch', { name: 'Active hours' })).toBeDisabled();
    fill('Events (comma-separated)', 'push, update');
    fireEvent.click(
      screen.getByRole('switch', { name: 'Verify HMAC signature' }),
    );
    fill('Signature header', 'X-Signature');
    fill('Signature prefix', 'sha256=');
    fill('Silence token', 'quiet');
    fill('Maximum quiet response characters', '100');
    fireEvent.click(screen.getByRole('radio', { name: 'One ongoing thread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create routine' }));
    await waitFor(() =>
      expect(routineApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          definition: expect.objectContaining({
            trigger: {
              kind: 'webhook',
              path: '/changed',
              events: ['push', 'update'],
              hmac: {
                header: 'X-Signature',
                algorithm: 'sha256',
                prefix: 'sha256=',
              },
            },
            activeHours: null,
            conversation: 'shared',
            silenceToken: 'quiet',
            silenceMaxChars: 100,
          }),
        }),
      ),
    );
  });
  it('retains event separators during typing, deleting and editing before canonical submit', async () => {
    render(<RoutineEditor mode="create" agentId="a" agentName="Caveman" onSaved={vi.fn()} onCancel={vi.fn()} />);
    fill('Name', 'Events');
    fill('What should Caveman do?', 'Handle events');
    fireEvent.click(screen.getByRole('radio', { name: 'Webhook' }));
    const input = screen.getByLabelText('Events (comma-separated)') as HTMLInputElement;
    for (const character of 'push, update') {
      fireEvent.change(input, { target: { value: input.value + character } });
    }
    expect(input).toHaveValue('push, update');
    fireEvent.change(input, { target: { value: input.value.replace(',', '') } });
    expect(input).toHaveValue('push update');
    fireEvent.change(input, { target: { value: input.value.replace(' ', ', ') } });
    expect(input).toHaveValue('push, update');
    for (const character of ', ') {
      fireEvent.change(input, { target: { value: input.value + character } });
    }
    expect(input).toHaveValue('push, update, ');
    fireEvent.click(screen.getByRole('button', { name: 'Create routine' }));
    await waitFor(() => expect(routineApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ definition: expect.objectContaining({
        trigger: { kind: 'webhook', path: '/project-updates', events: ['push', 'update'] },
      }) }),
    ));
  });
  it('represents missing receiver permission explicitly', async () => {
    vi.mocked(routineApi.getReceiver).mockRejectedValue(
      new RoutineApiError(404),
    );
    render(
      <RoutineEditor
        mode="create"
        agentId="a"
        agentName="Caveman"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Webhook' }));
    expect(
      await screen.findByText(
        'Webhook URL is unavailable. Receiver permission may be missing.',
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText('Webhook URL')).not.toBeInTheDocument();
  });
  it('default mode remains interval-only and keeps an existing disabled catalog entry disabled', async () => {
    const save = vi.fn().mockResolvedValue({});
    render(
      <DefaultRoutineEditor
        initial={{ ...editableDefinition(row), enabled: false }}
        onSave={save}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('radio', { name: 'Schedule' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radio', { name: 'Webhook' }),
    ).not.toBeInTheDocument();
    fill('Description', 'Updated');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, description: 'Updated' }),
      ),
    );
  });
  it('shows unavailable edit read without silently falling back to the stale list row', async () => {
    vi.mocked(routineApi.get).mockRejectedValue(new RoutineApiError(503));
    edit();
    expect(
      await screen.findByText(/We couldn’t load this routine/),
    ).toBeVisible();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });
});
