// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfirmAction, type ConfirmActionProps } from '../index.js';

afterEach(cleanup);

// Radix popper (the IconButton trigger's tooltip) measures with ResizeObserver, which jsdom lacks.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// A promise the test settles by hand, so the pending state can be observed.
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const base = {
  title: 'Remove example.com?',
  description: 'Agents will stop reaching this site.',
  confirmLabel: 'Remove site',
} as const;

function renderTrigger(props: Partial<ConfirmActionProps> = {}) {
  const onConfirm = vi.fn<() => Promise<void> | void>();
  const all = { ...base, onConfirm, trigger: { label: 'Remove' }, ...props } as ConfirmActionProps;
  render(<ConfirmAction {...all} />);
  return { onConfirm: all.onConfirm };
}

const trigger = () => screen.getByRole('button', { name: 'Remove' });
const confirmButton = () => screen.getByRole('button', { name: 'Remove site' });
const cancelButton = () => screen.getByRole('button', { name: 'Cancel' });
const open = () => fireEvent.click(trigger());

describe('ConfirmAction', () => {
  it('opens from trigger; title and description are the dialog\'s name and description', () => {
    renderTrigger();
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(base.title);
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe(base.description);
    expect(screen.getByRole('dialog', { name: base.title })).toBe(dialog);
  });

  it('Cancel closes without calling onConfirm', async () => {
    const { onConfirm } = renderTrigger();
    open();
    fireEvent.click(cancelButton());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirm resolves → onConfirm called once, dialog closes, focus back on trigger', async () => {
    const d = deferred();
    const { onConfirm } = renderTrigger({ onConfirm: vi.fn(() => d.promise) });
    open();
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => d.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it('double click on confirm while pending calls onConfirm once', async () => {
    const d = deferred();
    const { onConfirm } = renderTrigger({ onConfirm: vi.fn(() => d.promise) });
    open();
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    expect(confirmButton().getAttribute('aria-busy')).toBe('true');
    // Enter on the focused busy button fires another click.
    fireEvent.keyDown(confirmButton(), { key: 'Enter' });
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve());
  });

  it('a second confirm in the same tick (before re-render) is a no-op', async () => {
    const d = deferred();
    const { onConfirm } = renderTrigger({ onConfirm: vi.fn(() => d.promise) });
    open();
    const btn = confirmButton();
    act(() => {
      // Both clicks land before React re-renders the button as busy, so only the component's own guard can stop the second.
      btn.click();
      btn.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve());
  });

  it('Escape while pending does not close; Cancel disabled while pending', async () => {
    const d = deferred();
    renderTrigger({ onConfirm: vi.fn(() => d.promise) });
    open();
    fireEvent.click(confirmButton());
    expect((cancelButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(cancelButton());
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => d.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Escape when idle closes', async () => {
    renderTrigger();
    open();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reject → dialog stays, error Notice (role alert) shows errorMessage(err); confirm enabled again', async () => {
    const d = deferred();
    const errorMessage = vi.fn((err: unknown) => `Could not remove: ${(err as Error).message}`);
    const { onConfirm } = renderTrigger({ onConfirm: vi.fn(() => d.promise), errorMessage });
    open();
    fireEvent.click(confirmButton());
    const boom = new Error('boom');
    await act(async () => d.reject(boom));
    expect(errorMessage).toHaveBeenCalledWith(boom);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Could not remove: boom');
    expect(confirmButton().getAttribute('aria-busy')).toBeNull();
    expect(confirmButton().getAttribute('aria-disabled')).toBeNull();
    expect((cancelButton() as HTMLButtonElement).disabled).toBe(false);
    // And it can be retried.
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('a synchronous throw from onConfirm is handled like a rejection', async () => {
    renderTrigger({
      onConfirm: () => {
        throw new Error('sync');
      },
    });
    open();
    await act(async () => fireEvent.click(confirmButton()));
    expect(screen.getByRole('alert').textContent).toBe("That didn't work. Try again.");
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('default error copy is "That didn\'t work. Try again." and never includes the thrown message', async () => {
    renderTrigger({ onConfirm: vi.fn(() => Promise.reject(new Error('secret internal detail'))) });
    open();
    await act(async () => fireEvent.click(confirmButton()));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe("That didn't work. Try again.");
    expect(document.body.textContent).not.toContain('secret internal detail');
  });

  it('error is cleared when reopened', async () => {
    renderTrigger({ onConfirm: vi.fn(() => Promise.reject(new Error('x'))) });
    open();
    await act(async () => fireEvent.click(confirmButton()));
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(cancelButton());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    open();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('controlled mode: open=true renders dialog; resolve calls onOpenChange(false)', async () => {
    const d = deferred();
    const onOpenChange = vi.fn();
    render(<ConfirmAction {...base} onConfirm={() => d.promise} open onOpenChange={onOpenChange} />);
    expect(screen.getByRole('dialog', { name: base.title })).toBeTruthy();
    fireEvent.click(confirmButton());
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => d.resolve());
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('controlled mode: Escape while pending does not call onOpenChange', async () => {
    const d = deferred();
    const onOpenChange = vi.fn();
    render(<ConfirmAction {...base} onConfirm={() => d.promise} open onOpenChange={onOpenChange} />);
    fireEvent.click(confirmButton());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => d.resolve());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('controlled mode: an error is cleared when the parent closes and reopens', async () => {
    function Harness() {
      const [isOpen, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Close from parent
          </button>
          <ConfirmAction {...base} onConfirm={() => Promise.reject(new Error('x'))} open={isOpen} onOpenChange={setOpen} />
        </>
      );
    }
    render(<Harness />);
    await act(async () => fireEvent.click(confirmButton()));
    expect(screen.getByRole('alert')).toBeTruthy();
    // The parent closes it directly (not through onOpenChange), then reopens.
    act(() => screen.getByRole('button', { name: 'Close from parent', hidden: true }).click());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('controlled mode returns focus to what opened it', () => {
    function RowActions({ onConfirm }: { onConfirm: () => Promise<void> | void }) {
      const [isOpen, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Row actions
          </button>
          <ConfirmAction {...base} onConfirm={onConfirm} open={isOpen} onOpenChange={setOpen} />
        </>
      );
    }
    // While the modal is open Radix hides the rest of the page from the accessibility tree, so include hidden elements.
    const rowActions = () => screen.getByRole('button', { name: 'Row actions', hidden: true });
    const openFromRow = () => {
      rowActions().focus();
      fireEvent.click(rowActions());
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(document.activeElement).not.toBe(rowActions());
    };

    it('after Cancel', async () => {
      render(<RowActions onConfirm={() => {}} />);
      openFromRow();
      fireEvent.click(cancelButton());
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(rowActions());
    });

    it('after Escape', async () => {
      render(<RowActions onConfirm={() => {}} />);
      openFromRow();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(rowActions());
    });

    it('after onConfirm resolves', async () => {
      const d = deferred();
      render(<RowActions onConfirm={() => d.promise} />);
      openFromRow();
      fireEvent.click(confirmButton());
      await act(async () => d.resolve());
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(rowActions());
    });
  });

  it('labels: cancel is exactly "Cancel", confirm is confirmLabel', () => {
    renderTrigger({ confirmLabel: 'Revoke' });
    open();
    const buttons = screen.getAllByRole('button').filter((b) => screen.getByRole('dialog').contains(b));
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Revoke']);
  });

  it('confirm is the danger tone by default and primary when tone="neutral"', () => {
    renderTrigger();
    open();
    expect(confirmButton().className).toContain('ax-bg-status-danger');
    cleanup();
    renderTrigger({ tone: 'neutral' });
    open();
    expect(confirmButton().className).toContain('ax-bg-action');
    expect(confirmButton().className).not.toContain('ax-bg-status-danger');
  });

  it('trigger: a Button by default (secondary), an IconButton with label and icon when iconOnly (quiet)', () => {
    renderTrigger();
    expect(trigger().textContent).toBe('Remove');
    expect(trigger().className).toContain('ax-bg-surface-raised');
    expect(trigger().getAttribute('aria-haspopup')).toBe('dialog');
    cleanup();
    renderTrigger({ trigger: { label: 'Remove', icon: Trash2, iconOnly: true } });
    expect(trigger().getAttribute('aria-label')).toBe('Remove');
    expect(trigger().textContent).toBe('');
    expect(trigger().querySelector('svg')).toBeTruthy();
    expect(trigger().className).toContain('ax-bg-transparent');
    open();
    expect(screen.getByRole('dialog', { name: base.title })).toBeTruthy();
  });

  it('renders on the server without touching the DOM', () => {
    expect(() =>
      renderToString(<ConfirmAction {...base} onConfirm={() => {}} trigger={{ label: 'Remove' }} />),
    ).not.toThrow();
  });
});
