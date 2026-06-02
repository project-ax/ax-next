import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdminShell } from '../AdminShell';
import { UserProvider } from '../../../lib/user-context';
import type { AuthUser } from '../../../lib/auth';

// ProvidersPanel and ModelConfigTab fetch on mount — stub to avoid leaking
// unhandled promise rejections.
const fetchMock = vi.fn();
function emptyResponse(url: string): Response {
  // ProvidersPanel (default tab) calls adminCredentials.list() which hits
  // /admin/credentials (no trailing path) and expects { credentials: [] }.
  // ModelConfigTab calls listProviders() → /admin/credentials/providers → { providers: [] }.
  if (/\/admin\/credentials(\?|$)/.test(url) || /\/settings\/credentials(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ credentials: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  // SkillsTab (the default tab) → SkillsAppStore calls, on mount:
  //   listUserSkills()      → GET /settings/skills            → { skills: [] }
  //   listAuthoredSkills()  → GET /settings/skills/authored   → { skills: [] }
  //   listCatalogSkills()   → GET /api/chat/catalog-skills    → { skills: [] }
  //   listChatAgents()      → GET /api/chat/agents            → []
  //   getConnections(id)    → GET /api/chat/connections/:id   → { agentId, skills:[] }
  // (an admin also calls listCatalogRequests() → /admin/catalog/requests.)
  if (/\/settings\/skills\/authored(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (/\/settings\/skills(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (/\/api\/chat\/catalog-skills(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (/\/admin\/catalog\/requests(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ requests: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (/\/api\/chat\/connections\//.test(url)) {
    return new Response(JSON.stringify({ agentId: 'a1', skills: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (/\/api\/chat\/agents(\?|$)/.test(url)) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ providers: [], agents: [], teams: [], connectors: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation((input: RequestInfo | URL) =>
    Promise.resolve(emptyResponse(String(input))),
  );
});

const fakeUser: AuthUser = {
  id: 'u1',
  email: 'ana@example.co',
  name: 'Ana K.',
  role: 'admin',
};

function renderShell(onClose = vi.fn(), isAdmin = true) {
  return render(
    <UserProvider value={fakeUser}>
      <AdminShell isAdmin={isAdmin} onClose={onClose} />
    </UserProvider>,
  );
}

describe('AdminShell', () => {
  it('renders the user Settings tabs plus admin tabs, with Skills active by default', () => {
    renderShell();
    // The agent-centric Settings tabs (every user). No separate Credentials tab —
    // each connector owns its own key(s) (credentials-into-connectors).
    expect(screen.getByRole('button', { name: 'Skills' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connectors' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Credentials' })).toBeNull();
    // Agents is a USER Settings tab now (owner-scoped — every user manages their
    // own agents), no longer in the Admin group.
    expect(screen.getByRole('button', { name: 'Agents' })).toBeTruthy();
    // Admin tabs (Admin section) — present for admins. The Admin group is now
    // keys / model / sign-in / teams; the duplicate Catalog / Connector-catalog
    // surfaces are gone.
    expect(screen.getByRole('button', { name: 'AI model keys' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Default AI model' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Teams' })).toBeTruthy();
    // Skills is the default active tab for everyone.
    expect(
      screen.getByRole('button', { name: 'Skills' }).getAttribute('data-active'),
    ).toBeTruthy();
  });

  it('hides admin tabs when isAdmin is false — but keeps the user Agents tab', () => {
    renderShell(vi.fn(), false);
    expect(screen.getByRole('button', { name: 'Skills' })).toBeTruthy();
    // Agents is owner-scoped → a user Settings tab, shown even to non-admins.
    expect(screen.getByRole('button', { name: 'Agents' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'AI model keys' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Teams' })).toBeNull();
  });

  it('clicking Default AI model makes it the active tab', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Default AI model' }));
    expect(
      screen.getByRole('button', { name: 'Default AI model' }).getAttribute('data-active'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Skills' }).getAttribute('data-active'),
    ).toBeNull();
  });

  it('clicking ← chat calls onClose', () => {
    const onClose = vi.fn();
    renderShell(onClose);
    fireEvent.click(screen.getByRole('button', { name: /chat/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not render the folded Catalog / Skills-awaiting-review / Connector-catalog nav items, even for admins', () => {
    // settings-unified epic: these admin surfaces were folded out of the nav;
    // their curation moves inline into the user Skills/Connectors tabs. No nav
    // entry — and therefore no orphaned tab route — remains.
    renderShell();
    expect(screen.queryByRole('button', { name: 'Catalog' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skills awaiting review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connector catalog' })).toBeNull();
  });
});
