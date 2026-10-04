import { describe, expect, it } from 'vitest';
import {
  RUNNER_BOOT_FAILED,
  SANDBOX_EXIT_BEFORE_CHAT_END,
  classifyRunnerExit,
  runnerExitLogFields,
} from '../runner-exit.js';

describe('classifyRunnerExit (TASK-784)', () => {
  it('maps the runner fatal exit code 2 to runner-boot-failed', () => {
    expect(classifyRunnerExit({ code: 2, signal: null })).toBe(RUNNER_BOOT_FAILED);
    expect(RUNNER_BOOT_FAILED).toBe('runner-boot-failed');
  });

  it.each([
    { code: 0, signal: null },
    { code: 1, signal: null },
    { code: 137, signal: null, reason: 'OOMKilled' },
    { code: null, signal: 'SIGTERM' },
    { code: null, signal: null, reason: 'pod-gone' },
  ])('keeps the generic reason for %j', (info) => {
    expect(classifyRunnerExit(info)).toBe(SANDBOX_EXIT_BEFORE_CHAT_END);
  });

  it.each([undefined, null, 'x', {}, { code: '2' }])(
    'tolerates a malformed exit value %j (pathological provider)',
    (info) => {
      expect(classifyRunnerExit(info)).toBe(SANDBOX_EXIT_BEFORE_CHAT_END);
    },
  );
});

describe('runnerExitLogFields (TASK-784)', () => {
  it('reports code, signal and the backend reason', () => {
    expect(runnerExitLogFields({ code: 2, signal: null, reason: 'Error' })).toEqual({
      exitCode: 2,
      exitSignal: null,
      exitReason: 'Error',
    });
  });

  it('omits exitReason when the backend has none', () => {
    const f = runnerExitLogFields({ code: null, signal: 'SIGKILL' });
    expect(f).toEqual({ exitCode: null, exitSignal: 'SIGKILL' });
    expect('exitReason' in f).toBe(false);
  });

  it('clamps an oversized backend reason', () => {
    const f = runnerExitLogFields({ code: 1, signal: null, reason: 'r'.repeat(10_000) });
    expect(String(f.exitReason).length).toBeLessThanOrEqual(128);
  });

  it('tolerates undefined', () => {
    expect(runnerExitLogFields(undefined)).toEqual({ exitCode: null, exitSignal: null });
  });
});
