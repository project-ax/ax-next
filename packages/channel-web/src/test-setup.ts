/**
 * Vitest setup — runs once per worker before any tests.
 *
 * @testing-library/react ships an automatic cleanup that hooks into
 * the `afterEach` global. We run with `globals: false` (explicit imports
 * everywhere, smaller surface), so we wire cleanup manually here so
 * components rendered by one test don't leak into the next.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
