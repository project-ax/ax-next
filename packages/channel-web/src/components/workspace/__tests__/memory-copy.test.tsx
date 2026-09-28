/**
 * ONE SET OF WORDS FOR FIXING MEMORY — pinned (TASK-623).
 *
 * `memory-copy.ts` owns every string a person reads while correcting a memory.
 * These tests render the Memory tab and compare what it SAYS with the module's
 * constants, so a later surface that imports the module (the rail's "What I
 * learned in this chat", the "Memory used" chip) cannot drift from it. The last
 * block scans the components' source so a correction string cannot move back
 * inline without this file noticing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  workspaceApi,
  type AgentMemoryRead,
  type FactMemoryStatement,
} from '@/lib/workspace-api';
import { UNDO_WINDOW_MS } from '@/lib/workspace-types';
import { MemorySurface } from '../FactsMemory';
import * as copy from '../memory-copy';
import {
  MEMORY_CLOSURE_BADGE,
  MEMORY_FIX,
  MEMORY_FIX_FIELD_LABEL,
  MEMORY_FIX_HELPER,
  MEMORY_FIX_HELPER_TEAM,
  MEMORY_FIX_TITLE,
  MEMORY_FIX_UNDO_FAILED,
  MEMORY_FIX_UNDONE,
  MEMORY_FORGET,
  MEMORY_FORGOTTEN,
  MEMORY_RESTORED,
  MEMORY_UNDO,
  MEMORY_UNDO_FAILED,
  MEMORY_UNDO_RETRY,
  MEMORY_UPDATED,
  memoryFixLabel,
  memoryForgetLabel,
  memoryUndoFixLabel,
  memoryUndoLabel,
  memoryUndoSecondsLeft,
  memoryUndoText,
} from '../memory-copy';

/**
 * Text a person can SEE: leaves out the receipt's screen-reader announcer
 * (TASK-651), which says "Remembered again." / "Fix undone." a second time.
 */
const VISIBLE = { ignore: 'script, style, [data-memory-said] *' };

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      recallMemory: vi.fn(),
      rememberMemory: vi.fn(),
      correctMemory: vi.fn(),
      forgetMemory: vi.fn(),
      unforgetMemory: vi.fn(),
      uncorrectMemory: vi.fn(),
    },
  };
});

const recallMock = vi.mocked(workspaceApi.recallMemory);
const rememberMock = vi.mocked(workspaceApi.rememberMemory);
const forgetMock = vi.mocked(workspaceApi.forgetMemory);
const unforgetMock = vi.mocked(workspaceApi.unforgetMemory);
const uncorrectMock = vi.mocked(workspaceApi.uncorrectMemory);

const boston: FactMemoryStatement = {
  id: 'm1',
  about: 'user:alice',
  aboutText: 'you',
  relation: 'lives_in',
  value: 'Boston',
  when: '2026-09-01T00:00:00.000Z',
};

const read = (factsVisibility?: 'personal' | 'team'): AgentMemoryRead => ({
  rules: { status: 'ok', doc: { name: 'Your rules', scope: 'rules', body: '' } },
  factsAvailable: true,
  ...(factsVisibility !== undefined ? { factsVisibility } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  recallMock.mockResolvedValue({ statements: [boston], degraded: [] });
  rememberMock.mockResolvedValue({ id: 'mem-new' });
  vi.mocked(workspaceApi.correctMemory).mockResolvedValue({ id: 'mem-new' });
  forgetMock.mockResolvedValue({ forgotten: true });
  unforgetMock.mockResolvedValue({ restored: ['m1'] });
  uncorrectMock.mockResolvedValue({ undone: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The profile row's own action buttons — the row, not the whole page. */
async function rowActions(): Promise<HTMLElement[]> {
  const value = await screen.findByText('Boston');
  const li = value.closest('li');
  if (li === null) throw new Error('profile row not found');
  return within(li).getAllByRole('button');
}

async function forgetBoston(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: memoryForgetLabel('Boston') }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: MEMORY_FORGET }));
  await waitFor(() => expect(forgetMock).toHaveBeenCalledWith('a1', ['m1']));
}

describe('memory-copy — the Memory tab says what the module says', () => {
  it('row actions are exactly Fix and Forget, labelled by the memory they act on', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    const buttons = await rowActions();
    expect(buttons.map((b) => b.textContent)).toEqual([MEMORY_FIX, MEMORY_FORGET]);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      memoryFixLabel('Boston'),
      memoryForgetLabel('Boston'),
    ]);
    // Undo is a receipt, never a row verb; Edit is retired.
    expect(screen.queryByRole('button', { name: /^(Undo|Edit)\b/ })).toBeNull();
  });

  it('the Fix dialog draws its title, label and helper from the module', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    fireEvent.click(await screen.findByRole('button', { name: memoryFixLabel('Boston') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe(MEMORY_FIX_TITLE);
    expect(within(dialog).getByLabelText(MEMORY_FIX_FIELD_LABEL)).toBeInTheDocument();
    expect(within(dialog).getByText(MEMORY_FIX_HELPER)).toBeInTheDocument();
  });

  it('the Fix question draws its legend, options and helpers from the module', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    fireEvent.click(await screen.findByRole('button', { name: memoryFixLabel('Boston') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(copy.MEMORY_FIX_REASON_LEGEND)).toBeInTheDocument();
    expect(within(dialog).getAllByRole('radio')).toHaveLength(2);
    expect(
      within(dialog).getByRole('radio', { name: copy.MEMORY_FIX_REASON_CHANGED }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('radio', { name: copy.MEMORY_FIX_REASON_NEVER_RIGHT }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(copy.MEMORY_FIX_REASON_CHANGED_HELPER)).toBeInTheDocument();
    expect(
      within(dialog).getByText(copy.MEMORY_FIX_REASON_NEVER_RIGHT_HELPER),
    ).toBeInTheDocument();
    expect(copy.MEMORY_FIX_REASON_NEVER_RIGHT_HELPER).toBe(
      "I'll treat the old version as a mistake, not as something that used to be true.",
    );
  });

  it('a shared agent gets the team helper on Fix', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read('team')} />);
    fireEvent.click(await screen.findByRole('button', { name: memoryFixLabel('Boston') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(MEMORY_FIX_HELPER_TEAM)).toBeInTheDocument();
  });

  it('says Updated. once a fix is saved', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    fireEvent.click(await screen.findByRole('button', { name: memoryFixLabel('Boston') }));
    fireEvent.change(await screen.findByLabelText(MEMORY_FIX_FIELD_LABEL), {
      target: { value: 'Cambridge' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(MEMORY_UPDATED)).toBeInTheDocument();
  });
});

describe('memory-copy — the Forgotten receipt', () => {
  it('counts Undo down over the shared window, then takes the offer away', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    await forgetBoston();

    expect(await screen.findByText(MEMORY_FORGOTTEN)).toBeInTheDocument();
    const undo = screen.getByRole('button', { name: memoryUndoLabel('Boston') });
    expect(undo.textContent).toBe(memoryUndoText(UNDO_WINDOW_MS / 1000));

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(undo.textContent).toBe(memoryUndoText(UNDO_WINDOW_MS / 1000 - 3));

    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(screen.queryByRole('button', { name: memoryUndoLabel('Boston') })).toBeNull();
    expect(screen.queryByText(MEMORY_FORGOTTEN)).toBeNull();
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it('says Forgotten once — by the focus that lands on it — with the ticking Undo outside every live region', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    await forgetBoston();
    const outcome = await screen.findByText(MEMORY_FORGOTTEN);
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    // TASK-651: the line focus reads is not also a live region (it was read twice).
    expect(outcome.closest('[role="alert"], [role="status"], [aria-live]')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
    const undo = screen.getByRole('button', { name: memoryUndoLabel('Boston') });
    expect(undo.closest('[role="alert"], [role="status"], [aria-live]')).toBeNull();
  });

  it('Undo un-forgets the SAME row — it never re-saves it as the person', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    await forgetBoston();
    const recallsBefore = recallMock.mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: memoryUndoLabel('Boston') }));
    await waitFor(() => expect(unforgetMock).toHaveBeenCalledWith('a1', ['m1']));
    // TASK-630: a re-save would make an agent-saved memory person-saved.
    expect(rememberMock).not.toHaveBeenCalled();
    expect(await screen.findByText(MEMORY_RESTORED, VISIBLE)).toBeInTheDocument();
    await waitFor(() => expect(recallMock.mock.calls.length).toBeGreaterThan(recallsBefore));
  });

  it('a failed Undo says the memory is still forgotten and offers to try again', async () => {
    unforgetMock.mockRejectedValueOnce(new Error('down'));
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    await forgetBoston();
    fireEvent.click(await screen.findByRole('button', { name: memoryUndoLabel('Boston') }));
    expect(await screen.findByText(MEMORY_UNDO_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toContain(MEMORY_UNDO_FAILED);
    expect(screen.queryByText(MEMORY_RESTORED, VISIBLE)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: MEMORY_UNDO_RETRY }));
    expect(await screen.findByText(MEMORY_RESTORED, VISIBLE)).toBeInTheDocument();
    expect(unforgetMock).toHaveBeenCalledTimes(2);
    expect(rememberMock).not.toHaveBeenCalled();
  });
});

async function fixBostonToCambridge(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: memoryFixLabel('Boston') }));
  fireEvent.change(await screen.findByLabelText(MEMORY_FIX_FIELD_LABEL), {
    target: { value: 'Cambridge' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('memory-copy — the Updated receipt (TASK-634)', () => {
  it('offers Undo over the shared window, named by the fix, then takes the offer away', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    await fixBostonToCambridge();

    expect(await screen.findByText(MEMORY_UPDATED)).toBeInTheDocument();
    const undo = screen.getByRole('button', { name: memoryUndoFixLabel('Cambridge') });
    expect(undo.textContent).toBe(memoryUndoText(UNDO_WINDOW_MS / 1000));
    // Said by focus alone (TASK-651), and the ticking button sits outside every live region.
    expect(
      screen.getByText(MEMORY_UPDATED).closest('[role="alert"], [role="status"], [aria-live]'),
    ).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
    expect(undo.closest('[role="alert"], [role="status"], [aria-live]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(undo.textContent).toBe(memoryUndoText(UNDO_WINDOW_MS / 1000 - 3));

    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(screen.queryByRole('button', { name: memoryUndoFixLabel('Cambridge') })).toBeNull();
    expect(screen.queryByText(MEMORY_UPDATED)).toBeNull();
    expect(uncorrectMock).not.toHaveBeenCalled();
  });

  it('Undo takes the fix back — the new row out, the fixed row restored — and re-reads', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    await fixBostonToCambridge();
    const recallsBefore = recallMock.mock.calls.length;
    fireEvent.click(await screen.findByRole('button', { name: memoryUndoFixLabel('Cambridge') }));
    await waitFor(() =>
      expect(uncorrectMock).toHaveBeenCalledWith('a1', { id: 'mem-new', restore: 'm1' }),
    );
    expect(await screen.findByText(MEMORY_FIX_UNDONE, VISIBLE)).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toBe(MEMORY_FIX_UNDONE);
    await waitFor(() => expect(recallMock.mock.calls.length).toBeGreaterThan(recallsBefore));
    // Neither Forget's Undo nor a re-save stands in for it.
    expect(unforgetMock).not.toHaveBeenCalled();
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it('an Undo that finds nothing left to undo still says the fix is undone', async () => {
    uncorrectMock.mockResolvedValueOnce({ undone: false });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    await fixBostonToCambridge();
    fireEvent.click(await screen.findByRole('button', { name: memoryUndoFixLabel('Cambridge') }));
    expect(await screen.findByText(MEMORY_FIX_UNDONE, VISIBLE)).toBeInTheDocument();
  });

  it('a failed Undo says the new version is still in place and offers to try again', async () => {
    uncorrectMock.mockRejectedValueOnce(new Error('down'));
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read()} />);
    await fixBostonToCambridge();
    fireEvent.click(await screen.findByRole('button', { name: memoryUndoFixLabel('Cambridge') }));
    expect(await screen.findByText(MEMORY_FIX_UNDO_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toContain(MEMORY_FIX_UNDO_FAILED);
    // Not Forget's words: nothing was forgotten.
    expect(screen.queryByText(MEMORY_UNDO_FAILED)).toBeNull();
    expect(screen.queryByText(MEMORY_FIX_UNDONE, VISIBLE)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: MEMORY_UNDO_RETRY }));
    expect(await screen.findByText(MEMORY_FIX_UNDONE, VISIBLE)).toBeInTheDocument();
    expect(uncorrectMock).toHaveBeenCalledTimes(2);
    expect(uncorrectMock).toHaveBeenLastCalledWith('a1', { id: 'mem-new', restore: 'm1' });
  });
});

describe('memory-copy — the module itself', () => {
  it('counts whole seconds and never goes negative', () => {
    expect(memoryUndoSecondsLeft(1000, 1000)).toBe(UNDO_WINDOW_MS / 1000);
    expect(memoryUndoSecondsLeft(1000, 1001)).toBe(UNDO_WINDOW_MS / 1000);
    expect(memoryUndoSecondsLeft(1000, 1000 + UNDO_WINDOW_MS)).toBe(0);
    expect(memoryUndoSecondsLeft(1000, 1000 + UNDO_WINDOW_MS * 2)).toBe(0);
  });

  it('never promises more than the window, even from a clock read before the receipt began', () => {
    expect(memoryUndoSecondsLeft(61_000, 0)).toBe(UNDO_WINDOW_MS / 1000);
  });

  it('keeps the history vocabulary, Retracted included', () => {
    expect(MEMORY_CLOSURE_BADGE).toEqual({
      replaced: 'Replaced',
      forgotten: 'Forgotten',
      overridden: 'Overridden',
      retracted: 'Retracted',
    });
    expect(memoryUndoText(7)).toBe(`${MEMORY_UNDO} 7s`);
  });

  it('names a Fix Undo by the value it takes back', () => {
    expect(memoryUndoFixLabel('Cambridge')).toBe('Undo fix: Cambridge');
  });
});

describe('memory-copy — no correction string stays inline', () => {
  const DIR = join(__dirname, '..');

  /** Source with comments removed: a comment about old copy is history, not UI. */
  function code(file: string): string {
    return readFileSync(join(DIR, file), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  /**
   * Button words that are not about memory (`Save`, `Cancel`, `Try again`) also label the
   * rules editor in `AgentMemory`, so they are checked only where a memory is
   * being corrected.
   */
  const GENERIC = new Set(['Save', 'Cancel', 'Try again']);

  const constants = Object.entries(copy as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([name, value]) => ({ name, value: value.trim() }));
  const badges = Object.values(MEMORY_CLOSURE_BADGE).map((value) => ({
    name: `MEMORY_CLOSURE_BADGE:${value}`,
    value,
  }));

  /** The phrasing TASK-623 retired. None of it may come back. */
  const RETIRED = [
    />\s*Edit\s*</,
    /`Edit: /,
    /Edit remembered detail/,
    /What we should remember/,
    /can correct or forget/,
    // The module's templates, rebuilt inline — a constant scan cannot see these.
    /`(Fix|Forget|Undo)\b[^`$]*\$\{/,
    /`[^`]*— Replaced by/,
  ];

  function escape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function inlineUses(src: string, value: string): boolean {
    const v = escape(value);
    // As a quoted literal, or as bare JSX text between tags.
    return new RegExp(`(['"\`])${v}\\1|>\\s*${v}\\s*<`).test(src);
  }

  for (const file of [
    'FactsMemory.tsx',
    'AgentMemory.tsx',
    'MemoryCorrection.tsx',
    'MemoryUsedChip.tsx',
    'LearnedInChat.tsx',
  ]) {
    it(`${file} imports its memory-correction words`, () => {
      const src = code(file);
      const offenders = [...constants, ...badges]
        .filter(({ value }) => !(file === 'AgentMemory.tsx' && GENERIC.has(value)))
        .filter(({ value }) => inlineUses(src, value))
        .map(({ name }) => name);
      expect(offenders).toEqual([]);
      expect(RETIRED.filter((r) => r.test(src)).map(String)).toEqual([]);
    });
  }
});

describe('memory-copy — where a learned row came from (TASK-642)', () => {
  it('names the speaker of the source turn', () => {
    expect(copy.learnedSourceText('person')).toBe('from your message');
    expect(copy.learnedSourceText('agent')).toBe('from my reply');
  });

  it('accessible name starts with the visible words, then says which message', () => {
    expect(copy.learnedSourceLabel('agent', 'Got it — Oct 14')).toBe(
      'from my reply: “Got it — Oct 14”',
    );
    expect(copy.learnedSourceLabel('person', '')).toBe('from your message');
  });
});

describe('memory-copy — the "Used N memories" chip (TASK-628)', () => {
  it('counts one memory in the singular and more in the plural', () => {
    expect(copy.memoryUsedLabel(1)).toBe('Used 1 memory');
    expect(copy.memoryUsedLabel(3)).toBe('Used 3 memories');
  });

  it('names where a memory came from', () => {
    expect(copy.memoryUsedSource({ ...boston, savedBy: 'person' })).toBe('Saved by a person');
    expect(copy.memoryUsedSource({ ...boston, savedBy: 'agent' })).toBe('Noted by the agent');
    expect(copy.memoryUsedSource(boston)).toBe('From a chat');
  });

  it('joins source and date, or says just the source without a date', () => {
    expect(copy.memoryUsedDetail(boston, 'Sep 1, 2026')).toBe('From a chat · Sep 1, 2026');
    expect(copy.memoryUsedDetail(boston, '')).toBe('From a chat');
  });

  it('says Updated, not Fixed, for a replaced memory', () => {
    expect(copy.MEMORY_USED_SINCE).toEqual({
      replaced: 'Updated since this answer',
      retracted: 'Fixed since this answer',
      forgotten: 'Forgotten since this answer',
    });
  });
});
