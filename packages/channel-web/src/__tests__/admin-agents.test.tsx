/**
 * Admin agents form — Task 22.
 *
 * Covers AgentForm CRUD flow against the real `/admin/agents` wire shape
 * (camelCase: displayName / allowedTools / mcpConfigIds / model / visibility /
 * teamId / ...). TASK-142: the agent's identity lives in its `.ax/` files,
 * edited via the file editor + a separate PUT to /admin/agents/:id/identity —
 * not a `systemPrompt` field on this wire.
 *
 * TASK-98/107: the raw `mcpConfigIds` chip field was replaced by a connector
 * PICKER (a checkbox list over `/admin/connectors`). TASK-107 — selected
 * connector ids are now saved to the FIRST-CLASS per-agent connector-attachment
 * store (PATCH /admin/agents/:id/connector-attachments) AFTER the agent
 * create/PATCH, NOT into `mcpConfigIds` (which reverts to MCP-only meaning and
 * is sent as []).
 *
 * Strategy: render AgentForm directly (no shell wrapper) for all content
 * tests. AdminShell (wrapped in UserProvider) is used only for the
 * "Back to chat" shell-behavior test.
 *
 *   1. AgentForm lists existing agents from `/admin/agents` and renders
 *      their displayName.
 *   2. Clicking "+ New agent" reveals the form (name, identity files, etc.).
 *   3. Filling + submitting the form POSTs to `/admin/agents` with the
 *      camelCase shape AND the `X-Requested-With: ax-admin` CSRF header.
 *   4. Clicking "edit" on a row populates the form WITHOUT throwing —
 *      regression for a TypeError that happened when the form read
 *      snake_case (`a.allowed_tools.join`) against the camelCase wire.
 *   5. Clicking the "← chat" button in AdminSidebar calls `onClose`
 *      (AdminShell-level test, not AgentForm-level).
 *
 * The PATCH/DELETE rows share the same fetch round-trip + re-fetch shape
 * as POST, so the "create" + "edit" paths cover most of the wiring. The
 * delete path is also exercised explicitly to assert the CSRF header
 * (regression for a 403 caused by the missing X-Requested-With).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { AgentForm } from '../components/admin/AgentForm';
import { AdminShell } from '../components/admin/AdminShell';
import { UserProvider } from '../lib/user-context';
import type { AuthUser } from '../lib/auth';

const fetchMock = vi.fn();

const mockUser: AuthUser = {
  id: 'usr-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'admin',
};

const sampleAgent = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'agt-1',
  ownerId: 'usr-1',
  ownerType: 'user',
  visibility: 'personal',
  displayName: 'ax',
  allowedTools: ['bash'],
  mcpConfigIds: [],
  connectorAttachments: [],
  model: 'claude-sonnet-4-6',
  workspaceRef: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Default: stub all fetches with empty responses.
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      jsonOk({ providers: [], agents: [], teams: [], connectors: [] }),
    ),
  );
});

describe('AdminSettings — agents tab', () => {
  it('lists existing agents on open', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ agents: [sampleAgent({ displayName: 'ax' })] }));

    render(<AgentForm isAdmin />);
    await waitFor(() => {
      expect(screen.getByText('ax')).toBeTruthy();
    });
  });

  it('clicking + New agent reveals the form', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue(jsonOk({ agents: [], teams: [], connectors: [] }));

    render(<AgentForm isAdmin />);
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));
    expect(screen.getByLabelText(/name/i)).toBeTruthy();
    // TASK-142: the single "system prompt" textarea is replaced by the
    // file-based identity editor (Identity / Soul / Operating instructions).
    expect(screen.getByLabelText('Identity')).toBeTruthy();
    expect(screen.getByLabelText('Soul')).toBeTruthy();
    expect(screen.getByLabelText(/Operating instructions/)).toBeTruthy();
  });

  it('submitting the form POSTs to /admin/agents with camelCase + CSRF header', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // agents list on mount
    fetchMock.mockResolvedValueOnce(jsonOk({ agents: [] }));
    // teams + connectors lookup on form open
    fetchMock.mockResolvedValueOnce(jsonOk({ teams: [] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ connectors: [] }));
    // POST response (returns the created agent w/ its id)
    fetchMock.mockResolvedValueOnce(jsonOk({ agent: sampleAgent({ id: 'agent-x' }) }));
    // TASK-107 — connector-attachments PATCH after create
    fetchMock.mockResolvedValueOnce(jsonOk({ agent: sampleAgent({ id: 'agent-x' }) }));
    // TASK-142 — identity PUT after create
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true }));
    // re-fetch agents after save
    fetchMock.mockResolvedValueOnce(jsonOk({ agents: [] }));

    render(<AgentForm isAdmin />);
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));
    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: 'new-bot' },
    });
    // TASK-142: identity is authored via the file editor (Identity / Soul), not
    // a single "system prompt" field — and saved via a separate PUT (below).
    fireEvent.change(screen.getByLabelText('Identity'), {
      target: { value: 'I am new-bot.' },
    });
    fireEvent.change(screen.getByLabelText('Soul'), {
      target: { value: 'I am helpful.' },
    });
    fireEvent.change(screen.getByLabelText(/allowed tools/i), {
      target: { value: 'bash' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const post = calls.find(
        ([url, opts]) =>
          url === '/admin/agents' &&
          (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const opts = post?.[1] as RequestInit;
      const body = JSON.parse(String(opts.body));
      expect(body.displayName).toBe('new-bot');
      // TASK-142: the POST body no longer carries systemPrompt — identity is a
      // separate PUT (asserted below).
      expect(body.systemPrompt).toBeUndefined();
      expect(body.allowedTools).toEqual(['bash']);
      // TASK-107 — connectors no longer ride mcpConfigIds (MCP-only meaning).
      expect(body.mcpConfigIds).toEqual([]);
      expect(body.visibility).toBe('personal');
      const headers = opts.headers as Record<string, string>;
      expect(headers['x-requested-with']).toBe('ax-admin');
    });
    // TASK-142: the identity files are PUT to /admin/agents/:id/identity after
    // the agent is created.
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([url, opts]) =>
          String(url) === '/admin/agents/agent-x/identity' &&
          (opts as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.identity).toBe('I am new-bot.');
      expect(body.soul).toBe('I am helpful.');
      expect(body.operating).toBe('');
    });
    // TASK-107 — the connector-attachments PATCH was issued against the new id.
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, opts]) =>
          String(url) === '/admin/agents/agent-x/connector-attachments' &&
          (opts as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(String((patch![1] as RequestInit).body));
      // No connectors were checked in this test → empty attachment list.
      expect(body.connectorAttachments).toEqual([]);
    });
  });

  it('TASK-107: saving with a connector checked PATCHes the connector-attachment store with the id', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (/\/admin\/connectors(\?|$)/.test(url)) {
        return Promise.resolve(
          jsonOk({
            connectors: [
              {
                id: 'gh',
                name: 'GitHub',
                description: '',
                usageNote: '',
                keyMode: 'personal',
                visibility: 'private',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (url === '/admin/agents' && method === 'POST') {
        return Promise.resolve(jsonOk({ agent: sampleAgent({ id: 'agent-y' }) }));
      }
      if (/connector-attachments/.test(url)) {
        return Promise.resolve(jsonOk({ agent: sampleAgent({ id: 'agent-y' }) }));
      }
      if (/\/admin\/teams(\?|$)/.test(url)) return Promise.resolve(jsonOk({ teams: [] }));
      return Promise.resolve(jsonOk({ agents: [] }));
    });

    render(<AgentForm isAdmin />);
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'cbot' } });
    fireEvent.change(screen.getByLabelText(/allowed tools/i), {
      target: { value: 'bash' },
    });
    // Check the GitHub connector.
    const ghCheckbox = await screen.findByRole('checkbox', { name: /Attach GitHub/i });
    fireEvent.click(ghCheckbox);
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, opts]) =>
          String(url) === '/admin/agents/agent-y/connector-attachments' &&
          (opts as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse(String((patch![1] as RequestInit).body));
      expect(body.connectorAttachments).toEqual(['gh']);
    });
  });

  it('clicking edit populates the form + pre-checks the attached connector', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        agents: [
          sampleAgent({
            displayName: 'probe',
            allowedTools: ['bash', 'read_file'],
            // TASK-107 — the attached connector lives in the first-class store now.
            connectorAttachments: ['gh'],
          }),
        ],
      }),
    );
    // Form-open lookups: teams + the connector list. `gh` is the attached
    // connector — its checkbox must render checked. The edit view also renders
    // SkillAttachmentsSection (fetches /admin/skills) + AuthoredSkillsSection
    // (fetches authored-skills); return empty shapes so neither crashes.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/admin\/connectors(\?|$)/.test(url)) {
        return Promise.resolve(
          jsonOk({
            connectors: [
              {
                id: 'gh',
                name: 'GitHub',
                description: '',
                usageNote: '',
                keyMode: 'personal',
                visibility: 'private',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (/\/admin\/skills(\?|$)/.test(url)) return Promise.resolve(jsonOk({ skills: [] }));
      if (/authored-skills/.test(url)) return Promise.resolve(jsonOk({ skills: [] }));
      // TASK-142 — the edit view loads the agent's `.ax/` identity files.
      if (/\/identity$/.test(url)) {
        return Promise.resolve(jsonOk({ identity: 'I am probe.', soul: '', operating: '' }));
      }
      return Promise.resolve(jsonOk({ teams: [] }));
    });

    render(<AgentForm isAdmin />);
    await waitFor(() => screen.getByText('probe'));
    // Before the camelCase fix this threw "Cannot read properties of
    // undefined (reading 'join')" inside formFromAgent.
    fireEvent.click(screen.getByText(/^edit$/i));
    const nameInput = screen.getByLabelText(/name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('probe');
    const tools = screen.getByLabelText(/allowed tools/i) as HTMLInputElement;
    expect(tools.value).toBe('bash, read_file');
    // The attached connector `gh` renders pre-checked in the picker.
    const ghCheckbox = await screen.findByRole('checkbox', { name: /Attach GitHub/i });
    expect(ghCheckbox.getAttribute('data-state')).toBe('checked');
  });

  it('delete sends DELETE with X-Requested-With: ax-admin (CSRF regression)', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(
      jsonOk({ agents: [sampleAgent({ id: 'agt-1', displayName: 'probe' })] }),
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(jsonOk({ agents: [] }));

    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<AgentForm isAdmin />);
    await waitFor(() => screen.getByText('probe'));
    fireEvent.click(screen.getByText(/^delete$/i));

    // A styled dialog gates the delete — no OS confirm.
    const dialog = await screen.findByRole('dialog');
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/i }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        ([url, opts]) =>
          String(url).includes('/admin/agents/agt-1') &&
          (opts as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(del).toBeTruthy();
      const headers = (del?.[1] as RequestInit).headers as Record<string, string>;
      expect(headers['x-requested-with']).toBe('ax-admin');
    });
    confirmSpy.mockRestore();
  });

  it('clicking Back to chat calls onClose', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // ProvidersPanel (default tab) hits /admin/credentials → { credentials: [] }.
    // Other requests (providers, agents, etc.) get the generic empty response.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/admin\/credentials(\?|$)/.test(url) || /\/settings\/credentials(\?|$)/.test(url)) {
        return Promise.resolve(jsonOk({ credentials: [] }));
      }
      // SkillsTab (the default tab) lists the user's skills on mount.
      if (/\/settings\/skills(\/authored)?(\?|$)/.test(url)) {
        return Promise.resolve(jsonOk({ skills: [] }));
      }
      if (/\/api\/chat\/agents(\?|$)/.test(url)) {
        return Promise.resolve(jsonOk([]));
      }
      return Promise.resolve(jsonOk({ providers: [] }));
    });

    const onClose = vi.fn();
    render(
      <UserProvider value={mockUser}>
        <AdminShell isAdmin onClose={onClose} />
      </UserProvider>,
    );
    // AdminSidebar's back button has text "chat" (with a ChevronLeft icon).
    fireEvent.click(screen.getByRole('button', { name: /^chat$/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
