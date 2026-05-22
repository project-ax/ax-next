import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const subscribeMock = vi.fn();
vi.mock('../lib/title-events.js', () => ({
  subscribeTitleEvents: (opts: unknown) => subscribeMock(opts),
}));
const applyTitle = vi.fn();
const bumpVersion = vi.fn();
vi.mock('../lib/session-store.js', () => ({
  sessionStoreActions: { applyTitle: (...a: unknown[]) => applyTitle(...a), bumpVersion: () => bumpVersion() },
}));

import { useTitleEvents } from '../lib/use-title-events.js';

describe('useTitleEvents', () => {
  beforeEach(() => { subscribeMock.mockReset().mockReturnValue(() => {}); applyTitle.mockReset(); bumpVersion.mockReset(); });

  it('subscribes on mount and routes frames to store actions', () => {
    renderHook(() => useTitleEvents());
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    const opts = subscribeMock.mock.calls[0]![0] as {
      onTitle: (f: { conversationId: string; title: string }) => void;
      onOpen: () => void;
    };
    opts.onTitle({ conversationId: 'cnv_1', title: 'T' });
    expect(applyTitle).toHaveBeenCalledWith('cnv_1', 'T');
    opts.onOpen();
    expect(bumpVersion).toHaveBeenCalledTimes(1);
  });

  it('stops the subscription on unmount', () => {
    const stop = vi.fn();
    subscribeMock.mockReturnValue(stop);
    const { unmount } = renderHook(() => useTitleEvents());
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
