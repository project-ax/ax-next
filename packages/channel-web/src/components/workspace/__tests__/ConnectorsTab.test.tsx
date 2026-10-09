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
import { AgentSettings } from '../AgentSettings';
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
    <AgentSettings agent={detail().agent} section="connectors" onSection={vi.fn()} onBack={vi.fn()} compact startOnList={false} busy={false} instructions={null} memory={null} />,
  );
}

const sw = (name: string) => screen.findByRole('switch', { name });

beforeEach(() => {
  vi.clearAllMocks();
  railMock.mockResolvedValue(rail());
  abilitiesMock.mockResolvedValue({ abilities: ALL_ON });
  vi.mocked(workspaceApi.connectors).mockResolvedValue({ connectors: [], shared: false, connectorsSupported: true, manageable: true, sharedCredentials: false });
});

describe('Connectors tab shell', () => {
  it('shows Connectors in settings, with visible guidance and built-in abilities', async () => {
    renderTab();
    expect(screen.queryByRole('tab', { name: 'Connectors' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Connectors' })).not.toHaveClass('sr-only');
    expect(await screen.findByText('Tools Quill can work in for you. Open one to choose which actions it can take on its own.')).not.toHaveClass('sr-only');
    expect(screen.getByText("Built-in abilities. Turn off anything Quill doesn't need. Fewer abilities means less that can go wrong.")).toBeVisible();
    await sw('Web search');
  });

  it('draws the connector list (with its Add) above Other abilities', async () => {
    renderTab();
    await sw('Web search');
    expect(await screen.findByText(/No connectors yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add connector' })).toBeTruthy();
    const connectors = screen.getByRole('heading', { level: 1, name: 'Connectors' });
    const abilities = screen.getByRole('heading', { name: 'What Quill can do' });
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

/**
 * TASK-768 — the description must come from aria-describedby, not
 * aria-description (read unevenly by VoiceOver). jest-dom's
 * toHaveAccessibleDescription honours BOTH, so it alone cannot tell the two
 * wirings apart: assert the attribute shape as well.
 */
function expectDescribedBy(el: HTMLElement, text: string) {
  expect(el).not.toHaveAttribute('aria-description');
  const ids = el.getAttribute('aria-describedby');
  expect(ids).toBeTruthy();
  for (const id of ids!.split(/\s+/)) {
    expect(document.getElementById(id)).not.toBeNull();
  }
  expect(el).toHaveAccessibleDescription(text);
}

function expectNoDescription(el: HTMLElement) {
  expect(el).not.toHaveAttribute('aria-description');
  expect(el).not.toHaveAttribute('aria-describedby');
  expect(el).toHaveAccessibleDescription('');
}

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
    // The caveat travels with the switch while it is off — a short hint on the
    // label's own row (never a subtitle line) and the sentence as its description.
    expectDescribedBy(run, "Some skills won't work.");
    expect(screen.getByText('· skills limited')).toBeInTheDocument();
    // The accessible name is unchanged by the description wiring.
    expect(run).toHaveAccessibleName('Run code');
    expect(abilitiesMock).toHaveBeenCalledWith('a-quill');
  });

  it('says Read web pages asks first, on the row and to a screen reader', async () => {
    abilitiesMock.mockResolvedValue({
      abilities: { webSearch: true, readPages: true, runCode: true },
    });
    renderTab();

    const read = await sw('Read web pages');
    // The built-in rule is Ask first; the switch can only turn it off.
    expectDescribedBy(read, 'Asks you before opening a new site');
    // The visible "· asks first" stays out of the name (aria-hidden).
    expect(read).toHaveAccessibleName('Read web pages');
    const hint = screen.getByText('· asks first');
    expect(hint).toHaveClass('text-muted-foreground');
    // Same row as the label, not a subtitle line under it.
    expect(hint.closest('label')).toBe(
      document.querySelector('label[for="ability-readPages"]'),
    );
    // The hint is the only one — the other rows carry no such claim.
    expect(screen.getAllByText(/asks first/)).toHaveLength(1);
    expectNoDescription(await sw('Web search'));
    // Run code is on here, so its off-only caveat is not attached.
    expectNoDescription(await sw('Run code'));
  });

  it('drops "asks first" while Read web pages is off — on screen and to a screen reader', async () => {
    // TASK-769, owner decision 2026-10-03: an off switch never reads a page,
    // so it claims nothing about asking. Sighted and screen-reader users get
    // the same answer: no hint, no description, no dangling describedby.
    abilitiesMock.mockResolvedValue({
      abilities: { webSearch: true, readPages: false, runCode: true },
    });
    renderTab();

    const read = await sw('Read web pages');
    expect(read).toHaveAttribute('aria-checked', 'false');
    expectNoDescription(read);
    expect(read).toHaveAccessibleName('Read web pages');
    expect(screen.queryByText(/asks first/)).toBeNull();
    expect(document.getElementById('ability-readPages-description')).toBeNull();
  });

  it('brings "asks first" back when Read web pages is switched on', async () => {
    abilitiesMock.mockResolvedValue({
      abilities: { webSearch: true, readPages: false, runCode: true },
    });
    setAbilityMock.mockResolvedValue({ abilities: ALL_ON });
    renderTab();

    // Wait for the switches first — before they render, "no hint" is vacuous.
    const read = await sw('Read web pages');
    expect(screen.queryByText(/asks first/)).toBeNull();
    fireEvent.click(read);
    await waitFor(() =>
      expect(setAbilityMock).toHaveBeenCalledWith('a-quill', 'readPages', true),
    );
    await waitFor(async () =>
      expect(await sw('Read web pages')).toHaveAttribute('aria-checked', 'true'),
    );
    expect(screen.getByText('· asks first')).toBeInTheDocument();
    expectDescribedBy(
      await sw('Read web pages'),
      'Asks you before opening a new site',
    );
  });

  // TASK-789 — one per-row rule: what a sighted user sees muted on the row, a
  // screen-reader user hears as the switch's description, and a row with
  // nothing on screen says nothing to a screen reader either. The hint is the
  // short form of the description (the full sentence does not fit the row).
  const NOTES: Record<
    string,
    Record<'on' | 'off', readonly [hint: string, description: string] | null>
  > = {
    'Web search': { on: null, off: null },
    'Read web pages': {
      on: ['· asks first', 'Asks you before opening a new site'],
      off: null,
    },
    'Run code': { on: null, off: ['· skills limited', "Some skills won't work."] },
  };
  for (const state of ['on', 'off'] as const) {
    it(`gives each row the same note on screen and to a screen reader (all ${state})`, async () => {
      const v = state === 'on';
      abilitiesMock.mockResolvedValue({
        abilities: { webSearch: v, readPages: v, runCode: v },
      });
      renderTab();
      for (const [label, notes] of Object.entries(NOTES)) {
        const s = await sw(label);
        expect(s).toHaveAttribute('aria-checked', String(v));
        // The hint never leaks into the switch's name.
        expect(s).toHaveAccessibleName(label);
        const hint = document
          .querySelector(`label[for="${s.id}"]`)!
          .querySelector('[aria-hidden="true"]');
        const want = notes[state];
        if (want === null) {
          expect(hint).toBeNull();
          expectNoDescription(s);
        } else {
          expect(hint?.textContent).toBe(want[0]);
          expect(hint).toHaveClass('text-muted-foreground');
          expectDescribedBy(s, want[1]);
        }
      }
    });
  }

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
