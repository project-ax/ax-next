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

  it('aria-label names a row of look-alike buttons while the visible label stays', () => {
    render(<Button aria-label="Decline Quill Bot">Decline</Button>);
    const b = screen.getByRole('button', { name: 'Decline Quill Bot' });
    expect(b.textContent).toBe('Decline');
  });

  it('busy: aria-busy and aria-disabled (not disabled), keeps the label, ignores clicks', () => {
    const onClick = vi.fn();
    render(<Button busy onClick={onClick}>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect((b as HTMLButtonElement).disabled).toBe(false);
    expect(b.textContent).toBe('Save');
    expect(b.querySelector('svg.ax-animate-spin')).not.toBeNull();
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('busy keeps focus when it becomes busy', () => {
    const { rerender } = render(<Button>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    b.focus();
    expect(document.activeElement).toBe(b);
    rerender(<Button busy>Save</Button>);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  it('busy submit button does not submit its form', () => {
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" busy>Save</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('idle submit button does submit its form', () => {
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Save</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('real disabled still uses the disabled attribute', () => {
    render(<Button disabled>Save</Button>);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('busy without an icon differs from idle only in padding and gap classes (width stays identical)', () => {
    const PAD = /^ax-(gap|px|pl|pr)-/;
    for (const size of ['sm', 'md'] as const) {
      const idle = render(<Button size={size}>Save</Button>);
      const idleCls = idle.container.firstElementChild!.getAttribute('class')!.split(' ');
      idle.unmount();
      const busy = render(<Button size={size} busy>Save</Button>);
      const busyCls = busy.container.firstElementChild!.getAttribute('class')!.split(' ');
      busy.unmount();
      const removed = idleCls.filter((c) => !busyCls.includes(c)).sort();
      const added = busyCls.filter((c) => !idleCls.includes(c)).sort();
      expect(removed, size).toEqual(['ax-gap-sm', 'ax-px-lg']);
      expect(added, size).toEqual(['ax-gap-xs', 'ax-pl-sm', 'ax-pr-sm']);
      for (const c of [...removed, ...added]) expect(c).toMatch(PAD);
    }
  });

  it('busy with an icon keeps the idle spacing classes', () => {
    const a = render(<Button icon={Plus}>Add</Button>);
    const idle = a.container.firstElementChild!.getAttribute('class');
    a.unmount();
    const b = render(<Button icon={Plus} busy>Add</Button>);
    expect(b.container.firstElementChild!.getAttribute('class')).toBe(idle);
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

  it('busy: aria-busy and aria-disabled', () => {
    render(<IconButton label="Add item" icon={Plus} busy />);
    const b = screen.getByRole('button', { name: 'Add item' });
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.getAttribute('aria-disabled')).toBe('true');
  });

  it('ssr: renderToString does not throw', () => {
    expect(() => renderToString(<IconButton label="Add item" icon={Plus} />)).not.toThrow();
  });
});
