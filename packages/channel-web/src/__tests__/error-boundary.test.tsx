/**
 * ErrorBoundary — the backstop under every render-phase throw in the SPA.
 *
 * Context (TASK-273): `packages/channel-web/src` had no error boundary at
 * all, so any throw during React's render phase unmounted the entire chat
 * SPA into a blank page. Response validation at the API boundary
 * (`WorkspaceShapeError`) is the primary defence; this is the floor
 * underneath it for everything nobody thought to guard.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../components/ErrorBoundary';

function Boom(): never {
  throw new Error('shape drift: watchedKey.filter of undefined');
}

function Calm() {
  return <div>all good</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary surface="test">
        <Calm />
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeTruthy();
  });

  it('renders the fallback instead of propagating when a child throws during render', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary surface="test">
        <Boom />
      </ErrorBoundary>,
    );
    // The throw must not reach the test runner — the fallback speaks instead.
    expect(screen.getByText(/this part hit a snag/i)).toBeTruthy();
    expect(screen.queryByText(/shape drift/)).toBeNull();
  });

  it('try-again resets the boundary so the subtree can recover', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    const Flaky = () => {
      if (shouldThrow) throw new Error('transient');
      return <div>recovered</div>;
    };
    render(
      <ErrorBoundary surface="test">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/this part hit a snag/i)).toBeTruthy();
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('recovered')).toBeTruthy();
  });

  it('renders a custom fallback when one is provided', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary surface="test" fallback={<div>custom panel-down note</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('custom panel-down note')).toBeTruthy();
  });
});
