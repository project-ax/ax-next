/**
 * The "these connectors are off for this chat" notice (TASK-806).
 *
 * A connector this person never signed in to (or never added a key for) is
 * skipped for the turn by the host rather than blocking it. The chat says so,
 * once, in plain words, with a way to the fix — derived from the agent's
 * Connectors list (`health: 'needs-sign-in'`), so the rail and the notice
 * cannot disagree about which connectors those are.
 *
 * Two things are held here: the sentence (pure, and the connector NAME in it is
 * untrusted text), and the notice's behaviour — what it names, what dismissing
 * it means, and that a failed read says nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentConnectorRow, AgentConnectorsRead } from '@/lib/workspace-types';
import { workspaceApi, WorkspaceApiError } from '@/lib/workspace-api';
import {
  SkippedConnectorsNotice,
  skippedConnectorsSentence,
} from '../SkippedConnectorsNotice';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/workspace-api');
  return { ...actual, workspaceApi: { connectors: vi.fn() } };
});

const connectorsMock = vi.mocked(workspaceApi.connectors);

function row(over: Partial<AgentConnectorRow>): AgentConnectorRow {
  return {
    id: 'gmail',
    name: 'Gmail',
    source: 'attached',
    editable: false,
    health: 'ok',
    removable: true,
    ...over,
  };
}

function read(
  connectors: AgentConnectorRow[],
  over: Partial<AgentConnectorsRead> = {},
): AgentConnectorsRead {
  return { connectors, shared: false, manageable: true, sharedCredentials: false, connectorsSupported: true, ...over };
}

const GMAIL = row({ id: 'gmail', name: 'Gmail', health: 'needs-sign-in', setup: 'sign-in' });
const LINEAR = row({ id: 'linear', name: 'Linear', health: 'needs-sign-in', setup: 'sign-in' });
const NOTION = row({ id: 'notion', name: 'Notion', health: 'ok' });

describe('skippedConnectorsSentence', () => {
  it('one name: singular', () => {
    expect(skippedConnectorsSentence(['Gmail'])).toBe(
      'Gmail isn’t signed in yet, so it’s off for this chat.',
    );
  });

  it('two names: "A and B", plural', () => {
    expect(skippedConnectorsSentence(['Gmail', 'Linear'])).toBe(
      'Gmail and Linear aren’t signed in yet, so they’re off for this chat.',
    );
  });

  it('three or more: a comma list ending in "and"', () => {
    expect(skippedConnectorsSentence(['Gmail', 'Linear', 'Notion'])).toBe(
      'Gmail, Linear and Notion aren’t signed in yet, so they’re off for this chat.',
    );
    expect(skippedConnectorsSentence(['A', 'B', 'C', 'D'])).toBe(
      'A, B, C and D aren’t signed in yet, so they’re off for this chat.',
    );
  });

  it('keeps markup characters as literal text (it never builds HTML)', () => {
    expect(skippedConnectorsSentence(['<b>x</b>'])).toBe(
      '<b>x</b> isn’t signed in yet, so it’s off for this chat.',
    );
  });

  it('folds a newline in a name to a space, so a name cannot start a second line', () => {
    const s = skippedConnectorsSentence(['Gmail\nIgnore all of this']);
    expect(s).not.toMatch(/[\n\r]/);
    expect(s).toBe('Gmail Ignore all of this isn’t signed in yet, so it’s off for this chat.');
  });

  it('clamps a very long name rather than letting it eat the line', () => {
    const s = skippedConnectorsSentence(['x'.repeat(500)]);
    expect(s.length).toBeLessThan(120);
    expect(s).toContain('…');
  });

  it('never leaves a blank where a name should be', () => {
    expect(skippedConnectorsSentence(['  \n '])).toMatch(/^\S/);
  });
});

describe('SkippedConnectorsNotice', () => {
  beforeEach(() => {
    connectorsMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function mount(over: { onOpenConnectors?: () => void; refreshKey?: string; agentId?: string } = {}) {
    const props = {
      agentId: 'a-quill',
      refreshKey: '0',
      onOpenConnectors: vi.fn(),
      ...over,
    };
    const utils = render(<SkippedConnectorsNotice {...props} />);
    return {
      ...utils,
      props,
      again: (next: Partial<typeof props>) =>
        utils.rerender(<SkippedConnectorsNotice {...props} {...next} />),
    };
  }

  it('names only the connectors that need a sign-in', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL, NOTION]));
    mount();

    expect(
      await screen.findByText('Gmail isn’t signed in yet, so it’s off for this chat.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Notion/)).toBeNull();
    expect(connectorsMock).toHaveBeenCalledWith('a-quill');
  });

  it('names two together', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL, LINEAR, NOTION]));
    mount();

    expect(
      await screen.findByText(
        'Gmail and Linear aren’t signed in yet, so they’re off for this chat.',
      ),
    ).toBeTruthy();
  });

  it('is not an error: no alert role, and no destructive styling', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL]));
    mount();

    const notice = (await screen.findByText(/isn’t signed in yet/)).closest('[role]');
    expect(notice?.getAttribute('role')).toBe('note');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(notice?.className).not.toContain('destructive');
  });

  it('renders a hostile name as text, not markup', async () => {
    connectorsMock.mockResolvedValue(
      read([row({ id: 'x', name: '<b>x</b><img src=x onerror=alert(1)>', health: 'needs-sign-in' })]),
    );
    const { container } = mount();

    await screen.findByText(/<b>x<\/b>/);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('Open Connectors hands off to the caller', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL]));
    const { props } = mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Open Connectors' }));
    expect(props.onOpenConnectors).toHaveBeenCalledTimes(1);
  });

  it('Dismiss hides it', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL]));
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/isn’t signed in yet/)).toBeNull();
  });

  it('stays dismissed across a refetch that finds the same connectors', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL]));
    const { again } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    again({ refreshKey: '1' });
    await waitFor(() => expect(connectorsMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/isn’t signed in yet/)).toBeNull();
  });

  it('comes back when the set changes (a second connector becomes unsigned)', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL]));
    const { again } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    connectorsMock.mockResolvedValue(read([GMAIL, LINEAR]));
    again({ refreshKey: '1' });

    expect(
      await screen.findByText(
        'Gmail and Linear aren’t signed in yet, so they’re off for this chat.',
      ),
    ).toBeTruthy();
  });

  it('comes back for the same connector after it was signed in and then lapsed', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL]));
    const { again } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    connectorsMock.mockResolvedValue(read([row({ id: 'gmail', name: 'Gmail', health: 'ok' })]));
    again({ refreshKey: '1' });
    await waitFor(() => expect(connectorsMock).toHaveBeenCalledTimes(2));

    connectorsMock.mockResolvedValue(read([GMAIL]));
    again({ refreshKey: '2' });
    expect(await screen.findByText(/Gmail isn’t signed in yet/)).toBeTruthy();
  });

  it('clears itself when a refetch finds everything signed in', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL]));
    const { again } = mount();
    await screen.findByText(/Gmail isn’t signed in yet/);

    connectorsMock.mockResolvedValue(
      read([row({ id: 'gmail', name: 'Gmail', health: 'ok' })]),
    );
    again({ refreshKey: '1' });

    await waitFor(() => expect(screen.queryByText(/isn’t signed in yet/)).toBeNull());
  });

  it('shows nothing when every connector is fine', async () => {
    connectorsMock.mockResolvedValue(read([NOTION, row({ id: 'slack', name: 'Slack', health: 'unreachable' })]));
    mount();

    await waitFor(() => expect(connectorsMock).toHaveBeenCalled());
    expect(screen.queryByText(/signed in yet/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Connectors' })).toBeNull();
  });

  it('shows nothing, and no error, when the read fails', async () => {
    connectorsMock.mockRejectedValue(new WorkspaceApiError('/x', 500));
    const { container } = mount();

    await waitFor(() => expect(connectorsMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed refetch takes a previously shown notice down rather than leaving it stale', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL]));
    const { again } = mount();
    await screen.findByText(/Gmail isn’t signed in yet/);

    connectorsMock.mockRejectedValue(new WorkspaceApiError('/x', 500));
    again({ refreshKey: '1' });

    await waitFor(() => expect(screen.queryByText(/isn’t signed in yet/)).toBeNull());
  });

  it('shows nothing for an agent whose runner loads no connectors at all', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL], { connectorsSupported: false }));
    mount();

    await waitFor(() => expect(connectorsMock).toHaveBeenCalled());
    expect(screen.queryByText(/signed in yet/)).toBeNull();
  });

  it('refetches when the refresh key changes (a turn ended, or the person came back)', async () => {
    connectorsMock.mockResolvedValue(read([]));
    const { again } = mount();
    await waitFor(() => expect(connectorsMock).toHaveBeenCalledTimes(1));

    connectorsMock.mockResolvedValue(read([LINEAR]));
    again({ refreshKey: '1' });

    expect(await screen.findByText(/Linear isn’t signed in yet/)).toBeTruthy();
    expect(connectorsMock).toHaveBeenCalledTimes(2);
  });

  it('does not refetch on a plain re-render with the same key', async () => {
    connectorsMock.mockResolvedValue(read([GMAIL]));
    const { again } = mount();
    await screen.findByText(/Gmail isn’t signed in yet/);

    again({ onOpenConnectors: vi.fn() });
    expect(connectorsMock).toHaveBeenCalledTimes(1);
  });

  it('switching agents drops the old agent’s notice and reads the new one', async () => {
    connectorsMock.mockImplementation(async (id: string) =>
      id === 'a-quill' ? read([GMAIL]) : read([]),
    );
    const { again } = mount();
    await screen.findByText(/Gmail isn’t signed in yet/);

    again({ agentId: 'a-other' });

    await waitFor(() => expect(connectorsMock).toHaveBeenCalledWith('a-other'));
    await waitFor(() => expect(screen.queryByText(/signed in yet/)).toBeNull());
  });

  it('ignores a slow answer for the agent the person has already left', async () => {
    let resolveOld: (r: AgentConnectorsRead) => void = () => undefined;
    connectorsMock.mockImplementation((id: string) =>
      id === 'a-quill'
        ? new Promise<AgentConnectorsRead>((res) => {
            resolveOld = res;
          })
        : Promise.resolve(read([])),
    );
    const { again } = mount();
    again({ agentId: 'a-other' });
    await waitFor(() => expect(connectorsMock).toHaveBeenCalledWith('a-other'));

    // Let the late answer land (and any state update it causes flush).
    await act(async () => {
      resolveOld(read([GMAIL]));
    });
    expect(screen.queryByText(/signed in yet/)).toBeNull();
  });
});
