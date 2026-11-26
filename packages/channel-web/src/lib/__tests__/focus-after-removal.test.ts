import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterDialogCloses, focusAfterRemoval, REMOVAL_WINDOW_MS } from '../focus-after-removal';

function mount(html: string): void {
  document.body.innerHTML = html;
}
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('afterDialogCloses', () => {
  it('runs after two timer turns, not before', async () => {
    const fn = vi.fn();
    afterDialogCloses(fn);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).not.toHaveBeenCalled();
    await settle();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('focusAfterRemoval', () => {
  it('focuses the target when focus has fallen to <body>', async () => {
    mount('<button id="keep">New</button>');
    focusAfterRemoval('#keep');
    await settle();
    expect(document.activeElement).toBe(document.getElementById('keep'));
  });

  it('leaves focus alone on a live element (a failed removal kept its opener)', async () => {
    mount('<button id="keep">New</button><button id="opener">Delete</button>');
    document.getElementById('opener')!.focus();
    focusAfterRemoval('#keep');
    await settle();
    expect(document.activeElement).toBe(document.getElementById('opener'));
    // Even later, with nothing removed, it stays put.
    await vi.advanceTimersByTimeAsync(REMOVAL_WINDOW_MS + 10);
    expect(document.activeElement).toBe(document.getElementById('opener'));
  });

  it('waits for a delayed removal, then parks focus on the target', async () => {
    mount('<button id="keep">New</button><button id="opener">Delete</button>');
    const opener = document.getElementById('opener')!;
    opener.focus();
    focusAfterRemoval('#keep');
    await settle();
    expect(document.activeElement).toBe(opener);
    // The un-awaited re-read lands: the row goes and focus drops to <body>.
    opener.remove();
    await settle();
    expect(document.activeElement).toBe(document.getElementById('keep'));
  });

  it('gives up when the person moves focus elsewhere before the removal lands', async () => {
    mount('<button id="keep">New</button><button id="opener">Delete</button><button id="other">Other</button>');
    const opener = document.getElementById('opener')!;
    opener.focus();
    focusAfterRemoval('#keep');
    await settle();
    document.getElementById('other')!.focus();
    document.body.appendChild(document.createElement('div'));
    await settle();
    opener.remove();
    await settle();
    expect(document.activeElement).toBe(document.getElementById('other'));
  });

  it('does not move focus when the person merely blurred to <body> while the opener still exists', async () => {
    mount('<button id="keep">New</button><button id="opener">Delete</button>');
    const opener = document.getElementById('opener')!;
    opener.focus();
    focusAfterRemoval('#keep');
    await settle();
    opener.blur();
    document.body.appendChild(document.createElement('div'));
    await settle();
    expect(document.activeElement).toBe(document.body);
    // Still waiting: once the opener really leaves, the stand-in gets focus.
    opener.remove();
    await settle();
    expect(document.activeElement).toBe(document.getElementById('keep'));
  });
});
