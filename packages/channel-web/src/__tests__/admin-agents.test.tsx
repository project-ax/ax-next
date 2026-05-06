/**
 * Admin agents form — Task 22.
 *
 * Covers the AdminPanel chrome + AgentForm CRUD flow against the real
 * `/admin/agents` wire shape (camelCase: displayName / systemPrompt /
 * allowedTools / mcpConfigIds / model / visibility / teamId / ...).
 *
 *   1. Opening with `view="agents"` lists existing agents from
 *      `/admin/agents` and renders their displayName.
 *   2. Clicking "+ New agent" reveals the form (name, system prompt, etc.).
 *   3. Filling + submitting the form POSTs to `/admin/agents` with the
 *      camelCase shape AND the `X-Requested-With: ax-admin` CSRF header.
 *   4. Clicking "edit" on a row populates the form WITHOUT throwing —
 *      regression for a TypeError that happened when the form read
 *      snake_case (`a.allowed_tools.join`) against the camelCase wire.
 *   5. Clicking the close (×) button calls `onClose`.
 *
 * The PATCH/DELETE rows share the same fetch round-trip + re-fetch shape
 * as POST, so the "create" + "edit" paths cover most of the wiring. The
 * delete path is also exercised explicitly to assert the CSRF header
 * (regression for a 403 caused by the missing X-Requested-With).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminPanel } from '../components/admin/AdminPanel';
import { UserProvider } from '../lib/user-context';

const adminUser = {
  id: 'u1',
  email: 'admin@local',
  name: 'Admin',
  role: 'admin' as const,
};
const fetchMock = vi.fn();

const sampleAgent = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'agt-1',
  ownerId: 'usr-1',
  ownerType: 'user',
  visibility: 'personal',
  displayName: 'ax',
  systemPrompt: 'be helpful',
  allowedTools: ['bash'],
  mcpConfigIds: [],
  model: 'claude-sonnet-4-6',
  workspaceRef: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('AdminPanel — agents', () => {
  it('lists existing agents on open', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [sampleAgent({ displayName: 'ax' })] }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('ax')).toBeTruthy();
    });
  });

  it('clicking + New agent reveals the form', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [] }),
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ teams: [], servers: [] }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));
    expect(screen.getByLabelText(/name/i)).toBeTruthy();
    expect(screen.getByLabelText(/system prompt/i)).toBeTruthy();
  });

  it('submitting the form POSTs to /admin/agents with camelCase + CSRF header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [] }),
    });
    // teams + mcp lookup on form open
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ teams: [] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ servers: [] }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agent: sampleAgent({ id: 'agent-x' }) }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [] }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));
    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: 'new-bot' },
    });
    fireEvent.change(screen.getByLabelText(/system prompt/i), {
      target: { value: 'be helpful' },
    });
    fireEvent.change(screen.getByLabelText(/allowed tools/i), {
      target: { value: 'bash' },
    });
    fireEvent.click(screen.getByText(/Save/i));
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
      expect(body.systemPrompt).toBe('be helpful');
      expect(body.allowedTools).toEqual(['bash']);
      expect(body.mcpConfigIds).toEqual([]);
      expect(body.visibility).toBe('personal');
      const headers = opts.headers as Record<string, string>;
      expect(headers['x-requested-with']).toBe('ax-admin');
    });
  });

  it('clicking edit populates the form from the camelCase wire shape (regression)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        agents: [
          sampleAgent({
            displayName: 'probe',
            systemPrompt: 'reply ok',
            allowedTools: ['bash', 'read_file'],
            mcpConfigIds: ['gh'],
          }),
        ],
      }),
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ teams: [], servers: [] }),
    });
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText('probe'));
    // Before the fix this threw "Cannot read properties of undefined
    // (reading 'join')" inside formFromAgent because the form read
    // snake_case (allowed_tools) on a camelCase wire object.
    fireEvent.click(screen.getByText(/^edit$/i));
    const nameInput = screen.getByLabelText(/name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('probe');
    const tools = screen.getByLabelText(/allowed tools/i) as HTMLInputElement;
    expect(tools.value).toBe('bash, read_file');
    const mcps = screen.getByLabelText(/MCP servers/i) as HTMLInputElement;
    expect(mcps.value).toBe('gh');
  });

  it('delete sends DELETE with X-Requested-With: ax-admin (CSRF regression)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [sampleAgent({ id: 'agt-1', displayName: 'probe' })] }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [] }),
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={() => {}} />
      </UserProvider>,
    );
    await waitFor(() => screen.getByText('probe'));
    fireEvent.click(screen.getByText(/^delete$/i));
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

  it('clicking close calls onClose', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [] }),
    });
    const onClose = vi.fn();
    render(
      <UserProvider value={adminUser}>
        <AdminPanel view="agents" onClose={onClose} />
      </UserProvider>,
    );
    // Wait for the initial /admin/agents fetch to settle so the list
    // (or empty state) is in the DOM before we click close. Otherwise we
    // race the unmount against the pending state update and React logs
    // an act() warning.
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByLabelText(/close/i));
    expect(onClose).toHaveBeenCalled();
  });
});
