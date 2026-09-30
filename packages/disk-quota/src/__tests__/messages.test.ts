import { describe, it, expect } from 'vitest';
import {
  blobFullMessage,
  formatBytes,
  STORAGE_UNAVAILABLE_MESSAGE,
  workspaceFullMessage,
} from '../messages.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('formatBytes', () => {
  it('uses 1024-based units with one decimal only when needed', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(512 * 1024)).toBe('512 KB');
    expect(formatBytes(3.4 * MB)).toBe('3.4 MB');
    expect(formatBytes(3 * MB)).toBe('3 MB');
    expect(formatBytes(GB)).toBe('1 GB');
    expect(formatBytes(1.5 * GB)).toBe('1.5 GB');
    expect(formatBytes(1024 * GB)).toBe('1 TB');
  });

  it('trims a ".0" that rounding produces', () => {
    // 2.04 MB rounds to 2.0 -> "2 MB", not "2.0 MB".
    expect(formatBytes(2.04 * MB)).toBe('2 MB');
  });

  it('never prints a unit boundary as 1024 of the smaller unit', () => {
    // 1023.99 KB is "1024 KB" after rounding; it reads "1 MB".
    expect(formatBytes(1023.99 * 1024)).toBe('1 MB');
    expect(formatBytes(1023.99 * MB)).toBe('1 GB');
  });

  it('reads anything that is not a usable size as 0 B', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, -Infinity, '5' as unknown as number]) {
      expect(formatBytes(bad)).toBe('0 B');
    }
  });

  it('stays in TB for very large values', () => {
    expect(formatBytes(5000 * GB)).toBe('4.9 TB');
  });
});

describe('the refusal sentences', () => {
  it('the workspace one names the numbers, says the changes were removed, and points at an admin', () => {
    const m = workspaceFullMessage(1024 * MB, 1024 * MB);
    expect(m).toBe(
      'The storage limit has been reached (1 GB of 1 GB used), so this turn\'s file changes were not saved and have been removed. ' +
        "Please don't try to save them again. " +
        'Let the person know their storage is full and that an admin can make more room.',
    );
  });

  it('the upload one names the numbers and points at an admin', () => {
    const m = blobFullMessage(1.5 * GB, 2 * GB);
    expect(m).toBe(
      "You've used all of your storage (1.5 GB of 2 GB), so that file wasn't saved. " +
        'An admin can make more room, and then you can try again.',
    );
  });

  it('the unavailable one asks for a retry and names no numbers', () => {
    expect(STORAGE_UNAVAILABLE_MESSAGE).toBe(
      "We couldn't check your storage just now, so nothing was saved. Please try again in a moment.",
    );
    expect(STORAGE_UNAVAILABLE_MESSAGE).not.toMatch(/\d/);
  });

  it('none of them tells anyone to delete anything (no small chore makes room)', () => {
    for (const m of [
      workspaceFullMessage(MB, MB),
      blobFullMessage(MB, MB),
      STORAGE_UNAVAILABLE_MESSAGE,
    ]) {
      expect(m.toLowerCase()).not.toMatch(/delet|remove some|free up|clean/);
    }
  });
});
