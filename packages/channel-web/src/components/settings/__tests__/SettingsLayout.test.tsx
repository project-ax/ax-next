import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { List } from '@project-ax/ui';
import { SettingsHelp, SheetRow } from '../SettingsLayout';
import { Button } from '@/components/ui/button';

describe('Settings interactions', () => {
  it('opens persistent help and dismisses it without leaving the page', async () => {
    render(<><h1>Skills</h1><SettingsHelp title="Skills">Choose an agent to manage its skills.</SettingsHelp></>);
    const trigger = screen.getByRole('button', { name: 'About Skills' });
    fireEvent.click(trigger);
    expect(screen.getByText('Choose an agent to manage its skills.')).toBeVisible();
    fireEvent.keyDown(screen.getByText('Choose an agent to manage its skills.'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Choose an agent to manage its skills.')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeVisible();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps secondary actions in details and restores focus when dismissed', async () => {
    const remove = vi.fn();
    render(<List label="Skills"><SheetRow title="Research brief" meta="Scout · Enabled"><Button onClick={remove}>Remove skill</Button></SheetRow></List>);
    expect(screen.queryByRole('button', { name: 'Remove skill' })).toBeNull();
    const row = within(screen.getByRole('list', { name: 'Skills' })).getByRole('button', { name: 'Research brief' });
    row.focus();
    fireEvent.click(row);
    expect(screen.getByRole('dialog', { name: 'Research brief' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove skill' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    await waitFor(() => expect(row).toHaveFocus());
  });
});

describe('SheetRow focus return', () => {
  it('returns focus to the row title after a click-only open (no prior .focus(), as in Safari)', async () => {
    render(<List label="Skills"><SheetRow title="Research brief" meta="Scout"><Button>Remove skill</Button></SheetRow></List>);
    const row = within(screen.getByRole('list', { name: 'Skills' })).getByRole('button', { name: 'Research brief' });
    expect(row).not.toHaveFocus();
    fireEvent.click(row);
    expect(screen.getByRole('dialog', { name: 'Research brief' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(row).toHaveFocus());
  });
});
