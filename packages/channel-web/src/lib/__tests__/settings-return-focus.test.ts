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
  focusSettingsOpener,
  focusSettingsOpenerWhenReady,
} from '../settings-return-focus';

/** A mutation observer callback is a microtask; let it run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
});
