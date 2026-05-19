import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DefaultRoutineEditor } from '../DefaultRoutineEditor';
import type { DefaultRoutineDetail } from '@ax/routines';

// Mock the wire client
vi.mock('@/lib/default-routines', () => ({
  getDefaultRoutine: vi.fn(),
  upsertDefaultRoutine: vi.fn(),
  updateDefaultRoutine: vi.fn(),
}));

import {
  getDefaultRoutine,
  upsertDefaultRoutine,
  updateDefaultRoutine,
} from '@/lib/default-routines';

const mockGetDefaultRoutine = vi.mocked(getDefaultRoutine);
const mockUpsertDefaultRoutine = vi.mocked(upsertDefaultRoutine);
const mockUpdateDefaultRoutine = vi.mocked(updateDefaultRoutine);

const VALID_INTERVAL_MD = [
  '---',
  'name: my-default',
  'description: A test default routine.',
  'trigger:',
  '  kind: interval',
  '  every: 5m',
  'conversation: shared',
  '---',
  'Prompt body here.',
  '',
].join('\n');

const WEBHOOK_MD = [
  '---',
  'name: webhook-default',
  'description: A webhook routine.',
  'trigger:',
  '  kind: webhook',
  '  path: /hook',
  'conversation: per-fire',
  '---',
  'Body.',
  '',
].join('\n');

const DETAIL: DefaultRoutineDetail = {
  defaultRoutineId: 'heartbeat',
  name: 'heartbeat',
  description: 'Daily check-in.',
  trigger: { kind: 'interval', every: '1d' },
  enabled: true,
  updatedAt: '2026-05-19T00:00:00.000Z',
  sourceMd: [
    '---',
    'name: heartbeat',
    'description: Daily check-in.',
    'trigger:',
    '  kind: interval',
    '  every: 1d',
    'conversation: shared',
    '---',
    'Heartbeat prompt body.',
    '',
  ].join('\n'),
  silenceToken: null,
  silenceMax: 300,
  conversation: 'shared',
  activeHours: null,
  promptBody: 'Heartbeat prompt body.',
};

beforeEach(() => {
  vi.resetAllMocks();
  mockUpsertDefaultRoutine.mockResolvedValue({
    defaultRoutineId: 'my-default',
    created: true,
  });
  mockUpdateDefaultRoutine.mockResolvedValue({
    defaultRoutineId: 'heartbeat',
    created: false,
  });
});

describe('DefaultRoutineEditor', () => {
  it('renders the empty template when no defaultRoutineId is provided', async () => {
    render(<DefaultRoutineEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toContain('name: my-default');
      expect(textarea.value).toContain('kind: interval');
    });
  });

  it('loads existing routine content when defaultRoutineId is given', async () => {
    mockGetDefaultRoutine.mockResolvedValueOnce(DETAIL);
    render(
      <DefaultRoutineEditor
        defaultRoutineId="heartbeat"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Shows loading initially
    expect(screen.getByText('Loading…')).toBeTruthy();

    await waitFor(() => {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toContain('name: heartbeat');
    });

    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('disables Save when content has no frontmatter fence', async () => {
    render(<DefaultRoutineEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'no frontmatter here' } });

    await waitFor(() => {
      const saveBtn = screen.getByRole('button', { name: 'Create' });
      expect(saveBtn.hasAttribute('disabled')).toBe(true);
    });
  });

  it('warns and disables Save when trigger.kind is webhook', async () => {
    render(<DefaultRoutineEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: WEBHOOK_MD } });

    await waitFor(() => {
      expect(
        screen.getByText(/Webhook triggers are not allowed/),
      ).toBeTruthy();
    });

    const saveBtn = screen.getByRole('button', { name: 'Create' });
    expect(saveBtn.hasAttribute('disabled')).toBe(true);
  });

  it('warns and disables Save when trigger.kind is cron', async () => {
    render(<DefaultRoutineEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    const textarea = screen.getByRole('textbox');
    const cronMd = [
      '---',
      'name: cron-default',
      'description: A cron routine.',
      'trigger:',
      '  kind: cron',
      "  expr: '0 9 * * *'",
      '  tz: UTC',
      'conversation: shared',
      '---',
      'Body.',
      '',
    ].join('\n');
    fireEvent.change(textarea, { target: { value: cronMd } });

    await waitFor(() => {
      expect(screen.getByText(/Cron triggers are not allowed/)).toBeTruthy();
    });

    const saveBtn = screen.getByRole('button', { name: 'Create' });
    expect(saveBtn.hasAttribute('disabled')).toBe(true);
  });

  it('renders parsed preview (name + trigger + conversation) on valid interval input', async () => {
    render(<DefaultRoutineEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: VALID_INTERVAL_MD } });

    await waitFor(() => {
      expect(screen.getByText('my-default')).toBeTruthy();
      expect(screen.getByText('A test default routine.')).toBeTruthy();
      expect(screen.getByText('interval')).toBeTruthy();
      expect(screen.getByText(/every 5m/)).toBeTruthy();
      expect(screen.getByText('shared')).toBeTruthy();
    });
  });

  it('calls upsertDefaultRoutine and invokes onSaved on success (no id)', async () => {
    const onSaved = vi.fn();
    render(<DefaultRoutineEditor onSaved={onSaved} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: VALID_INTERVAL_MD } });

    await waitFor(() => {
      const saveBtn = screen.getByRole('button', { name: 'Create' });
      expect(saveBtn.hasAttribute('disabled')).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(mockUpsertDefaultRoutine).toHaveBeenCalledWith(VALID_INTERVAL_MD);
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('calls updateDefaultRoutine when defaultRoutineId is provided', async () => {
    mockGetDefaultRoutine.mockResolvedValueOnce(DETAIL);
    const onSaved = vi.fn();
    render(
      <DefaultRoutineEditor
        defaultRoutineId="heartbeat"
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Update' });
      expect(btn.hasAttribute('disabled')).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(mockUpdateDefaultRoutine).toHaveBeenCalledWith(
        'heartbeat',
        expect.stringContaining('name: heartbeat'),
      );
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces server-side error in the alert', async () => {
    mockUpsertDefaultRoutine.mockRejectedValueOnce(
      new Error('invalid-routine-md'),
    );
    render(<DefaultRoutineEditor onSaved={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: VALID_INTERVAL_MD } });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled'),
      ).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('invalid-routine-md')).toBeTruthy();
    });
  });
});
