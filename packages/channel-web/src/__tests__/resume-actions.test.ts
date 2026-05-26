import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeActions } from '../lib/resume-actions';

describe('resume-actions', () => {
  afterEach(() => resumeActions.reset());

  it('continueAfterGrant() invokes the registered regenerate', () => {
    const regen = vi.fn();
    resumeActions.registerRegenerate(regen);
    resumeActions.continueAfterGrant();
    expect(regen).toHaveBeenCalledTimes(1);
  });

  it('continueAfterGrant() is a no-op when nothing is registered', () => {
    expect(() => resumeActions.continueAfterGrant()).not.toThrow();
  });

  it('the latest registration wins (runtime re-mounts)', () => {
    const a = vi.fn();
    const b = vi.fn();
    resumeActions.registerRegenerate(a);
    resumeActions.registerRegenerate(b);
    resumeActions.continueAfterGrant();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
