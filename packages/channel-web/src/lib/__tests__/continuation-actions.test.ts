import { afterEach, describe, expect, it, vi } from 'vitest';
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
