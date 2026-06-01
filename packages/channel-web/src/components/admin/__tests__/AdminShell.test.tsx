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
  // SkillsTab (the default tab) calls listUserSkills() → /settings/skills and
  // listAuthoredSkills() → /settings/skills/authored on mount.
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
  if (/\/api\/chat\/agents(\?|$)/.test(url)) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  // CatalogTab (listSkills → /admin/skills) and AdmitQueueTab
  // (listCatalogRequests → /admin/catalog/requests) fetch on mount.
  if (/\/admin\/skills(\?|$)/.test(url)) {
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
  // ConnectorRegistry (listConnectors → /admin/connectors) fetches on mount.
  if (/\/admin\/connectors(\?|$)/.test(url)) {
    return new Response(JSON.stringify({ connectors: [] }), {
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
  it('renders the three user Settings tabs plus admin tabs, with Skills active by default', () => {
    renderShell();
    // The agent-centric Settings tabs (every user). "Connectors" the user tab
    // shares its label with the admin "Connector catalog" registry, so scope to
    // the user nav button by its exact label.
    expect(screen.getByRole('button', { name: 'Skills' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connectors' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Credentials' })).toBeTruthy();
    // Admin tabs (Admin section) — present for admins.
    expect(screen.getByRole('button', { name: 'AI model keys' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Default AI model' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connector catalog' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Teams' })).toBeTruthy();
    // Skills is the default active tab for everyone.
    expect(
      screen.getByRole('button', { name: 'Skills' }).getAttribute('data-active'),
    ).toBeTruthy();
  });

  it('hides admin tabs when isAdmin is false', () => {
    renderShell(vi.fn(), false);
    expect(screen.getByRole('button', { name: 'Skills' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'AI model keys' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Teams' })).toBeNull();
    // The admin connector-catalog registry is hidden for non-admins.
    expect(screen.queryByRole('button', { name: 'Connector catalog' })).toBeNull();
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

  it('shows the Catalog and Skills awaiting review nav items for admins', () => {
    renderShell();
    expect(screen.getByRole('button', { name: 'Catalog' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skills awaiting review' })).toBeTruthy();
  });

  it('clicking Catalog makes it the active tab', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Catalog' }));
    expect(
      screen.getByRole('button', { name: 'Catalog' }).getAttribute('data-active'),
    ).toBeTruthy();
  });

  it('hides Catalog and Skills awaiting review when isAdmin is false', () => {
    renderShell(vi.fn(), false);
    expect(screen.queryByRole('button', { name: 'Catalog' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skills awaiting review' })).toBeNull();
  });
});
