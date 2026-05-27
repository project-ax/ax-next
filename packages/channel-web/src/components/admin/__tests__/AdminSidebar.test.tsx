import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminSidebar } from '../AdminSidebar';

const noop = () => {};

describe('AdminSidebar (role-aware Settings surface)', () => {
  it('always shows the user tabs (Connections, Keys)', () => {
    render(
      <AdminSidebar activeTab="connections" isAdmin={false} onTabChange={noop} onBackToChat={noop} />,
    );
    expect(screen.getByText('Connections')).toBeInTheDocument();
    expect(screen.getByText('Keys')).toBeInTheDocument();
  });

  it('hides admin tabs from non-admins', () => {
    render(
      <AdminSidebar activeTab="connections" isAdmin={false} onTabChange={noop} onBackToChat={noop} />,
    );
    expect(screen.queryByText('Providers')).not.toBeInTheDocument();
    expect(screen.queryByText('Teams')).not.toBeInTheDocument();
    // The "Admin" section label is also absent for non-admins.
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('shows admin tabs to admins alongside the user tabs', () => {
    render(
      <AdminSidebar activeTab="providers" isAdmin onTabChange={noop} onBackToChat={noop} />,
    );
    expect(screen.getByText('Connections')).toBeInTheDocument();
    expect(screen.getByText('Providers')).toBeInTheDocument();
    expect(screen.getByText('Teams')).toBeInTheDocument();
  });

  it('fires onTabChange when a tab is clicked', () => {
    const onTabChange = vi.fn();
    render(
      <AdminSidebar activeTab="connections" isAdmin={false} onTabChange={onTabChange} onBackToChat={noop} />,
    );
    screen.getByText('Keys').click();
    expect(onTabChange).toHaveBeenCalledWith('keys');
  });
});
