import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      forgetMemory: vi.fn(),
    },
  };
});

const recallMock = vi.mocked(workspaceApi.recallMemory);
const rememberMock = vi.mocked(workspaceApi.rememberMemory);
const forgetMock = vi.mocked(workspaceApi.forgetMemory);

const fact = (over: Partial<FactMemoryStatement> & { id: string }): FactMemoryStatement => ({
  about: 'user:alice',
  aboutText: 'you',
  relation: 'lives_in',
  value: 'Boston',
  when: '2026-09-01T00:00:00.000Z',
  ...over,
});

const read = (factsAvailable: boolean): AgentMemoryRead => ({
  rules: {
    status: 'ok',
    doc: { name: 'Your rules', scope: 'rules', body: '- Always cc Priya' },
  },
  learned: { status: 'ok', docs: [] },
  ...(factsAvailable ? { factsAvailable: true } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  recallMock.mockResolvedValue({ statements: [], degraded: [] });
  rememberMock.mockResolvedValue({ id: 'mem-new' });
  forgetMock.mockResolvedValue({ forgotten: true });
});

describe('MemorySurface', () => {
  it('leaves the Strata surface untouched when facts are unavailable', () => {
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
    expect(screen.queryByText('What it worked out')).toBeNull();
    expect(screen.queryByText(/drop the ones that stop being useful/)).toBeNull();
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

  it('edits a row through the dialog with exact arguments, then refreshes', async () => {
    recallMock.mockResolvedValue({
      statements: [
        fact({ id: 'm1', about: 'user:alice', relation: 'lives_in', value: 'Boston' }),
      ],
      degraded: [],
    });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: Boston' }));
    const input = await screen.findByLabelText('What we should remember');
    fireEvent.change(input, { target: { value: 'Cambridge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(rememberMock).toHaveBeenCalledWith('a1', {
        about: 'user:alice',
        relation: 'lives_in',
        value: 'Cambridge',
      }),
    );
    await waitFor(() => expect(recallMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Edit remembered detail')).toBeNull();
  });

  it('keeps the dialog and the draft when the save fails', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    rememberMock.mockRejectedValueOnce(new Error('down'));
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: Boston' }));
    const input = await screen.findByLabelText('What we should remember');
    fireEvent.change(input, { target: { value: 'Cambridge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('We could not save this detail. Your changes are still here.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Edit remembered detail')).toBeInTheDocument();
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

  it('shows closed rows in history with their closure, and no edit or forget on them', async () => {
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
    expect(screen.queryByRole('button', { name: 'Edit: Worcester' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forget: Worcester' })).toBeNull();
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
    expect(screen.getByText('Unclassified')).toBeInTheDocument();
    expect(screen.getByText('When (UTC)')).toBeInTheDocument();
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

  it('renders the owner\'s speaker as "you" and never the raw user id', async () => {
    recallMock.mockResolvedValue({ statements: [fact({ id: 'm1' })], degraded: [] });
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/you lives in: Boston/)).toBeInTheDocument();
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
    expect(await screen.findByText(/priya likes: tea/)).toBeInTheDocument();
    expect(screen.queryByText(/you likes/)).toBeNull();
  });

  it('interleaves closed and active rows oldest-first, not bucketed', async () => {
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    await screen.findByText('Search memories from your conversations.');
    recallMock.mockResolvedValue({
      statements: [
        fact({ id: 'b', value: 'Feb', when: '2026-02-01T00:00:00Z' }),
        fact({ id: 'a', value: 'Jan', when: '2026-01-01T00:00:00Z', until: '2026-02-05T00:00:00Z', closure: 'forgotten' }),
        fact({ id: 'c', value: 'Mar', when: '2026-03-01T00:00:00Z', until: '2026-04-01T00:00:00Z', closure: 'forgotten' }),
      ],
      degraded: [],
    });
    fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Jan/)).toBeInTheDocument();
    const cells = screen.getAllByRole('cell').map((c) => c.textContent ?? '');
    const flat = cells.join('');
    expect(flat.indexOf('Jan')).toBeLessThan(flat.indexOf('Feb'));
    expect(flat.indexOf('Feb')).toBeLessThan(flat.indexOf('Mar'));
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
    rememberMock.mockImplementation(
      () => new Promise<{ id: string }>((resolve) => { release = () => resolve({ id: 'x' }); }),
    );
    render(<MemorySurface agentId="a1" agentName="Quill" memory={read(true)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit: Boston' }));
    const input = await screen.findByLabelText('What we should remember');
    fireEvent.change(input, { target: { value: 'Cambridge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rememberMock).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.getByText('Edit remembered detail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(rememberMock).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() => expect(screen.queryByText('Edit remembered detail')).toBeNull());
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
});
