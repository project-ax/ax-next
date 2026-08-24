/**
 * FireRowsTable — React keys for the admin fires table (TASK-312).
 *
 * Why this file exists: the fires that reach this table used to carry the
 * store's `BIGSERIAL` row id, and the table keyed off it. That id is storage
 * vocabulary and no longer crosses the hook bus, so the key had to move — and
 * moving it is the kind of change that breaks *silently*. `HookBus.call`
 * returns `returns.safeParse(...).data` and zod strips undeclared keys, while
 * the HTTP hop into this component is an untyped `get<T>` plus a cast. A key
 * that resolves to `undefined` therefore produces zero tsc errors and zero
 * failing assertions anywhere else in the repo — only React's dev-mode key
 * warning notices.
 *
 * Pinned behaviors:
 *   - Two fires that share the same `firedAt` (postgres stores microseconds,
 *     the wire carries milliseconds — sub-millisecond fires DO collide) both
 *     render, and React emits no key warning.
 *   - No key warning at all, which covers both failure modes:
 *       * "Each child in a list should have a unique key prop" — what a key
 *         pointing at a stripped field (`f.id`) produces.
 *       * "Encountered two children with the same key" — what a key made only
 *         of `firedAt` would produce for the fires below.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FireRowsTable } from '../FireRowsTable';
import type { Fire } from '@/lib/routines';

/** Same instant for both fires — the collision case. */
const SHARED_FIRED_AT = new Date('2026-05-17T01:00:00.000Z');

const firstFire: Fire = {
  agentId: 'agt_a',
  path: 'heartbeat.md',
  firedAt: SHARED_FIRED_AT,
  triggerSource: 'tick',
  status: 'ok',
  error: null,
  conversationId: 'cnv_1',
  renderedPrompt: 'first fire prompt',
};

const secondFire: Fire = {
  ...firstFire,
  // A distinct row in the store, indistinguishable on the wire: same agent,
  // same path, same millisecond.
  conversationId: 'cnv_2',
  renderedPrompt: 'second fire prompt',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FireRowsTable React keys', () => {
  it('renders two fires sharing firedAt with no React key warning', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<FireRowsTable fires={[firstFire, secondFire]} />);

    // Both rows are on screen — a key collision would still render both, so
    // this guards the render, and the warning assertion below guards the key.
    expect(screen.getByText('first fire prompt')).toBeTruthy();
    expect(screen.getByText('second fire prompt')).toBeTruthy();

    const keyWarnings = errorSpy.mock.calls.filter((call) =>
      call.some((arg) => typeof arg === 'string' && /key/i.test(arg)),
    );
    expect(keyWarnings).toEqual([]);
  });

  it('renders each fire as its own row', () => {
    render(<FireRowsTable fires={[firstFire, secondFire]} />);
    // Status chip per fire — two fires, two chips.
    expect(screen.getAllByText('ok')).toHaveLength(2);
  });
});
