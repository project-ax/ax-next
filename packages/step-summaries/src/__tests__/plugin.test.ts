import { describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, type LlmCallInput, type LlmCallOutput } from '@ax/core';
import { createStepSummariesPlugin, DEFAULT_SUMMARY_MODEL, MAX_SUMMARIES_PER_TURN } from '../plugin.js';

const LLM_HOOK = `llm:call:${DEFAULT_SUMMARY_MODEL.slice(0, DEFAULT_SUMMARY_MODEL.indexOf('/'))}`;
const REASONING = 'I need to animate the legs, so I will write a small script that computes the pedal angles.';

async function setup(answer: string | (() => Promise<LlmCallOutput>) = 'Working out the leg motion with a script.') {
  const bus = new HookBus();
  const llmCalls: LlmCallInput[] = [];
  const appended: unknown[] = [];
  const frames: Array<Record<string, unknown>> = [];
  bus.registerService<LlmCallInput, LlmCallOutput>(LLM_HOOK, 'mock-llm', async (_ctx, input) => {
    llmCalls.push(input);
    if (typeof answer === 'function') return answer();
    return { text: answer, stopReason: 'end_turn' } as LlmCallOutput;
  });
  bus.registerService('conversations:append-event', 'mock-conv', async (_ctx, input) => {
    appended.push(input);
    return {};
  });
  bus.subscribe<Record<string, unknown>>('chat:stream-chunk', 'spy', async (_ctx, p) => {
    if (p.kind === 'step-summary') frames.push(p);
    return undefined;
  });
  await createStepSummariesPlugin().init({ bus, config: {} });
  const ctx = makeAgentContext({ sessionId: 's1', agentId: 'agt_a', userId: 'u1', conversationId: 'c1' });
  const chunk = (p: Record<string, unknown>) => bus.fire('chat:stream-chunk', ctx, { reqId: 'r1', ...p });
  const settle = () => vi.waitFor(() => expect(llmCalls.length).toBeGreaterThan(0));
  return { bus, ctx, chunk, llmCalls, appended, frames, settle };
}

describe('@ax/step-summaries', () => {
  it('summarizes the reasoning before a tool call into one frame and one stored event', async () => {
    const t = await setup();
    await t.chunk({ kind: 'thinking', text: REASONING });
    await t.chunk({ kind: 'tool-use', toolCallId: 'tu1', toolName: 'Bash', input: {} });
    await vi.waitFor(() => expect(t.appended).toHaveLength(1));
    expect(t.frames).toEqual([
      { reqId: 'r1', kind: 'step-summary', toolCallId: 'tu1', text: 'Working out the leg motion with a script.' },
    ]);
    expect(t.appended[0]).toEqual({
      conversationId: 'c1',
      kind: 'step-summary',
      key: 'tu1',
      payload: { toolCallId: 'tu1', text: 'Working out the leg motion with a script.' },
    });
  });

  it('sends the reasoning only to the model, fenced as material, never in a frame or event', async () => {
    const t = await setup();
    await t.chunk({ kind: 'thinking', text: REASONING });
    await t.chunk({ kind: 'tool-use', toolCallId: 'tu1', toolName: 'Bash', input: {} });
    await vi.waitFor(() => expect(t.appended).toHaveLength(1));
    const content = t.llmCalls[0]!.messages[0]!.content as string;
    expect(content).toContain('<reasoning>');
    expect(content).toContain(REASONING);
    expect(JSON.stringify([t.frames, t.appended])).not.toContain('pedal angles');
  });

  it('skips a step with too little reasoning, and reasoning that led to prose', async () => {
    const t = await setup();
    await t.chunk({ kind: 'thinking', text: 'Let me check.' });
    await t.chunk({ kind: 'tool-use', toolCallId: 'tu1', toolName: 'Bash', input: {} });
    await t.chunk({ kind: 'thinking', text: REASONING });
    await t.chunk({ kind: 'text', text: 'Here you go.' });
    await t.chunk({ kind: 'tool-use', toolCallId: 'tu2', toolName: 'Bash', input: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.llmCalls).toHaveLength(0);
  });

  it('drops an unusable answer instead of showing it', async () => {
    const t = await setup('   \n');
    await t.chunk({ kind: 'thinking', text: REASONING });
    await t.chunk({ kind: 'tool-use', toolCallId: 'tu1', toolName: 'Bash', input: {} });
    await t.settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.frames).toHaveLength(0);
    expect(t.appended).toHaveLength(0);
  });

  it('a failed model call costs only the summary', async () => {
    const t = await setup(async () => {
      throw new Error('provider down');
    });
    await t.chunk({ kind: 'thinking', text: REASONING });
    await t.chunk({ kind: 'tool-use', toolCallId: 'tu1', toolName: 'Bash', input: {} });
    await t.settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.frames).toHaveLength(0);
  });

  it(`stops at ${MAX_SUMMARIES_PER_TURN} summaries in one request`, async () => {
    const t = await setup();
    for (let i = 0; i < MAX_SUMMARIES_PER_TURN + 5; i++) {
      await t.chunk({ kind: 'thinking', text: REASONING });
      await t.chunk({ kind: 'tool-use', toolCallId: `tu${i}`, toolName: 'Bash', input: {} });
    }
    await vi.waitFor(() => expect(t.llmCalls).toHaveLength(MAX_SUMMARIES_PER_TURN));
  });

  it('ignores a call id too long to be one (it would become a stored key)', async () => {
    const t = await setup();
    await t.chunk({ kind: 'thinking', text: REASONING });
    await t.chunk({ kind: 'tool-use', toolCallId: 'x'.repeat(300), toolName: 'Bash', input: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.llmCalls).toHaveLength(0);
  });

  it("never summarizes one session's reasoning onto another session's call", async () => {
    const t = await setup();
    const other = makeAgentContext({ sessionId: 's2', agentId: 'agt_b', userId: 'u2', conversationId: 'c2' });
    // Session s1 thinks; a different session claims the same reqId and calls a tool.
    await t.chunk({ kind: 'thinking', text: REASONING });
    await t.bus.fire('chat:stream-chunk', other, { reqId: 'r1', kind: 'tool-use', toolCallId: 'tu9', toolName: 'Bash', input: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.llmCalls).toHaveLength(0);
    // Its own call still gets its own summary.
    await t.chunk({ kind: 'tool-use', toolCallId: 'tu1', toolName: 'Bash', input: {} });
    await vi.waitFor(() => expect(t.appended).toHaveLength(1));
    expect(t.appended[0]).toMatchObject({ conversationId: 'c1', key: 'tu1' });
  });
});
