import { describe, expect, it, vi } from 'vitest';
import { makeAgentContext, type AgentContext } from '@ax/core';
import { taskCaptureVeto } from '../capture.js';

// TASK-908: routines refuses memory capture of a task check-in's conversation,
// asks only about routine runs, and fails closed when it can't tell.
const routineRun = (over: Partial<Parameters<typeof makeAgentContext>[0]> = {}): AgentContext => makeAgentContext({
  sessionId: 's', agentId: 'agent', userId: 'owner', conversationId: 'c-ctx', source: 'routine', ...over,
});
const storeAnswering = (answer: boolean | Error) => ({
  isTaskConversation: vi.fn(async () => { if (answer instanceof Error) throw answer; return answer; }),
});

describe('taskCaptureVeto (TASK-908)', () => {
  it('no source routine: never asks', async () => {
    const store = storeAnswering(true);
    expect(await taskCaptureVeto(store, routineRun({ source: 'user' }), { conversationId: 'c-task' })).toBeUndefined();
    const noSource = makeAgentContext({ sessionId: 's', agentId: 'agent', userId: 'owner', conversationId: 'c-task' });
    expect(await taskCaptureVeto(store, noSource, { conversationId: 'c-task' })).toBeUndefined();
    expect(store.isTaskConversation).not.toHaveBeenCalled();
  });

  it('refuses a task conversation', async () => {
    const store = storeAnswering(true);
    expect(await taskCaptureVeto(store, routineRun(), { conversationId: 'c-task' })).toEqual({ rejected: true, reason: 'task-check-in' });
    expect(store.isTaskConversation).toHaveBeenCalledWith({ agentId: 'agent', conversationId: 'c-task' });
  });

  it('lets a non-task conversation through', async () => {
    expect(await taskCaptureVeto(storeAnswering(false), routineRun(), { conversationId: 'c-repeat' })).toBeUndefined();
  });

  it('falls back to ctx.conversationId when the payload is unreadable', async () => {
    const store = storeAnswering(true);
    expect(await taskCaptureVeto(store, routineRun(), { conversationId: 7 })).toEqual({ rejected: true, reason: 'task-check-in' });
    expect(store.isTaskConversation).toHaveBeenCalledWith({ agentId: 'agent', conversationId: 'c-ctx' });
    // With no conversation anywhere there is nothing to ask about.
    const none = storeAnswering(true);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'agent', userId: 'owner', source: 'routine' });
    expect(await taskCaptureVeto(none, ctx, null)).toBeUndefined();
    expect(none.isTaskConversation).not.toHaveBeenCalled();
  });

  it('refuses when the lookup throws', async () => {
    const warn = vi.fn();
    const ctx = { ...routineRun(), logger: { ...routineRun().logger, warn } };
    expect(await taskCaptureVeto(storeAnswering(new Error('database unavailable')), ctx, { conversationId: 'c-task' }))
      .toEqual({ rejected: true, reason: 'task-check-in' });
    expect(warn).toHaveBeenCalledWith('routines_capture_check_failed', { agentId: 'agent', err: 'database unavailable' });
  });
});
