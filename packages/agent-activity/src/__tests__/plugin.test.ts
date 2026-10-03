import { HookBus, makeAgentContext, type AgentContext, type ToolDescriptor } from '@ax/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentActivityPlugin } from '../plugin.js';
import type { AgentActivityGetOutput } from '../types.js';

const T0 = Date.parse('2026-08-21T09:00:00.000Z');

let clock = T0;
function now(): number {
  return clock;
}

function ctx(
  over: { agentId?: string; triggerLabel?: string; reqId?: string } = {},
): AgentContext {
  return makeAgentContext({
    sessionId: 's1',
    userId: 'u1',
    agentId: over.agentId ?? 'a1',
    ...(over.triggerLabel !== undefined ? { triggerLabel: over.triggerLabel } : {}),
    ...(over.reqId !== undefined ? { reqId: over.reqId } : {}),
  });
}

/**
 * A runner-driven `chat:turn-end`, shaped the way the host really fires it:
 * the IPC boundary stamps a FRESH `ctx.reqId` per request, and the turn's own
 * id — the `agent:invoke` reqId that `chat:start` carried — rides in the
 * payload. A test that reused the start's ctx here would pass against a
 * subscriber that read the wrong one.
 */
async function turnEnd(
  bus: HookBus,
  over: { agentId?: string; reqId?: string; role?: 'assistant' | 'tool'; foldedReqIds?: unknown } = {},
): Promise<void> {
  await bus.fire('chat:turn-end', ctx({ agentId: over.agentId, reqId: 'ipc-restamped' }), {
    reason: 'user-message-wait',
    role: over.role ?? 'assistant',
    ...(over.reqId !== undefined ? { reqId: over.reqId } : {}),
    ...(over.foldedReqIds !== undefined ? { foldedReqIds: over.foldedReqIds } : {}),
  });
}

function descriptor(over: Partial<ToolDescriptor> & { name: string }): ToolDescriptor {
  return { inputSchema: {}, executesIn: 'host', ...over };
}

/** A stand-in for @ax/tool-dispatcher's `tool:list`. */
function registerCatalog(bus: HookBus, tools: ToolDescriptor[]): { calls: number } {
  const counter = { calls: 0 };
  bus.registerService<Record<string, never>, { tools: ToolDescriptor[] }>(
    'tool:list',
    '@ax/test-catalog',
    async () => {
      counter.calls += 1;
      return { tools };
    },
  );
  return counter;
}

async function boot(
  bus: HookBus,
): Promise<ReturnType<typeof createAgentActivityPlugin>> {
  const plugin = createAgentActivityPlugin({ now });
  await plugin.init({ bus, config: undefined });
  return plugin;
}

async function get(bus: HookBus, agentId = 'a1'): Promise<AgentActivityGetOutput> {
  return bus.call<{ agentId: string }, AgentActivityGetOutput>('agent-activity:get', ctx(), {
    agentId,
  });
}

beforeEach(() => {
  clock = T0;
});

describe('the tool:pre-call subscriber can never affect the call', () => {
  it('returns undefined and leaves the call unmodified', async () => {
    const bus = new HookBus();
    registerCatalog(bus, [descriptor({ name: 'web_search', activityPhrase: 'Searching the web' })]);
    await boot(bus);

    const call = { id: 'c1', name: 'web_search', input: { query: 'cats' } };
    const result = await bus.fire('tool:pre-call', ctx(), call);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.payload).toBe(call);
  });

  it('still returns undefined when its own bookkeeping throws — a status line must never veto a tool call', async () => {
    const bus = new HookBus();
    // A `tool:list` that blows up is the most realistic internal failure: it is
    // the one thing the subscriber awaits.
    bus.registerService('tool:list', '@ax/test-catalog', async () => {
      throw new Error('catalog exploded');
    });
    await boot(bus);

    const call = { id: 'c1', name: 'web_search', input: {} };
    const logger = { ...ctx().logger, error: vi.fn() };
    const noisyCtx = { ...ctx(), logger } as unknown as AgentContext;

    const result = await bus.fire('tool:pre-call', noisyCtx, call);

    expect(result.rejected).toBe(false);
    if (result.rejected) return;
    expect(result.payload).toBe(call);
    // Swallowed, but loudly — HookBus.fire would have eaten a throw silently.
    expect(logger.error).toHaveBeenCalledWith(
      'agent_activity_record_failed',
      expect.objectContaining({ tool: 'web_search' }),
    );
  });

  it('still records the STEP when the catalog read fails — a failed lookup must not read as silence', async () => {
    const bus = new HookBus();
    bus.registerService('tool:list', '@ax/test-catalog', async () => {
      throw new Error('catalog exploded');
    });
    await boot(bus);

    await bus.fire('chat:start', ctx(), {});
    clock = T0 + 80_000;
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });

    // 80s after the turn started, but only 10s after the step: not stale.
    clock = T0 + 89_000;
    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Working on your request',
      stale: false,
    });
  });

  it('does not reject when there is no tool catalog at all', async () => {
    const bus = new HookBus();
    await boot(bus);
    const result = await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });
    expect(result.rejected).toBe(false);
  });
});

describe('agent-activity:get', () => {
  it('is null before any work starts and after it ends', async () => {
    const bus = new HookBus();
    await boot(bus);
    expect((await get(bus)).activity).toBeNull();

    await bus.fire('chat:start', ctx(), { message: { role: 'user', content: 'hi' } });
    expect((await get(bus)).activity).not.toBeNull();

    await bus.fire('chat:end', ctx(), { outcome: { kind: 'complete', messages: [] } });
    expect((await get(bus)).activity).toBeNull();
  });

  it('says nothing at all once the turn errors — the error state is not this line to tell', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx(), {});
    await bus.fire('chat:turn-error', ctx(), { reqId: 'r1', reason: 'sandbox-died' });
    expect((await get(bus)).activity).toBeNull();
  });

  it('resolves to the T0 floor for a user turn with no routine behind it', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx(), {});
    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Working on your request',
      source: 'trigger',
      counter: null,
      stale: false,
      startedAt: '2026-08-21T09:00:00.000Z',
    });
  });

  it("resolves to the routine's own name when the context carries one", async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ triggerLabel: 'Morning email pass' }), {});
    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Morning email pass',
      source: 'trigger',
    });
  });

  it("promotes to the running tool's in-repo phrase, and back down when the turn ends", async () => {
    const bus = new HookBus();
    registerCatalog(bus, [descriptor({ name: 'web_search', activityPhrase: 'Searching the web' })]);
    await boot(bus);

    await bus.fire('chat:start', ctx({ triggerLabel: 'Morning email pass' }), {});
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });

    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Searching the web',
      source: 'tool',
    });

    await bus.fire('chat:end', ctx(), { outcome: { kind: 'complete', messages: [] } });
    expect((await get(bus)).activity).toBeNull();
  });

  it('never borrows a description: a tool with no activityPhrase falls to T0', async () => {
    const bus = new HookBus();
    registerCatalog(bus, [
      descriptor({ name: 'mcp.acme.list_things', description: 'List all the things, fast!' }),
    ]);
    await boot(bus);

    await bus.fire('chat:start', ctx({ triggerLabel: 'Morning email pass' }), {});
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'mcp.acme.list_things', input: {} });

    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Morning email pass',
      source: 'trigger',
    });
  });

  it('starts a record for a pre-call that arrived with no chat:start behind it', async () => {
    const bus = new HookBus();
    registerCatalog(bus, [descriptor({ name: 'web_search', activityPhrase: 'Searching the web' })]);
    await boot(bus);

    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });
    expect((await get(bus)).activity).toMatchObject({ phrase: 'Searching the web' });
  });

  it('reads the catalog once per stretch of work, not once per tool call', async () => {
    const bus = new HookBus();
    const counter = registerCatalog(bus, [
      descriptor({ name: 'web_search', activityPhrase: 'Searching the web' }),
    ]);
    await boot(bus);

    await bus.fire('chat:start', ctx(), {});
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });
    await bus.fire('tool:pre-call', ctx(), { id: 'c2', name: 'web_search', input: {} });
    expect(counter.calls).toBe(1);

    await bus.fire('chat:end', ctx(), { outcome: { kind: 'complete', messages: [] } });
    await bus.fire('chat:start', ctx(), {});
    await bus.fire('tool:pre-call', ctx(), { id: 'c3', name: 'web_search', input: {} });
    expect(counter.calls).toBe(2);
  });

  it('keeps one line per agent', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ agentId: 'a1', triggerLabel: 'Morning email pass' }), {});
    await bus.fire('chat:start', ctx({ agentId: 'a2', triggerLabel: 'Weekly digest' }), {});

    expect((await get(bus, 'a1')).activity).toMatchObject({ phrase: 'Morning email pass' });
    expect((await get(bus, 'a2')).activity).toMatchObject({ phrase: 'Weekly digest' });
    expect((await get(bus, 'a3')).activity).toBeNull();
  });

  /*
    ONE LINE PER AGENT IS ALSO ONE **RECORD** PER AGENT, and that has a cost
    worth pinning rather than discovering (TASK-498). There is no refcount:
    the first `chat:end` for an agent forgets the whole record, even when a
    second turn for that same agent is still running — a routine fire beside a
    chat, or two open threads.

    THIS TEST DOES NOT ENDORSE THAT, it fixes it in place so the next reader
    knows it is a shape and not an accident. It matters because TASK-498 made
    the workspace roster's working/resting word a reading of this record
    (`deriveState` in channel-web's routes-workspace.ts), so the gap now
    reaches a chip a person looks at: the agent reads "resting" while its
    other turn is visibly streaming.

    THE DIRECTION IS WHY IT IS LEFT ALONE FOR NOW. Under-reporting obeys the
    reading surface's standing rule that "we don't know" renders as resting,
    and it self-heals on the running turn's next step (see the second half).
    A refcount fails the other way: one `chat:start` whose end never arrives
    would pin the agent on "Working" with nothing running, which is precisely
    the bug TASK-498 existed to end. Fixing it properly means owning that leak
    story here, in this plugin, on its own card.

    TASK-686 DID NOT CHANGE THIS, and deliberately. It added per-turn ids so a
    `chat:turn-end` ends only its own turn (see "a turn ends on chat:turn-end"
    below) — but those ids only ever let the record go EARLIER. `chat:end` and
    `chat:turn-error` still forget the whole agent, so a stranded id can never
    hold "Working" past the end that used to clear it. Both assertions here
    still hold unchanged.
  */
  it('forgets the whole agent on the FIRST end, even with a second turn still running', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ agentId: 'a1', triggerLabel: 'Morning email pass' }), {});
    await bus.fire('chat:start', ctx({ agentId: 'a1', triggerLabel: 'Weekly digest' }), {});
    expect((await get(bus, 'a1')).activity).not.toBeNull();

    // One of the two ends. The other is still going.
    await bus.fire('chat:end', ctx({ agentId: 'a1' }), {
      outcome: { kind: 'complete', messages: [] },
    });
    expect((await get(bus, 'a1')).activity).toBeNull();
  });

  it('recovers the running turn on its next step — the gap is transient, not sticky', async () => {
    const bus = new HookBus();
    registerCatalog(bus, [descriptor({ name: 'read_email', activityPhrase: 'Reading email' })]);
    await boot(bus);
    await bus.fire('chat:start', ctx({ agentId: 'a1', triggerLabel: 'Morning email pass' }), {});
    await bus.fire('chat:start', ctx({ agentId: 'a1', triggerLabel: 'Weekly digest' }), {});
    await bus.fire('chat:end', ctx({ agentId: 'a1' }), {
      outcome: { kind: 'complete', messages: [] },
    });
    expect((await get(bus, 'a1')).activity).toBeNull();

    // The surviving turn calls a tool. `recordToolCall` starts a record for a
    // step that arrived with no `chat:start` behind it, so the line — and the
    // working/resting word read off it — comes back on its own.
    await bus.fire('tool:pre-call', ctx({ agentId: 'a1' }), {
      name: 'read_email',
      input: {},
    });
    expect((await get(bus, 'a1')).activity).toMatchObject({ phrase: 'Reading email' });
  });
});

/*
  TASK-686. Under keepAlive (the k8s preset) a turn COMPLETES on
  `chat:turn-end` and the runner is left warm; `chat:end` only arrives when the
  idle reaper takes the runner, minutes later. Forgetting on `chat:end` alone
  left the agent reading "Working" for that whole window after it had replied.
*/
describe('a turn ends on chat:turn-end, even while the runner stays warm', () => {
  it('forgets the record when the only running turn ends, with no chat:end behind it', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ reqId: 'r1' }), {});
    expect((await get(bus)).activity).not.toBeNull();

    await turnEnd(bus, { reqId: 'r1' });
    expect((await get(bus)).activity).toBeNull();
  });

  it('keeps reading working while a second turn on the same agent is still in flight', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ reqId: 'r1', triggerLabel: 'Morning email pass' }), {});
    await bus.fire('chat:start', ctx({ reqId: 'r2', triggerLabel: 'Weekly digest' }), {});

    await turnEnd(bus, { reqId: 'r1' });
    expect((await get(bus)).activity).not.toBeNull();

    await turnEnd(bus, { reqId: 'r2' });
    expect((await get(bus)).activity).toBeNull();
  });

  it('keeps the EARLIER turn when the later one finishes first', async () => {
    // A later chat:start re-writes the line; it must not drop the turn that
    // was already running from the set, or that turn's survivor reads resting.
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ reqId: 'r1' }), {});
    await bus.fire('chat:start', ctx({ reqId: 'r2' }), {});

    await turnEnd(bus, { reqId: 'r2' });
    expect((await get(bus)).activity).not.toBeNull();

    await turnEnd(bus, { reqId: 'r1' });
    expect((await get(bus)).activity).toBeNull();
  });

  it('is idempotent across the tool + assistant turn-ends one user message emits', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ reqId: 'r1' }), {});
    await bus.fire('chat:start', ctx({ reqId: 'r2' }), {});

    // r1's two turn-ends must not spend r2's turn as well.
    await turnEnd(bus, { reqId: 'r1', role: 'tool' });
    await turnEnd(bus, { reqId: 'r1', role: 'assistant' });
    expect((await get(bus)).activity).not.toBeNull();
  });

  it('ignores a turn-end for a turn it never saw start while another is running', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ reqId: 'r1' }), {});

    await turnEnd(bus, { reqId: 'someone-else' });
    expect((await get(bus)).activity).not.toBeNull();
  });

  it('keeps the other agent working when one agent\'s turn ends', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ agentId: 'a1', reqId: 'r1' }), {});
    await bus.fire('chat:start', ctx({ agentId: 'a2', reqId: 'r2' }), {});

    await turnEnd(bus, { agentId: 'a1', reqId: 'r1' });
    expect((await get(bus, 'a1')).activity).toBeNull();
    expect((await get(bus, 'a2')).activity).not.toBeNull();
  });

  it('forgets a record a tool step recovered, once that turn ends', async () => {
    // The survivor of the "first end forgets the whole agent" gap re-creates
    // its record on its next tool call — a record no `chat:start` stands
    // behind, so it knows no turn ids. Its turn-end must still close it, or
    // the recovery would pin "Working" until the reaper.
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('tool:pre-call', ctx({ reqId: 'ipc-restamped' }), {
      id: 'c1',
      name: 'web_search',
      input: {},
    });
    expect((await get(bus)).activity).not.toBeNull();

    await turnEnd(bus, { reqId: 'r2' });
    expect((await get(bus)).activity).toBeNull();
  });

  // TASK-708. A message that reaches a busy claude-sdk runner is folded into
  // the running turn: two chat:starts, ONE turn. The folded message never gets
  // a turn-end of its own, so before the runner named it on the turn that
  // answered it, the agent read Working after the reply until the reaper —
  // and the stranded id rode every later turn on that warm runner.
  it('clears when one turn answers two chat:starts in one session (a fold)', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ reqId: 'r1' }), {});
    await bus.fire('chat:start', ctx({ reqId: 'r2' }), {});

    await turnEnd(bus, { reqId: 'r1', role: 'tool', foldedReqIds: ['r2'] });
    await turnEnd(bus, { reqId: 'r1', role: 'assistant', foldedReqIds: ['r2'] });
    expect((await get(bus)).activity).toBeNull();

    // Not sticky: the next turn on the warm runner clears on its own turn-end.
    await bus.fire('chat:start', ctx({ reqId: 'r3' }), {});
    await turnEnd(bus, { reqId: 'r3' });
    expect((await get(bus)).activity).toBeNull();
  });

  it('a folded id ends only that turn — a genuinely concurrent turn keeps it working', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ reqId: 'r1' }), {});
    await bus.fire('chat:start', ctx({ reqId: 'r2' }), {});
    await bus.fire('chat:start', ctx({ reqId: 'r3' }), {});

    await turnEnd(bus, { reqId: 'r1', foldedReqIds: ['r2', 'never-started'] });
    expect((await get(bus)).activity).not.toBeNull();

    await turnEnd(bus, { reqId: 'r3' });
    expect((await get(bus)).activity).toBeNull();
  });

  it('ignores a malformed foldedReqIds rather than reading it as a turn', async () => {
    const bus = new HookBus();
    await boot(bus);
    // A one-character id, so a reader that iterated a bare string (strings
    // are iterable) would find it and wrongly end the turn.
    await bus.fire('chat:start', ctx({ reqId: 'r1' }), {});
    await bus.fire('chat:start', ctx({ reqId: 'x' }), {});

    await turnEnd(bus, { reqId: 'r1', foldedReqIds: 'x' });
    await turnEnd(bus, { reqId: 'r1', foldedReqIds: [42, null, { id: 'x' }] });
    expect((await get(bus)).activity).not.toBeNull();
  });

  it('falls to resting when a turn-end names no turn at all — never pinned on working', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ reqId: 'r1' }), {});
    await bus.fire('chat:start', ctx({ reqId: 'r2' }), {});

    await turnEnd(bus, {});
    expect((await get(bus)).activity).toBeNull();
  });

  it('a later turn on the warm runner starts a fresh stretch of work', async () => {
    const bus = new HookBus();
    await boot(bus);
    await bus.fire('chat:start', ctx({ reqId: 'r1' }), {});
    await turnEnd(bus, { reqId: 'r1' });

    clock = T0 + 60_000;
    await bus.fire('chat:start', ctx({ reqId: 'r2' }), {});
    expect((await get(bus)).activity).toMatchObject({
      startedAt: new Date(T0 + 60_000).toISOString(),
    });
    await turnEnd(bus, { reqId: 'r2' });
    expect((await get(bus)).activity).toBeNull();
  });
});

describe('two tool calls in flight at once', () => {
  it('shows the tool that was CALLED last, not the lookup that RESOLVED last', async () => {
    const bus = new HookBus();
    const gates: Array<() => void> = [];
    bus.registerService<Record<string, never>, { tools: ToolDescriptor[] }>(
      'tool:list',
      '@ax/test-catalog',
      async () =>
        new Promise((resolve) => {
          gates.push(() =>
            resolve({
              tools: [
                descriptor({ name: 'slow_tool', activityPhrase: 'Reading a web page' }),
                descriptor({ name: 'fast_tool', activityPhrase: 'Searching the web' }),
              ],
            }),
          );
        }),
    );
    await boot(bus);
    await bus.fire('chat:start', ctx(), {});

    // Two calls start, in order; their catalog lookups finish in the opposite
    // order. The line must follow call order.
    const first = bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'slow_tool', input: {} });
    clock = T0 + 1;
    const second = bus.fire('tool:pre-call', ctx(), { id: 'c2', name: 'fast_tool', input: {} });

    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!();
    gates[0]!();
    await Promise.all([first, second]);

    expect((await get(bus)).activity).toMatchObject({ phrase: 'Searching the web' });
  });
});

describe('staleness, through the injected clock', () => {
  it('replaces the phrase after 90 seconds of silence and drops the counter', async () => {
    const bus = new HookBus();
    registerCatalog(bus, [
      descriptor({ name: 'web_search', activityPhrase: 'Searching the web', countable: 'results' }),
    ]);
    await boot(bus);

    await bus.fire('chat:start', ctx(), {});
    await bus.fire('tool:pre-call', ctx(), { id: 'c1', name: 'web_search', input: {} });
    expect((await get(bus)).activity).toMatchObject({ phrase: 'Searching the web', stale: false });

    clock = T0 + 4 * 60_000;
    expect((await get(bus)).activity).toMatchObject({
      phrase: 'No activity for 4 minutes',
      stale: true,
      counter: null,
    });

    // A fresh step un-stales it — the line follows the stream, it does not latch.
    clock = T0 + 4 * 60_000 + 1_000;
    await bus.fire('tool:pre-call', ctx(), { id: 'c2', name: 'web_search', input: {} });
    expect((await get(bus)).activity).toMatchObject({
      phrase: 'Searching the web',
      stale: false,
      // startedAt still marks when the WORK started, not when the step landed.
      startedAt: '2026-08-21T09:00:00.000Z',
    });
  });
});

describe('lifecycle', () => {
  it('unsubscribes and forgets everything on shutdown', async () => {
    const bus = new HookBus();
    const plugin = await boot(bus);
    await bus.fire('chat:start', ctx(), {});

    await plugin.shutdown?.();

    expect(bus.unsubscribe('chat:start', '@ax/agent-activity')).toBe(0);
    expect(bus.unsubscribe('tool:pre-call', '@ax/agent-activity')).toBe(0);
    // Idempotent — a second shutdown is a no-op, not a throw.
    await plugin.shutdown?.();
  });
});

describe('the manifest', () => {
  it('registers one read hook, subscribes to five, and requires nothing', () => {
    const { manifest } = createAgentActivityPlugin();
    expect(manifest.registers).toEqual(['agent-activity:get']);
    expect(manifest.calls).toEqual([]);
    expect(manifest.optionalCalls?.map((o) => o.hook)).toEqual(['tool:list']);
    expect(manifest.subscribes).toEqual([
      'chat:start',
      'chat:turn-end',
      'chat:end',
      'chat:turn-error',
      'tool:pre-call',
    ]);
  });
});
