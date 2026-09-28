/**
 * The "Used N memories" chip under an answer (TASK-628).
 *
 * Closed by default, a real disclosure (aria-expanded), one row per memory
 * the answer was handed, and Fix goes through the shared dialog — after which
 * the row says what happened to it instead of offering Fix again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi } from '@/lib/workspace-api';
import type { MemoryUsed, MemoryUsedStatement } from '@/lib/workspace-types';
import { MemoryUsedChip } from '../MemoryUsedChip';
import {
  MEMORY_FIX,
  MEMORY_FIX_FIELD_LABEL,
  MEMORY_FIX_HELPER_TEAM,
  MEMORY_FIX_REASON_NEVER_RIGHT,
  MEMORY_FIX_UNDONE,
  MEMORY_UPDATED,
  MEMORY_USED_SINCE,
  memoryFixLabel,
  memoryUndoFixLabel,
  memoryStatementText,
  memoryUsedLabel,
} from '../memory-copy';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      recallMemory: vi.fn(),
      rememberMemory: vi.fn(),
      correctMemory: vi.fn(),
      forgetMemory: vi.fn(),
      uncorrectMemory: vi.fn(),
    },
  };
});

const correctMock = vi.mocked(workspaceApi.correctMemory);
const uncorrectMock = vi.mocked(workspaceApi.uncorrectMemory);

const boston: MemoryUsedStatement = {
  id: 'm1',
  about: 'user:alice',
  aboutText: 'you',
  relation: 'lives_in',
  value: 'Boston',
  when: '2026-09-01T12:00:00.000Z',
  savedBy: 'person',
};
const tea: MemoryUsedStatement = {
  id: 'm2',
  about: 'user:alice',
  aboutText: 'you',
  relation: 'likes',
  value: 'tea',
  when: '2026-08-15T12:00:00.000Z',
};

const used = (statements: MemoryUsedStatement[], visibility?: 'personal' | 'team'): MemoryUsed => ({
  statements,
  ...(visibility !== undefined ? { visibility } : {}),
});

function trigger(): HTMLElement {
  const chip = screen.getByTestId('workspace-memory-used');
  return within(chip).getByRole('button', { name: /^Used / });
}

/**
 * Open the chip the way a keyboard does. jsdom does not synthesize a click
 * from Enter/Space (and `user-event` is not a dependency here), so this pins
 * the part that makes the keyboard work in a browser — the trigger is a
 * focusable native `<button>`, which the browser activates on Enter and Space
 * — and then delivers that activation.
 */
function open(): void {
  const t = trigger();
  expect(t.tagName).toBe('BUTTON');
  t.focus();
  expect(document.activeElement).toBe(t);
  fireEvent.click(t);
}

beforeEach(() => {
  vi.clearAllMocks();
  correctMock.mockResolvedValue({ id: 'mem-new' });
  uncorrectMock.mockResolvedValue({ undone: true });
});

describe('MemoryUsedChip', () => {
  it('counts one memory in the singular', () => {
    render(<MemoryUsedChip used={used([boston])} agentId="a1" />);
    expect(trigger().textContent).toContain(memoryUsedLabel(1));
    expect(trigger().textContent).toContain('Used 1 memory');
  });

  it('counts several memories in the plural', () => {
    render(<MemoryUsedChip used={used([boston, tea])} agentId="a1" />);
    expect(trigger().textContent).toContain('Used 2 memories');
  });

  it('starts closed, and opens from the keyboard', async () => {
    render(<MemoryUsedChip used={used([boston])} agentId="a1" />);
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(memoryStatementText(boston))).toBeNull();

    open();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText(memoryStatementText(boston))).toBeInTheDocument();
  });

  it('draws each memory as a list item with its text, source and date', async () => {
    render(<MemoryUsedChip used={used([boston, tea])} agentId="a1" />);
    open();
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText(memoryStatementText(boston))).toBeInTheDocument();
    expect(within(items[0]!).getByText(/^Saved by a person · .*2026/)).toBeInTheDocument();
    expect(within(items[1]!).getByText(memoryStatementText(tea))).toBeInTheDocument();
    expect(within(items[1]!).getByText(/^From a chat · .*2026/)).toBeInTheDocument();
    expect(
      within(items[0]!).getByRole('button', { name: memoryFixLabel('Boston') }).textContent,
    ).toBe(MEMORY_FIX);
  });

  it('an unparseable date leaves just the source', async () => {
    render(<MemoryUsedChip used={used([{ ...tea, when: 'not a date' }])} agentId="a1" />);
    open();
    expect(await screen.findByText('From a chat')).toBeInTheDocument();
  });

  it('a memory closed since the answer says so, and offers no Fix', async () => {
    render(
      <MemoryUsedChip
        used={used([{ ...boston, closedSince: 'replaced' }, { ...tea, closedSince: 'retracted' }])}
        agentId="a1"
      />,
    );
    open();
    expect(await screen.findByText(MEMORY_USED_SINCE.replaced)).toBeInTheDocument();
    expect(screen.getByText(MEMORY_USED_SINCE.retracted)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Fix/ })).toBeNull();
  });

  it('Fix saves through the shared dialog, and the row flips to Updated', async () => {
    render(<MemoryUsedChip used={used([boston], 'team')} agentId="a1" />);
    open();
    fireEvent.click(await screen.findByRole('button', { name: memoryFixLabel('Boston') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(MEMORY_FIX_HELPER_TEAM)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(MEMORY_FIX_FIELD_LABEL), {
      target: { value: 'Cambridge' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(correctMock).toHaveBeenCalledWith('a1', {
        id: 'm1',
        about: 'user:alice',
        relation: 'lives_in',
        value: 'Cambridge',
        reason: 'changed',
      }),
    );
    expect(await screen.findByText(MEMORY_USED_SINCE.replaced)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: memoryFixLabel('Boston') })).toBeNull();
  });

  it('"It was never right" flips the row to Fixed', async () => {
    render(<MemoryUsedChip used={used([boston])} agentId="a1" />);
    open();
    fireEvent.click(await screen.findByRole('button', { name: memoryFixLabel('Boston') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: MEMORY_FIX_REASON_NEVER_RIGHT }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(correctMock).toHaveBeenCalledWith('a1', expect.objectContaining({ reason: 'never-right' })),
    );
    expect(await screen.findByText(MEMORY_USED_SINCE.retracted)).toBeInTheDocument();
  });

  it('Undo on the receipt takes the fix back, and the row offers Fix again (TASK-634)', async () => {
    render(<MemoryUsedChip used={used([boston])} agentId="a1" />);
    open();
    fireEvent.click(await screen.findByRole('button', { name: memoryFixLabel('Boston') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(MEMORY_FIX_FIELD_LABEL), {
      target: { value: 'Cambridge' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(MEMORY_UPDATED)).toBeInTheDocument();
    expect(screen.getByText(MEMORY_USED_SINCE.replaced)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: memoryUndoFixLabel('Cambridge') }));
    await waitFor(() =>
      expect(uncorrectMock).toHaveBeenCalledWith('a1', { id: 'mem-new', restore: 'm1' }),
    );
    expect(await screen.findByText(MEMORY_FIX_UNDONE)).toBeInTheDocument();
    expect(screen.queryByText(MEMORY_USED_SINCE.replaced)).toBeNull();
    expect(screen.getByRole('button', { name: memoryFixLabel('Boston') })).toBeInTheDocument();
  });

  it('renders untrusted memory text literally, never as markup', async () => {
    const { container } = render(
      <MemoryUsedChip used={used([{ ...tea, value: '<b>x</b>' }])} agentId="a1" />,
    );
    open();
    expect(await screen.findByText(/<b>x<\/b>/)).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });
});

/** Activate a button the way a keyboard does: it has focus first, then it fires. */
function press(el: HTMLElement): void {
  el.focus();
  expect(document.activeElement).toBe(el);
  fireEvent.click(el);
}

describe('MemoryUsedChip — where focus goes when the dialog closes (TASK-644)', () => {
  it('Save lands on the receipt\'s "Updated." line — not <body> — with Undo the next stop', async () => {
    render(<MemoryUsedChip used={used([boston])} agentId="a1" />);
    open();
    press(await screen.findByRole('button', { name: memoryFixLabel('Boston') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(MEMORY_FIX_FIELD_LABEL), {
      target: { value: 'Cambridge' },
    });
    press(within(dialog).getByRole('button', { name: 'Save' }));

    const outcome = await screen.findByText(MEMORY_UPDATED);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    const undo = screen.getByRole('button', { name: memoryUndoFixLabel('Cambridge') });
    expect(outcome.compareDocumentPosition(undo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Cancel returns focus to the Fix button it came from', async () => {
    render(<MemoryUsedChip used={used([boston])} agentId="a1" />);
    open();
    const fix = await screen.findByRole('button', { name: memoryFixLabel('Boston') });
    press(fix);
    press(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(fix));
  });

  it('Cancel goes back to its opener even while an earlier fix\'s receipt is showing', async () => {
    render(<MemoryUsedChip used={used([boston, tea])} agentId="a1" />);
    open();
    press(await screen.findByRole('button', { name: memoryFixLabel('Boston') }));
    press(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));
    const outcome = await screen.findByText(MEMORY_UPDATED);
    await waitFor(() => expect(document.activeElement).toBe(outcome));

    // Only the close that follows a save lands on the receipt.
    const fixTea = screen.getByRole('button', { name: memoryFixLabel('tea') });
    press(fixTea);
    press(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(fixTea));
    expect(screen.getByText(MEMORY_UPDATED)).toBeInTheDocument();
  });
});
