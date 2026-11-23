import { describe, expect, it } from 'vitest';
import { buildBackgroundTasksEnv } from '../background-tasks-env.js';

describe('buildBackgroundTasksEnv', () => {
  it("turns off the CLI's background tasks: run_in_background and backgrounding at timeout", () => {
    // TASK-1217: measured on CLI 2.1.119, a background command (asked for, or
    // moved there when it outlives its timeout) wakes the model for a turn
    // nobody asked for when it finishes. Dropping the key brings that back.
    expect(buildBackgroundTasksEnv()).toEqual({
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    });
  });

  it('returns a fresh object each call', () => {
    const a = buildBackgroundTasksEnv();
    const b = buildBackgroundTasksEnv();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
