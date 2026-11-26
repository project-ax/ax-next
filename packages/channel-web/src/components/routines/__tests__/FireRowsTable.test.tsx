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
import { render, screen, within } from '@testing-library/react';
import { FireRowsTable } from '../FireRowsTable';
import type { Fire } from '@/lib/routines';

/** Same instant for both fires — the collision case. */
const SHARED_FIRED_AT = '2026-05-17T01:00:00.000Z';

const firstFire: Fire = {
  agentId: 'agt_a',
  routineId: 'r1',
  firedAt: SHARED_FIRED_AT,
  triggerSource: 'tick',
  status: 'ok',
  error: null,
  warning: null,
  conversationId: 'cnv_1',
  renderedPrompt: 'first fire prompt',
  report: null,
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

/**
 * "This run went without a connector" (slice 6). A run that skipped a connector
 * still finished — it is a note about the run, not a failure — so it is drawn
 * as muted text with a warning mark, NOT in the destructive register the
 * `error` line uses.
 */
describe('FireRowsTable warning', () => {
  const WARNING = "Gmail isn't signed in on Bob, so this run went without it.";

  it("shows a fire's warning under its status", () => {
    render(<FireRowsTable fires={[{ ...firstFire, warning: WARNING }]} />);
    const line = screen.getByTestId('routine-warning');
    expect(line.textContent).toContain(WARNING);
    expect(line.getAttribute('title')).toBe(WARNING);
    expect(screen.getByText(WARNING)).toBeTruthy();
    // The run history wraps, so the whole sentence reads; isolated direction.
    const text = line.querySelector('[dir="auto"]')!;
    expect(text.className).toContain('break-words');
    expect(text.className).not.toContain('truncate');
    expect(text.textContent).toContain(WARNING);
  });

  it('is not styled as an error', () => {
    const { container } = render(
      <FireRowsTable fires={[{ ...firstFire, warning: WARNING }]} />,
    );
    const line = screen.getByTestId('routine-warning');
    expect(line.className).toContain('text-muted-foreground');
    expect(line.className).not.toContain('destructive');
    // Nothing inside the warning line is destructive either.
    expect(line.querySelector('[class*="destructive"]')).toBeNull();
    // And no destructive text anywhere in the row apart from the status chip
    // (which is `ok` here, so nothing at all).
    expect(container.querySelector('[class*="destructive"]')).toBeNull();
  });

  it('draws no warning line for a fire without one', () => {
    render(<FireRowsTable fires={[firstFire, secondFire]} />);
    expect(screen.queryByTestId('routine-warning')).toBeNull();
  });

  it('keeps a warning and an error apart: the error stays destructive, the warning does not', () => {
    render(
      <FireRowsTable
        fires={[{ ...firstFire, status: 'error', error: 'boom', warning: WARNING }]}
      />,
    );
    // The whole message wraps in a danger notice under the row (not a one-line badge); the warning stays out of it.
    const error = screen.getByText('boom');
    expect(error.closest('[class*="status-danger"]')).not.toBeNull();
    expect(error.closest('li')).toBe(screen.getByTestId('routine-warning').closest('li'));
    expect(screen.getByTestId('routine-warning').className).not.toContain('destructive');
  });

  it('renders a hostile warning as literal text', () => {
    const hostile = '<img src=x onerror=alert(1)><b>bold</b>';
    const { container } = render(<FireRowsTable fires={[{ ...firstFire, warning: hostile }]} />);
    expect(screen.getByText(hostile)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('FireRowsTable list', () => {
  it('is a compact named list, one row per run, with its prompt shown under the row', () => {
    render(<FireRowsTable fires={[firstFire, { ...firstFire, firedAt: '2026-05-17T02:00:00.000Z', renderedPrompt: 'later prompt' }]} />);
    const list = screen.getByRole('list', { name: 'Recent runs' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('first fire prompt');
    expect(rows[1]).toHaveTextContent('later prompt');
    // Prompt, warning and error sit under their row with no toggle: no two rows share a button name.
    expect(within(rows[0]!).getByText('Run by tick')).toBeInTheDocument();
    expect(within(list).queryAllByRole('button')).toEqual([]);
    expect(rows[0]!.querySelector('time')).not.toBeNull();
  });
});
