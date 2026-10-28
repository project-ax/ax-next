import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAgentContext, SYSTEM_PROMPT_LANDED_HOOK, type AgentContext } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { createCheckInHarness, routineRunner, TASK_DEFINITION } from './support/check-in.js';
import { ROUTINES_AUGMENT_PROVIDER } from '../brief.js';
import { createRoutinesStore } from '../store.js';

let h: RoutineHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('task update canary: signed HTTP to elected scheduler to check-in and report', () => {
  it('queues a reply during an active check-in without starting another run or losing the reply', async () => {
    const checkIns = await createCheckInHarness();
    h = checkIns;
    const task = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
      agentId: h.agentId, requestId: 'reply-task', definition: RoutineDefinitionSchema.parse(TASK_DEFINITION),
    });
    await checkIns.checkIn(task, 'first', async (ctx, bus) => {
      expect(await bus.call('routines:reply', h!.owner, { agentId: h!.agentId, routineId: task.routineId, requestId: 'during-check-in', text: 'Please check the overdue ticket too.' }))
        .toMatchObject({ checkIn: 'queued' });
      expect(h!.invokeCalls).toHaveLength(1);
      await bus.call('tool:execute:routine_report', routineRunner(ctx), { id: 'report', name: 'routine_report', input: { status: 'on-track', update: 'Checked current tickets.', ask: null } });
    });
    await expect.poll(async () => (await createRoutinesStore(h!.db).recentFires(task)).length).toBe(1);
    const { message } = await checkIns.checkIn(task, 'after-reply', async (ctx, bus) => {
      await bus.call('tool:execute:routine_report', routineRunner(ctx), { id: 'report', name: 'routine_report', input: { status: 'on-track', update: 'Checked the overdue ticket.', ask: null } });
    });
    expect(message).toContain('Please check the overdue ticket too.');
    expect(h.invokeCalls).toHaveLength(2);
    await expect.poll(async () => (await createRoutinesStore(h!.db).recentFires(task)).length).toBe(2);
    // A lost queued response can be retried after the follow-up has finished.
    // The original reply's stable request must not launch another check-in.
    expect(await h.bus.call('routines:reply', h.owner, { agentId: h.agentId, routineId: task.routineId, requestId: 'during-check-in', text: 'Please check the overdue ticket too.' }))
      .toMatchObject({ checkIn: 'replayed' });
    expect(h.invokeCalls).toHaveLength(2);
  });

  it('persists and batches FIFO updates, retries an unreported batch, and scopes full reads to the live owner check-in', async () => {
    let time = Date.parse('2031-01-01T12:00:00Z');
    let sleepers = 0;
    let wake: (() => void) | undefined;
    const messages: string[] = [];
    const errors: unknown[] = [];
    const contexts: AgentContext[] = [];
    let fullRead: { eventId: string; payload: string } | undefined;
    let sendLate: (() => Promise<number>) | undefined;
    h = await createRoutineHarness({
      clock: {
        now: () => new Date(time),
        sleep: (_ms, signal) => new Promise<void>(resolve => {
          sleepers++;
          const finish = () => { signal.removeEventListener('abort', finish); wake = undefined; resolve(); };
          wake = finish;
          if (signal.aborted) finish();
          else signal.addEventListener('abort', finish, { once: true });
        }),
      },
      invoke: async (ctx, bus, input) => {
        contexts.push(ctx);
        const message = (input as { message: { content: string } }).message.content;
        messages.push(message);
        try {
          const brief = await bus.call<unknown, { brief?: string }>(ROUTINES_AUGMENT_PROVIDER, ctx, {});
          expect(brief.brief).toContain('untrusted outside content');
          expect(brief.brief).not.toContain('PAYLOAD_PRIVATE');
          const landed = await bus.fire(SYSTEM_PROMPT_LANDED_HOOK, ctx, { reqId: ctx.reqId, providers: [ROUTINES_AUGMENT_PROVIDER] });
          expect(landed.rejected).toBe(false);
          const eventId = /App update (update_[A-Za-z0-9_-]+),/.exec(message)?.[1];
          expect(eventId).toBeDefined();
          if (messages.length === 1) {
            // An update arriving after this run's snapshot belongs to a later
            // batch, even if this run reports after that delivery committed.
            expect(await sendLate!()).toBe(202);
            fullRead = await bus.call('tool:execute:routine_read_update', routineRunner(ctx), { id: 'full', name: 'routine_read_update', input: { eventId } });
            expect(fullRead?.payload).toContain('PAYLOAD_PRIVATE_TAIL');
            expect(fullRead?.payload).toContain('Untrusted outside content');
            for (const outside of [routineRunner(ctx, { userId: 'peer' }), routineRunner(ctx, { conversationId: 'other' }), makeAgentContext({ userId: ctx.userId, agentId: ctx.agentId, sessionId: 'chat', conversationId: ctx.conversationId })])
              await expect(bus.call('tool:execute:routine_read_update', outside, { id: 'read', name: 'routine_read_update', input: { eventId } })).rejects.toBeDefined();
            // No report on the first run: every assigned update must survive.
          } else {
            await bus.call('tool:execute:routine_report', routineRunner(ctx), { id: 'report', name: 'routine_report', input: { status: 'on-track', update: 'Handled app updates.', notes: 'Checked the app.', ask: null } });
          }
        } catch (error) { errors.push(error); }
        await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] });
        return { kind: 'complete' };
      },
    });
    const task = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
      agentId: h.agentId, requestId: 'task', definition: RoutineDefinitionSchema.parse({
        name: 'Support queue', promptBody: 'Keep the queue clear.', kind: 'stay-on-top', goodWhen: 'Nothing waits.',
        schedule: { kind: 'interval', every: '1h' }, webhook: { kind: 'webhook', path: '/updates', respondWithin: '60s', hmac: { header: 'sig', algorithm: 'sha256' } },
      }),
    });
    const address = await h.bus.call<unknown, { token: string }>('routines:webhook-address', h.owner, { agentId: h.agentId, routineId: task.routineId });
    const listening = captureExpectedStderr(message => message.startsWith('[ax/http-server] listening on http://127.0.0.1:'));
    const server = createHttpServerPlugin({ host: '127.0.0.1', port: 0, cookieKey: Buffer.alloc(32, 1), allowedOrigins: ['http://localhost'] });
    const transport = await createTestHarness({ plugins: [server] });
    try {
      for (const route of h.routes) await transport.bus.call('http:register-route', h.owner, route);
      const send = async (number: number) => {
        const body = JSON.stringify({ number, text: number === 0 ? 'PAYLOAD_PRIVATE_' + '💚'.repeat(1500) + 'PAYLOAD_PRIVATE_TAIL' : `update-${number}` });
        return fetch(`http://127.0.0.1:${server.boundPort()}/webhooks/${address.token}/updates`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-delivery': `delivery-${number}`, sig: createHmac('sha256', 'test-secret').update(body).digest('hex') }, body });
      };
      sendLate = async () => (await send(21)).status;
      for (let n = 0; n < 21; n++) expect((await send(n)).status).toBe(202);
      expect((await send(0)).status).toBe(202); // Durable dedupe, not another entry.
      expect(messages).toHaveLength(0); // The receiver never starts task check-ins.
      const step = async (ms: number, expectedRuns: number) => {
        const previous = sleepers;
        time += ms;
        expect(wake).toBeTypeOf('function');
        wake!();
        await expect.poll(() => sleepers).toBeGreaterThan(previous);
        await expect.poll(() => messages.length).toBe(expectedRuns);
        await expect.poll(async () => (await createRoutinesStore(h!.db).recentFires(task)).length).toBe(expectedRuns);
        if (errors.length) throw errors[0];
      };
      await step(59_000, 0);
      await step(1_000, 1);
      expect(messages[0]!.match(/App update update_/g)).toHaveLength(20);
      expect(messages[0]).toContain('preview cut at 4 KB');
      expect(messages[0]).not.toContain('PAYLOAD_PRIVATE_TAIL');
      expect(messages[0]).toContain('"number":19');
      expect(messages[0]).not.toContain('"number":20');
      expect(messages[0]).not.toContain('"number":21');
      await step(60_000, 2);
      expect(messages[1]!.match(/App update update_/g)).toHaveLength(20);
      expect(messages[1]).toContain(fullRead!.eventId);
      // The reported batch retires; overflow and the late update follow promptly.
      await step(5_000, 3);
      expect(messages[2]!.match(/App update update_/g)).toHaveLength(2);
      expect(messages[2]).toContain('"number":20');
      expect(messages[2]).toContain('"number":21');
      expect(messages[2]).toContain('may reflect your own earlier change');
      await expect(h.bus.call('tool:execute:routine_read_update', routineRunner(contexts[0]!), { id: 'stale', name: 'routine_read_update', input: { eventId: fullRead!.eventId } })).rejects.toBeDefined();
      const stored = await createRoutinesStore(h.db).findOne(task);
      expect(stored?.nextRunAt?.getTime()).toBe(time + 60 * 60_000);
      const generic = await h.bus.call('routines:get', h.owner, { agentId: h.agentId, routineId: task.routineId });
      expect(JSON.stringify(generic)).not.toContain('PAYLOAD_PRIVATE');
      expect((await createRoutinesStore(h.db).recentFires(task)).every(run => run.renderedPrompt === null)).toBe(true);
    } finally { await transport.close(); listening.restore(); }
  }, 120_000);
});
