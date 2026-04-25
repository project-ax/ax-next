/**
 * Vitest setup — runs once per worker before any tests.
 *
 * @testing-library/react ships an automatic cleanup that hooks into
 * the `afterEach` global. We run with `globals: false` (explicit imports
 * everywhere, smaller surface), so we wire cleanup manually here so
 * components rendered by one test don't leak into the next.
 *
 * jsdom doesn't ship `ResizeObserver`, but assistant-ui's
 * `ThreadPrimitive.Viewport` registers one via `useOnResizeContent` to
 * track autoscroll. We install a no-op stub so the primitive can mount
 * in tests without exploding.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // Cast through `unknown` because the DOM lib's ResizeObserver type
  // expects callback wiring we don't need here.
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub })
    .ResizeObserver = ResizeObserverStub;
}

afterEach(() => {
  cleanup();
});
