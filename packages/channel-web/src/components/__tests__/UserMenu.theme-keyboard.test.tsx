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

async function openAppearanceWithKeyboard() {
  await openWithKeyboard();
  const appearance = screen.getByRole('menuitem', { name: 'Appearance' });
  await pressAndExpectFocus('ArrowDown', appearance);
  fireEvent.keyDown(appearance, { key: 'ArrowRight' });
  await screen.findByRole('group', { name: 'Theme' });
  await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveFocus());
}

async function pressAndExpectFocus(key: string, target: HTMLElement): Promise<void> {
  const from = document.activeElement;
  if (!(from instanceof HTMLElement)) throw new Error('nothing focused');
  fireEvent.keyDown(from, { key });
  await waitFor(() => expect(document.activeElement).toBe(target));
}

describe('UserMenu Theme control — keyboard (TASK-500)', () => {
  it('walks the account menu and opens the Appearance submenu with ArrowRight', async () => {
    await openWithKeyboard();
    const appearance = screen.getByRole('menuitem', { name: 'Appearance' });
    const signOut = screen.getByRole('menuitem', { name: 'Sign out' });
    await pressAndExpectFocus('ArrowDown', appearance);
    await pressAndExpectFocus('ArrowDown', signOut);
    await pressAndExpectFocus('ArrowUp', appearance);
    fireEvent.keyDown(appearance, { key: 'ArrowRight' });
    const light = await screen.findByRole('menuitemradio', { name: 'Light' });
    await waitFor(() => expect(light).toHaveFocus());
    await pressAndExpectFocus('ArrowDown', screen.getByRole('menuitemradio', { name: 'Dark' }));
    await pressAndExpectFocus('ArrowDown', screen.getByRole('menuitemradio', { name: 'System' }));
    await pressAndExpectFocus('ArrowUp', screen.getByRole('menuitemradio', { name: 'Dark' }));
    await pressAndExpectFocus('ArrowLeft', appearance);
  });

  it('aria-checked marks the current theme (System when nothing is pinned)', async () => {
    await openAppearanceWithKeyboard();
    const group = screen.getByRole('group', { name: 'Theme' });
    const checked = within(group)
      .getAllByRole('menuitemradio')
      .filter((el) => el.getAttribute('aria-checked') === 'true')
      .map((el) => el.textContent?.trim());
    expect(checked).toEqual(['System']);
  });

  it('Enter on a focused option selects it, moves aria-checked, and keeps the menu open', async () => {
    await openAppearanceWithKeyboard();
    const group = screen.getByRole('group', { name: 'Theme' });
    const light = within(group).getByRole('menuitemradio', { name: 'Light' });
    const dark = within(group).getByRole('menuitemradio', { name: 'Dark' });

    expect(light).toHaveFocus();
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
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    expect(dark.isConnected).toBe(true);
  });
});
