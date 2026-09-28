import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  workspaceApi,
  type AgentMemoryRead,
  type FactMemoryStatement,
} from '@/lib/workspace-api';
import { MemorySurface } from '../FactsMemory';

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
const correctMock = vi.mocked(workspaceApi.correctMemory);
const forgetMock = vi.mocked(workspaceApi.forgetMemory);
const unforgetMock = vi.mocked(workspaceApi.unforgetMemory);

const fact = (over: Partial<FactMemoryStatement> & { id: string }): FactMemoryStatement => ({
  about: 'user:alice',
  aboutText: 'you',
  relation: 'lives_in',
  value: 'Boston',
  when: '2026-09-01T00:00:00.000Z',
  ...over,
});

const read = (
  factsAvailable: boolean,
  factsVisibility?: 'personal' | 'team',
): AgentMemoryRead => ({
  rules: {
    status: 'ok',
    doc: { name: 'Your rules', scope: 'rules', body: '- Always cc Priya' },
  },
  ...(factsAvailable ? { factsAvailable: true } : {}),
  ...(factsVisibility !== undefined ? { factsVisibility } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  recallMock.mockResolvedValue({ statements: [], degraded: [] });
  rememberMock.mockResolvedValue({ id: 'mem-new' });
  correctMock.mockResolvedValue({ id: 'mem-new' });
  forgetMock.mockResolvedValue({ forgotten: true });
});

describe('MemorySurface', () => {
  it('falls back to the rules-only surface when facts are unavailable', () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(false)} />);
    expect(screen.getByText('Rules you gave me')).toBeInTheDocument();
    expect(screen.queryByText('Profile')).toBeNull();
    expect(screen.queryByText('Search memories')).toBeNull();
    expect(recallMock).not.toHaveBeenCalled();
  });

  it('keeps the rules editor and renders the two facts cards when available', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(screen.getByText('Rules you gave me')).toBeInTheDocument();
    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getAllByText('Search memories')).not.toHaveLength(0);
    await waitFor(() =>
      expect(recallMock).toHaveBeenCalledWith('a1', { profile: true, history: false }),
    );
  });

  it('shows the profile rows the product picked, one row per slot', async () => {
    recallMock.mockResolvedValue({
      statements: [
        fact({ id: 'm1', slot: 'lives_in', value: 'Boston', whenText: '2026-09-01 (Tue)' }),
        fact({ id: 'm2', slot: 'timezone', relation: 'timezone', value: 'UTC-5' }),
      ],
      degraded: [],
    });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(await screen.findByText('Boston')).toBeInTheDocument();
    expect(screen.getByText('UTC-5')).toBeInTheDocument();
    expect(screen.getByText('lives in:')).toBeInTheDocument();
    expect(screen.getByText('Noted 2026-09-01 (Tue)')).toBeInTheDocument();
  });

  it('says the profile is empty only when the read worked', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(
      await screen.findByText(/No profile memories yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not read/)).toBeNull();
  });

  it('shows a failed read with retry, never an empty state', async () => {
    recallMock.mockRejectedValueOnce(new Error('down'));
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(await screen.findByText('We could not read these memories. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/No profile memories yet/)).toBeNull();

    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    expect(await screen.findByText('Boston')).toBeInTheDocument();
  });

  it('shows a neutral degraded notice without raw flags or a retry offer', async () => {
    recallMock.mockResolvedValue({
      statements: [fact({ id: 'm1' })],
      degraded: ['semantic', 'ranking'],
    });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(
      await screen.findByText('Some search features are unavailable. Results may be incomplete.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/semantic|ranking/)).toBeNull();
  });

  it('renders hostile statement text literally — no links, images, or markup', async () => {
    recallMock.mockResolvedValue({
      statements: [
        fact({
          id: 'm1',
          value: '[click here](javascript:alert(1)) <img src=x onerror=alert(1)>',
        }),
      ],
      degraded: [],
    });
    const { container } = render(
      <MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />,
    );
    expect(
      await screen.findByText(/click here.*javascript:alert/),
    ).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('fixes a row through the dialog with exact arguments, then refreshes', async () => {
    recallMock.mockResolvedValue({
      statements: [
        fact({ id: 'm1', about: 'user:alice', relation: 'lives_in', value: 'Boston' }),
      ],
      degraded: [],
    });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix: Boston' }));
    const input = await screen.findByLabelText('What should I remember?');
    fireEvent.change(input, { target: { value: 'Cambridge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(correctMock).toHaveBeenCalledWith('a1', {
        id: 'm1',
        about: 'user:alice',
        relation: 'lives_in',
        value: 'Cambridge',
        reason: 'changed',
      }),
    );
    expect(rememberMock).not.toHaveBeenCalled();
    await waitFor(() => expect(recallMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Fix this memory')).toBeNull();
  });

  it('asks what happened, defaulting to "It changed"', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix: Boston' }));
    const group = await screen.findByRole('radiogroup');
    expect(group).toBeInTheDocument();
    expect(screen.getByText('What happened?')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'It changed' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'It was never right' })).not.toBeChecked();
    expect(
      screen.getByText(
        "I'll treat the old version as a mistake, not as something that used to be true.",
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ['It changed', 'changed'],
    ['It was never right', 'never-right'],
  ] as const)('choosing "%s" sends reason %s', async (label, reason) => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix: Boston' }));
    fireEvent.change(await screen.findByLabelText('What should I remember?'), {
      target: { value: 'Denver' },
    });
    // Pick the other option first, so each case proves its click lands.
    fireEvent.click(
      screen.getByRole('radio', {
        name: reason === 'changed' ? 'It was never right' : 'It changed',
      }),
    );
    fireEvent.click(screen.getByRole('radio', { name: label }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(correctMock).toHaveBeenCalledWith('a1', {
        id: 'm1',
        about: 'user:alice',
        relation: 'lives_in',
        value: 'Denver',
        reason,
      }),
    );
  });

  it('resets the answer to "It changed" when Fix opens on another memory', async () => {
    recallMock.mockResolvedValue({
      statements: [
        fact({ id: 'm1', value: 'Boston' }),
        fact({ id: 'm2', relation: 'works_at', value: 'Acme' }),
      ],
      degraded: [],
    });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix: Boston' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'It was never right' }));
    expect(screen.getByRole('radio', { name: 'It was never right' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Fix this memory')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Fix: Acme' }));
    expect(await screen.findByRole('radio', { name: 'It changed' })).toBeChecked();
  });

  it('keeps the dialog and the draft when the save fails', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    correctMock.mockRejectedValueOnce(new Error('down'));
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix: Boston' }));
    const input = await screen.findByLabelText('What should I remember?');
    fireEvent.change(input, { target: { value: 'Cambridge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('We could not save this fix. Your changes are still here.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Fix this memory')).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('Cambridge');
    expect(recallMock).toHaveBeenCalledTimes(1);
  });

  it('forgets only after confirmation, then refreshes', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Forget: Boston' }));
    expect(await screen.findByText('Forget this memory?')).toBeInTheDocument();
    expect(forgetMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Forget this memory?')).toBeNull());
    expect(forgetMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Forget: Boston' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(forgetMock).toHaveBeenCalledWith('a1', ['m1']));
    await waitFor(() => expect(recallMock).toHaveBeenCalledTimes(2));
  });

  it('keeps the row and reports the failure when forget fails', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    forgetMock.mockRejectedValueOnce(new Error('down'));
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Forget: Boston' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }));
    expect(
      await screen.findByText('We could not forget this memory. Try again.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Boston')).toBeInTheDocument();
  });

  it('shows closed rows in history with their closure, and no fix or forget on them', async () => {
    recallMock.mockImplementation(async (_id, input) => {
      if (input?.history === true) {
        return {
          statements: [
            fact({ id: 'm1', value: 'Cambridge' }),
            fact({
              id: 'm0',
              value: 'Boston',
              until: '2026-09-10T00:00:00.000Z',
              closure: 'replaced',
              closedBy: 'm1',
            }),
            fact({
              id: 'm-1',
              value: 'Worcester',
              until: '2026-08-01T00:00:00.000Z',
              closure: 'forgotten',
            }),
          ],
          degraded: [],
        };
      }
      return { statements: [fact({ id: 'm1', value: 'Cambridge' })], degraded: [] };
    });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(await screen.findByText('Cambridge')).toBeInTheDocument();
    expect(screen.queryByText('Boston')).toBeNull();

    fireEvent.click(screen.getAllByRole('switch', { name: 'Show history' })[0]!);
    await waitFor(() =>
      expect(recallMock).toHaveBeenCalledWith('a1', { profile: true, history: true }),
    );
    expect(await screen.findByText(/Boston/)).toBeInTheDocument();
    expect(screen.getByText('Replaced')).toBeInTheDocument();
    expect(screen.getByText(/Replaced by: Cambridge/)).toBeInTheDocument();
    expect(screen.getByText('Forgotten')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fix: Worcester' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forget: Worcester' })).toBeNull();
  });

  it('strikes through a retracted value and badges it Retracted; a replaced row stays Replaced', async () => {
    recallMock.mockImplementation(async (_id, input) => {
      if (input?.history === true) {
        return {
          statements: [
            fact({ id: 'm2', value: 'Denver' }),
            fact({
              id: 'm0',
              value: 'Boston',
              until: '2026-09-20T00:00:00.000Z',
              closure: 'replaced',
              closedBy: 'm2',
            }),
            fact({
              id: 'm1',
              value: 'Seattle',
              until: '2026-09-27T00:00:00.000Z',
              closure: 'retracted',
            }),
          ],
          degraded: [],
        };
      }
      return { statements: [fact({ id: 'm2', value: 'Denver' })], degraded: [] };
    });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(await screen.findByText('Denver')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('switch', { name: 'Show history' })[0]!);

    const seattle = await screen.findByText('Seattle');
    expect(seattle).toHaveClass('line-through');
    const seattleRow = seattle.closest('li')!;
    expect(seattleRow.textContent).toContain('Retracted');
    expect(seattleRow.textContent).toContain('2026-09-27');
    expect(seattleRow.textContent).not.toContain('Replaced');
    expect(screen.queryByRole('button', { name: 'Fix: Seattle' })).toBeNull();

    const boston = screen.getByText('Boston');
    expect(boston).not.toHaveClass('line-through');
    expect(boston.closest('li')!.textContent).toContain('Replaced by: Denver');
    expect(screen.getByText('Denver')).not.toHaveClass('line-through');
  });

  it('shows an overridden row as closed history with a badge, even though it has no until', async () => {
    recallMock.mockImplementation(async (_id, input) => {
      if (input?.history === true) {
        return {
          statements: [
            fact({ id: 'm1', value: 'Cambridge' }),
            fact({ id: 'm0', value: 'Outranked', closure: 'overridden' }),
          ],
          degraded: [],
        };
      }
      return { statements: [fact({ id: 'm1', value: 'Cambridge' })], degraded: [] };
    });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(await screen.findByText('Cambridge')).toBeInTheDocument();
    expect(screen.queryByText('Outranked')).toBeNull();

    fireEvent.click(screen.getAllByRole('switch', { name: 'Show history' })[0]!);
    expect(await screen.findByText('Outranked')).toBeInTheDocument();
    expect(screen.getByText('Overridden')).toBeInTheDocument();
    expect(screen.getByText(/another memory is used instead/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fix: Outranked' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forget: Outranked' })).toBeNull();
  });

  it('never shows Forget on an overridden row in search results', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    await screen.findByText('Search memories from your conversations.');
    recallMock.mockResolvedValue({
      statements: [fact({ id: 'm1', value: 'Outranked', closure: 'overridden' })],
      degraded: [],
    });
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Outranked/)).toBeInTheDocument();
    expect(screen.getByText('Overridden')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Forget:/ })).toBeNull();
  });

  it('searches on submit and maps kinds to friendly type labels', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(
      await screen.findByText('Search memories from your conversations.'),
    ).toBeInTheDocument();

    recallMock.mockResolvedValue({
      statements: [
        fact({ id: 'm1', kind: 'world', value: 'Tea', relation: 'likes' }),
        fact({ id: 'm2', kind: 'observation', value: 'Quiet', relation: 'prefers' }),
        fact({ id: 'm3', kind: 'opinion', value: 'Bold', relation: 'thinks' }),
        fact({ id: 'm4', value: 'Plain', relation: 'notes' }),
      ],
      degraded: [],
    });
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'tea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(recallMock).toHaveBeenCalledWith('a1', { query: 'tea', history: false }),
    );
    expect(await screen.findByText(/Tea/)).toBeInTheDocument();
    expect(screen.getAllByText('Fact')).not.toHaveLength(0);
    expect(screen.getByText('Observation')).toBeInTheDocument();
    expect(screen.getByText('Opinion')).toBeInTheDocument();
    // No kind, no savedBy: the honest gap is "Older memory", not "Unclassified"
    // (which read as a claim about the row rather than about our own metadata).
    expect(screen.getByText('Older memory')).toBeInTheDocument();
    expect(screen.getByText('When (UTC)')).toBeInTheDocument();
  });

  it('labels a kindless row by who saved it, not by a raw provenance token', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    await screen.findByText('Search memories from your conversations.');
    recallMock.mockResolvedValue({
      statements: [
        fact({ id: 'm1', value: 'Human-saved', savedBy: 'person' }),
        fact({ id: 'm2', value: 'Agent-saved', savedBy: 'agent' }),
      ],
      degraded: [],
    });
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Saved by a person')).toBeInTheDocument();
    expect(screen.getByText('Agent note')).toBeInTheDocument();
  });

  it('says no matches only after a real search came back empty', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'zzz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(
      await screen.findByText('No memories match that. Try a different word or phrase.'),
    ).toBeInTheDocument();
  });

  it('never paints an older search over a newer one', async () => {
    const pending: {
      resolve: (v: { statements: FactMemoryStatement[]; degraded: string[] }) => void;
    }[] = [];
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    await screen.findByText('Search memories from your conversations.');

    recallMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push({ resolve });
        }),
    );
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(recallMock).toHaveBeenCalledWith('a1', { query: 'old', history: false }));

    recallMock.mockResolvedValue({
      statements: [fact({ id: 'new1', value: 'Newest' })],
      degraded: [],
    });
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Newest/)).toBeInTheDocument();

    pending[0]?.resolve({ statements: [fact({ id: 'old1', value: 'Stale' })], degraded: [] });
    await waitFor(() => expect(screen.queryByText(/Stale/)).toBeNull());
    expect(screen.getByText(/Newest/)).toBeInTheDocument();
  });

  it('never paints the previous agent\'s rows under a new agent', async () => {
    recallMock.mockResolvedValue({
      statements: [fact({ id: 'm1', value: 'AliceSecret' })],
      degraded: [],
    });
    const { rerender } = render(
      <MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />,
    );
    expect(await screen.findByText('AliceSecret')).toBeInTheDocument();

    recallMock.mockResolvedValue({ statements: [], degraded: [] });
    rerender(<MemorySurface agentId="a2" agentName="Quill" memory={read(true)} />);
    await waitFor(() => expect(screen.queryByText(/AliceSecret/)).toBeNull());
    await waitFor(() =>
      expect(recallMock).toHaveBeenCalledWith('a2', { profile: true, history: false }),
    );
    expect(await screen.findByText(/No profile memories yet/)).toBeInTheDocument();
  });

  it('renders the owner\'s speaker as "You" and never the raw user id', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/You — lives in: Boston/)).toBeInTheDocument();
    expect(screen.queryByText(/user:alice|alice lives/)).toBeNull();
  });

  it('keeps a foreign subject literal — not relabelled as you', async () => {
    recallMock.mockResolvedValue({
      statements: [fact({ id: 'm1', about: 'priya', aboutText: 'priya', relation: 'likes', value: 'tea' })],
      degraded: [],
    });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Priya — likes: tea/)).toBeInTheDocument();
    expect(screen.queryByText(/You — likes/)).toBeNull();
  });

  it('renders the engine\'s own order — best match first, never re-sorted by date', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    await screen.findByText('Search memories from your conversations.');
    recallMock.mockResolvedValue({
      statements: [
        // Deliberately NOT date order: the engine's rank puts the oldest row
        // first and the newest last. If the UI re-sorted by date this would
        // come back Jan, Feb, Mar — the bug T3 removes.
        fact({ id: 'a', value: 'Jan', when: '2026-01-01T00:00:00Z' }),
        fact({ id: 'c', value: 'Mar', when: '2026-03-01T00:00:00Z' }),
        fact({ id: 'b', value: 'Feb', when: '2026-02-01T00:00:00Z' }),
      ],
      degraded: [],
    });
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Jan/)).toBeInTheDocument();
    const cells = screen.getAllByRole('cell').map((c) => c.textContent ?? '');
    const flat = cells.join('');
    expect(flat.indexOf('Jan')).toBeLessThan(flat.indexOf('Mar'));
    expect(flat.indexOf('Mar')).toBeLessThan(flat.indexOf('Feb'));
    expect(screen.getByText('Best matches first.')).toBeInTheDocument();
  });

  it('submitting the same query twice makes a second request', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    await screen.findByText('Search memories from your conversations.');
    const input = screen.getByLabelText('Search memories');
    fireEvent.change(input, { target: { value: 'tea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(recallMock).toHaveBeenCalledWith('a1', { query: 'tea', history: false }),
    );
    const searches = () =>
      recallMock.mock.calls.filter(([, i]) => i.query === 'tea').length;
    expect(searches()).toBe(1);

    recallMock.mockResolvedValue({
      statements: [fact({ id: 'm2', value: 'Green tea' })],
      degraded: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(searches()).toBe(2));
    expect(await screen.findByText(/Green tea/)).toBeInTheDocument();
  });

  it('cannot be dismissed or double-fired while a save is pending', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    let release: (() => void) | undefined;
    correctMock.mockImplementation(
      () => new Promise<{ id: string }>((resolve) => { release = () => resolve({ id: 'x' }); }),
    );
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Fix: Boston' }));
    const input = await screen.findByLabelText('What should I remember?');
    fireEvent.change(input, { target: { value: 'Cambridge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(correctMock).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.getByText('Fix this memory')).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(correctMock).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() => expect(screen.queryByText('Fix this memory')).toBeNull());
    await waitFor(() => expect(recallMock.mock.calls.length).toBeGreaterThan(1));
  });

  it('cannot dismiss a pending forget on Escape', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    let release: (() => void) | undefined;
    forgetMock.mockImplementation(
      () => new Promise<{ forgotten: true }>((resolve) => { release = () => resolve({ forgotten: true }); }),
    );
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Forget: Boston' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(forgetMock).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.getByText('Forget this memory?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    expect(forgetMock).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() => expect(screen.queryByText('Forget this memory?')).toBeNull());
  });

  it('discloses a shared agent\'s team visibility before any write', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    render(
      <MemorySurface
        agentId="a1"
        agentName="Quill"
        memory={read(true, 'team')}
      />,
    );
    expect(
      screen.getByText(
        /Memories saved with this shared agent are visible to its team\. Team members can fix or forget them\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('These details are about you and are visible to the team.'),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Fix: Boston' }));
    expect(
      await screen.findByText(
        'Saving replaces it for the team. The earlier version stays in History.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Forget: Boston' }));
    expect(
      await screen.findByText(
        'This memory will be removed from active results for the team. It stays in History, and past conversations do not change.',
      ),
    ).toBeInTheDocument();
  });

  it('discloses a personal agent\'s private scope and keeps personal wording', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    render(
      <MemorySurface
        agentId="a1"
        agentName="Quill"
        memory={read(true, 'personal')}
      />,
    );
    expect(
      screen.getByText('Memories saved with this personal agent are private to you.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/visible to its team|visible to the team/),
    ).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Forget: Boston' }));
    expect(
      await screen.findByText(
        /This memory will be removed from active results\. It stays in History, and past conversations do not change\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/for the team/)).toBeNull();
  });

  it('labels no scope when the deployment does not report one', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(await screen.findByText('Boston')).toBeInTheDocument();
    expect(
      screen.queryByText(/private to you|visible to its team/),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Forget: Boston' }));
    expect(
      await screen.findByText(
        /This memory will be removed from active results\. It stays in History, and past conversations do not change\./,
      ),
    ).toBeInTheDocument();
  });
});

describe('MemorySurface — extraction paused', () => {
  const paused = (factsAvailable: boolean): AgentMemoryRead => ({
    ...read(factsAvailable),
    factsExtraction: 'paused',
  });

  it('says memory is paused, points at the admin fix, and drops the empty-state promise', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={paused(true)} />);
    expect(screen.getByText('Memory is paused')).toBeInTheDocument();
    expect(screen.getByText(/Admin → AI model keys/)).toBeInTheDocument();
    expect(screen.getByText(/doesn't have an OpenRouter key yet/)).toBeInTheDocument();
    // One notice for the whole surface, not one per card.
    expect(screen.getAllByText('Memory is paused')).toHaveLength(1);

    expect(await screen.findByText('No profile memories yet.')).toBeInTheDocument();
    expect(screen.queryByText(/will appear here/)).toBeNull();
  });

  it('shows no notice and keeps the full empty-state sentence when not paused', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    expect(
      await screen.findByText(
        'No profile memories yet. Details we remember from your conversations will appear here.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Memory is paused')).toBeNull();
    expect(screen.queryByText(/AI model keys/)).toBeNull();
  });

  it('renders no notice on the rules-only fallback surface (only the facts surface reads the flag)', () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={paused(false)} />);
    expect(screen.getByText('Rules you gave me')).toBeInTheDocument();
    expect(screen.queryByText('Memory is paused')).toBeNull();
  });
});

/** Activate a button the way a keyboard does: it has focus first, then it fires. */
function press(el: HTMLElement): void {
  el.focus();
  expect(document.activeElement).toBe(el);
  fireEvent.click(el);
}

describe('MemorySurface — where focus goes when a dialog closes (TASK-644)', () => {
  beforeEach(() => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
  });

  it('Fix → Save lands on the receipt\'s "Updated." line, with Undo the next stop', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    press(await screen.findByRole('button', { name: 'Fix: Boston' }));
    fireEvent.change(await screen.findByLabelText('What should I remember?'), {
      target: { value: 'Cambridge' },
    });
    press(screen.getByRole('button', { name: 'Save' }));

    const outcome = await screen.findByText('Updated.');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    const undo = screen.getByRole('button', { name: /^Undo/ });
    expect(outcome.compareDocumentPosition(undo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Forget lands on the receipt\'s "Forgotten" line, with Undo the next stop', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    press(await screen.findByRole('button', { name: 'Forget: Boston' }));
    press(await screen.findByRole('button', { name: 'Forget' }));

    const outcome = await screen.findByText('Forgotten');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    const undo = screen.getByRole('button', { name: /^Undo/ });
    expect(outcome.compareDocumentPosition(undo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Cancel returns focus to the button that opened the dialog', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    const fix = await screen.findByRole('button', { name: 'Fix: Boston' });
    press(fix);
    press(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(fix));

    const forgetBtn = screen.getByRole('button', { name: 'Forget: Boston' });
    press(forgetBtn);
    press(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(forgetBtn));
  });
});

describe('MemorySurface — where focus goes after Undo or when the receipt runs out (TASK-651)', () => {
  let current: FactMemoryStatement[] = [];

  beforeEach(() => {
    current = [fact({ id: 'm1' })];
    recallMock.mockImplementation(() => Promise.resolve({ statements: current, degraded: [] }));
    forgetMock.mockImplementation(() => {
      current = [];
      return Promise.resolve({ forgotten: true });
    });
    correctMock.mockImplementation(() => {
      current = [fact({ id: 'm2', value: 'Cambridge' })];
      return Promise.resolve({ id: 'm2' });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The row's own line — what focus should land on — inside the row that has `fixLabel`. */
  function rowLine(fixLabel: string): Element {
    const li = screen.getByRole('button', { name: fixLabel }).closest('li');
    expect(li).not.toBeNull();
    const line = li!.firstElementChild?.firstElementChild;
    expect(line).toBeTruthy();
    return line!;
  }

  async function forgetBoston(): Promise<void> {
    press(await screen.findByRole('button', { name: 'Forget: Boston' }));
    press(await screen.findByRole('button', { name: 'Forget' }));
    const outcome = await screen.findByText('Forgotten');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(outcome));
  }

  it('Forget → Undo waits on the Profile heading while the list re-reads, then lands on the row', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    await forgetBoston();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Fix: Boston' })).toBeNull());

    let finish: () => void = () => {};
    recallMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ statements: [fact({ id: 'm1' })], degraded: [] });
        }),
    );
    unforgetMock.mockImplementation(() => {
      current = [fact({ id: 'm1' })];
      return Promise.resolve({ restored: ['m1'] });
    });
    press(screen.getByRole('button', { name: /^Undo/ }));

    const heading = screen.getByText('Profile');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    act(() => finish());
    await screen.findByRole('button', { name: 'Fix: Boston' });
    await waitFor(() => expect(document.activeElement).toBe(rowLine('Fix: Boston')));
    expect(document.activeElement?.textContent).toBe('lives in: Boston');
  });

  it('a Forgotten receipt that runs out while it has focus hands focus to the Profile heading', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    await forgetBoston();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    await waitFor(() => expect(screen.queryByText('Forgotten')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Profile')));
  });

  it('an Updated receipt that runs out while it has focus hands focus to the fixed row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    press(await screen.findByRole('button', { name: 'Fix: Boston' }));
    fireEvent.change(await screen.findByLabelText('What should I remember?'), {
      target: { value: 'Cambridge' },
    });
    press(screen.getByRole('button', { name: 'Save' }));
    const outcome = await screen.findByText('Updated.');
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    await screen.findByRole('button', { name: 'Fix: Cambridge' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    await waitFor(() => expect(screen.queryByText('Updated.')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rowLine('Fix: Cambridge')));
  });
});
