// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBadge, StatusMark, type StatusTone } from '../index.js';

afterEach(cleanup);

const TONES: StatusTone[] = ['neutral', 'info', 'success', 'warning', 'danger'];
const fill = (el: Element): string | undefined => el.className.split(' ').find((c) => c.startsWith('ax-bg-'));

describe('StatusMark', () => {
  it('renders a distinct shape per tone (5 different data-shape values)', () => {
    const shapes = TONES.map((tone) => {
      const { container, unmount } = render(<StatusMark tone={tone} />);
      const shape = container.querySelector('[data-shape]')?.getAttribute('data-shape');
      unmount();
      return shape;
    });
    expect(new Set(shapes).size).toBe(5);
    expect(shapes[TONES.indexOf('warning')]).toBe('diamond');
  });

  it('is aria-hidden without label, role=img with label', () => {
    const { container, unmount } = render(<StatusMark tone="warning" />);
    expect(container.querySelector('[data-shape]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();
    unmount();
    render(<StatusMark tone="warning" label="Waiting on you" />);
    const img = screen.getByRole('img', { name: 'Waiting on you' });
    expect(img.getAttribute('aria-hidden')).toBeNull();
    expect(img.getAttribute('data-shape')).toBe('diamond');
  });
});

describe('StatusBadge', () => {
  const badgeFill = (tone: StatusTone): string | undefined => {
    const { container, unmount } = render(<StatusBadge tone={tone}>x</StatusBadge>);
    const f = fill(container.firstElementChild as Element);
    unmount();
    return f;
  };

  it('tone classes follow the ladder: success fill === neutral fill, warning fill !== success fill', () => {
    expect(badgeFill('success')).toBeTruthy();
    expect(badgeFill('success')).toBe(badgeFill('neutral'));
    expect(badgeFill('warning')).not.toBe(badgeFill('success'));
    expect(badgeFill('danger')).not.toBe(badgeFill('warning'));
    expect(badgeFill('info')).not.toBe(badgeFill('success'));
  });

  it('dot renders a StatusMark of the same tone, and none by default', () => {
    const { container, unmount } = render(
      <StatusBadge tone="warning" dot>
        Waiting
      </StatusBadge>,
    );
    expect(container.querySelector('[data-shape="diamond"]')).toBeTruthy();
    unmount();
    const r = render(<StatusBadge tone="warning">Waiting</StatusBadge>);
    expect(r.container.querySelector('[data-shape]')).toBeNull();
  });

  it('long badge text truncates (has truncation class + title)', () => {
    const long = 'A very long status label '.repeat(8).trim();
    render(<StatusBadge tone="info">{long}</StatusBadge>);
    const text = screen.getByText(long);
    // The badge itself caps at its container (nowrap text would otherwise force it wider than 390px).
    expect(text.parentElement?.className).toContain('ax-max-w-full');
    expect(text.className).toContain('ax-truncate');
    expect(text.getAttribute('title')).toBe(long);
  });

  it('sizes differ', () => {
    const a = render(<StatusBadge tone="info" size="sm">x</StatusBadge>).container.innerHTML;
    cleanup();
    const b = render(<StatusBadge tone="info" size="md">x</StatusBadge>).container.innerHTML;
    expect(a).not.toBe(b);
  });
});

describe('SSR', () => {
  it('renders every tone without inline style or window access', () => {
    for (const tone of TONES) {
      const html = renderToString(
        <StatusBadge tone={tone} dot size="sm">
          x
        </StatusBadge>,
      );
      expect(html).toContain('data-shape');
      expect(html).not.toContain('style=');
      expect(renderToString(<StatusMark tone={tone} label="x" />)).toContain('role="img"');
    }
  });
});
