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
 * Every tab in the nav, by the word on its button — which is also the pane
 * title, and therefore the `h1` each one must produce.
 *
 * `Connectors` and `Routines` are absent DELIBERATELY. Both bodies throw in
 * jsdom under a bare `fetch` stub (they read through `lib/*` modules that this
 * file does not mock), which would make their rows measure the stub rather than
 * the outline. `ConnectorsTab.test.tsx` — which has those modules mocked
 * properly — carries the outline assertion for the Connectors body instead, and
 * `RoutinesTab` has no headings of its own to place.
 */
const TABS = [
  'Skills',
  'Agents',
  'AI model keys',
  'Helper model',
  'Sign-in methods',
  'Teams',
  'Branding',
];

describe('AdminShell heading outline', () => {
  for (const tab of TABS) {
    it(`heads the ${tab} tab with a single h1 and no skipped levels`, async () => {
      renderShell();
      fireEvent.click(screen.getByRole('button', { name: tab }));

      await waitFor(() => expect(headingOutlineProblems()).toEqual([]));

      const h1s = screen.getAllByRole('heading', { level: 1 });
      expect(h1s).toHaveLength(1);
      // The `h1` is the pane title, so it says which of the nine you are on.
      expect(h1s[0]?.textContent).toBe(tab);
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
