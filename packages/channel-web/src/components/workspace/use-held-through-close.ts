import { useState } from 'react';

/**
 * A dialog opened by a value (`value !== null` means open) keeps drawing its
 * last value while it animates closed, instead of flashing blank ("until .",
 * "Unlink ?"). Call `release` from the dialog's `onCloseAutoFocus`, which runs
 * once the close has finished, so nothing (a one-time link code included) is
 * held longer than the dialog is on screen.
 */
export function useHeldThroughClose<T>(value: T | null): { held: T | null; release: () => void } {
  const [held, setHeld] = useState<T | null>(value);
  if (value !== null && value !== held) setHeld(value);
  return {
    held: value ?? held,
    release: () => {
      if (value === null) setHeld(null);
    },
  };
}
