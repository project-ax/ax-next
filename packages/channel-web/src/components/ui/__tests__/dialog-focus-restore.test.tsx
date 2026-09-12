/**
 * Where keyboard focus lands when a Dialog or Sheet closes.
 *
 * A browser walk on the sign-in lockout dialog: Tab to the provider switch,
 * press Space to raise "Turn off the only way to sign in?", press Escape to
 * back out. The dialog closed correctly and the provider stayed on — and focus
 * was on `<body>`. Nothing to Tab from, nothing announced, no way back to the
 * control except starting at the top of the page again.
 *
 * The cause is in Radix, not in the call site. Its modal content ships:
 *
 *     onCloseAutoFocus={composeEventHandlers(props.onCloseAutoFocus, (e) => {
 *       e.preventDefault()
 *       context.triggerRef.current?.focus()
 *     })}
 *
 * The `preventDefault()` cancels FocusScope's own restore, and the focus call
 * after it does nothing when there is no `<DialogTrigger>` — `triggerRef` is
 * null. Opening from state instead of from a trigger is the norm here (22 of 25
 * `DialogContent` call sites, and the only `SheetContent` one), so the restore
 * lives in the primitives.
 *
 * These tests drive the primitives directly, trigger-less, exactly as the real
 * call sites use them.
 */
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle } from '../dialog';
import { Sheet, SheetContent, SheetTitle } from '../sheet';

/** The shape every real call site uses: `open` from state, no trigger. */
function StateDrivenDialog({ onCloseAutoFocus }: { onCloseAutoFocus?: (e: Event) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open it
      </button>
      <button type="button">Somewhere else</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}>
          <DialogTitle>Turn off the only way to sign in?</DialogTitle>
          <button type="button" onClick={() => setOpen(false)}>
            Keep it on
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StateDrivenSheet() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Add key
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetTitle>Add your OpenRouter API key</SheetTitle>
          <button type="button" onClick={() => setOpen(false)}>
            Save
          </button>
        </SheetContent>
      </Sheet>
    </>
  );
}

describe('overlay focus restore', () => {
  it('returns focus to the control that opened a trigger-less dialog', async () => {
    render(<StateDrivenDialog />);
    const opener = screen.getByRole('button', { name: 'Open it' });

    // Focus the opener the way a keyboard user arrives at it, then activate.
    opener.focus();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);

    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Keep it on' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Before the fix this was document.body.
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('returns focus to the control that opened a trigger-less sheet', async () => {
    render(<StateDrivenSheet />);
    const opener = screen.getByRole('button', { name: 'Add key' });

    opener.focus();
    fireEvent.click(opener);

    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  /**
   * The restore must stay overridable, or it becomes the next thing someone has
   * to work around. A caller that handles `onCloseAutoFocus` and calls
   * `preventDefault()` owns focus completely.
   */
  it('yields to a caller that takes focus over itself', async () => {
    let elsewhere: HTMLElement | null = null;
    render(
      <StateDrivenDialog
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          elsewhere?.focus();
        }}
      />,
    );
    const opener = screen.getByRole('button', { name: 'Open it' });
    elsewhere = screen.getByRole('button', { name: 'Somewhere else' });

    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Keep it on' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(elsewhere));
  });
});
