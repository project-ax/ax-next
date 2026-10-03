/**
 * The Connectors tab shell + "Other abilities" (TASK-738).
 *
 * The switches change what an agent may reach, so the tests pin that they
 * draw what the SERVER says after a write — never what was asked for — and
 * that Run code's one caveat is said before it is switched off.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, WorkspaceApiError, type AgentDetail } from '@/lib/workspace-api';
import { AgentRail } from '../AgentRail';
import { rail } from './rail-fixture';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      rail: vi.fn(),
      revokeGrant: vi.fn(),
      abilities: vi.fn(),
      setAbility: vi.fn(),
      connectors: vi.fn(),
      removeConnector: vi.fn(),
    },
  };
});

const railMock = vi.mocked(workspaceApi.rail);
const abilitiesMock = vi.mocked(workspaceApi.abilities);
const setAbilityMock = vi.mocked(workspaceApi.setAbility);

const ALL_ON = { webSearch: true, readPages: true, runCode: true };

function detail(): AgentDetail {
  return {
    agent: {
      id: 'a-quill',
      name: 'Quill',
      state: 'resting',
      now: null,
      counter: null,
      startedAt: null,
      stoppedReason: null,
    },
    conversationId: null,
    thread: [],
    decisions: { status: 'ok' },
    past: [],
    memory: { rules: { status: 'unavailable', doc: null } },
  };
}

function renderTab() {
  return render(
    <AgentRail detail={detail()} openPastId={null} onOpenPast={vi.fn()} tab="connectors" />,
  );
}

const sw = (name: string) => screen.findByRole('switch', { name });

beforeEach(() => {
  vi.clearAllMocks();
  railMock.mockResolvedValue(rail());
  abilitiesMock.mockResolvedValue({ abilities: ALL_ON });
  vi.mocked(workspaceApi.connectors).mockResolvedValue({ connectors: [], shared: false });
});

describe('Connectors tab shell', () => {
  it('is the Plug tab named "Connectors", with no visible panel title', async () => {
    renderTab();
    const tab = screen.getByRole('tab', { name: 'Connectors' });
    expect(tab).toHaveAttribute('data-state', 'active');
    expect(tab.querySelector('svg.lucide-plug')).not.toBeNull();
    // The old tab is gone, by name.
    expect(screen.queryByRole('tab', { name: 'What it may do alone' })).toBeNull();
    // The heading outline keeps an h2, but nobody sees it.
    const h2 = screen.getByRole('heading', { level: 2, name: 'Connectors' });
    expect(h2.className).toContain('sr-only');
    await sw('Web search');
  });

  it('draws the connector list above Other abilities, but no Add button until TASK-740', async () => {
    renderTab();
    await sw('Web search');
    expect(await screen.findByText(/No connectors yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
    const connectors = screen.getByRole('heading', { level: 3, name: /^Connectors/ });
    const abilities = screen.getByRole('heading', { level: 3, name: 'Other abilities' });
    expect(
      connectors.compareDocumentPosition(abilities) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('says the changes are scoped to this agent', async () => {
    renderTab();
    expect(await screen.findByText(/Changes apply to Quill only\./)).toBeTruthy();
  });

  it('says on the tab itself when the reach record would not load', async () => {
    // The list moved behind a link; a failed read must not hide behind it too.
    railMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill/rail', 500));
    renderTab();
    expect(
      await screen.findByText(/couldn’t read what Quill can reach just now/),
    ).toBeTruthy();
  });

  it('says nothing about a failed read when the rail loaded', async () => {
    renderTab();
    await sw('Web search');
    await waitFor(() => expect(railMock).toHaveBeenCalled());
    expect(screen.queryByText(/couldn’t read what Quill can reach/)).toBeNull();
  });
});

describe('Other abilities', () => {
  it('draws one switch per ability, set from the server', async () => {
    abilitiesMock.mockResolvedValue({
      abilities: { webSearch: true, readPages: false, runCode: false },
    });
    renderTab();

    expect(await sw('Web search')).toHaveAttribute('aria-checked', 'true');
    expect(await sw('Read web pages')).toHaveAttribute('aria-checked', 'false');
    const run = await sw('Run code');
    expect(run).toHaveAttribute('aria-checked', 'false');
    // The caveat travels with the switch while it is off — no visible subtitle.
    expect(run).toHaveAttribute('aria-description', "Some skills won't work.");
    expect(abilitiesMock).toHaveBeenCalledWith('a-quill');
  });

  it('writes one switch and draws what the server answered', async () => {
    setAbilityMock.mockResolvedValue({
      abilities: { webSearch: false, readPages: true, runCode: true },
    });
    renderTab();

    fireEvent.click(await sw('Web search'));
    await waitFor(() =>
      expect(setAbilityMock).toHaveBeenCalledWith('a-quill', 'webSearch', false),
    );
    await waitFor(async () =>
      expect(await sw('Web search')).toHaveAttribute('aria-checked', 'false'),
    );
  });

  it('never shows a change the server did not keep', async () => {
    // The write "succeeded" but the re-read says it is still on — the switch
    // follows the store, not the click.
    setAbilityMock.mockResolvedValue({ abilities: ALL_ON });
    renderTab();

    fireEvent.click(await sw('Read web pages'));
    await waitFor(() => expect(setAbilityMock).toHaveBeenCalled());
    await waitFor(async () =>
      expect(await sw('Read web pages')).not.toBeDisabled(),
    );
    expect(await sw('Read web pages')).toHaveAttribute('aria-checked', 'true');
  });

  it('says nothing changed when the write fails, and leaves the switch where it was', async () => {
    setAbilityMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill/abilities', 500));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderTab();

    fireEvent.click(await sw('Web search'));
    expect(await screen.findByText(/couldn’t change that just now\. Nothing changed\./)).toBeTruthy();
    // The operator's half: the cause is logged, not swallowed.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[agent-abilities]'));
    warn.mockRestore();
    expect(await sw('Web search')).toHaveAttribute('aria-checked', 'true');
  });

  it('asks before turning Run code off, and does nothing on "Keep it on"', async () => {
    renderTab();

    fireEvent.click(await sw('Run code'));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off Run code for Quill?' });
    expect(within(dialog).getByText(/Some skills won't work\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it on' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(setAbilityMock).not.toHaveBeenCalled();
    expect(await sw('Run code')).toHaveAttribute('aria-checked', 'true');
  });

  it('turns Run code off once confirmed', async () => {
    setAbilityMock.mockResolvedValue({
      abilities: { webSearch: true, readPages: true, runCode: false },
    });
    renderTab();

    fireEvent.click(await sw('Run code'));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off Run code for Quill?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(setAbilityMock).toHaveBeenCalledWith('a-quill', 'runCode', false),
    );
    await waitFor(async () =>
      expect(await sw('Run code')).toHaveAttribute('aria-checked', 'false'),
    );
  });

  it('turns Run code back on without asking', async () => {
    abilitiesMock.mockResolvedValue({
      abilities: { webSearch: true, readPages: true, runCode: false },
    });
    setAbilityMock.mockResolvedValue({ abilities: ALL_ON });
    renderTab();

    fireEvent.click(await sw('Run code'));
    await waitFor(() =>
      expect(setAbilityMock).toHaveBeenCalledWith('a-quill', 'runCode', true),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('draws no switches where there is nothing to switch (503)', async () => {
    abilitiesMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill/abilities', 503));
    renderTab();

    expect(await screen.findByText(/can’t switch these on or off yet/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('says the read failed rather than drawing three "on" switches', async () => {
    abilitiesMock.mockRejectedValue(new WorkspaceApiError('/agents/a-quill/abilities', 500));
    renderTab();

    expect(await screen.findByText(/couldn’t read these just now/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
