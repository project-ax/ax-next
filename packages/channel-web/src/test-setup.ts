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
 *
 * Radix Popover + cmdk also require a few DOM APIs that jsdom omits:
 * - `Element.prototype.scrollIntoView` — called by cmdk to scroll the
 *   selected item into view on mount/navigation.
 * - `Element.prototype.hasPointerCapture` — read by Radix's dismissable-
 *   layer to decide whether a pointer event should close the popover.
 * - `window.PointerEvent` — Radix registers pointerdown listeners; jsdom
 *   dispatches MouseEvents instead, so we alias PointerEvent → MouseEvent
 *   so `instanceof PointerEvent` checks don't throw.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

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

// cmdk calls scrollIntoView when the selected item changes.
// Radix dismissable-layer reads hasPointerCapture.
// Guard with `typeof Element` so these don't explode in SSR/node workers.
if (typeof Element !== 'undefined') {
  if (typeof Element.prototype.scrollIntoView === 'undefined') {
    Element.prototype.scrollIntoView = () => {};
  }
  if (typeof Element.prototype.hasPointerCapture === 'undefined') {
    // Return false so Radix dismissable-layer leaves the popover open during tests.
    Element.prototype.hasPointerCapture = () => false;
  }
}

// Radix registers pointerdown listeners; jsdom lacks PointerEvent.
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).PointerEvent = window.MouseEvent;
}

afterEach(() => {
  cleanup();
});
