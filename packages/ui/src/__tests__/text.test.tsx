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
  it('caption uses fg-muted: fg-subtle is below 4.5:1 for 12px text on light surfaces', () => {
    const cls = render(<Text role="caption">x</Text>).container.firstElementChild!.className;
    expect(cls).toContain('ax-text-fg-muted');
    expect(cls).not.toContain('ax-text-fg-subtle');
  });
  it('sets the font family per role: mono for code, sans for everything else', () => {
    for (const role of ['body', 'body-strong', 'meta', 'caption'] as const) {
      const r = render(<Text role={role}>x</Text>);
      const cls = r.container.firstElementChild!.className.split(' ');
      expect(cls, role).toContain('ax-font-sans');
      expect(cls, role).not.toContain('ax-font-mono');
      r.unmount();
    }
    const code = render(<Text role="code">x</Text>).container.firstElementChild!.className.split(' ');
    expect(code).toContain('ax-font-mono');
    expect(code).not.toContain('ax-font-sans');
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
  it('sets the sans font family for every role', () => {
    for (const role of ['display', 'title', 'heading', 'subheading'] as const) {
      const r = render(<Heading role={role}>x</Heading>);
      expect(r.container.firstElementChild!.className.split(' '), role).toContain('ax-font-sans');
      r.unmount();
    }
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
