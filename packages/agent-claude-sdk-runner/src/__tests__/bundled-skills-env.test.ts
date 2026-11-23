import { describe, expect, it } from 'vitest';
import { buildBundledSkillsEnv } from '../bundled-skills-env.js';

describe('buildBundledSkillsEnv', () => {
  it('turns off the cron-backed loop skill and the claude-api skill', () => {
    // TASK-1207: measured on CLI 2.1.119, these are the only two switches that
    // remove a bundled skill without also removing AX's own skills. `loop`
    // tells the model to schedule with CronCreate / ScheduleWakeup, which the
    // `tools` allowlist keeps out, so an agent following it reports a schedule
    // that never runs. Dropping either key brings that skill back.
    expect(buildBundledSkillsEnv()).toEqual({
      CLAUDE_CODE_DISABLE_CRON: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: '1',
    });
  });

  it('returns a fresh object each call', () => {
    const a = buildBundledSkillsEnv();
    const b = buildBundledSkillsEnv();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
