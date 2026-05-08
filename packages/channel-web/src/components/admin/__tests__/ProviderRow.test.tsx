import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProviderRow } from '../ProviderRow';

describe('ProviderRow', () => {
  it('renders empty state with Add key button', () => {
    const onEdit = vi.fn();
    render(
      <ProviderRow
        mark="An"
        name="Anthropic"
        status="empty"
        onEdit={onEdit}
      />,
    );
    expect(screen.getByText('Anthropic')).toBeTruthy();
    expect(screen.getByText('Not configured')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /add key/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('renders configured state with masked stub and Edit button', () => {
    render(
      <ProviderRow
        mark="An"
        name="Anthropic"
        status="ok"
        keyStub="sk-ant-•••••••••3c2f"
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByText('Configured')).toBeTruthy();
    expect(screen.getByText('sk-ant-•••••••••3c2f')).toBeTruthy();
    expect(screen.getByRole('button', { name: /edit key/i })).toBeTruthy();
  });

  it('renders error state', () => {
    render(
      <ProviderRow
        mark="An"
        name="Anthropic"
        status="bad"
        statusLabel="Key rejected by provider"
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByText('Key rejected by provider')).toBeTruthy();
  });

  it('renders an editing form in the body slot', () => {
    render(
      <ProviderRow
        mark="An"
        name="Anthropic"
        status="empty"
        statusLabel="Adding key…"
        editing
        body={<div data-testid="key-form-slot">form here</div>}
      />,
    );
    expect(screen.getByTestId('key-form-slot')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add key/i })).toBeNull();
  });
});
