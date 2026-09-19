/**
 * The two properties of the Settings focus restore that the App-level test
 * cannot isolate (TASK-443).
 *
 * `__tests__/settings-return-focus.test.tsx` drives the real thing end to end
 * — user menu → Settings → back → focus. What it cannot do is hold the
 * document in the awkward states this restore was written for: the opener
 * arriving a tick LATE (the workspace paints a loading screen with no sidebar
 * in it first), and somebody taking the keyboard DURING that wait. Both are
 * the difference between a restore that works on a fast machine and one that
 * works.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SETTINGS_OPENER_ATTR,
  SETTINGS_RESTORE_WINDOW_MS,
  focusSettingsOpener,
  focusSettingsOpenerWhenReady,
} from '../settings-return-focus';

/** A mutation observer callback is a microtask; let it run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Let a short restore window close. Real timers — see `SHORT_WINDOW_MS`. */
const after = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms + 10));

/**
 * A restore window short enough to close inside a test, passed explicitly.
 *
 * Real timers rather than `vi.useFakeTimers()` on purpose: the thing under test
 * is the interaction between a MUTATION OBSERVER callback (a microtask, which
 * fake timers do not drive) and a timeout. Faking only half of that pair would
 * test a schedule that cannot happen.
 */
const SHORT_WINDOW_MS = 30;

let cancel: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  cancel?.();
  cancel = null;
  document.body.innerHTML = '';
});

function addOpener(label = 'opener'): HTMLButtonElement {
  const button = document.createElement('button');
  button.setAttribute(SETTINGS_OPENER_ATTR, '');
  button.textContent = label;
  document.body.appendChild(button);
  return button;
}

describe('focusSettingsOpener', () => {
  it('focuses the marked control and says so', () => {
    const opener = addOpener();
    expect(focusSettingsOpener()).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('reports false rather than silently doing nothing when there is no opener', () => {
    // The fail-open direction: no marked node means focus stays on <body>,
    // which is indistinguishable from the bug unless the caller is told.
    expect(focusSettingsOpener()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('reports false when the marked control refuses focus', () => {
    const opener = addOpener();
    opener.disabled = true;
    // Checked against `activeElement`, not against having called `.focus()` —
    // a disabled control accepts the call and ignores it.
    expect(focusSettingsOpener()).toBe(false);
    expect(document.activeElement).not.toBe(opener);
  });
});

describe('focusSettingsOpenerWhenReady', () => {
  it('waits for an opener that is not rendered yet', async () => {
    // This is the measured shape of the real close: `WorkspaceShell` re-reads
    // its board and renders "Loading your workspace…" with no sidebar, so at
    // the moment Settings closes there is nothing to focus.
    cancel = focusSettingsOpenerWhenReady();
    expect(document.activeElement).toBe(document.body);

    const opener = addOpener();
    await flush();

    expect(document.activeElement).toBe(opener);
  });

  it('gives way to whoever took the keyboard while it waited', async () => {
    cancel = focusSettingsOpenerWhenReady();

    // Someone Tabs onto the "Try again" button on the loading/error screen.
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    const opener = addOpener();
    await flush();

    // Yanking them off a control they chose is worse than the bug.
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(opener);
  });

  it('stops waiting once cancelled', async () => {
    const stop = focusSettingsOpenerWhenReady();
    stop();

    addOpener();
    await flush();

    // Re-opening Settings, or unmounting, must call off a restore that would
    // otherwise land on a surface nobody is looking at any more.
    expect(document.activeElement).toBe(document.body);
  });

  it('focuses straight away when the opener is already there', async () => {
    const opener = addOpener();
    cancel = focusSettingsOpenerWhenReady();
    expect(document.activeElement).toBe(opener);
  });

  it('treats <html> as nobody, the way it treats <body>', async () => {
    // Engines disagree about what an unfocused document reports. `<body>`,
    // `<html>` and `null` all mean "the focused thing went away", not "a
    // person is standing here", so the restore must still happen.
    //
    // The `tabIndex` is a test rig, not the case being described: jsdom
    // silently ignores `focus()` on an element that is not focusable, so
    // without it `activeElement` stays `<body>` and this test passes whatever
    // the predicate does. Measured — it did exactly that before the tabIndex
    // was added, and stayed green with the `documentElement` case deleted from
    // `keyboardIsClaimed`.
    const html = document.documentElement;
    const originalTabIndex = html.getAttribute('tabindex');
    html.tabIndex = -1;
    try {
      cancel = focusSettingsOpenerWhenReady();
      html.focus();
      expect(document.activeElement).toBe(html);

      const opener = addOpener();
      await flush();

      expect(document.activeElement).toBe(opener);
    } finally {
      // Hand focus back before restoring the attribute — a still-focused
      // `<html>` would leak into the next test and abort ITS restore under the
      // yield rule, which is how a broken predicate could turn one red test
      // into three confusing ones.
      html.blur();
      if (originalTabIndex === null) html.removeAttribute('tabindex');
      else html.setAttribute('tabindex', originalTabIndex);
    }
  });
});

/**
 * The blocker this file grew for (review of #628).
 *
 * The first cut waited for an opener that it assumed would always arrive. Two
 * reachable surfaces never produce one: a narrow viewport, where the only
 * `UserMenu` lives inside a closed `Sheet` that Radix unmounts, and a board
 * read that blips on the way back, whose "Try again" screen has no sidebar. On
 * both, focus stays on `<body>` so the yield rule never trips either — leaving
 * a `subtree: true` observer attached to `document.body` for the rest of the
 * session, still able to fire minutes later and steal the keyboard from a nav
 * sheet opened for a different reason.
 */
describe('focusSettingsOpenerWhenReady — the wait ENDS', () => {
  it('gives up when the opener never comes back', async () => {
    cancel = focusSettingsOpenerWhenReady(document, SHORT_WINDOW_MS);

    // The surface comes back without an opener in it, and keeps churning —
    // this is the compact / error-screen shape.
    document.body.appendChild(document.createElement('div'));
    await flush();
    await after(SHORT_WINDOW_MS);

    // The late opener: the person taps the hamburger minutes later and the nav
    // sheet mounts its user menu. That is navigation, not a Settings close.
    const late = addOpener();
    await flush();

    expect(document.activeElement).not.toBe(late);
    expect(document.activeElement).toBe(document.body);
  });

  it('still restores inside the window, so giving up is not the whole story', async () => {
    // The anti-vacuity half: if the window were zero — or the give-up ran
    // eagerly — the test above would pass for the wrong reason.
    cancel = focusSettingsOpenerWhenReady(document, SHORT_WINDOW_MS);

    const opener = addOpener();
    await flush();

    expect(document.activeElement).toBe(opener);
  });

  it('ships a window that is a real, positive duration', () => {
    // A zero or negative default would make the restore dead on arrival in the
    // app while every test above still passed on its explicit override.
    expect(SETTINGS_RESTORE_WINDOW_MS).toBeGreaterThan(0);
  });
});
