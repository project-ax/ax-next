/**
 * Admin agents form — Task 22.
 *
 * Covers AgentForm CRUD flow against the real `/admin/agents` wire shape
 * (camelCase: displayName / allowedTools / mcpConfigIds / model / visibility /
 * teamId / ...). TASK-142: the agent's identity lives in its `.ax/` files,
 * edited via the file editor + a separate PUT to /admin/agents/:id/identity —
 * not a `systemPrompt` field on this wire.
 *
 * TASK-799: the form no longer assigns connectors at all — people add them
 * from the workspace rail — so a save never touches
 * `/admin/agents/:id/connector-attachments`. `mcpConfigIds` keeps its MCP-only
 * meaning and is sent as [].
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
  model: 'anthropic/claude-sonnet-4-6',
  workspaceRef: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/** What GET /admin/agents/models serves in these tests — the deployment's
 *  agents allow-list, labelled by whichever `models:list-supported:<provider>`
 *  registrants are loaded. */
const MODEL_OPTIONS = [
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', kind: 'either' },
  { id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', kind: 'default' },
];

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
      jsonOk({
        providers: [],
        agents: [],
        teams: [],
        connectors: [],
        models: MODEL_OPTIONS,
      }),
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


  // ---------------------------------------------------------------------
  // #401 — the picker must never display a model the form would not save.
  //
  // The old code bound `value={form.model}` and back-filled `form.model` from
  // an effect one commit after the model list landed. A `<select>` whose value
  // matches no `<option>` displays its FIRST option, so inside that window the
  // dropdown showed "Claude Sonnet 4.6" while the form held `''` — and Save
  // answered "no model is available to assign", contradicting the visible UI.
  //
  // The window was ~10% of runs (measured: 3 failures in 30 runs of this file
  // before the fix, 0 in 40 after), which is why it surfaced as a flaky test
  // rather than as the contradiction it actually was.
  //
  // This assertion is deliberately written as the INVARIANT — what the picker
  // shows is what gets posted — rather than against a hardcoded model id, so it
  // fails for the real reason instead of merely noticing a different string.
  // ---------------------------------------------------------------------
  it('posts the model the picker is displaying, never a contradiction', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/admin/agents/models') {
        return Promise.resolve(jsonOk({ models: MODEL_OPTIONS }));
      }
      if (url === '/admin/agents' && method === 'POST') {
        return Promise.resolve(jsonOk({ agent: sampleAgent({ id: 'agent-x' }) }));
      }
      if (/\/identity$/.test(url)) return Promise.resolve(jsonOk({ ok: true }));
      if (/\/admin\/teams(\?|$)/.test(url)) return Promise.resolve(jsonOk({ teams: [] }));
      if (/\/admin\/connectors(\?|$)/.test(url)) {
        return Promise.resolve(jsonOk({ connectors: [] }));
      }
      return Promise.resolve(jsonOk({ agents: [] }));
    });

    render(<AgentForm isAdmin />);
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));
    fireEvent.change(screen.getByLabelText(/name/i), {
      target: { value: 'new-bot' },
    });
    fireEvent.change(screen.getByLabelText(/allowed tools/i), {
      target: { value: 'bash' },
    });

    // Wait only for the OPTIONS to exist — deliberately NOT for the select's
    // value to settle. Waiting on the value is what let the old bug hide: the
    // browser's first-option fallback satisfied that wait before the form state
    // caught up, so the test's readiness signal was not evidence of readiness.
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Model') as HTMLSelectElement).getAllByRole(
          'option',
        ).length,
      ).toBe(MODEL_OPTIONS.length),
    );
    const shown = (screen.getByLabelText('Model') as HTMLSelectElement).value;
    expect(shown).not.toBe('');

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, opts]) =>
          url === '/admin/agents' &&
          (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body)).model).toBe(shown);
    });
    // The contradiction itself, asserted directly.
    expect(screen.queryByText(/no model is available to assign/i)).toBeNull();
  });

  it('submitting the form POSTs to /admin/agents with camelCase + CSRF header', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Route by URL rather than by call order — the form issues several
    // independent lookups on open (teams, models, connectors) and a fixed
    // queue makes the test hostage to their ordering.
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/admin/agents/models') {
        return Promise.resolve(jsonOk({ models: MODEL_OPTIONS }));
      }
      if (url === '/admin/agents' && method === 'POST') {
        return Promise.resolve(jsonOk({ agent: sampleAgent({ id: 'agent-x' }) }));
      }
      if (/\/identity$/.test(url)) return Promise.resolve(jsonOk({ ok: true }));
      if (/\/admin\/teams(\?|$)/.test(url)) return Promise.resolve(jsonOk({ teams: [] }));
      if (/\/admin\/connectors(\?|$)/.test(url)) {
        return Promise.resolve(jsonOk({ connectors: [] }));
      }
      return Promise.resolve(jsonOk({ agents: [] }));
    });

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
    // The Model picker is populated from GET /admin/agents/models — wait for
    // that to land before saving, so the POST carries a real model ref.
    await waitFor(() =>
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe(
        'anthropic/claude-sonnet-4-6',
      ),
    );
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
      // A fully-qualified `provider/model-id` ref — the agents allow-list
      // rejects bare ids.
      expect(body.model).toBe('anthropic/claude-sonnet-4-6');
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
    // TASK-799 — connectors are added from the workspace rail, never here.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/connector-attachments')),
    ).toBe(false);
  });

  // TASK-719 — the storage limit turned the identity save away. The agent row
  // was already created (the form saves in that order), so the person must be
  // told, in one plain sentence, that the AGENT is saved and its IDENTITY is not — not handed `save agent identity: 413:
  // storage-full`, and not a sentence worded for the agent that writes files.
  it('says a full storage limit in plain words when the identity save is refused', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const sentence =
      "The agent was saved, but its identity wasn't, because storage is full. An admin can make room.";
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/admin/agents/models') {
        return Promise.resolve(jsonOk({ models: MODEL_OPTIONS }));
      }
      if (url === '/admin/agents' && method === 'POST') {
        return Promise.resolve(jsonOk({ agent: sampleAgent({ id: 'agent-x' }) }));
      }
      if (/\/identity$/.test(url) && method === 'PUT') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'storage-full', message: sentence }), {
            status: 413,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (/\/admin\/teams(\?|$)/.test(url)) return Promise.resolve(jsonOk({ teams: [] }));
      if (/\/admin\/connectors(\?|$)/.test(url)) {
        return Promise.resolve(jsonOk({ connectors: [] }));
      }
      return Promise.resolve(jsonOk({ agents: [] }));
    });

    render(<AgentForm isAdmin />);
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'new-bot' } });
    fireEvent.change(screen.getByLabelText('Identity'), { target: { value: 'I am new-bot.' } });
    fireEvent.change(screen.getByLabelText('Soul'), { target: { value: 'I am helpful.' } });
    fireEvent.change(screen.getByLabelText(/allowed tools/i), { target: { value: 'bash' } });
    await waitFor(() =>
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe(
        'anthropic/claude-sonnet-4-6',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    // The destructive Alert holds the server's sentence and nothing else.
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(sentence);
    });
    expect(screen.queryByText(/save agent identity/i)).toBeNull();
    expect(screen.queryByText(/413/)).toBeNull();
    // The form stays open with what was typed: nothing was thrown away.
    expect((screen.getByLabelText('Identity') as HTMLTextAreaElement).value).toBe('I am new-bot.');
  });

  it('model options come from GET /admin/agents/models, not a hardcoded list', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // A list nothing in the SPA could have invented.
    const served = [
      { id: 'openrouter/x-ai/grok-4.6', label: 'Grok 4.6', kind: 'default' },
      { id: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', kind: 'fast' },
    ];
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/admin/agents/models') return Promise.resolve(jsonOk({ models: served }));
      if (/\/admin\/teams(\?|$)/.test(url)) return Promise.resolve(jsonOk({ teams: [] }));
      if (/connectors(\?|$)/.test(url)) return Promise.resolve(jsonOk({ connectors: [] }));
      return Promise.resolve(jsonOk({ agents: [] }));
    });

    render(<AgentForm isAdmin />);
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));

    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(select.options).map((o) => o.value)).toEqual(
        served.map((m) => m.id),
      ),
    );
    // Rendered with the served LABEL, valued by the served id.
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Grok 4.6',
      'Claude Haiku 4.5',
    ]);
    // First option is preselected for a new agent.
    expect(select.value).toBe('openrouter/x-ai/grok-4.6');
  });

  it('an empty model list explains itself instead of rendering an empty picker', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // What a first-run deployment with no provider plugin returns: 200 + [].
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/admin/agents/models') return Promise.resolve(jsonOk({ models: [] }));
      if (/\/admin\/teams(\?|$)/.test(url)) return Promise.resolve(jsonOk({ teams: [] }));
      if (/connectors(\?|$)/.test(url)) return Promise.resolve(jsonOk({ connectors: [] }));
      return Promise.resolve(jsonOk({ agents: [] }));
    });

    render(<AgentForm isAdmin />);
    await waitFor(() => screen.getByText(/New agent/i));
    fireEvent.click(screen.getByText(/New agent/i));

    await waitFor(() =>
      expect(screen.getByText(/No models are available yet/i)).toBeTruthy(),
    );
    // No silently-empty <select> left behind.
    expect(screen.queryByLabelText('Model')).toBeNull();
  });

  it('TASK-799: saving an edited team agent that has connectors never writes connector attachments', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const teamAgent = sampleAgent({
      id: 'agent-t',
      ownerId: 'team_1',
      ownerType: 'team',
      visibility: 'team',
      displayName: 'team-bot',
      connectorAttachments: ['gh'],
    });
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/admin/agents/models') {
        return Promise.resolve(jsonOk({ models: MODEL_OPTIONS }));
      }
      if (url === '/admin/agents/agent-t') {
        return Promise.resolve(jsonOk({ agent: teamAgent }));
      }
      if (/\/admin\/connectors(\?|$)/.test(url)) {
        return Promise.resolve(jsonOk({ connectors: [] }));
      }
      if (/connector-attachments/.test(url)) {
        return Promise.resolve(jsonOk({ agent: teamAgent }));
      }
      if (/\/identity$/.test(url)) {
        return Promise.resolve(
          method === 'PUT'
            ? jsonOk({ ok: true })
            : jsonOk({ identity: '', soul: '', operating: '' }),
        );
      }
      if (/\/admin\/teams(\?|$)/.test(url)) {
        return Promise.resolve(
          jsonOk({ teams: [{ id: 'team_1', displayName: 'Eng', createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z' }] }),
        );
      }
      if (/\/admin\/skills(\?|$)/.test(url)) return Promise.resolve(jsonOk({ skills: [] }));
      if (/authored-skills/.test(url)) return Promise.resolve(jsonOk({ skills: [] }));
      return Promise.resolve(jsonOk({ agents: [teamAgent] }));
    });

    render(<AgentForm isAdmin />);
    await waitFor(() => screen.getByText('team-bot'));
    fireEvent.click(screen.getByText(/^edit$/i));
    await screen.findByRole('heading', { name: 'Edit team-bot' });
    await waitFor(() =>
      expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe(
        'anthropic/claude-sonnet-4-6',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The identity PUT is the last write of a save — once it lands, the save is done.
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([url, opts]) =>
          String(url) === '/admin/agents/agent-t/identity' &&
          (opts as RequestInit | undefined)?.method === 'PUT',
      );
      expect(put).toBeTruthy();
    });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/connector-attachments')),
    ).toBe(false);
  });

  it('clicking edit populates the form', async () => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        agents: [sampleAgent({ displayName: 'probe', allowedTools: ['bash', 'read_file'] })],
      }),
    );
    // The edit view also renders SkillAttachmentsSection (fetches /admin/skills)
    // + AuthoredSkillsSection (fetches authored-skills); return empty shapes so
    // neither crashes.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/admin/agents/agt-1') {
        return Promise.resolve(jsonOk({ agent: sampleAgent({
          displayName: 'probe', allowedTools: ['bash', 'read_file'],
        }) }));
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
    const nameInput = await screen.findByLabelText(/name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('probe');
    const tools = screen.getByLabelText(/allowed tools/i) as HTMLInputElement;
    expect(tools.value).toBe('bash, read_file');
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
