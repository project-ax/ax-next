import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsDetailRow, SettingsHelp } from '../SettingsLayout';
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
    render(<SettingsDetailRow label="Research brief" detail="Scout" value="Enabled"><Button onClick={remove}>Remove skill</Button></SettingsDetailRow>);
    expect(screen.queryByRole('button', { name: 'Remove skill' })).toBeNull();
    const row = screen.getByRole('button', { name: 'Details for Research brief' });
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
