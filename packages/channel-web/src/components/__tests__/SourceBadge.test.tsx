import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  SourceBadge,
  skillSource,
  connectorSource,
} from '../SourceBadge';

describe('SourceBadge', () => {
  it('renders the single "Catalog" tag for a catalog-sourced item', () => {
    render(<SourceBadge source="catalog" />);
    expect(screen.getByText('Catalog')).toBeInTheDocument();
  });

  it('renders nothing (no badge, no "catalog" copy) for a private item', () => {
    const { container } = render(<SourceBadge source="private" />);
    expect(container.textContent).toBe('');
    expect(screen.queryByText(/catalog/i)).toBeNull();
  });
});

describe('skillSource', () => {
  it("maps 'global' scope → catalog (admin-curated)", () => {
    expect(skillSource('global')).toBe('catalog');
  });
  it("maps 'user' scope → private (no badge)", () => {
    expect(skillSource('user')).toBe('private');
  });
});

describe('connectorSource', () => {
  it('a default-on connector is catalog-sourced', () => {
    expect(
      connectorSource({ defaultAttached: true, visibility: 'private' }),
    ).toBe('catalog');
  });
  it('a shared connector is catalog-sourced', () => {
    expect(
      connectorSource({ defaultAttached: false, visibility: 'shared' }),
    ).toBe('catalog');
  });
  it('a private, non-default connector shows no badge', () => {
    expect(
      connectorSource({ defaultAttached: false, visibility: 'private' }),
    ).toBe('private');
  });
});
