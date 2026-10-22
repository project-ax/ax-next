import { describe, expect, it, vi } from 'vitest';
import { makeAgentContext, MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS, type AgentContext } from '@ax/core';
import { CAPTURE_CHECK_DEADLINE_MS, taskCaptureVeto } from '../capture.js';

// TASK-908: routines refuses memory capture of a task check-in's conversation,
// whoever's pass it is, and fails closed when it can't tell in time.
const routineRun = (over: Partial<Parameters<typeof makeAgentContext>[0]> = {}): AgentContext => makeAgentContext({
  sessionId: 's', agentId: 'agent', userId: 'owner', conversationId: 'c-ctx', source: 'routine', ...over,
});
const storeAnswering = (answer: boolean | Error) => ({
  isTaskConversation: vi.fn(async () => { if (answer instanceof Error) throw answer; return answer; }),
});

describe('taskCaptureVeto (TASK-908)', () => {
  it("refuses a task conversation whoever's pass it is: a person's, or one with no source", async () => {
    const noSource = makeAgentContext({ sessionId: 's', agentId: 'agent', userId: 'owner', conversationId: 'c-task' });
    for (const ctx of [routineRun({ source: 'user' }), noSource]) {
      const store = storeAnswering(true);
      expect(await taskCaptureVeto(store, ctx, { conversationId: 'c-task' })).toEqual({ rejected: true, reason: 'task-check-in' });
      expect(store.isTaskConversation).toHaveBeenCalledWith({ agentId: 'agent', conversationId: 'c-task' });
    }
    // A person's own chat goes through.
    expect(await taskCaptureVeto(storeAnswering(false), routineRun({ source: 'user' }), { conversationId: 'c-chat' })).toBeUndefined();
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

  it('refuses when the lookup takes longer than its deadline', async () => {
    const warn = vi.fn();
    const ctx = { ...routineRun(), logger: { ...routineRun().logger, warn } };
    const hung = { isTaskConversation: vi.fn(() => new Promise<boolean>(() => {})) };
    expect(await taskCaptureVeto(hung, ctx, { conversationId: 'c-chat' }, 20)).toEqual({ rejected: true, reason: 'task-check-in' });
    expect(warn).toHaveBeenCalledWith('routines_capture_check_failed', { agentId: 'agent', err: 'capture check took longer than 20 ms' });
  });

  it('answers inside memory\'s own subscriber bound, so a slow lookup is refused, not skipped', () => {
    expect(CAPTURE_CHECK_DEADLINE_MS).toBeLessThan(MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS);
  });

  it("a payload rewritten by an earlier subscriber can't steer it off the host-set conversation", async () => {
    const tasks = new Set(['c-task']);
    const store = { isTaskConversation: vi.fn(async ({ conversationId }: { conversationId: string }) => tasks.has(conversationId)) };
    // The pass is on a task conversation, but the payload now names an ordinary chat.
    expect(await taskCaptureVeto(store, routineRun({ conversationId: 'c-task' }), { conversationId: 'c-chat' })).toEqual({ rejected: true, reason: 'task-check-in' });
    // And a payload naming a task conversation is refused whatever ctx says.
    expect(await taskCaptureVeto(store, routineRun({ conversationId: 'c-chat' }), { conversationId: 'c-task' })).toEqual({ rejected: true, reason: 'task-check-in' });
    expect(await taskCaptureVeto(store, routineRun({ conversationId: 'c-chat' }), { conversationId: 'c-chat' })).toBeUndefined();
  });

  it('a logger that throws doesn’t stop the refusal', async () => {
    const ctx = { ...routineRun(), logger: { ...routineRun().logger, warn: () => { throw new Error('log sink down'); } } };
    expect(await taskCaptureVeto(storeAnswering(new Error('database unavailable')), ctx, { conversationId: 'c-task' }))
      .toEqual({ rejected: true, reason: 'task-check-in' });
  });

  it('refuses when the lookup throws', async () => {
    const warn = vi.fn();
    const ctx = { ...routineRun(), logger: { ...routineRun().logger, warn } };
    expect(await taskCaptureVeto(storeAnswering(new Error('database unavailable')), ctx, { conversationId: 'c-task' }))
      .toEqual({ rejected: true, reason: 'task-check-in' });
    expect(warn).toHaveBeenCalledWith('routines_capture_check_failed', { agentId: 'agent', err: 'database unavailable' });
  });
});
