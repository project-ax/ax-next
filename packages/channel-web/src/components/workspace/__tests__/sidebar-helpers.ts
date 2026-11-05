/**
 * Driving the sidebar's agent switcher from a test.
 *
 * The roster used to be a list of buttons; it is now a Radix dropdown, which
 * opens on `pointerdown` (jsdom's `click` alone does not). Every test that
 * opens an agent or the new-agent flow goes through these, so the next change
 * to the switcher is one edit, not twenty.
 */
import { fireEvent, screen } from '@testing-library/react';

/** The switcher trigger — also the new-agent flow's focus-return target. */
export function switcherTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /Switch agent/ });
}

/** Open the switcher's menu and return it. */
export async function openSwitcher(): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: /Switch agent/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}

/** Pick an agent from the switcher by (a prefix of) its name. */
export async function pickAgent(name: string | RegExp): Promise<void> {
  await openSwitcher();
  const matcher = typeof name === 'string' ? new RegExp(`^${name}\\b`) : name;
  fireEvent.click(await screen.findByRole('menuitem', { name: matcher }));
}

/** Open the new-agent flow through the switcher's "New agent" item. */
export async function chooseNewAgent(): Promise<void> {
  await openSwitcher();
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New agent' }));
}

/** Open the selected agent's ⋮ menu. */
export async function openAgentOptions(name: string): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: `Options for ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}
