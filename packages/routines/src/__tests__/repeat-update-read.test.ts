import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHold, makeAgentContext, type AgentContext, type ToolCall } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { routineRunner } from './support/check-in.js';
import { createRoutinesStore } from '../store.js';
import { fullTaskEventPayload, repeatUpdateNotice } from '../task-event-content.js';

let h: RoutineHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

// TASK-1050: a repeat job an app update started, end to end through the real routines, agents,
// tool-policy and decisions plugins, Postgres and HTTP.
type Run = { message: string; eventId: string; read: unknown };

describe('repeat job app updates', () => {
  it('a repeat job an app update started is told its eventId and reads the update in full, only in that run (TASK-1050)', async () => {
    const errors: unknown[] = [];
    const runs: Run[] = [];
    const contexts: AgentContext[] = [];
    h = await createRoutineHarness({
      invoke: async (ctx, bus, input) => {
        const message = (input as { message: { content: string } }).message.content;
        // A background default run is none of this test's business.
        if (!message.startsWith('Summarize the new issue.')) return { kind: 'complete' };
        try {
          const eventId = /Its eventId is (delivery_[0-9a-f]{32}),/.exec(message)?.[1];
          expect(eventId).toBeDefined();
          const call: ToolCall = { id: 'read', name: 'routine_read_update', input: { eventId } };
          // A held or rejected read here would mean the read is held in every routine run.
          const pre = await bus.fire('tool:pre-call', routineRunner(ctx), call);
          expect(pre.rejected).toBe(false);
          expect(isHold(pre)).toBe(false);
          const read = await bus.call('tool:execute:routine_read_update', routineRunner(ctx), call);
          runs.push({ message, eventId: eventId!, read });
          contexts.push(ctx);
          for (const outside of [
            routineRunner(ctx, { userId: 'peer' }),
            routineRunner(ctx, { conversationId: 'other' }),
            makeAgentContext({ userId: ctx.userId, agentId: ctx.agentId, sessionId: 'chat', conversationId: ctx.conversationId }),
          ]) await expect(bus.call('tool:execute:routine_read_update', outside, call)).rejects.toBeDefined();
          await expect(bus.call('tool:execute:routine_read_update', routineRunner(ctx), { id: 'unknown', name: 'routine_read_update', input: { eventId: `delivery_${'0'.repeat(32)}` } }))
            .rejects.toMatchObject({ toolCode: 'not-found' });
        } catch (error) { errors.push(error); }
        await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] });
        return { kind: 'complete' };
      },
    });
    const job = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
      agentId: h.agentId, requestId: 'new-issues', definition: RoutineDefinitionSchema.parse({
        name: 'New issues', promptBody: 'Summarize the new issue.', schedule: null, webhook: { kind: 'webhook', path: '/issues' },
      }),
    });
    // No secret is saved, so unsigned updates are accepted (TASK-1026).
    const { token } = await h.bus.call<unknown, { token: string }>('routines:webhook-address', h.owner, { agentId: h.agentId, routineId: job.routineId });
    const listening = captureExpectedStderr(message => message.startsWith('[ax/http-server] listening on http://127.0.0.1:'));
    const server = createHttpServerPlugin({ host: '127.0.0.1', port: 0, cookieKey: Buffer.alloc(32, 1), allowedOrigins: ['http://localhost'] });
    const transport = await createTestHarness({ plugins: [server] });
    try {
      for (const route of h.routes) await transport.bus.call('http:register-route', h.owner, route);
      const store = createRoutinesStore(h.db);
      const bodies = ['A', 'B'].map((marker, i) => JSON.stringify({
        action: 'create', data: { identifier: `TES-${3 + i}`, title: `PAYLOAD_PRIVATE_${marker}`, description: 'x'.repeat(5000) + `PAYLOAD_PRIVATE_TAIL_${marker}` },
      }));
      for (const [i, body] of bodies.entries()) {
        const response = await fetch(`http://127.0.0.1:${server.boundPort()}/webhooks/${token}/issues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        expect(response.status).toBe(202);
        await vi.waitFor(async () => {
          expect((await store.recentFires(job)).map(run => run.status)).toEqual(Array(i + 1).fill('ok'));
        }, { timeout: 60_000 });
      }
      if (errors.length) throw errors[0];
      expect(runs).toHaveLength(2);
      for (const [i, run] of runs.entries()) {
        const marker = i === 0 ? 'A' : 'B';
        const other = i === 0 ? 'B' : 'A';
        const parsed = /Its eventId is (delivery_[0-9a-f]{32}), and it was received at (\S+)\. Read it/.exec(run.message);
        expect(parsed).not.toBeNull();
        const [, eventId, receivedIso] = parsed!;
        expect(run.message).toBe(`Summarize the new issue.\n\n${repeatUpdateNotice({ eventId: eventId!, receivedAt: new Date(receivedIso!) })}`);
        expect(run.message).not.toContain('PAYLOAD_PRIVATE');
        const expected = { eventId, receivedAt: receivedIso, payload: fullTaskEventPayload(Buffer.from(bodies[i]!)) };
        expect(run.read).toEqual(expected);
        expect(expected.payload).toContain(`PAYLOAD_PRIVATE_TAIL_${marker}`);
        expect(expected.payload).not.toContain(`PAYLOAD_PRIVATE_${other}`);
      }
      expect(runs[0]!.eventId).not.toBe(runs[1]!.eventId);
      // The run is over: its own update is no longer readable.
      await expect(h.bus.call('tool:execute:routine_read_update', routineRunner(contexts[0]!), { id: 'after', name: 'routine_read_update', input: { eventId: runs[0]!.eventId } }))
        .rejects.toMatchObject({ toolCode: 'not-found' });
      const fires = await store.recentFires(job);
      expect(fires).toHaveLength(2);
      for (const fire of fires) expect(fire).toMatchObject({ triggerSource: 'webhook', renderedPrompt: null });
    } finally { await transport.close(); listening.restore(); }
  }, 120_000);
});
