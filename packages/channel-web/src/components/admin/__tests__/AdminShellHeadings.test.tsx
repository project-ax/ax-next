/**
 * The Settings shell's heading OUTLINE (TASK-446).
 *
 * WHAT WAS ACTUALLY MEASURED, and it is narrower than the card claimed. The
 * card said `AdminShell` "renders zero h1–h3 at all". In jsdom on 2026-09-19,
 * against the commit before the fix, six of the nine tabs already rendered a
 * heading — `h2: Teams`, `h2: AI model keys`, `h3: Installed`, and so on. What
 * was true of all nine was narrower and still a real barrier:
 *
 *   - NO `h1`, anywhere, on any tab. The pane title — the one piece of text
 *     that says which of the nine surfaces you are on — was a `<span>`.
 *   - The two tabs everyone sees first (Skills, Connectors) opened at `h3`,
 *     skipping two levels before they began.
 *
 * So this file asserts the whole outline per tab rather than "an h1 exists":
 * the fix is the outline being right, and the ways to get it wrong (two `h1`s,
 * a body that still opens at `h3` under the new `h1`) would each pass a
 * presence check. See `test-utils/heading-outline.ts` for the four rules and
 * why "no headings at all" is one of them.
 *
 * ("Nine" is the count when that was measured. There are eleven tabs now — the
 * Usage tab (TASK-692) is the tenth, Storage (TASK-690) the eleventh — and
 * `TABS` below is the live list.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminShell } from '../AdminShell';
import { UserProvider } from '../../../lib/user-context';
import type { AuthUser } from '../../../lib/auth';
import {
  headingOutline,
  headingOutlineProblems,
} from '@/test-utils/heading-outline';

/*
  Every tab fetches on mount. These stubs answer with empty collections so the
  bodies render their real chrome (which is where the headings are) rather than
  an error pane — see `AdminShell.test.tsx`, which documents the same routes.
*/
const fetchMock = vi.fn();
function emptyResponse(url: string): Response {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  if (
    /\/admin\/credentials(\?|$)/.test(url) ||
    /\/settings\/credentials(\?|$)/.test(url)
  ) {
    return json({ credentials: [] });
  }
  if (/\/settings\/skills\/authored(\?|$)/.test(url)) return json({ skills: [] });
  if (/\/settings\/skills(\?|$)/.test(url)) return json({ skills: [] });
  if (/\/api\/chat\/catalog-skills(\?|$)/.test(url)) return json({ skills: [] });
  if (/\/admin\/catalog\/requests(\?|$)/.test(url)) return json({ requests: [] });
  if (/\/api\/chat\/connections\//.test(url)) return json({ agentId: 'a1', skills: [] });
  if (/\/api\/chat\/agents(\?|$)/.test(url)) return json([]);
  // UsageTab (TASK-692) reads a usage report; an empty day is a valid one.
  if (/\/admin\/usage(\?|$)/.test(url)) {
    return json({
      windowHours: 24,
      truncated: false,
      limits: { dailySpendUsd: 5, turnsPerHour: 60, assumedTurnCostUsd: 0.25 },
      totals: { turns: 0, spendUsd: 0, users: 0 },
      users: [],
    });
  }
  // StorageTab (TASK-690): the person's own reading, and the admin report.
  if (/\/settings\/storage(\?|$)/.test(url)) {
    return json({
      usedBytes: 1_048_576,
      limitBytes: 1_073_741_824,
      warnBytes: 858_993_459,
      workspaceBytes: 1_048_576,
      fileBytes: 0,
      status: 'ok',
    });
  }
  if (/\/admin\/storage(\?|$)/.test(url)) {
    return json({
      limits: { limitMb: 1024, warnPercent: 80 },
      defaults: { limitMb: 1024, warnPercent: 80 },
      bounds: { limitMb: { min: 64, max: 10_485_760 }, warnPercent: { min: 1, max: 99 } },
      owners: [],
      ownerCount: 0,
      totalBytes: 0,
    });
  }
  return json({ providers: [], agents: [], teams: [], connectors: [] });
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation((input: RequestInfo | URL) =>
    Promise.resolve(emptyResponse(String(input))),
  );
});

const fakeUser: AuthUser = {
  id: 'u1',
  email: 'ana@example.co',
  name: 'Ana K.',
  role: 'admin',
};

function renderShell() {
  return render(
    <UserProvider value={fakeUser}>
      <AdminShell isAdmin onClose={vi.fn()} />
    </UserProvider>,
  );
}

/**
 * Every tab in the nav, as `[the word on its button, the `h1` it must produce]`.
 * For all but one the two are the same word; Usage is the exception (the nav
 * says "Usage", the page says "Usage and limits"), which is why this is a pair
 * and not a bare name.
 *
 * `Connectors` and `Routines` are absent DELIBERATELY. Both bodies throw in
 * jsdom under a bare `fetch` stub (they read through `lib/*` modules that this
 * file does not mock), which would make their rows measure the stub rather than
 * the outline. `ConnectorsTab.test.tsx` — which has those modules mocked
 * properly — carries the outline assertion for the Connectors body instead, and
 * `RoutinesTab` has no headings of its own to place.
 */
const TABS: ReadonlyArray<readonly [nav: string, title: string]> = [
  ['Skills', 'Skills'],
  ['Agents', 'Agents'],
  ['AI model keys', 'AI model keys'],
  ['Helper model', 'Helper model'],
  ['Sign-in methods', 'Sign-in methods'],
  ['Teams', 'Teams'],
  ['Branding', 'Branding'],
  ['Usage', 'Usage and limits'],
  ['Storage', 'Storage'],
];

describe('AdminShell heading outline', () => {
  for (const [nav, title] of TABS) {
    it(`heads the ${nav} tab with a single h1 and no skipped levels`, async () => {
      renderShell();
      fireEvent.click(screen.getByRole('button', { name: nav }));

      await waitFor(() => expect(headingOutlineProblems()).toEqual([]));

      const h1s = screen.getAllByRole('heading', { level: 1 });
      expect(h1s).toHaveLength(1);
      // The `h1` is the pane title, so it says which tab you are on.
      expect(h1s[0]?.textContent).toBe(title);
    });
  }

  /*
    THE DEFAULT TAB, spelled out. Skills is what everyone lands on, and it is
    one of the two that used to open at `h3`: its two shelves were `h3`s under
    no `h1` at all. Pinning the exact outline (rather than "problems === []")
    is what stops a future edit from satisfying the generic guard by DELETING
    the shelf headings instead of levelling them.
  */
  it('opens Skills at the pane title and steps down one level to the shelves', async () => {
    renderShell();

    await waitFor(() =>
      expect(headingOutline()).toEqual([
        'h1: Skills',
        'h2: Installed',
        'h2: Not installed · available in your workspace',
      ]),
    );
  });

  /*
    USAGE, spelled out (TASK-692). Its two cards are `div`s with
    `role="heading"` at level 2, so the outline steps h1 -> h2 -> h2. The trap
    it avoids is `AlertTitle`, which is hard-coded to `<h5>` and would have put
    an h2 -> h5 jump into the outline the first time the load-error Alert grew a
    title. Pinning the exact outline (rather than "no problems") also stops a
    future edit from passing the generic guard by deleting the card headings.
  */
  it('gives Usage and limits one h1 and its two cards as h2s', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }));

    await waitFor(() =>
      expect(headingOutline()).toEqual([
        'h1: Usage and limits',
        'h2: Limits',
        'h2: Last 24 hours',
      ]),
    );
    expect(headingOutlineProblems()).toEqual([]);
  });

  /*
    STORAGE, spelled out (TASK-690). Same construction as Usage: card titles are
    `div`s at `role="heading"` level 2, so the outline steps h1 -> h2 and never
    borrows the `h5` in `AlertTitle`. An admin's tab has three cards; an
    ordinary person's has one, and that one is the same card. Pinning both
    outlines exactly (rather than "no problems") also stops an edit from
    passing the generic guard by deleting the card headings, and pins that the
    admin half is ADDED to the person's card rather than replacing it.
  */
  it('gives an admin Storage one h1 and its three cards as h2s', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Storage' }));

    await waitFor(() =>
      expect(headingOutline()).toEqual([
        'h1: Storage',
        'h2: Your storage',
        'h2: Storage limits',
        "h2: Everyone's storage",
      ]),
    );
    expect(headingOutlineProblems()).toEqual([]);
  });

  it('gives an ordinary person Storage one h1 and just their own card', async () => {
    render(
      <UserProvider value={{ ...fakeUser, role: 'user' }}>
        <AdminShell isAdmin={false} onClose={vi.fn()} />
      </UserProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Storage' }));

    await waitFor(() =>
      expect(headingOutline()).toEqual(['h1: Storage', 'h2: Your storage']),
    );
    expect(headingOutlineProblems()).toEqual([]);
  });

  /*
    The nav column sits BEFORE the pane in the DOM, and its two group labels
    ("Settings", "Admin") are not headings — if they were, the outline would
    open on them and the page title would read as a subsection of the nav group
    it came from. They stay `div`s; naming the nav groups is an `aria-label`
    job, and a separate one (TASK-437 territory).
  */
  it('does not let the sidebar group labels into the outline', async () => {
    renderShell();

    await waitFor(() => expect(headingOutlineProblems()).toEqual([]));
    expect(headingOutline()[0]).toBe('h1: Skills');
    expect(headingOutline()).not.toContain('h2: Settings');
    expect(headingOutline()).not.toContain('h2: Admin');
  });
});
