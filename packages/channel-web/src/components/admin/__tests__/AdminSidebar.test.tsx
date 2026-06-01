import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminSidebar } from '../AdminSidebar';

const noop = () => {};

describe('AdminSidebar (role-aware Settings surface)', () => {
  it('always shows the three user tabs (Skills, Connectors, Credentials)', () => {
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={noop} onBackToChat={noop} />,
    );
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('Connectors')).toBeInTheDocument();
    expect(screen.getByText('Credentials')).toBeInTheDocument();
  });

  it('hides admin tabs from non-admins', () => {
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={noop} onBackToChat={noop} />,
    );
    expect(screen.queryByText('Providers')).not.toBeInTheDocument();
    expect(screen.queryByText('Teams')).not.toBeInTheDocument();
    // The admin connector-catalog registry is also hidden for non-admins.
    expect(screen.queryByText('Connector catalog')).not.toBeInTheDocument();
    // The "Admin" section label is also absent for non-admins.
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });

  it('shows admin tabs to admins alongside the user tabs', () => {
    render(
      <AdminSidebar activeTab="providers" isAdmin onTabChange={noop} onBackToChat={noop} />,
    );
    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.getByText('Providers')).toBeInTheDocument();
    expect(screen.getByText('Connector catalog')).toBeInTheDocument();
    expect(screen.getByText('Teams')).toBeInTheDocument();
  });

  it('fires onTabChange when a tab is clicked', () => {
    const onTabChange = vi.fn();
    render(
      <AdminSidebar activeTab="skills" isAdmin={false} onTabChange={onTabChange} onBackToChat={noop} />,
    );
    screen.getByText('Credentials').click();
    expect(onTabChange).toHaveBeenCalledWith('credentials');
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
