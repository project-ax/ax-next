import { afterEach, describe, expect, it, vi } from 'vitest';
import { continuationActions } from '../continuation-actions';

describe('continuationActions', () => {
  afterEach(() => {
    continuationActions.reset();
    vi.restoreAllMocks();
  });

  it('stages the id and kicks the registered resume', () => {
    const resume = vi.fn();
    continuationActions.registerResume(resume);
    continuationActions.resumeContinuation('req-1');
    expect(resume).toHaveBeenCalledTimes(1);
    expect(continuationActions.takePendingContinuation()).toBe('req-1');
  });

  it('ignores junk ids without kicking anything', () => {
    const resume = vi.fn();
    continuationActions.registerResume(resume);
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

  it('the staged id is consume-once', () => {
    continuationActions.registerResume(vi.fn());
    continuationActions.resumeContinuation('req-1');
    expect(continuationActions.takePendingContinuation()).toBe('req-1');
    expect(continuationActions.takePendingContinuation()).toBeNull();
  });
});
