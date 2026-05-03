import { describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  makeAgentContext,
  PluginError,
  type AgentContext,
  type LlmCallInput,
  type LlmCallOutput,
} from '@ax/core';
import type { ContentBlock } from '@ax/ipc-protocol';
import { createConversationTitlesPlugin } from '../plugin.js';
import type {
  Conversation,
  GetInput,
  GetOutput,
  SetTitleInput,
  SetTitleOutput,
  Turn,
  TurnRole,
} from '../types.js';

// ---------------------------------------------------------------------------
// Test fixtures.
//
// We register stubs for `conversations:get`, `llm:call`, and
// `conversations:set-title` directly on a HookBus, mirror the @ax/llm-anthropic
// plugin test pattern (HookBus + makeAgentContext + manual hook registration).
// ---------------------------------------------------------------------------

interface Stubs {
  bus: HookBus;
  getCalls: Array<GetInput>;
  llmCalls: Array<LlmCallInput>;
  setTitleCalls: Array<SetTitleInput>;
  setGetResult(v: GetOutput | (() => Promise<GetOutput>)): void;
  setLlmResult(v: LlmCallOutput | (() => Promise<LlmCallOutput>)): void;
  setSetTitleResult(
    v: SetTitleOutput | (() => Promise<SetTitleOutput>),
  ): void;
}

function makeStubsBus(): Stubs {
  const bus = new HookBus();
  const getCalls: Array<GetInput> = [];
  const llmCalls: Array<LlmCallInput> = [];
  const setTitleCalls: Array<SetTitleInput> = [];

  let getResult: GetOutput | (() => Promise<GetOutput>) = {
    conversation: makeConversation({ title: null }),
    turns: [],
  };
  let llmResult: LlmCallOutput | (() => Promise<LlmCallOutput>) = {
    text: 'Default Title',
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  let setTitleResult: SetTitleOutput | (() => Promise<SetTitleOutput>) = {
    updated: true,
  };

  bus.registerService<GetInput, GetOutput>(
    'conversations:get',
    'mock-conversations',
    async (_ctx, input) => {
      getCalls.push(input);
      if (typeof getResult === 'function') return getResult();
      return getResult;
    },
  );
  bus.registerService<LlmCallInput, LlmCallOutput>(
    'llm:call',
    'mock-llm',
    async (_ctx, input) => {
      llmCalls.push(input);
      if (typeof llmResult === 'function') return llmResult();
      return llmResult;
    },
  );
  bus.registerService<SetTitleInput, SetTitleOutput>(
    'conversations:set-title',
    'mock-conversations',
    async (_ctx, input) => {
      setTitleCalls.push(input);
      if (typeof setTitleResult === 'function') return setTitleResult();
      return setTitleResult;
    },
  );

  return {
    bus,
    getCalls,
    llmCalls,
    setTitleCalls,
    setGetResult(v) {
      getResult = v;
    },
    setLlmResult(v) {
      llmResult = v;
    },
    setSetTitleResult(v) {
      setTitleResult = v;
    },
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    title: null,
    ...overrides,
  };
}

let turnCounter = 0;
function turn(role: TurnRole, blocks: ContentBlock[]): Turn {
  turnCounter += 1;
  return {
    turnId: `t${turnCounter}`,
    turnIndex: turnCounter,
    role,
    contentBlocks: blocks,
    createdAt: '2026-05-03T00:00:00.000Z',
  };
}

function makeCtx(overrides: {
  conversationId?: string;
  userId?: string;
} = {}): AgentContext {
  return makeAgentContext({
    sessionId: 's1',
    agentId: 'agt_a',
    userId: overrides.userId ?? 'userA',
    ...(overrides.conversationId !== undefined
      ? { conversationId: overrides.conversationId }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('@ax/conversation-titles plugin manifest', () => {
  it('declares no registers, three calls, one subscribe', () => {
    const plugin = createConversationTitlesPlugin();
    expect(plugin.manifest).toEqual({
      name: '@ax/conversation-titles',
      version: '0.0.0',
      registers: [],
      calls: ['llm:call', 'conversations:get', 'conversations:set-title'],
      subscribes: ['chat:turn-end'],
    });
  });
});

// ---------------------------------------------------------------------------
// chat:turn-end behavior
// ---------------------------------------------------------------------------

describe('@ax/conversation-titles chat:turn-end subscriber', () => {
  it('is a no-op when the turn role is "user"', async () => {
    const stubs = makeStubsBus();
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const ctx = makeCtx({ conversationId: 'c1' });
    await stubs.bus.fire('chat:turn-end', ctx, { role: 'user' });

    expect(stubs.getCalls).toHaveLength(0);
    expect(stubs.llmCalls).toHaveLength(0);
    expect(stubs.setTitleCalls).toHaveLength(0);
  });

  it('is a no-op when ctx.conversationId is undefined', async () => {
    const stubs = makeStubsBus();
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const ctx = makeCtx(); // no conversationId
    await stubs.bus.fire('chat:turn-end', ctx, { role: 'assistant' });

    expect(stubs.getCalls).toHaveLength(0);
    expect(stubs.llmCalls).toHaveLength(0);
    expect(stubs.setTitleCalls).toHaveLength(0);
  });

  it('is a no-op when the conversation already has a title', async () => {
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: 'Existing Title' }),
      turns: [turn('user', [{ type: 'text', text: 'Hi' }])],
    });
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const ctx = makeCtx({ conversationId: 'c1' });
    await stubs.bus.fire('chat:turn-end', ctx, { role: 'assistant' });

    expect(stubs.getCalls).toHaveLength(1);
    expect(stubs.llmCalls).toHaveLength(0);
    expect(stubs.setTitleCalls).toHaveLength(0);
  });

  it('is a no-op when the transcript is empty', async () => {
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [],
    });
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const ctx = makeCtx({ conversationId: 'c1' });
    await stubs.bus.fire('chat:turn-end', ctx, { role: 'assistant' });

    expect(stubs.getCalls).toHaveLength(1);
    expect(stubs.llmCalls).toHaveLength(0);
    expect(stubs.setTitleCalls).toHaveLength(0);
  });

  it('happy path: reads transcript, calls llm, writes set-title with ifNull=true', async () => {
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [
        turn('user', [{ type: 'text', text: 'Hi there' }]),
        turn('assistant', [{ type: 'text', text: 'Hello!' }]),
      ],
    });
    stubs.setLlmResult({
      text: 'My Conversation',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const ctx = makeCtx({ conversationId: 'c1', userId: 'userA' });
    const result = await stubs.bus.fire('chat:turn-end', ctx, {
      role: 'assistant',
    });

    // The fire never rejects (subscribers swallow errors).
    expect(result.rejected).toBe(false);

    expect(stubs.getCalls).toHaveLength(1);
    expect(stubs.getCalls[0]).toEqual({
      conversationId: 'c1',
      userId: 'userA',
    });

    expect(stubs.llmCalls).toHaveLength(1);
    expect(stubs.llmCalls[0]?.model).toBe('claude-haiku-4-5-20251001');
    expect(stubs.llmCalls[0]?.maxTokens).toBe(32);
    expect(stubs.llmCalls[0]?.temperature).toBe(0.3);
    expect(stubs.llmCalls[0]?.messages).toEqual([
      {
        role: 'user',
        content: expect.stringContaining('User: Hi there') as unknown,
      },
    ]);

    expect(stubs.setTitleCalls).toHaveLength(1);
    expect(stubs.setTitleCalls[0]).toEqual({
      conversationId: 'c1',
      userId: 'userA',
      title: 'My Conversation',
      ifNull: true,
    });
  });

  it('swallows llm:call failures and skips set-title', async () => {
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [turn('user', [{ type: 'text', text: 'Hi' }])],
    });
    stubs.setLlmResult(async () => {
      throw new PluginError({
        code: 'unknown',
        plugin: 'mock-llm',
        hookName: 'llm:call',
        message: 'simulated upstream failure',
      });
    });
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const ctx = makeCtx({ conversationId: 'c1' });
    // The fire promise resolves normally — subscriber must not throw.
    const fireResult = await stubs.bus.fire('chat:turn-end', ctx, {
      role: 'assistant',
    });
    expect(fireResult.rejected).toBe(false);

    expect(stubs.llmCalls).toHaveLength(1);
    expect(stubs.setTitleCalls).toHaveLength(0);
  });

  it('skips set-title when validation rejects the model output (literal "Untitled")', async () => {
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [turn('user', [{ type: 'text', text: 'Hi' }])],
    });
    stubs.setLlmResult({
      text: 'Untitled',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const ctx = makeCtx({ conversationId: 'c1' });
    await stubs.bus.fire('chat:turn-end', ctx, { role: 'assistant' });

    expect(stubs.llmCalls).toHaveLength(1);
    expect(stubs.setTitleCalls).toHaveLength(0);
  });

  it('sanitizes quoted/multi-line model output before writing set-title', async () => {
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [turn('user', [{ type: 'text', text: 'Hi' }])],
    });
    stubs.setLlmResult({
      text: '"Hello World"\n',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const ctx = makeCtx({ conversationId: 'c1' });
    await stubs.bus.fire('chat:turn-end', ctx, { role: 'assistant' });

    expect(stubs.setTitleCalls).toHaveLength(1);
    expect(stubs.setTitleCalls[0]?.title).toBe('Hello World');
    expect(stubs.setTitleCalls[0]?.ifNull).toBe(true);
  });

  it('logs and tolerates a set-title returning { updated: false }', async () => {
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [turn('user', [{ type: 'text', text: 'Hi' }])],
    });
    stubs.setLlmResult({
      text: 'Race Loser',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    stubs.setSetTitleResult({ updated: false });

    const debugSpy = vi.fn();
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const baseCtx = makeCtx({ conversationId: 'c1' });
    const ctx: AgentContext = {
      ...baseCtx,
      logger: {
        ...baseCtx.logger,
        debug: debugSpy,
      },
    };
    const fireResult = await stubs.bus.fire('chat:turn-end', ctx, {
      role: 'assistant',
    });
    expect(fireResult.rejected).toBe(false);

    expect(stubs.setTitleCalls).toHaveLength(1);
    expect(debugSpy).toHaveBeenCalledWith(
      'conversation_titles_already_set',
      expect.objectContaining({ conversationId: 'c1' }),
    );
  });

  it('swallows set-title failures (subscriber must not throw)', async () => {
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [turn('user', [{ type: 'text', text: 'Hi' }])],
    });
    stubs.setLlmResult({
      text: 'Some Title',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    stubs.setSetTitleResult(async () => {
      throw new PluginError({
        code: 'unknown',
        plugin: 'mock-conversations',
        hookName: 'conversations:set-title',
        message: 'simulated DB failure',
      });
    });
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const ctx = makeCtx({ conversationId: 'c1' });
    const fireResult = await stubs.bus.fire('chat:turn-end', ctx, {
      role: 'assistant',
    });
    expect(fireResult.rejected).toBe(false);
    expect(stubs.setTitleCalls).toHaveLength(1);
  });
});
