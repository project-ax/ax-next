/**
 * The agent settings page on its own (TASK-888): the honest empty states, the
 * phone's list → section → list flow, and the heading outline.
 *
 * The URL half — deep links, canonical addresses, the rail's way in and
 * "Back to chat" keeping the conversation — is pinned from the shell's side in
 * `WorkspaceShellRouting.test.tsx`. jsdom has no layout, so nothing here
 * claims anything about widths; the `compact` prop is the tree switch.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import {
  AGENT_SETTINGS_SECTIONS,
  type AgentSettingsSection,
} from '@/lib/workspace-route';
import { headingOutline } from '@/test-utils/heading-outline';
import { AgentSettings } from '../AgentSettings';

vi.mock('@/lib/routines', () => ({ routines: { list: vi.fn(async () => []), listAgentDefaults: vi.fn(async () => []) } }));

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      rail: vi.fn(async () => null),
      revokeGrant: vi.fn(),
      abilities: vi.fn(async () => ({ abilities: {} })),
    },
  };
});

const quill: WorkspaceAgent = {
  id: 'a-quill',
  name: 'Quill',
  state: 'resting',
  now: null,
  counter: null,
  startedAt: null,
  stoppedReason: null,
};

/** The page with its section held in state, as the shell's URL would hold it. */
function Harness({
  initial = 'instructions',
  compact = false,
  startOnList = true,
  memory = null,
  onBack = vi.fn(),
}: {
  initial?: AgentSettingsSection;
  compact?: boolean;
  startOnList?: boolean;
  memory?: React.ReactNode;
  onBack?: () => void;
}) {
  const [section, setSection] = useState<AgentSettingsSection>(initial);
  return (
    <AgentSettings
      agent={quill}
      section={section}
      onSection={setSection}
      onBack={onBack}
      compact={compact}
      startOnList={startOnList}
      busy={false}
      instructions={<textarea aria-label="Instructions for Quill" />}
      memory={memory}
    />
  );
}

describe('AgentSettings — desktop', () => {
  it('heads the page with the agent, and the section under it', () => {
    render(<Harness initial="model" />);
    expect(headingOutline()).toEqual(['h1: Quill settings', 'h2: Model']);
    expect(
      screen.getByText(
        'These only change Quill. Connectors your whole team shares live in Admin.',
      ),
    ).toBeTruthy();
  });

  it('lists every section in the nav, in order, with the open one marked', () => {
    render(<Harness initial="memory" />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const items = within(nav).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([
      'Instructions',
      'Model',
      'Connectors',
      'Memory',
      'Skills',
      'Routines',
    ]);
    expect(items.filter((b) => b.getAttribute('aria-current') === 'page')).toHaveLength(1);
    expect(within(nav).getByRole('button', { name: 'Memory' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('names the section in the breadcrumb', () => {
    render(<Harness initial="skills" />);
    const crumbs = screen.getByRole('navigation', { name: 'breadcrumb' });
    expect(crumbs).toHaveTextContent(/Quill.*Settings.*Skills/u);
  });

  it('goes back to the chat from "Back to chat"', () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('hosts the rules editor under Instructions, with the verbatim promise', () => {
    render(<Harness initial="instructions" />);
    expect(screen.getByRole('textbox', { name: 'Instructions for Quill' })).toBeTruthy();
    expect(
      screen.getByText('Kept word for word. Quill reads them before every run.'),
    ).toBeTruthy();
  });

  it.each([
    [
      'model',
      'Using the workspace default',
      "Picking a model just for Quill isn't here yet. Until it is, Quill uses whatever model your admin set for the whole workspace.",
    ],
  ] as const)('says the %s section is empty, honestly, with no controls', (section, title, body) => {
    render(<Harness initial={section} />);
    const empty = document.querySelector('[data-slot="empty"]');
    expect(empty).not.toBeNull();
    expect(within(empty as HTMLElement).getByText(title)).toBeTruthy();
    if (body !== null) expect(within(empty as HTMLElement).getByText(body)).toBeTruthy();
    // No fake controls: nothing to press, type in or toggle inside it.
    expect(within(empty as HTMLElement).queryAllByRole('button')).toHaveLength(0);
    expect(within(empty as HTMLElement).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(empty as HTMLElement).queryAllByRole('switch')).toHaveLength(0);
    expect(within(empty as HTMLElement).queryAllByRole('combobox')).toHaveLength(0);
  });

  it.each([['skills', 'Installed'], ['routines', 'My routines']] as const)('wires the %s section to its agent-specific controls', async (initial, tab) => {
    render(<Harness initial={initial} />);
    expect(screen.getByRole('tab', { name: tab })).toBeTruthy();
    expect(await screen.findByRole('button', { name: initial === 'skills' ? 'Create' : 'New routine' })).toBeTruthy();
  });

  it('draws the memories list it is given under Memory', () => {
    render(<Harness initial="memory" memory={<p>the memories list</p>} />);
    expect(screen.getByText('the memories list')).toBeTruthy();
  });

  it('never leaves Memory blank on a deployment that keeps no memories', () => {
    render(<Harness initial="memory" memory={null} />);
    expect(screen.getByText('No memories to show')).toBeTruthy();
  });

  it('renders something in every section — none of them is blank', () => {
    for (const section of AGENT_SETTINGS_SECTIONS) {
      const { unmount } = render(<Harness initial={section} />);
      const region = screen.getByRole('region', { name: screen.getByRole('heading', { level: 2 }).textContent ?? '' });
      expect(region.textContent?.length ?? 0).toBeGreaterThan(
        (screen.getByRole('heading', { level: 2 }).textContent ?? '').length,
      );
      unmount();
    }
  });
});

describe('AgentSettings — phone', () => {
  it('shows the section list first, drills in on a tap, and comes back out', () => {
    render(<Harness compact initial="instructions" />);

    // The list, with a one-line summary per section and no nav column.
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull();
    const list = screen.getByRole('list', { name: 'Settings sections' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(AGENT_SETTINGS_SECTIONS.length);
    expect(within(list).getByRole('button', { name: /Skills\s*Instructions this agent can reuse/u })).toBeTruthy();
    expect(headingOutline()).toEqual(['h1: Quill settings']);

    fireEvent.click(within(list).getByRole('button', { name: /^Model/u }));

    expect(headingOutline()).toEqual(['h1: Model']);
    expect(screen.getByText('Using the workspace default')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Settings sections' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByRole('list', { name: 'Settings sections' })).toBeTruthy();
    expect(headingOutline()).toEqual(['h1: Quill settings']);
  });

  it('goes back to the chat from the list', () => {
    const onBack = vi.fn();
    render(<Harness compact onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('keeps every row at least 44px tall', () => {
    // jsdom has no layout; this pins the class that sets the target size.
    render(<Harness compact />);
    const list = screen.getByRole('list', { name: 'Settings sections' });
    for (const row of within(list).getAllByRole('button')) {
      expect(row.className).toContain('min-h-11');
    }
  });
});

it('opens the named section on a mobile direct link or reload', () => {
  render(<Harness compact initial="model" startOnList={false} />);
  expect(screen.getByRole('heading', { level: 1, name: 'Model' })).toBeTruthy();
  expect(screen.getByText('Using the workspace default')).toBeTruthy();
});
