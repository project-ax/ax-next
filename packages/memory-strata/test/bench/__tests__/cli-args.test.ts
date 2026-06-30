import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../cli.js';

describe('parseCliArgs — e2e mode flags (TASK-189)', () => {
  it('defaults to bench mode', () => {
    const a = parseCliArgs([]);
    expect(a.mode).toBe('bench');
    expect(a.full).toBe(false);
    expect(a.cap).toBeUndefined();
    expect(a.resume).toBeUndefined();
  });

  it('parses --mode e2e with cap, full, and resume', () => {
    const a = parseCliArgs(['--mode', 'e2e', '--cap', '10', '--full', '--resume', 'run-7']);
    expect(a.mode).toBe('e2e');
    expect(a.cap).toBe(10);
    expect(a.full).toBe(true);
    expect(a.resume).toBe('run-7');
  });

  it('keeps --sample working in e2e mode', () => {
    const a = parseCliArgs(['--mode', 'e2e', '--sample', '50']);
    expect(a.mode).toBe('e2e');
    expect(a.sample).toBe(50);
  });

  it('treats an unknown --mode value as bench (safe default)', () => {
    expect(parseCliArgs(['--mode', 'wat']).mode).toBe('bench');
  });
});
