// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Plus } from 'lucide-react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from '../index.js';
import type { ButtonIntent, ButtonSize } from '../index.js';

afterEach(cleanup);

// Radix popper measures with ResizeObserver, which jsdom lacks.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('Button', () => {
  it('renders a <button type="button"> by default', () => {
    render(<Button>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('type')).toBe('button');
  });

  it('busy: aria-busy, disabled, keeps the label, ignores clicks', () => {
    const onClick = vi.fn();
    render(<Button busy onClick={onClick}>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(b.textContent).toBe('Save');
    expect(b.querySelector('svg.ax-animate-spin')).not.toBeNull();
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is not aria-busy when idle, and clicks fire', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.hasAttribute('aria-busy')).toBe(false);
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('intent/size map to distinct class sets', () => {
    const intents: ButtonIntent[] = ['primary', 'secondary', 'quiet'];
    const sizes: ButtonSize[] = ['sm', 'md'];
    const matrix: Record<string, string> = {};
    for (const intent of intents) {
      for (const size of sizes) {
        const r = render(<Button intent={intent} size={size}>x</Button>);
        matrix[`${intent}/${size}`] = r.container.firstElementChild!.getAttribute('class')!;
        r.unmount();
      }
    }
    expect(new Set(Object.values(matrix)).size).toBe(6);
    expect(matrix).toMatchSnapshot();
  });

  it('the leading icon is aria-hidden', () => {
    render(<Button icon={Plus}>Add</Button>);
    const svg = screen.getByRole('button', { name: 'Add' }).querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('ssr: renderToString does not throw and emits no inline style', () => {
    const html = renderToString(<Button busy>Save</Button>);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('style=');
  });
});

describe('IconButton', () => {
  it('has the label as its accessible name and the icon is aria-hidden', () => {
    render(<IconButton label="Add item" icon={Plus} />);
    const b = screen.getByRole('button', { name: 'Add item' });
    expect(b.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the label in a tooltip on focus', async () => {
    render(<IconButton label="Add item" icon={Plus} />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await act(async () => {
      screen.getByRole('button', { name: 'Add item' }).focus();
    });
    expect((await screen.findByRole('tooltip')).textContent).toBe('Add item');
  });

  it('busy: aria-busy and disabled', () => {
    render(<IconButton label="Add item" icon={Plus} busy />);
    const b = screen.getByRole('button', { name: 'Add item' });
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('ssr: renderToString does not throw', () => {
    expect(() => renderToString(<IconButton label="Add item" icon={Plus} />)).not.toThrow();
  });
});
