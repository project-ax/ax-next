/**
 * Admin agents form — Task 22.
 *
 * Covers the AdminSettings shell + AgentForm CRUD flow against the real
 * `/admin/agents` wire shape (camelCase: displayName / systemPrompt /
 * allowedTools / mcpConfigIds / model / visibility / teamId / ...).
 *
 * Strategy: render AdminSettings, navigate to the Agents tab, then assert
 * the same behavioral coverage as before.
 *
 *   1. Navigating to the "Agents" tab lists existing agents from
 *      `/admin/agents` and renders their displayName.
 *   2. Clicking "+ New agent" reveals the form (name, system prompt, etc.).
 *   3. Filling + submitting the form POSTs to `/admin/agents` with the
 *      camelCase shape AND the `X-Requested-With: ax-admin` CSRF header.
 *   4. Clicking "edit" on a row populates the form WITHOUT throwing —
 *      regression for a TypeError that happened when the form read
 *      snake_case (`a.allowed_tools.join`) against the camelCase wire.
 *   5. Clicking the "← Back to chat" button calls `onClose`.
 *
 * The PATCH/DELETE rows share the same fetch round-trip + re-fetch shape
 * as POST, so the "create" + "edit" paths cover most of the wiring. The
 * delete path is also exercised explicitly to assert the CSRF header
 * (regression for a 403 caused by the missing X-Requested-With).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminSettings } from '../components/admin/AdminSettings';

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

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Default: providers list returns empty (for ProviderKeysTab which loads first)
  fetchMock.mockImplementation(() =>
    Promise.resolve(jsonOk({ providers: [], agents: [], teams: [], servers: [] })),
  );
});

/** Helper: render AdminSettings and navigate to the Agents tab. */
async function renderAtAgentsTab(overrides?: () => void) {
  if (overrides) overrides();
  render(<AdminSettings onClose={() => {}} />);
  // Click the Agents tab to navigate away from the default provider-keys tab.
  fireEvent.click(screen.getByRole('tab', { name: /^Agents$/i }));
}

describe('AdminSettings — agents tab', () => {
  it('lists existing agents on open', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // providers fetch (default tab)
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    // agents fetch (on Agents tab mount)
    fetchMock.mockResolvedValueOnce(jsonOk({ agents: [sampleAgent({ displayName: 'ax' })] }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Agents$/i }));
    await waitFor(() => {
      expect(screen.getByText('ax')).toBeTruthy();
    });
  });

  it('clicking + New agent reveals the form', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValue(jsonOk({ agents: [], teams: [], servers: [] }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Agents$/i }));
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));
    expect(screen.getByLabelText(/name/i)).toBeTruthy();
    expect(screen.getByLabelText(/system prompt/i)).toBeTruthy();
  });

  it('submitting the form POSTs to /admin/agents with camelCase + CSRF header', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // providers fetch (default tab)
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    // agents list on tab mount
    fetchMock.mockResolvedValueOnce(jsonOk({ agents: [] }));
    // teams + mcp lookup on form open
    fetchMock.mockResolvedValueOnce(jsonOk({ teams: [] }));
    fetchMock.mockResolvedValueOnce(jsonOk({ servers: [] }));
    // POST response
    fetchMock.mockResolvedValueOnce(jsonOk({ agent: sampleAgent({ id: 'agent-x' }) }));
    // re-fetch agents after save
    fetchMock.mockResolvedValueOnce(jsonOk({ agents: [] }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Agents$/i }));
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
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        agents: [
          sampleAgent({
            displayName: 'probe',
            systemPrompt: 'reply ok',
            allowedTools: ['bash', 'read_file'],
            mcpConfigIds: ['gh'],
          }),
        ],
      }),
    );
    fetchMock.mockResolvedValue(jsonOk({ teams: [], servers: [] }));

    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Agents$/i }));
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
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(jsonOk({ providers: [] }));
    fetchMock.mockResolvedValueOnce(
      jsonOk({ agents: [sampleAgent({ id: 'agt-1', displayName: 'probe' })] }),
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(jsonOk({ agents: [] }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminSettings onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Agents$/i }));
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

  it('clicking Back to chat calls onClose', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation(() => Promise.resolve(jsonOk({ providers: [] })));

    const onClose = vi.fn();
    render(<AdminSettings onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Back to chat/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
