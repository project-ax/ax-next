import { describe, expect, it } from 'vitest';
import {
  ROUTINE_CHECKIN_LOOKUP_MAX_IDS,
  RoutineTasksForConversationsInputSchema,
  RoutineTasksForConversationsOutputSchema,
} from '../index.js';

// `routines:tasks-for-conversations` (TASK-932): which conversations are
// check-ins of a task the caller owns, so Today can name the task.

describe('routines:tasks-for-conversations (TASK-932)', () => {
  it('takes an agent and 1 to 200 conversation ids, and nothing else', () => {
    const parse = (v: unknown) => RoutineTasksForConversationsInputSchema.safeParse(v);
    expect(RoutineTasksForConversationsInputSchema.parse({ agentId: 'a', conversationIds: ['c1'] })).toEqual({ agentId: 'a', conversationIds: ['c1'] });
    const many = Array.from({ length: 200 }, (_, i) => `c${i}`);
    expect(parse({ agentId: 'a', conversationIds: many }).success).toBe(true);
    expect(parse({ agentId: 'a', conversationIds: [] }).success).toBe(false);
    expect(parse({ agentId: 'a', conversationIds: [...many, 'c200'] }).success).toBe(false);
    expect(parse({ agentId: 'a', conversationIds: [''] }).success).toBe(false);
    expect(parse({ agentId: 'a', conversationIds: ['x'.repeat(257)] }).success).toBe(false);
    expect(parse({ agentId: 'a', conversationIds: 'c1' }).success).toBe(false);
    expect(parse({ agentId: 'a', conversationIds: ['c1'], userId: 'owner' }).success).toBe(false);
    expect(parse({ conversationIds: ['c1'] }).success).toBe(false);
    expect(ROUTINE_CHECKIN_LOOKUP_MAX_IDS).toBe(200);
  });

  it('answers check-ins as a conversation, a task id and a name, and nothing else', () => {
    const parse = (v: unknown) => RoutineTasksForConversationsOutputSchema.safeParse(v);
    expect(RoutineTasksForConversationsOutputSchema.parse({ checkIns: [] })).toEqual({ checkIns: [] });
    const ok = { checkIns: [{ conversationId: 'c1', routineId: 'r1', name: 'Support queue' }] };
    expect(RoutineTasksForConversationsOutputSchema.parse(ok)).toEqual(ok);
    expect(parse({ checkIns: [{ ...ok.checkIns[0], ownerUserId: 'u' }] }).success).toBe(false);
    expect(parse({ ...ok, kind: 'task' }).success).toBe(false);
    expect(parse({ checkIns: [{ ...ok.checkIns[0], name: '' }] }).success).toBe(false);
    expect(parse({ checkIns: [{ ...ok.checkIns[0], name: 'x'.repeat(129) }] }).success).toBe(false);
  });
});
