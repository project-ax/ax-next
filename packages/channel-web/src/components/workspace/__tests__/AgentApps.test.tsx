/**
 * The Apps section of an agent's settings: linking an app with a one-time
 * code, granting it connector tools, and taking access back. The wire client
 * and the two connector hooks are stubbed; what is asserted is what a person
 * sees and what the section asks the server to do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAppsRead, AppGrant, AppLink } from '@ax/apps-bridge-contract';
import type { AgentConnectorTool } from '@/lib/workspace-types';
import { AgentApps } from '../AgentApps';
import { beforeNoon, freezeClock, thawClock } from '@/test-utils/time';
import { useHeldThroughClose } from '../use-held-through-close';

const api = vi.hoisted(() => ({
  fetchAgentApps: vi.fn(),
  mintLinkCode: vi.fn(),
  unlinkApp: vi.fn(),
  saveGrant: vi.fn(),
  removeGrant: vi.fn(),
  revokeApproval: vi.fn(),
}));

vi.mock('@/lib/agent-apps', async (original) => ({
  ...(await original<typeof import('@/lib/agent-apps')>()),
  ...api,
}));

const hooks = vi.hoisted(() => ({
  tools: [] as AgentConnectorTool[],
  manageable: true,
  connectorsStatus: 'ok' as 'ok' | 'failed',
  toolsStatus: 'ok' as 'ok' | 'failed',
  refresh: null as unknown as ReturnType<typeof vi.fn>,
  reload: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@/lib/agent-connectors', () => ({
  useAgentConnectors: () => ({
    connectors:
      hooks.connectorsStatus === 'ok'
        ? [
            { id: 'linear', name: 'Linear' },
            { id: 'github', name: 'GitHub' },
          ]
        : null,
    status: hooks.connectorsStatus,
    manageable: hooks.manageable,
    refresh: hooks.refresh,
  }),
}));

vi.mock('@/lib/agent-connector-tools', async (original) => ({
  ...(await original<typeof import('@/lib/agent-connector-tools')>()),
  useConnectorTools: (_agentId: string, connectorId: string) => ({
    data:
      hooks.toolsStatus === 'ok'
        ? {
            connector: { id: connectorId, name: connectorId, access: 'personal' },
            status: 'ok',
            checkedAt: null,
            possiblyIncomplete: false,
            tools: hooks.tools,
          }
        : null,
    status: hooks.toolsStatus,
    pending: new Set(),
    setVerdict: vi.fn(),
    reload: hooks.reload,
  }),
}));

const NS = 'c0123456789';
const key = (name: string) => `mcp.${NS}.${name}`;
const tool = (name: string, verdict: AgentConnectorTool['verdict']): AgentConnectorTool => ({
  toolKey: key(name),
  title: name,
  description: `What ${name} does`,
  readOnly: null,
  outward: null,
  verdict,
  ceiling: 'allow',
});

const GRANT: AppGrant = {
  connectorId: 'linear',
  connectorName: 'Linear',
  mode: 'builder',
  tools: [{ toolKey: key('search_issues'), name: 'search_issues' }],
};
const LINK: AppLink = {
  appId: 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6B',
  appName: 'Sprint board',
  createdAt: '2026-11-21T10:00:00.000Z',
  grants: [GRANT],
};
const CODE = 'axl_abcdefghijklmnopqrstuvwxyz234567';

function read(over: Partial<Extract<AgentAppsRead, { enabled: true }>> = {}): AgentAppsRead {
  return { enabled: true, canManage: true, links: [LINK], approvals: [], ...over };
}

async function renderApps(answer: AgentAppsRead | 'unavailable' = read()) {
  api.fetchAgentApps.mockResolvedValue(answer);
  render(<AgentApps agentId="a1" agentName="Quill" />);
  await waitFor(() => expect(screen.queryByText('Loading apps')).toBeNull());
}

beforeEach(() => {
  freezeClock();
  for (const fn of Object.values(api)) fn.mockReset();
  hooks.tools = [tool('search_issues', 'allow'), tool('create_issue', 'hold'), tool('delete_issue', 'deny')];
  hooks.manageable = true;
  hooks.connectorsStatus = 'ok';
  hooks.toolsStatus = 'ok';
  hooks.refresh = vi.fn(async () => null);
  hooks.reload = vi.fn();
});

afterEach(() => {
  thawClock();
  vi.unstubAllGlobals();
});

describe('AgentApps', () => {
  it('bridge off: an honest empty state and no controls', async () => {
    await renderApps({ enabled: false });
    expect(screen.getByText("The apps platform isn't set up here")).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  });

  it('a server without the Apps routes reads the same as bridge off', async () => {
    await renderApps('unavailable');
    expect(screen.getByText("The apps platform isn't set up here")).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it("lists linked apps by name with each grant's connector, mode and tools", async () => {
    const viewerGrant: AppGrant = {
      connectorId: 'github',
      connectorName: 'GitHub',
      mode: 'viewer',
      tools: [
        { toolKey: key('list_prs'), name: 'list_prs' },
        { toolKey: key('get_pr'), name: 'get_pr' },
      ],
    };
    await renderApps(read({ links: [{ ...LINK, grants: [GRANT, viewerGrant] }] }));
    const list = screen.getByRole('list', { name: 'Apps that use this agent' });
    const app = within(list).getByRole('listitem', { name: 'Sprint board' });
    expect(within(app).getByText(LINK.appId)).toBeTruthy();
    expect(within(app).getByText('Linear')).toBeTruthy();
    expect(within(app).getByText("This agent's sign-in")).toBeTruthy();
    expect(within(app).getByText('search_issues')).toBeTruthy();
    expect(within(app).getByText('GitHub')).toBeTruthy();
    expect(within(app).getByText("Each viewer's sign-in")).toBeTruthy();
    expect(within(app).getByText('list_prs, get_pr')).toBeTruthy();
  });

  it('renders an app name as text, never as markup', async () => {
    const name = '<img src=x onerror="alert(1)">Board';
    await renderApps(read({ links: [{ ...LINK, appName: name }] }));
    expect(screen.getByText(name)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('a person who cannot manage sees the list read-only', async () => {
    await renderApps(read({ canManage: false }));
    expect(screen.getByText('Sprint board')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Link an app' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Unlink/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add a connector/ })).toBeNull();
  });

  it('Link an app shows a one-time code with Copy and its expiry; there is no app id field', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    api.mintLinkCode.mockResolvedValue({ code: CODE, expiresAt: beforeNoon(-10 * 60_000) });
    await renderApps(read({ links: [] }));
    expect(screen.queryByLabelText(/app id/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Link an app' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.mintLinkCode).toHaveBeenCalledWith('a1');
    const code = within(dialog).getByRole('textbox', { name: 'Link code' });
    expect(code).toHaveValue(CODE);
    expect(code).toHaveAttribute('readonly');
    // The only field: there is nowhere to type an app id.
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    expect(within(dialog).queryByLabelText(/app id/i)).toBeNull();
    // Ten minutes past the frozen local noon, the same day: the clock alone.
    const expiry = '12:10 PM';
    expect(dialog).toHaveTextContent(
      `Give this code to your apps platform, or to the agent building the app. It works once, until ${expiry}.`,
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE));

    api.fetchAgentApps.mockClear();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Done' })[0]!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.fetchAgentApps).toHaveBeenCalledWith('a1');
    // Shown once: gone from the page once the dialog closes.
    expect(screen.queryByDisplayValue(CODE)).toBeNull();
  });

  it('a refused mint says so and opens no dialog', async () => {
    const { AgentAppsError } = await import('@/lib/agent-apps');
    api.mintLinkCode.mockRejectedValue(new AgentAppsError(403, 'forbidden'));
    await renderApps(read({ links: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Link an app' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('only Allow tools can be granted; Ask first and Deny tools say why', async () => {
    api.saveGrant.mockResolvedValue(GRANT);
    await renderApps();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Linear for Sprint board' }));
    const dialog = await screen.findByRole('dialog');

    const allowed = within(dialog).getByRole('checkbox', { name: 'search_issues' });
    const asks = within(dialog).getByRole('checkbox', { name: 'create_issue' });
    const denied = within(dialog).getByRole('checkbox', { name: 'delete_issue' });
    expect(allowed).toBeEnabled();
    expect(allowed).toBeChecked();
    expect(asks).toBeDisabled();
    expect(denied).toBeDisabled();
    expect(within(dialog).getByText("Asks first, so apps can't use it. Set it to Allow under Connectors.")).toBeTruthy();
    expect(within(dialog).getByText("Set to Deny under Connectors, so apps can't use it.")).toBeTruthy();
    // Not granted and not Allow: it can't be ticked, by a click either.
    expect(asks).not.toBeChecked();
    fireEvent.click(asks);
    expect(asks).not.toBeChecked();
    // Untrusted tool descriptions are text.
    expect(within(dialog).getByText('What search_issues does')).toBeTruthy();

    // The connector is fixed while editing.
    expect(within(dialog).getByRole('combobox', { name: 'Connector' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('radio', { name: "Each viewer's own sign-in, after they say yes" }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveGrant).toHaveBeenCalledWith('a1', {
        appId: LINK.appId,
        connectorId: 'linear',
        mode: 'viewer',
        toolKeys: [key('search_issues')],
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('adds a connector to an app: pick one not yet granted, a mode and its Allow tools', async () => {
    api.saveGrant.mockResolvedValue(GRANT);
    await renderApps();
    fireEvent.click(screen.getByRole('button', { name: 'Add a connector to Sprint board' }));
    const dialog = await screen.findByRole('dialog');
    // Nothing to tick until a connector is chosen, and nothing to save.
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Connector' }), { key: 'ArrowDown' });
    // Linear is already granted to this app: Edit is the way to change it.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['GitHub']);
    fireEvent.click(screen.getByRole('option', { name: 'GitHub' }));

    const box = within(dialog).getByRole('checkbox', { name: 'search_issues' });
    expect(box).not.toBeChecked();
    expect(within(dialog).getByRole('radio', { name: "This agent's sign-in" })).toBeChecked();
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveGrant).toHaveBeenCalledWith('a1', {
        appId: LINK.appId,
        connectorId: 'github',
        mode: 'builder',
        toolKeys: [key('search_issues')],
      }),
    );
  });

  it('a granted tool the connector no longer offers is marked', async () => {
    const stale: AppGrant = { ...GRANT, tools: [...GRANT.tools, { toolKey: key('old_tool'), name: 'old_tool' }] };
    await renderApps(read({ links: [{ ...LINK, grants: [stale] }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Linear for Sprint board' }));
    const dialog = await screen.findByRole('dialog');
    const row = within(dialog).getByText('old_tool').closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('No longer offered. Saving removes it.')).toBeTruthy();
    expect(within(row as HTMLElement).queryByRole('checkbox')).toBeNull();
  });

  it('saving a mode change keeps a granted tool that has since become Ask first', async () => {
    api.saveGrant.mockResolvedValue(GRANT);
    const held: AppGrant = { ...GRANT, tools: [...GRANT.tools, { toolKey: key('create_issue'), name: 'create_issue' }] };
    await renderApps(read({ links: [{ ...LINK, grants: [held] }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Linear for Sprint board' }));
    const dialog = await screen.findByRole('dialog');

    const asks = within(dialog).getByRole('checkbox', { name: 'create_issue' });
    expect(asks).toBeChecked();
    expect(asks).toBeEnabled();
    expect(
      within(dialog).getByText("Still given to this app, but it won't work until it's set to Allow under Connectors."),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('radio', { name: "Each viewer's own sign-in, after they say yes" }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveGrant).toHaveBeenCalledWith('a1', {
        appId: LINK.appId,
        connectorId: 'linear',
        mode: 'viewer',
        toolKeys: [key('search_issues'), key('create_issue')],
      }),
    );
  });

  it('a granted tool that is no longer Allow can be unticked, but not ticked again', async () => {
    const held: AppGrant = { ...GRANT, tools: [{ toolKey: key('create_issue'), name: 'create_issue' }] };
    await renderApps(read({ links: [{ ...LINK, grants: [held] }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Linear for Sprint board' }));
    const dialog = await screen.findByRole('dialog');
    // Only that tool, and it isn't Allow: Save still works for a mode-only change.
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();

    const asks = within(dialog).getByRole('checkbox', { name: 'create_issue' });
    fireEvent.click(asks);
    expect(asks).not.toBeChecked();
    expect(asks).toBeDisabled();
    expect(within(dialog).getByText("Asks first, so apps can't use it. Set it to Allow under Connectors.")).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it("the editor says when the agent's connectors or a connector's tools can't be read, and retries", async () => {
    hooks.connectorsStatus = 'failed';
    await renderApps();
    fireEvent.click(screen.getByRole('button', { name: 'Add a connector to Sprint board' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText("We couldn't load this agent's connectors.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(hooks.refresh).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    hooks.connectorsStatus = 'ok';
    hooks.toolsStatus = 'failed';
    fireEvent.click(screen.getByRole('button', { name: 'Edit Linear for Sprint board' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText("We couldn't list this connector's tools just now.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(hooks.reload).toHaveBeenCalled();
  });

  it("while an app is being unlinked, nothing else on its row can start", async () => {
    let finish: () => void = () => {};
    api.unlinkApp.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    await renderApps();
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Sprint board' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(api.unlinkApp).toHaveBeenCalled());
    for (const name of ['Add a connector to Sprint board', 'Edit Linear for Sprint board', 'Remove Linear from Sprint board']) {
      expect(screen.getByRole('button', { name, hidden: true })).toBeDisabled();
    }
    await act(async () => finish());
  });

  it('removes a grant and unlinks an app only after confirming', async () => {
    api.removeGrant.mockResolvedValue(undefined);
    api.unlinkApp.mockResolvedValue(undefined);
    await renderApps();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Linear from Sprint board' }));
    const removeDialog = await screen.findByRole('dialog', { name: 'Remove Linear from Sprint board?' });
    expect(api.removeGrant).not.toHaveBeenCalled();
    fireEvent.click(within(removeDialog).getByRole('button', { name: 'Remove connector' }));
    await waitFor(() => expect(api.removeGrant).toHaveBeenCalledWith('a1', LINK.appId, 'linear'));
    expect(api.removeGrant).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Unlink Sprint board' }));
    const dialog = await screen.findByRole('dialog');
    expect(api.unlinkApp).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(api.unlinkApp).toHaveBeenCalledWith('a1', LINK.appId));
  });

  it('after an unlink whose re-read lands later, focus parks on "Link an app", not <body>', async () => {
    api.unlinkApp.mockResolvedValue(undefined);
    await renderApps();
    // The re-read after the unlink answers a moment later, with the app gone.
    api.fetchAgentApps.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(read({ links: [] })), 150)),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Sprint board' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unlink Sprint board' })).toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Link an app' })), { timeout: 3000 });
  });

  it("shows only the person's own approvals, each with Revoke", async () => {
    api.revokeApproval.mockResolvedValue(undefined);
    await renderApps(
      read({
        canManage: false,
        links: [],
        approvals: [
          { appId: LINK.appId, appName: 'Sprint board', connectorId: 'linear', connectorName: 'Linear', createdAt: LINK.createdAt },
        ],
      }),
    );
    const list = screen.getByRole('list', { name: "Apps using this agent's sign-ins as you" });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Sprint board');
    expect(rows[0]).toHaveTextContent('Linear');
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Revoke Sprint board using Linear' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke this permission?' });
    expect(api.revokeApproval).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.revokeApproval).toHaveBeenCalledWith('a1', LINK.appId, 'linear'));
    expect(api.revokeApproval).toHaveBeenCalledTimes(1);
  });

  it('with no approvals, the approvals list is not drawn', async () => {
    await renderApps();
    expect(screen.queryByRole('list', { name: "Apps using this agent's sign-ins as you" })).toBeNull();
  });

  it('a dialog keeps drawing its last value until its close has finished, then lets go', () => {
    const { result, rerender } = renderHook(({ v }: { v: string | null }) => useHeldThroughClose(v), {
      initialProps: { v: 'axl_code' as string | null },
    });
    expect(result.current.held).toBe('axl_code');
    rerender({ v: null });
    expect(result.current.held).toBe('axl_code');
    act(() => result.current.release());
    expect(result.current.held).toBeNull();
    rerender({ v: 'next' });
    expect(result.current.held).toBe('next');
  });

  it('uses no raw colours', () => {
    for (const file of ['AgentApps.tsx', 'AgentAppsRows.tsx', 'AppGrantEditor.tsx', 'AppLinkCodeDialog.tsx']) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8')
        // Comments may name the colours they avoid.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src).not.toMatch(/\b(?:bg|text|border|ring|fill|stroke)-(?:red|orange|amber|yellow|green|blue|sky|indigo|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|black|white)\b/);
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/\brgb\(|\bhsl\(/);
    }
  });
});
