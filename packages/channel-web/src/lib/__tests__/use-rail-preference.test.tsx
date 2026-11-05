import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRailPreference } from '../use-rail-preference';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
describe('sidebar rail preference', () => {
  it('persists the sidebar collapse across remounts', () => {
    const sidebar = renderHook(() => useRailPreference('sidebar'));
    expect(sidebar.result.current[0]).toBe(false);
    act(() => sidebar.result.current[1](true));
    expect(localStorage.getItem('ax-workspace-sidebar-collapsed')).toBe('true');
    sidebar.unmount();
    expect(
      renderHook(() => useRailPreference('sidebar')).result.current[0],
    ).toBe(true);
  });
  it('still allows collapse when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useRailPreference('sidebar'));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
