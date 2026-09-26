/**
 * TASK-500 — the Theme control has to be operable from the keyboard.
 *
 * The card described the defect as "a radiogroup with no arrow keys". Measured
 * against the unfixed component it was worse: the control sat inside a Radix
 * `DropdownMenu`, whose content `preventDefault`s Tab and whose roving focus
 * only walks `menuitem`s — so ArrowDown went Settings → Sign out and the three
 * theme buttons could not be focused by keyboard at all.
 *
 * Everything below is asserted through the accessibility tree and
 * `document.activeElement` (jsdom has no layout, so nothing visual would mean
 * anything). Radix moves menu focus on a `setTimeout`, hence `waitFor`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UserMenu } from '../UserMenu';
import { UserProvider } from '../../lib/user-context';
import { setTheme } from '../../lib/theme';

const user = { id: 'u1', email: 'alice@local', name: 'Alice', role: 'user' as const };

beforeEach(() => {
  localStorage.clear();
  setTheme('auto');
});
afterEach(() => {
  setTheme('auto');
  localStorage.clear();
});

/** Open the menu the way a keyboard user does: focus the trigger, press Enter. */
async function openWithKeyboard(): Promise<HTMLElement> {
  render(
    <UserProvider value={user}>
      <UserMenu onOpenAdminSettings={() => {}} />
    </UserProvider>,
  );
  const trigger = screen.getByRole('button', { name: /Alice/ });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const settings = await screen.findByRole('menuitem', { name: 'Settings' });
  await waitFor(() => expect(document.activeElement).toBe(settings));
  return settings;
}

async function pressAndExpectFocus(key: string, target: HTMLElement): Promise<void> {
  const from = document.activeElement;
  if (!(from instanceof HTMLElement)) throw new Error('nothing focused');
  fireEvent.keyDown(from, { key });
  await waitFor(() => expect(document.activeElement).toBe(target));
}

describe('UserMenu Theme control — keyboard (TASK-500)', () => {
  it('ArrowDown walks Settings → Light → Dark → System → Sign out, and ArrowUp walks back', async () => {
    await openWithKeyboard();
    const group = screen.getByRole('group', { name: 'Theme' });
    const light = within(group).getByRole('menuitemradio', { name: 'Light' });
    const dark = within(group).getByRole('menuitemradio', { name: 'Dark' });
    const system = within(group).getByRole('menuitemradio', { name: 'System' });
    const signOut = screen.getByRole('menuitem', { name: 'Sign out' });

    await pressAndExpectFocus('ArrowDown', light);
    await pressAndExpectFocus('ArrowDown', dark);
    await pressAndExpectFocus('ArrowDown', system);
    await pressAndExpectFocus('ArrowDown', signOut);
    await pressAndExpectFocus('ArrowUp', system);
    await pressAndExpectFocus('ArrowUp', dark);
  });

  it('aria-checked marks the current theme (System when nothing is pinned)', async () => {
    await openWithKeyboard();
    const group = screen.getByRole('group', { name: 'Theme' });
    const checked = within(group)
      .getAllByRole('menuitemradio')
      .filter((el) => el.getAttribute('aria-checked') === 'true')
      .map((el) => el.textContent?.trim());
    expect(checked).toEqual(['System']);
  });

  it('Enter on a focused option selects it, moves aria-checked, and keeps the menu open', async () => {
    await openWithKeyboard();
    const group = screen.getByRole('group', { name: 'Theme' });
    const light = within(group).getByRole('menuitemradio', { name: 'Light' });
    const dark = within(group).getByRole('menuitemradio', { name: 'Dark' });

    await pressAndExpectFocus('ArrowDown', light);
    await pressAndExpectFocus('ArrowDown', dark);
    fireEvent.keyDown(dark, { key: 'Enter' });

    await waitFor(() => expect(dark.getAttribute('aria-checked')).toBe('true'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('ax-theme')).toBe('dark');
    expect(
      within(group)
        .getAllByRole('menuitemradio')
        .filter((el) => el.getAttribute('aria-checked') === 'true'),
    ).toEqual([dark]);
    // Picking a theme is a preview-and-compare action — the menu stays put so
    // the next arrow press can try another one.
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(dark.isConnected).toBe(true);
  });
});
