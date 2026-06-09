import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RoutineFrontmatterFields } from '@ax/validator-routine/frontmatter';
import { RoutineEditor } from '../RoutineEditor';

// The create-mode agent picker pulls the caller's agents.
vi.mock('@/lib/agents', () => ({ listChatAgents: vi.fn() }));
import { listChatAgents } from '@/lib/agents';
const mockListChatAgents = vi.mocked(listChatAgents);

const ALL_TRIGGERS = ['interval', 'cron', 'webhook'] as const;

beforeEach(() => {
  vi.resetAllMocks();
  mockListChatAgents.mockResolvedValue([
    { agentId: 'agt_a', displayName: 'Alpha', visibility: 'personal' },
    { agentId: 'agt_b', displayName: 'Beta', visibility: 'team' },
  ]);
});

function fillField(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function fillBasics(name = 'hb', description = 'periodic check', prompt = 'do it') {
  fillField('Name', name);
  fillField('Description', description);
  fillField('Prompt', prompt);
}

describe('RoutineEditor (form-first)', () => {
  it('renders the form (not raw) by default with empty fields on create', () => {
    render(
      <RoutineEditor
        constraints={{ allowedTriggers: ALL_TRIGGERS, showAgentPicker: true }}
        onSave={vi.fn()}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText('Description')).toBeTruthy();
    expect(screen.getByLabelText('Prompt')).toBeTruthy();
    expect(screen.queryByLabelText('Raw routine .md')).toBeNull();
  });

  it('create: requires an agent, assembles the md, and calls onSave with {agentId, name}', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi.fn();
    render(
      <RoutineEditor
        constraints={{ allowedTriggers: ALL_TRIGGERS, showAgentPicker: true }}
        onSave={onSave}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );
    await fillBasics('hb', 'periodic check', 'ping the thing');
    // Default trigger is interval — set a valid duration.
    fillField('Interval', '1h');

    // No agent picked yet → Save disabled.
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }));
    fireEvent.click(await screen.findByText('Alpha'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [sourceMd, opts] = onSave.mock.calls[0]!;
    expect(sourceMd).toContain('name: hb');
    expect(sourceMd).toContain('description: periodic check');
    expect(sourceMd).toContain('kind: interval');
    expect(sourceMd).toContain('every: 1h');
    expect(sourceMd).toContain('ping the thing');
    expect(opts).toEqual({ agentId: 'agt_a', name: 'hb' });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('create: Save is disabled until the name is a valid slug', async () => {
    render(
      <RoutineEditor
        constraints={{ allowedTriggers: ALL_TRIGGERS, showAgentPicker: true }}
        onSave={vi.fn()}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fillField('Description', 'x');
    fillField('Interval', '1h');
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }));
    fireEvent.click(await screen.findByText('Alpha'));
    // Name still empty → invalid → disabled.
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true);
    // Uppercase / spaces are not a valid slug.
    fillField('Name', 'Not A Slug');
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true);
  });

  it('switching the trigger to Cron reveals expr + tz and writes a cron trigger', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RoutineEditor
        constraints={{ allowedTriggers: ALL_TRIGGERS, showAgentPicker: false }}
        onSave={onSave}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await fillBasics();
    fireEvent.click(screen.getByText('Schedule'));
    fillField('Cron expression', '0 2 * * *');
    fillField('Timezone', 'America/New_York');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [sourceMd] = onSave.mock.calls[0]!;
    expect(sourceMd).toContain('kind: cron');
    expect(sourceMd).toContain('expr: 0 2 * * *');
    expect(sourceMd).toContain('tz: America/New_York');
  });

  it('switching the trigger to Webhook reveals the path field', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RoutineEditor
        constraints={{ allowedTriggers: ALL_TRIGGERS, showAgentPicker: false }}
        onSave={onSave}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await fillBasics();
    fireEvent.click(screen.getByText('Webhook'));
    fillField('Webhook path', '/gh/push');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [sourceMd] = onSave.mock.calls[0]!;
    expect(sourceMd).toContain('kind: webhook');
    expect(sourceMd).toContain('path: /gh/push');
  });

  it('constraints.allowedTriggers limits the trigger choices (interval-only for defaults)', () => {
    render(
      <RoutineEditor
        constraints={{ allowedTriggers: ['interval'], showAgentPicker: false }}
        onSave={vi.fn()}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByText('Schedule')).toBeNull();
    expect(screen.queryByText('Webhook')).toBeNull();
    expect(screen.getByLabelText('Interval')).toBeTruthy();
  });

  it('edit: populates from initial fields and labels Save as Update', async () => {
    const initial: RoutineFrontmatterFields = {
      name: 'nightly',
      description: 'nightly triage',
      trigger: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' },
      silenceMaxChars: 300,
      conversation: 'shared',
      promptBody: 'triage',
    };
    render(
      <RoutineEditor
        initial={initial}
        constraints={{ allowedTriggers: ALL_TRIGGERS, showAgentPicker: false }}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('nightly');
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('0 3 * * *');
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
  });

  it('toggles to raw seeded from the form and back, preserving the name', async () => {
    render(
      <RoutineEditor
        constraints={{ allowedTriggers: ALL_TRIGGERS, showAgentPicker: false }}
        onSave={vi.fn()}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await fillBasics('greeter', 'a friendly routine', 'hello');
    fillField('Interval', '2h');

    fireEvent.click(screen.getByLabelText(/Advanced — edit raw/i));
    const raw = (await screen.findByLabelText('Raw routine .md')) as HTMLTextAreaElement;
    expect(raw.value).toContain('name: greeter');
    expect(raw.value).toContain('every: 2h');

    fireEvent.click(screen.getByLabelText(/Advanced — edit raw/i));
    await waitFor(() =>
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('greeter'),
    );
  });

  it('stays in raw mode and shows the error when the raw text does not parse', async () => {
    render(
      <RoutineEditor
        constraints={{ allowedTriggers: ALL_TRIGGERS, showAgentPicker: false }}
        onSave={vi.fn()}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await fillBasics();
    fillField('Interval', '1h');
    fireEvent.click(screen.getByLabelText(/Advanced — edit raw/i));
    const raw = await screen.findByLabelText('Raw routine .md');
    fireEvent.change(raw, { target: { value: 'no frontmatter here' } });

    fireEvent.click(screen.getByLabelText(/Advanced — edit raw/i));
    await waitFor(() => expect(screen.getByLabelText('Raw routine .md')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true);
  });

  it('preserves a webhook hmac across a form round-trip (carried, not editable)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const initial: RoutineFrontmatterFields = {
      name: 'gh',
      description: 'gh hook',
      trigger: {
        kind: 'webhook',
        path: '/gh',
        hmac: {
          secretRef: 'routine:agt_a:.ax/routines/gh.md:hmac',
          header: 'X-Hub-Signature-256',
          algorithm: 'sha256',
        },
      },
      silenceMaxChars: 300,
      conversation: 'per-fire',
      promptBody: 'handle it',
    };
    render(
      <RoutineEditor
        initial={initial}
        constraints={{ allowedTriggers: ALL_TRIGGERS, showAgentPicker: false }}
        onSave={onSave}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Edit a form field, then save — hmac must survive even though the form
    // has no control for it.
    fillField('Description', 'gh hook updated');
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [sourceMd] = onSave.mock.calls[0]!;
    expect(sourceMd).toContain('secretRef: routine:agt_a:.ax/routines/gh.md:hmac');
    expect(sourceMd).toContain('header: X-Hub-Signature-256');
  });

  it('surfaces a save error in an alert', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('interval.every: minimum is 60s'));
    render(
      <RoutineEditor
        constraints={{ allowedTriggers: ALL_TRIGGERS, showAgentPicker: false }}
        onSave={onSave}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await fillBasics();
    fillField('Interval', '1h');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByText(/minimum is 60s/)).toBeTruthy());
  });
});
