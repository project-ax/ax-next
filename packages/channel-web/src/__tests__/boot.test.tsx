import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { App } from '../App';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  // Stub `/api/auth/get-session` so the auth-gate effect doesn't blow up
  // mid-render. We never resolve it — first paint shows the loading
  // state and the boot test only cares that mounting doesn't throw.
  fetchMock.mockReturnValue(
    new Promise(() => {
      /* never resolves */
    }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('boot', () => {
  it('mounts the App without throwing', () => {
    const { container } = render(<App />);
    // First paint while auth fetch is in flight is the loading state.
    expect(container.textContent).toMatch(/connecting/i);
  });
});
