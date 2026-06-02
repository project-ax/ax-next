import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminSidebar } from '../AdminSidebar';

const noop = () => {};

describe('AdminSidebar (role-aware Settings surface)', () => {
  it('shows the user tabs (Skills, Connectors, Agents) — no separate Credentials tab', () => {
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={noop} onBackToChat={noop} />,
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
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={noop} onBackToChat={noop} />,
    );
    expect(screen.queryByText('AI model keys')).not.toBeInTheDocument();
    expect(screen.queryByText('Teams')).not.toBeInTheDocument();
    // The "Admin" section label is also absent for non-admins.
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    // Agents is owner-scoped and lives in the user Settings group → still shown.
    expect(screen.getByText('Agents')).toBeInTheDocument();
  });

  it('routes the Agents user tab to the agents tab id', () => {
    const onTabChange = vi.fn();
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={onTabChange} onBackToChat={noop} />,
    );
    screen.getByText('Agents').click();
    expect(onTabChange).toHaveBeenCalledWith('agents');
  });

  it('shows admin tabs to admins alongside the user tabs', () => {
    render(
      <AdminSidebar activeTab="providers" isAdmin onTabChange={noop} onBackToChat={noop} />,
    );
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('AI model keys')).toBeInTheDocument();
    expect(screen.getByText('Teams')).toBeInTheDocument();
  });

  it('folds the catalog / admit-queue / connector-registry surfaces out of the nav', () => {
    // settings-unified epic: the duplicate admin Skills/Connectors surfaces
    // (Catalog, Skills awaiting review, Connector catalog) no longer have nav
    // entries — their curation moves inline into the user Skills/Connectors
    // tabs. Even for admins, none of these labels render.
    render(
      <AdminSidebar activeTab="providers" isAdmin onTabChange={noop} onBackToChat={noop} />,
    );
    expect(screen.queryByText('Catalog')).not.toBeInTheDocument();
    expect(screen.queryByText('Skills awaiting review')).not.toBeInTheDocument();
    expect(screen.queryByText('Connector catalog')).not.toBeInTheDocument();
  });

  it('fires onTabChange when a tab is clicked', () => {
    const onTabChange = vi.fn();
    render(
      <AdminSidebar activeTab="connectors-user" isAdmin={false} onTabChange={onTabChange} onBackToChat={noop} />,
    );
    screen.getByText('Skills').click();
    expect(onTabChange).toHaveBeenCalledWith('skills');
  });

  it('the user "Connectors" tab uses the connectors-user id', () => {
    const onTabChange = vi.fn();
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={onTabChange} onBackToChat={noop} />,
    );
    screen.getByText('Connectors').click();
    expect(onTabChange).toHaveBeenCalledWith('connectors-user');
  });
});
