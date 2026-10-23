import { describe, expect, it } from 'vitest';
import type { DecisionReadError } from '@/lib/workspace-decisions';
import { approvalReadFrom } from '../AgentConversation';

const EXPIRED: DecisionReadError = { kind: 'expired', detail: '' };
const FAILED: DecisionReadError = { kind: 'failed', detail: '' };

describe('approvalReadFrom (TASK-911)', () => {
  it('a session that ran out outranks everything', () => {
    expect(approvalReadFrom('failed', EXPIRED)).toBe('expired');
    expect(approvalReadFrom('ok', EXPIRED)).toBe('expired');
  });

  it('either read failing is a failed read', () => {
    expect(approvalReadFrom('failed', null)).toBe('failed');
    expect(approvalReadFrom('ok', FAILED)).toBe('failed');
    expect(approvalReadFrom('unavailable', FAILED)).toBe('failed');
  });

  it('otherwise it is the thread’s own read', () => {
    expect(approvalReadFrom('ok', null)).toBe('ok');
    expect(approvalReadFrom('unavailable', null)).toBe('unavailable');
  });
});
