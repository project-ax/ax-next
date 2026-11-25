// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Heading, Text } from '../index.js';
import { HeadingLevelContext } from '../internal/heading-level.js';

describe('Text', () => {
  it('renders p / span / code', () => {
    const a = render(<Text>x</Text>);
    expect(a.container.firstElementChild!.tagName).toBe('P');
    a.unmount();
    const b = render(<Text inline>x</Text>);
    expect(b.container.firstElementChild!.tagName).toBe('SPAN');
    b.unmount();
    const c = render(<Text role="code">x</Text>);
    expect(c.container.firstElementChild!.tagName).toBe('CODE');
  });
  it('meta colors', () => {
    const { container } = render(<Text role="meta">x</Text>);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain('ax-text-meta');
    expect(cls).toContain('ax-text-fg-muted');
  });
  it('truncate', () => {
    const { container } = render(<Text truncate>x</Text>);
    expect(container.firstElementChild!.className).toContain('ax-truncate');
  });
});

describe('Heading', () => {
  it('defaults to h2/heading', () => {
    const { container } = render(<Heading>x</Heading>);
    const el = container.firstElementChild!;
    expect(el.tagName).toBe('H2');
    expect(el.className).toContain('ax-text-heading');
  });
  it('level 1 is title', () => {
    const { container } = render(
      <HeadingLevelContext.Provider value={1}><Heading>x</Heading></HeadingLevelContext.Provider>,
    );
    const el = container.firstElementChild!;
    expect(el.tagName).toBe('H1');
    expect(el.className).toContain('ax-text-title');
  });
  it('caps at h6', () => {
    const { container } = render(
      <HeadingLevelContext.Provider value={9}><Heading>x</Heading></HeadingLevelContext.Provider>,
    );
    expect(container.firstElementChild!.tagName).toBe('H6');
  });
  it('level 3 is subheading', () => {
    const { container } = render(
      <HeadingLevelContext.Provider value={3}><Heading>x</Heading></HeadingLevelContext.Provider>,
    );
    expect(container.firstElementChild!.className).toContain('ax-text-subheading');
  });
});
