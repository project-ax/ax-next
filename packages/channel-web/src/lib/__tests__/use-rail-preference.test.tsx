import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRailPreference } from '../use-rail-preference';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
describe('rail preferences', () => {
  it('persists each rail independently across remounts', () => {
    const sidebar = renderHook(() => useRailPreference('sidebar'));
    const details = renderHook(() => useRailPreference('details'));
    act(() => sidebar.result.current[1](true));
    expect(details.result.current[0]).toBe(false);
    expect(localStorage.getItem('ax-workspace-sidebar-collapsed')).toBe('true');
    expect(localStorage.getItem('ax-workspace-details-collapsed')).toBe(
      'false',
    );
    sidebar.unmount();
    details.unmount();
    expect(
      renderHook(() => useRailPreference('sidebar')).result.current[0],
    ).toBe(true);
    expect(
      renderHook(() => useRailPreference('details')).result.current[0],
    ).toBe(false);
  });
  it('still allows collapse when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useRailPreference('details'));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
