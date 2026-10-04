/**
 * TASK-854 — the team-key dialog says whether each slot has a key, and lets a
 * team admin remove one (inline confirm) or replace it.
 *
 * Pinned:
 *   - "Key saved" / "No key" per slot, from `workspaceApi.getTeamKeys`;
 *   - the key itself never reaches the DOM — not after a save, not ever;
 *   - Remove asks first, then calls `removeTeamKey` with the slot, flips the
 *     slot to "No key" and tells the caller (`onRemoved`);
 *   - a refused remove shows why and leaves the key "saved";
 *   - a status read that fails says so, with no badge and no Remove.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { workspaceApi, TEAM_KEY_FORBIDDEN } from '@/lib/workspace-api';
import { HttpError } from '@/lib/http';
import * as connectorsLib from '@/lib/connectors';
import type { Connector } from '@/lib/connectors';
import { TeamKeyDialog } from '../TeamKeyDialog';

vi.mock('@/lib/workspace-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workspace-api')>('@/lib/workspace-api');
  return {
    ...actual,
    workspaceApi: {
      setTeamKey: vi.fn(),
      getTeamKeys: vi.fn(),
      removeTeamKey: vi.fn(),
    },
  };
});

vi.mock('@/lib/connectors', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/connectors');
  return { ...actual, getConnector: vi.fn() };
});

const ACME: Connector = {
  id: 'acme',
  name: 'Acme',
  description: '',
  usageNote: '',
  keyMode: 'personal',
  visibility: 'shared',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  capabilities: {
    ...connectorsLib.emptyCapabilities(),
    credentials: [
      { slot: 'ACME_KEY', kind: 'api-key' },
      { slot: 'ACME_SECRET', kind: 'api-key' },
    ],
  },
};

const getTeamKeys = vi.mocked(workspaceApi.getTeamKeys);
const removeTeamKey = vi.mocked(workspaceApi.removeTeamKey);
const setTeamKey = vi.mocked(workspaceApi.setTeamKey);

function renderDialog(over: { onSaved?: () => void; onRemoved?: () => void } = {}) {
  const onSaved = over.onSaved ?? vi.fn();
  const onRemoved = over.onRemoved ?? vi.fn();
  render(
    <TeamKeyDialog
      agentId="a-quill"
      agentName="Quill"
      connectorId="acme"
      connectorName="Acme"
      isAdmin={false}
      open
      onOpenChange={vi.fn()}
      onSaved={onSaved}
      onRemoved={onRemoved}
    />,
  );
  return { onSaved, onRemoved };
}

async function slotGroup(slot: string) {
  return screen.findByRole('group', { name: new RegExp(slot) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connectorsLib.getConnector).mockResolvedValue(ACME);
});

describe('TeamKeyDialog — saved state (TASK-854)', () => {
  it('is titled "Team key" and shows Key saved / No key per slot', async () => {
    getTeamKeys.mockResolvedValue([
      { slot: 'ACME_KEY', saved: true },
      { slot: 'ACME_SECRET', saved: false },
    ]);
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Team key' })).toBeTruthy();
    expect(getTeamKeys).toHaveBeenCalledWith('a-quill', 'acme');
    const saved = await slotGroup('ACME_KEY');
    expect(await within(saved).findByText('Key saved')).toBeTruthy();
    expect(within(saved).getByRole('button', { name: 'Remove key' })).toBeTruthy();
    expect(within(saved).getByRole('button', { name: 'Replace' })).toBeTruthy();
    const unsaved = await slotGroup('ACME_SECRET');
    expect(within(unsaved).getByText('No key')).toBeTruthy();
    expect(within(unsaved).queryByRole('button', { name: 'Remove key' })).toBeNull();
  });

  it('a save flips the slot to Key saved, clears the field, and never puts the key in the DOM', async () => {
    const SECRET = 'sk-acme-TOPSECRET-9f2';
    getTeamKeys.mockResolvedValue([
      { slot: 'ACME_KEY', saved: false },
      { slot: 'ACME_SECRET', saved: false },
    ]);
    setTeamKey.mockResolvedValue(undefined);
    const { onSaved } = renderDialog();
    const group = await slotGroup('ACME_KEY');
    await within(group).findByText('No key');
    const input = within(group).getByLabelText(/^(replace )?api key$/i) as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.submit(input.closest('form')!);

    expect(await within(group).findByText('Key saved')).toBeTruthy();
    expect(setTeamKey).toHaveBeenCalledWith('a-quill', 'acme', 'ACME_KEY', SECRET);
    expect((within(group).getByLabelText(/^(replace )?api key$/i) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText(new RegExp(SECRET))).toBeNull();
    expect(document.body.innerHTML).not.toContain(SECRET);
    // One of two slots: the dialog stays open.
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes once every slot has a key — counting keys saved before', async () => {
    getTeamKeys.mockResolvedValue([
      { slot: 'ACME_KEY', saved: true },
      { slot: 'ACME_SECRET', saved: false },
    ]);
    setTeamKey.mockResolvedValue(undefined);
    const { onSaved } = renderDialog();
    const group = await slotGroup('ACME_SECRET');
    await within(group).findByText('No key');
    const input = within(group).getByLabelText(/^(replace )?api key$/i);
    fireEvent.change(input, { target: { value: 'k2' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});

describe('TeamKeyDialog — Remove (TASK-854)', () => {
  it('asks first; Cancel keeps the key and calls nothing', async () => {
    getTeamKeys.mockResolvedValue([
      { slot: 'ACME_KEY', saved: true },
      { slot: 'ACME_SECRET', saved: false },
    ]);
    renderDialog();
    const group = await slotGroup('ACME_KEY');
    fireEvent.click(await within(group).findByRole('button', { name: 'Remove key' }));
    expect(within(group).getByText(/Remove this team key\?/)).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(within(group).getByText('Key saved')).toBeTruthy();
    expect(removeTeamKey).not.toHaveBeenCalled();
  });

  it('Remove calls removeTeamKey with the slot, shows No key, and calls onRemoved', async () => {
    getTeamKeys.mockResolvedValue([
      { slot: 'ACME_KEY', saved: true },
      { slot: 'ACME_SECRET', saved: false },
    ]);
    removeTeamKey.mockResolvedValue(undefined);
    const { onRemoved } = renderDialog();
    const group = await slotGroup('ACME_KEY');
    fireEvent.click(await within(group).findByRole('button', { name: 'Remove key' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Remove' }));
    expect(await within(group).findByText('No key')).toBeTruthy();
    expect(removeTeamKey).toHaveBeenCalledWith('a-quill', 'acme', 'ACME_KEY');
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(within(group).queryByRole('button', { name: 'Remove key' })).toBeNull();
    expect(within(group).getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('a refused remove shows why and the key stays saved', async () => {
    getTeamKeys.mockResolvedValue([
      { slot: 'ACME_KEY', saved: true },
      { slot: 'ACME_SECRET', saved: false },
    ]);
    removeTeamKey.mockRejectedValue(new HttpError('/x', 403, TEAM_KEY_FORBIDDEN));
    const { onRemoved } = renderDialog();
    const group = await slotGroup('ACME_KEY');
    fireEvent.click(await within(group).findByRole('button', { name: 'Remove key' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Remove' }));
    expect(await within(group).findByText(TEAM_KEY_FORBIDDEN)).toBeTruthy();
    expect(within(group).getByText('Key saved')).toBeTruthy();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('a status read that fails says so, with no badge and no Remove — saving still works', async () => {
    getTeamKeys.mockRejectedValue(new HttpError('/x', 503));
    renderDialog();
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText('We couldn’t check whether a team key is saved.'),
    ).toBeTruthy();
    const group = await slotGroup('ACME_KEY');
    expect(within(dialog).queryByText('Key saved')).toBeNull();
    expect(within(dialog).queryByText('No key')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Remove key' })).toBeNull();
    expect(within(group).getByLabelText(/^(replace )?api key$/i)).toBeTruthy();
  });
});
