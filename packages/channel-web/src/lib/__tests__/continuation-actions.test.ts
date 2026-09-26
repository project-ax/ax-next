import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { continuationActions } from '../continuation-actions';

describe('continuationActions', () => {
  afterEach(() => {
    continuationActions.reset();
    vi.restoreAllMocks();
  });

  it('stages the id and kicks the registered resume', () => {
    const resume = vi.fn();
    continuationActions.registerResume(resume, () => null);
    continuationActions.resumeContinuation('req-1');
    expect(resume).toHaveBeenCalledTimes(1);
    expect(continuationActions.takePendingContinuation()).toBe('req-1');
  });

  it('ignores junk ids without kicking anything', () => {
    const resume = vi.fn();
    continuationActions.registerResume(resume, () => null);
    continuationActions.resumeContinuation('');
    expect(resume).not.toHaveBeenCalled();
    expect(continuationActions.takePendingContinuation()).toBeNull();
  });

  it('drops the id with a warn when no chat runtime is mounted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    continuationActions.resumeContinuation('req-1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(continuationActions.takePendingContinuation()).toBeNull();
  });

  it('a throwing kick unstages the id instead of failing the approval path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    continuationActions.registerResume(() => {
      throw new Error('runtime is gone');
    }, () => null);
    expect(() => continuationActions.resumeContinuation('req-1')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(continuationActions.takePendingContinuation()).toBeNull();
  });

  describe('continueApprovedTurn — the one rule both surfaces share (TASK-542)', () => {
    it('attaches when the decision belongs to the registered thread’s open conversation', () => {
      const resume = vi.fn();
      continuationActions.registerResume(resume, () => 'c1');
      continuationActions.continueApprovedTurn({ conversationId: 'c1' }, 'req-1');
      expect(resume).toHaveBeenCalledTimes(1);
      expect(continuationActions.takePendingContinuation()).toBe('req-1');
    });

    it('reads the open conversation at settle time, not at registration', () => {
      let open: string | null = 'c1';
      const resume = vi.fn();
      continuationActions.registerResume(resume, () => open);
      open = 'c2';
      continuationActions.continueApprovedTurn({ conversationId: 'c1' }, 'req-1');
      expect(resume).not.toHaveBeenCalled();
      expect(continuationActions.takePendingContinuation()).toBeNull();
    });

    it('attaches nothing for a null streamReqId, the welcome state, or another thread', () => {
      const resume = vi.fn();
      let open: string | null = 'c1';
      continuationActions.registerResume(resume, () => open);
      continuationActions.continueApprovedTurn({ conversationId: 'c1' }, null);
      continuationActions.continueApprovedTurn({ conversationId: 'c2' }, 'req-1');
      open = null;
      continuationActions.continueApprovedTurn({ conversationId: 'c1' }, 'req-1');
      expect(resume).not.toHaveBeenCalled();
      expect(continuationActions.takePendingContinuation()).toBeNull();
    });

    it('is quiet when no thread is registered — approving from Today is ordinary', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      continuationActions.continueApprovedTurn({ conversationId: 'c1' }, 'req-1');
      expect(warn).not.toHaveBeenCalled();
      expect(continuationActions.takePendingContinuation()).toBeNull();
    });
  });

  /*
    TASK-574 — the host defers the continuation until the undo window closes,
    so the approve answers `pendingUntil` with the `streamReqId`. Attaching at
    once showed "Thinking…" for the whole window, and hung forever after an
    Undo: nothing ever runs on that id.
  */
  describe('continueApprovedTurn waits out pendingUntil (TASK-574)', () => {
    const NOW = new Date('2026-09-26T12:00:00.000Z').getTime();
    const inMs = (ms: number) => new Date(NOW + ms).toISOString();

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not attach until pendingUntil passes, then attaches exactly once', () => {
      const resume = vi.fn();
      continuationActions.registerResume(resume, () => 'c1');
      continuationActions.continueApprovedTurn(
        { id: 'd1', conversationId: 'c1', pendingUntil: inMs(10_000) },
        'req-1',
      );
      expect(resume).not.toHaveBeenCalled();
      expect(continuationActions.takePendingContinuation()).toBeNull();

      vi.advanceTimersByTime(9_999);
      expect(resume).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(continuationActions.takePendingContinuation()).toBe('req-1');

      vi.advanceTimersByTime(60_000);
      expect(resume).toHaveBeenCalledTimes(1);
    });

    it('cancelApprovedTurn before the window closes: never attaches', () => {
      const resume = vi.fn();
      continuationActions.registerResume(resume, () => 'c1');
      continuationActions.continueApprovedTurn(
        { id: 'd1', conversationId: 'c1', pendingUntil: inMs(10_000) },
        'req-1',
      );
      vi.advanceTimersByTime(4_000);
      continuationActions.cancelApprovedTurn('d1');
      vi.advanceTimersByTime(60_000);
      expect(resume).not.toHaveBeenCalled();
      expect(continuationActions.takePendingContinuation()).toBeNull();
    });

    it('cancelApprovedTurn for an id with nothing pending is a no-op', () => {
      expect(() => continuationActions.cancelApprovedTurn('nope')).not.toThrow();
    });

    it('checks the open conversation when the timer FIRES, not when it was set', () => {
      let open: string | null = 'c1';
      const resume = vi.fn();
      continuationActions.registerResume(resume, () => open);
      continuationActions.continueApprovedTurn(
        { id: 'd1', conversationId: 'c1', pendingUntil: inMs(10_000) },
        'req-1',
      );
      open = 'c2'; // the reader moved to another thread inside the window
      vi.advanceTimersByTime(10_000);
      expect(resume).not.toHaveBeenCalled();
      expect(continuationActions.takePendingContinuation()).toBeNull();
    });

    it('checks the registrant when the timer fires: an unmounted thread attaches nothing', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const resume = vi.fn();
      const dispose = continuationActions.registerResume(resume, () => 'c1');
      continuationActions.continueApprovedTurn(
        { id: 'd1', conversationId: 'c1', pendingUntil: inMs(10_000) },
        'req-1',
      );
      dispose();
      vi.advanceTimersByTime(10_000);
      expect(resume).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('a second call for the same decision replaces the first timer: one attach', () => {
      const resume = vi.fn();
      continuationActions.registerResume(resume, () => 'c1');
      continuationActions.continueApprovedTurn(
        { id: 'd1', conversationId: 'c1', pendingUntil: inMs(10_000) },
        'req-1',
      );
      continuationActions.continueApprovedTurn(
        { id: 'd1', conversationId: 'c1', pendingUntil: inMs(12_000) },
        'req-2',
      );
      vi.advanceTimersByTime(10_000);
      expect(resume).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(continuationActions.takePendingContinuation()).toBe('req-2');
      vi.advanceTimersByTime(60_000);
      expect(resume).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['in the past', inMs(-1_000)],
      ['null', null],
      ['absent', undefined],
      ['unparseable', 'not-a-date'],
    ])('attaches at once when pendingUntil is %s', (_what, pendingUntil) => {
      const resume = vi.fn();
      continuationActions.registerResume(resume, () => 'c1');
      continuationActions.continueApprovedTurn(
        // Absent means the key is missing, not present-and-undefined.
        { id: 'd1', conversationId: 'c1', ...(pendingUntil === undefined ? {} : { pendingUntil }) },
        'req-1',
      );
      expect(resume).toHaveBeenCalledTimes(1);
      expect(continuationActions.takePendingContinuation()).toBe('req-1');
    });

    it('reset() drops every pending timer', () => {
      const resume = vi.fn();
      continuationActions.registerResume(resume, () => 'c1');
      continuationActions.continueApprovedTurn(
        { id: 'd1', conversationId: 'c1', pendingUntil: inMs(10_000) },
        'req-1',
      );
      continuationActions.reset();
      const later = vi.fn();
      continuationActions.registerResume(later, () => 'c1');
      vi.advanceTimersByTime(10_000);
      expect(resume).not.toHaveBeenCalled();
      expect(later).not.toHaveBeenCalled();
    });
  });

  describe('registerResume disposer', () => {
    it('unregisters its own registration', () => {
      const resume = vi.fn();
      const dispose = continuationActions.registerResume(resume, () => 'c1');
      dispose();
      continuationActions.continueApprovedTurn({ conversationId: 'c1' }, 'req-1');
      expect(resume).not.toHaveBeenCalled();
    });

    it('does not evict a later registration that replaced it', () => {
      const first = vi.fn();
      const second = vi.fn();
      const disposeFirst = continuationActions.registerResume(first, () => 'c1');
      continuationActions.registerResume(second, () => 'c1');
      disposeFirst();
      continuationActions.continueApprovedTurn({ conversationId: 'c1' }, 'req-1');
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });

  it('the staged id is consume-once', () => {
    continuationActions.registerResume(vi.fn(), () => null);
    continuationActions.resumeContinuation('req-1');
    expect(continuationActions.takePendingContinuation()).toBe('req-1');
    expect(continuationActions.takePendingContinuation()).toBeNull();
  });
});
