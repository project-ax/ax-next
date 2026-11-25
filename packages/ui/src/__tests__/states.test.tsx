// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AsyncState, EmptyState, Notice, Stack } from '../index.js';

afterEach(cleanup);

// Radix popper (IconButton tooltip) measures with ResizeObserver, which jsdom lacks.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('Notice', () => {
  it('danger and warning have role alert; info and success have role status', () => {
    const { unmount } = render(<Notice tone="danger">Bad</Notice>);
    expect(screen.getByRole('alert').textContent).toBe('Bad');
    unmount();
    render(<Notice tone="warning">Careful</Notice>);
    expect(screen.getByRole('alert')).toBeTruthy();
    cleanup();
    render(<Notice tone="info">FYI</Notice>);
    expect(screen.getByRole('status').textContent).toBe('FYI');
    cleanup();
    render(<Notice tone="success">Done</Notice>);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('action renders a button with the label and calls onClick', () => {
    const onClick = vi.fn();
    render(<Notice tone="info" action={{ label: 'Reconnect', onClick }}>x</Notice>);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('onDismiss renders "Dismiss" and calls the handler', () => {
    const onDismiss = vi.fn();
    render(<Notice tone="info" onDismiss={onDismiss}>x</Notice>);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders no buttons without action or onDismiss, and shows the title', () => {
    render(<Notice tone="danger" title="Heads up">x</Notice>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Heads up')).toBeTruthy();
  });
});

describe('Notice body', () => {
  it('accepts block content without invalid-nesting console errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <Notice tone="info">
        <Stack>
          <div data-testid="block">block body</div>
        </Stack>
      </Notice>,
    );
    expect(screen.getByRole('status').contains(screen.getByTestId('block'))).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('EmptyState', () => {
  it('title is a heading', () => {
    render(<EmptyState title="Nothing here" description="Add one" icon={Inbox} />);
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeTruthy();
    expect(screen.getByText('Add one')).toBeTruthy();
  });

  it('action renders a button that calls onClick', () => {
    const onClick = vi.fn();
    render(<EmptyState title="t" action={{ label: 'Create', onClick }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('AsyncState', () => {
  it('loading: role status, aria-busy, sr label, no children rendered', () => {
    render(
      <AsyncState status="loading" skeleton="rows" loadingLabel="Loading sites">
        <p>content</p>
      </AsyncState>,
    );
    const s = screen.getByRole('status');
    expect(s.getAttribute('aria-busy')).toBe('true');
    expect(s.textContent).toBe('Loading sites');
    expect(screen.queryByText('content')).toBeNull();
  });

  it('loading skeletons have the documented bar counts', () => {
    const count = (shape: 'rows' | 'lines' | 'block') => {
      const { container, unmount } = render(<AsyncState status="loading" skeleton={shape} loadingLabel="l" />);
      const n = container.querySelectorAll('.ax-animate-pulse').length;
      unmount();
      return n;
    };
    expect([count('rows'), count('lines'), count('block')]).toEqual([3, 3, 1]);
  });

  it('skeleton bars use the muted fill (surface-raised is invisible on the light page)', () => {
    for (const shape of ['rows', 'lines', 'block'] as const) {
      const { container, unmount } = render(<AsyncState status="loading" skeleton={shape} loadingLabel="l" />);
      const bars = container.querySelectorAll('.ax-animate-pulse');
      expect(bars.length).toBeGreaterThan(0);
      for (const b of bars) {
        expect(b.classList.contains('ax-bg-muted')).toBe(true);
        expect(b.classList.contains('ax-bg-surface-raised')).toBe(false);
      }
      unmount();
    }
  });

  it('error with onRetry shows exactly "Try again"; without onRetry shows no button', () => {
    const onRetry = vi.fn();
    const { unmount } = render(
      <AsyncState status="error" skeleton="rows" loadingLabel="l" error={{ message: 'Nope', onRetry }} />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Nope');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();
    render(<AsyncState status="error" skeleton="rows" loadingLabel="l" error={{ message: 'Nope' }} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('error tone info renders role status (read-register: expired session)', () => {
    render(
      <AsyncState status="error" skeleton="rows" loadingLabel="l" error={{ message: 'Session expired', tone: 'info' }} />,
    );
    expect(screen.getByRole('status').textContent).toContain('Session expired');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('error without an error object falls back to a generic message', () => {
    render(<AsyncState status="error" skeleton="rows" loadingLabel="l" />);
    expect(screen.getByRole('alert').textContent).toBe('Something went wrong.');
  });

  it('empty renders EmptyState; a missing empty renders nothing', () => {
    const { unmount } = render(
      <AsyncState status="empty" skeleton="rows" loadingLabel="l" empty={{ title: 'No sites yet' }}>
        <p>content</p>
      </AsyncState>,
    );
    expect(screen.getByRole('heading', { name: 'No sites yet' })).toBeTruthy();
    expect(screen.queryByText('content')).toBeNull();
    unmount();
    const r = render(<AsyncState status="empty" skeleton="rows" loadingLabel="l" />);
    expect(r.container.innerHTML).toBe('');
  });

  it('ready renders children only', () => {
    render(
      <AsyncState status="ready" skeleton="rows" loadingLabel="Loading" error={{ message: 'e' }} empty={{ title: 't' }}>
        <p>content</p>
      </AsyncState>,
    );
    expect(screen.getByText('content')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('SSR', () => {
  it('renders every status to a string', () => {
    const base = { skeleton: 'lines', loadingLabel: 'Loading' } as const;
    expect(renderToString(<AsyncState {...base} status="loading" />)).toContain('Loading');
    expect(renderToString(<AsyncState {...base} status="error" error={{ message: 'E', onRetry: () => {} }} />)).toContain('Try again');
    expect(renderToString(<AsyncState {...base} status="empty" empty={{ title: 'Empty', icon: Inbox }} />)).toContain('Empty');
    expect(renderToString(<AsyncState {...base} status="ready">ok</AsyncState>)).toBe('ok');
    expect(renderToString(<Notice tone="warning" title="T" onDismiss={() => {}} action={{ label: 'A', onClick: () => {} }}>b</Notice>)).toContain('Dismiss');
  });
});
