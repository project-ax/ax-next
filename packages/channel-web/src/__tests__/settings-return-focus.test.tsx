/**
 * TASK-443 — closing Settings from the workspace must not drop focus on `<body>`.
 *
 * THE DEFECT. `App.tsx` renders Settings as a PANE SWAP, not as an overlay:
 * `adminSettingsOpen ? <AdminShell/> : <WorkspaceShell/>`. Opening Settings
 * unmounts the entire workspace, the user-menu trigger it was opened from
 * included; closing it mounts a brand-new workspace. Nothing in that sequence
 * moves focus, so a keyboard user who opened Settings from the menu is left on
 * `<body>` at the top of the document with every workspace control ahead of
 * them by a blind Tab crawl.
 *
 * WHY THE CARD'S PRESCRIBED FIX CANNOT WORK HERE, which is the finding that
 * shaped these tests. The card asked for #599's `consent-focus.ts` pattern —
 * capture the opener node, restore it on close "while the node is still
 * mounted". There is no such moment on this surface. The opener is destroyed
 * by the pane swap the instant Settings opens, and `use-opener-restore.ts`,
 * the repo's existing node-capture restore for Dialog/Sheet, deliberately
 * BAILS on exactly this case (`if (!opener || !opener.isConnected) return`)
 * because focusing a detached node is a silent no-op that lands on `<body>`
 * again. So the restore has to be by IDENTITY — find the opener's successor in
 * the newly-mounted tree — and that is what `settings-return-focus.ts` does.
 *
 * WHICH DIRECTION THIS FAILS IN. Both the bug and a botched fix land focus on
 * `<body>`, and a detached-node restore looks like a fix in any test that only
 * asserts "not body" — the stale node is still an element and still answers to
 * `document.activeElement` if you kept a handle on it. So these tests assert
 * the IDENTITY of the focused element against a node re-queried AFTER the
 * close, and additionally assert it is connected to the document. A restore to
 * the pre-Settings node would fail both.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { getSession, type AuthSession } from '../lib/auth';
import { fetchBootstrapStatus } from '../lib/bootstrap-status';
import { fetchFeatures } from '../lib/features';
import { workspaceApi } from '../lib/workspace-api';
import { rail as railFixture } from '../components/workspace/__tests__/rail-fixture';
import { clearViewport, setViewport } from '../components/workspace/__tests__/viewport';

vi.mock('../lib/bootstrap-status', () => ({
  fetchBootstrapStatus: vi.fn(async () => 'completed'),
}));

vi.mock('../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/auth')>();
  return { ...actual, getSession: vi.fn(async () => null) };
});

vi.mock('../lib/features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/features')>();
  return { ...actual, fetchFeatures: vi.fn(async () => actual.DEFAULT_FEATURES) };
});

// The REAL `WorkspaceShell` mounts here — unlike `workspace-gate.test.tsx`,
// which stubs it. The whole subject is the user-menu trigger the real sidebar
// renders, so a stub would test nothing. Its data layer is mocked instead.
vi.mock('../lib/workspace-api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    workspaceApi: {
      board: vi.fn(async () => ({ agents: [] })),
      agent: vi.fn(),
      route: vi.fn(),
      activity: vi.fn(async () => ({ events: [], nextBefore: null })),
      decisions: vi.fn(async () => ({ decisions: [] })),
      approveDecision: vi.fn(),
      dismissDecision: vi.fn(),
      undoDecision: vi.fn(),
      grants: vi.fn(async () => ({ grants: [] })),
      rail: vi.fn(async () => railFixture()),
      revokeGrant: vi.fn(),
    },
  };
});

// `AdminShell` is real — its back button is what calls `onClose`, and that
// wiring is half the subject. Only its DEFAULT TAB's body is stubbed: the
// skills app-store has its own data layer and its own tests, and mounting it
// here trips the workspace error boundary on an unmocked catalog fetch, which
// would replace the shell (back button included) with a fallback.
vi.mock('../components/settings/SkillsTab', () => ({
  SkillsTab: () => <div data-testid="skills-tab-stub" />,
}));
// Same reason, for the tab the TASK-510 tab-switch case moves to.
vi.mock('../components/settings/ConnectorsTab', () => ({
  ConnectorsTab: () => <div data-testid="connectors-tab-stub" />,
}));

const mockGetSession = vi.mocked(getSession);
const mockFetchBootstrapStatus = vi.mocked(fetchBootstrapStatus);
const mockFetchFeatures = vi.mocked(fetchFeatures);

const ALICE: AuthSession = {
  user: { id: 'u2', email: 'alice@local', name: 'Alice', role: 'user' },
};

function installShellFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/chat/agents')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { agentId: 'a1', displayName: 'Scout', visibility: 'personal' },
        ],
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

function setPathname(pathname: string): void {
  const loc = window.location;
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...loc, pathname, search: '', replace: vi.fn() },
  });
}

let originalLocation: Location;
beforeEach(() => {
  originalLocation = window.location;
  mockGetSession.mockReset();
  mockGetSession.mockResolvedValue(ALICE);
  mockFetchBootstrapStatus.mockReset();
  mockFetchBootstrapStatus.mockResolvedValue('completed');
  mockFetchFeatures.mockReset();
  mockFetchFeatures.mockResolvedValue({ agentWorkspacePreview: true });
  installShellFetch();
  setPathname('/workspace');
  vi.mocked(workspaceApi.board).mockResolvedValue({ agents: [] });
});
afterEach(() => {
  clearViewport();
  Object.defineProperty(window, 'location', {
    writable: true,
    value: originalLocation,
  });
});

/** The user-menu trigger, re-queried from the CURRENT tree every time. */
function userMenuTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /Alice/ });
}

/** Open Settings the way a person does: user menu → Settings. */
async function openSettingsFromWorkspace(): Promise<void> {
  const trigger = await waitFor(userMenuTrigger);
  // Radix menus open on pointerdown, not click.
  fireEvent.pointerDown(
    trigger,
    new PointerEvent('pointerdown', { bubbles: true }),
  );
  fireEvent.click(trigger);
  const entry = await waitFor(() =>
    screen.getByRole('menuitem', { name: /Settings/i }),
  );
  fireEvent.click(entry);
  // AdminShell's back button names where you came from.
  await waitFor(() => screen.getByRole('button', { name: /^workspace$/i }));
}

describe('closing Settings from the workspace (TASK-443)', () => {
  it('returns focus to the control that opened it, not to <body>', async () => {
    render(<App />);
    await openSettingsFromWorkspace();
    // Desktop really is desktop: no hamburger anywhere, so the assertion below
    // is about the opener itself and not about the compact stand-in (TASK-474).
    expect(screen.queryByRole('button', { name: /open navigation/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^workspace$/i }));

    // Re-query: the pane swap mounted a NEW workspace, so this is a different
    // node from the one clicked above. Asserting against the OLD handle would
    // pass for a detached-node restore, which is the failure mode this is
    // written to exclude.
    await waitFor(() => {
      expect(document.activeElement).toBe(userMenuTrigger());
    });
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).isConnected).toBe(true);
  });

  /**
   * Proves the test above is about the RESTORE and not about the workspace
   * merely coming back. If focus were already on the trigger before Settings
   * ever opened, the assertion above would pass on a no-op.
   */
  it('really does start from <body> — the restore is doing the work', async () => {
    render(<App />);
    await waitFor(userMenuTrigger);
    expect(document.activeElement).toBe(document.body);
  });
});

/**
 * TASK-474 — the same close on a COMPACT viewport.
 *
 * Below `md` the only `UserMenu` lives inside the nav `Sheet`, which Radix
 * unmounts while closed, and the sheet is closed when the workspace comes back.
 * So the opener never reappears and #628's by-identity wait simply expired,
 * leaving focus on `<body>`. The restore now falls back to the hamburger — a
 * DIFFERENT element from the one that opened Settings, chosen on purpose: it is
 * the control on screen that leads back to the opener.
 */
describe('closing Settings on a compact viewport (TASK-474)', () => {
  /** The hamburger, re-queried from the CURRENT tree every time. */
  function navTrigger(): HTMLElement {
    return screen.getByRole('button', { name: /open navigation/i });
  }

  async function openSettingsFromCompactNav(): Promise<void> {
    fireEvent.click(await waitFor(navTrigger));
    await openSettingsFromWorkspace();
  }

  it('lands focus on the hamburger trigger, not on <body> or <html>', async () => {
    setViewport(true);
    render(<App />);
    await openSettingsFromCompactNav();

    fireEvent.click(screen.getByRole('button', { name: /^workspace$/i }));

    await waitFor(() => {
      expect(document.activeElement).toBe(navTrigger());
    });
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(document.documentElement);
    expect((document.activeElement as HTMLElement).isConnected).toBe(true);
    // The premise, asserted rather than assumed: the opener really is gone
    // (the sheet is closed), so this is the stand-in doing the work.
    expect(screen.queryByRole('button', { name: /Alice/ })).toBeNull();
  });

  it('really does start from <body> on compact too', async () => {
    setViewport(true);
    render(<App />);
    await waitFor(navTrigger);
    expect(document.activeElement).toBe(document.body);
  });
});

/**
 * TASK-510 — the OTHER direction: opening Settings must move focus INTO it.
 *
 * Measured on kind (walk TASK-358): restore-on-close worked, but entry did
 * not — the pane swap destroys the menu item that had focus and nothing
 * focused anything in `AdminShell`, so the person was on `<body>` in a surface
 * they had not been taken to. Settings now focuses its page heading (the `h1`
 * TASK-446 made the surface's one always-present title) on mount.
 *
 * The heading is re-queried from the current tree and must be connected, and
 * the assertion is repeated after a macrotask so a deferred restore by the
 * closing menu (Radix defers its unmount auto-focus with a `setTimeout`) cannot
 * pass the first read and then take focus away.
 */
describe('opening Settings moves focus into it (TASK-510)', () => {
  function settingsHeading(): HTMLElement {
    return screen.getByRole('heading', { level: 1, name: 'Skills' });
  }

  async function expectHeadingHoldsFocus(): Promise<void> {
    await waitFor(() => {
      expect(document.activeElement).toBe(settingsHeading());
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(settingsHeading());
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).isConnected).toBe(true);
  }

  it('lands focus on the Settings heading, not <body>', async () => {
    render(<App />);
    await openSettingsFromWorkspace();
    await expectHeadingHoldsFocus();
  });

  it('does the same on a compact viewport', async () => {
    setViewport(true);
    render(<App />);
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /open navigation/i })),
    );
    await openSettingsFromWorkspace();
    await expectHeadingHoldsFocus();
  });

  it('does not pull focus back to the heading when the person switches tabs', async () => {
    render(<App />);
    await openSettingsFromWorkspace();
    await expectHeadingHoldsFocus();

    const connectors = screen.getByRole('button', { name: /Connectors/ });
    connectors.focus();
    fireEvent.click(connectors);

    await screen.findByRole('heading', { level: 1, name: 'Connectors' });
    expect(document.activeElement).toBe(connectors);
  });
});
