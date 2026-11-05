import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePanelPreference } from '../use-panel-preference';

type P = 'memory' | 'files';
const isP = (v: unknown): v is P => v === 'memory' || v === 'files';
const KEY = 'ax-workspace-side-panel';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('usePanelPreference — the side panel’s remembered view', () => {
  it('starts closed when nothing is stored', () => {
    const { result } = renderHook(() => usePanelPreference(isP));
    expect(result.current[0]).toBeNull();
  });

  it('remembers the open view across remounts, and closing it', () => {
    const first = renderHook(() => usePanelPreference(isP));
    act(() => first.result.current[1]('files'));
    expect(localStorage.getItem(KEY)).toBe('files');
    first.unmount();
    const second = renderHook(() => usePanelPreference(isP));
    expect(second.result.current[0]).toBe('files');
    act(() => second.result.current[1](null));
    expect(localStorage.getItem(KEY)).toBe('none');
    second.unmount();
    expect(renderHook(() => usePanelPreference(isP)).result.current[0]).toBeNull();
  });

  it('ignores a stored value that is not a panel (a removed view, junk)', () => {
    localStorage.setItem(KEY, 'chat');
    expect(renderHook(() => usePanelPreference(isP)).result.current[0]).toBeNull();
  });

  it('still opens when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => usePanelPreference(isP));
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]('memory'));
    expect(result.current[0]).toBe('memory');
  });
});
