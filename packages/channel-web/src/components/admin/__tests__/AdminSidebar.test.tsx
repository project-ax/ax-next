import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminSidebar } from '../AdminSidebar';

const noop = () => {};

describe('AdminSidebar (role-aware Settings surface)', () => {
  /**
   * The back button used to say "chat" unconditionally. That was correct while
   * chat was the only shell that could open Settings, and became a wrong sign
   * the moment the workspace could — pointing people at the surface being
   * retired, from the surface replacing it.
   *
   * Naming the destination rather than saying a bare "Back" is the existing
   * design and worth keeping. It just has to be the caller's destination.
   */
  it('names the destination its caller came from', () => {
    const { unmount } = render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={noop} onBack={noop} backLabel="workspace" />,
    );
    expect(screen.getByRole('button', { name: /workspace/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^chat$/i })).toBeNull();
    unmount();

    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={noop} onBack={noop} backLabel="chat" />,
    );
    expect(screen.getByRole('button', { name: /chat/i })).toBeInTheDocument();
  });

  it('shows the user tabs (Skills, Connectors, Agents) — no separate Credentials tab', () => {
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={noop} onBack={noop} backLabel="chat" />,
    );
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('Connectors')).toBeInTheDocument();
    // Agents is a user-facing Settings tab now — every user lists + manages their
    // OWN agents (owner-scoped). Visible even to a non-admin.
    expect(screen.getByText('Agents')).toBeInTheDocument();
    // The Credentials tab was folded into Connectors — each connector owns its
    // own key(s), so there's no standalone Credentials nav entry.
    expect(screen.queryByText('Credentials')).not.toBeInTheDocument();
  });

  it('hides admin tabs from non-admins (but NOT Agents — it is a user tab now)', () => {
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={noop} onBack={noop} backLabel="chat" />,
    );
    expect(screen.queryByText('AI model keys')).not.toBeInTheDocument();
    expect(screen.queryByText('Teams')).not.toBeInTheDocument();
    expect(screen.queryByText('Usage')).not.toBeInTheDocument();
    // The "Admin" section label is also absent for non-admins.
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    // Agents is owner-scoped and lives in the user Settings group → still shown.
    expect(screen.getByText('Agents')).toBeInTheDocument();
  });

  it('routes the Agents user tab to the agents tab id', () => {
    const onTabChange = vi.fn();
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={onTabChange} onBack={noop} backLabel="chat" />,
    );
    screen.getByText('Agents').click();
    expect(onTabChange).toHaveBeenCalledWith('agents');
  });

  it('shows admin tabs to admins alongside the user tabs', () => {
    render(
      <AdminSidebar activeTab="providers" isAdmin onTabChange={noop} onBack={noop} backLabel="chat" />,
    );
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('AI model keys')).toBeInTheDocument();
    expect(screen.getByText('Teams')).toBeInTheDocument();
    expect(screen.getByText('Usage')).toBeInTheDocument();
  });

  it('routes the admin Usage tab to the usage tab id', () => {
    const onTabChange = vi.fn();
    render(
      <AdminSidebar activeTab="branding" isAdmin onTabChange={onTabChange} onBack={noop} backLabel="chat" />,
    );
    screen.getByText('Usage').click();
    expect(onTabChange).toHaveBeenCalledWith('usage');
  });

  it('lists Usage in the Admin group, right after Branding', () => {
    render(
      <AdminSidebar activeTab="usage" isAdmin onTabChange={noop} onBack={noop} backLabel="chat" />,
    );
    const items = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.trim() ?? '')
      .filter((t) => t.length > 0);
    expect(items.indexOf('Usage')).toBe(items.indexOf('Branding') + 1);
    expect(screen.getByRole('button', { name: 'Usage' }).getAttribute('data-active')).toBeTruthy();
  });

  // TASK-690 — everyone has a storage limit, so everyone gets the tab that
  // shows it. (An admin's extra controls live INSIDE the tab: the nav does not
  // grow a second entry.)
  it('shows Storage to everyone, not just admins', () => {
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={noop} onBack={noop} backLabel="chat" />,
    );
    expect(screen.getByRole('button', { name: 'Storage' })).toBeInTheDocument();
  });

  it('lists Storage in the Settings group, right after Routines, and once for an admin', () => {
    render(
      <AdminSidebar activeTab="storage" isAdmin onTabChange={noop} onBack={noop} backLabel="chat" />,
    );
    const items = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.trim() ?? '')
      .filter((t) => t.length > 0);
    expect(items.indexOf('Storage')).toBe(items.indexOf('Routines') + 1);
    // Still in the Settings group: the Admin section starts after it.
    expect(items.indexOf('Storage')).toBeLessThan(items.indexOf('AI model keys'));
    expect(items.filter((t) => t === 'Storage')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Storage' }).getAttribute('data-active')).toBeTruthy();
  });

  it('routes the Storage tab to the storage tab id', () => {
    const onTabChange = vi.fn();
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={onTabChange} onBack={noop} backLabel="chat" />,
    );
    screen.getByText('Storage').click();
    expect(onTabChange).toHaveBeenCalledWith('storage');
  });

  it('folds the catalog / admit-queue / connector-registry surfaces out of the nav', () => {
    // settings-unified epic: the duplicate admin Skills/Connectors surfaces
    // (Catalog, Skills awaiting review, Connector catalog) no longer have nav
    // entries — their curation moves inline into the user Skills/Connectors
    // tabs. Even for admins, none of these labels render.
    render(
      <AdminSidebar activeTab="providers" isAdmin onTabChange={noop} onBack={noop} backLabel="chat" />,
    );
    expect(screen.queryByText('Catalog')).not.toBeInTheDocument();
    expect(screen.queryByText('Skills awaiting review')).not.toBeInTheDocument();
    expect(screen.queryByText('Connector catalog')).not.toBeInTheDocument();
  });

  it('fires onTabChange when a tab is clicked', () => {
    const onTabChange = vi.fn();
    render(
      <AdminSidebar activeTab="connectors-user" isAdmin={false} onTabChange={onTabChange} onBack={noop} backLabel="chat" />,
    );
    screen.getByText('Skills').click();
    expect(onTabChange).toHaveBeenCalledWith('skills');
  });

  it('the user "Connectors" tab uses the connectors-user id', () => {
    const onTabChange = vi.fn();
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={onTabChange} onBack={noop} backLabel="chat" />,
    );
    screen.getByText('Connectors').click();
    expect(onTabChange).toHaveBeenCalledWith('connectors-user');
  });
});
