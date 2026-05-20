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
import {
  createConversationTitlesPlugin,
  parseModelRef,
} from '../plugin.js';
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
// We register stubs for `conversations:get`, `llm:call:anthropic`, and
// `conversations:set-title` directly on a HookBus, mirror the @ax/llm-anthropic
// plugin test pattern (HookBus + makeAgentContext + manual hook registration).
// ---------------------------------------------------------------------------

interface Stubs {
  bus: HookBus;
  getCalls: Array<GetInput>;
  llmCalls: Array<LlmCallInput>;
  setTitleCalls: Array<SetTitleInput>;
  /**
   * Inputs `storage:get` has been called with (only when the stub was
   * registered via `registerStorageGet`).
   */
  storageGetCalls: Array<{ key: string }>;
  setGetResult(v: GetOutput | (() => Promise<GetOutput>)): void;
  setLlmResult(v: LlmCallOutput | (() => Promise<LlmCallOutput>)): void;
  setSetTitleResult(
    v: SetTitleOutput | (() => Promise<SetTitleOutput>),
  ): void;
  /**
   * Register a `storage:get` stub on the bus that returns `value` for the
   * fast-model key (and `undefined` for any other key). Pass a thunk to
   * simulate a transient failure. Call sites that DON'T invoke this leave
   * `storage:get` unregistered, exercising the "no storage layer" path.
   */
  registerStorageGet(
    value: Uint8Array | undefined | (() => Promise<Uint8Array | undefined>),
  ): void;
  /**
   * Register stubs for an alternate provider (used by the storage-override
   * tests). Returns the captured llm-call list.
   */
  registerLlmCallProvider(provider: string): Array<LlmCallInput>;
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
    'llm:call:anthropic',
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

  const storageGetCalls: Array<{ key: string }> = [];

  return {
    bus,
    getCalls,
    llmCalls,
    setTitleCalls,
    storageGetCalls,
    setGetResult(v) {
      getResult = v;
    },
    setLlmResult(v) {
      llmResult = v;
    },
    setSetTitleResult(v) {
      setTitleResult = v;
    },
    registerStorageGet(value) {
      bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
        'storage:get',
        'mock-storage',
        async (_ctx, input) => {
          storageGetCalls.push(input);
          const v = typeof value === 'function' ? await value() : value;
          if (input.key !== 'settings:fast-model') return { value: undefined };
          return { value: v };
        },
      );
    },
    registerLlmCallProvider(provider) {
      const calls: Array<LlmCallInput> = [];
      bus.registerService<LlmCallInput, LlmCallOutput>(
        `llm:call:${provider}`,
        `mock-llm-${provider}`,
        async (_ctx, input) => {
          calls.push(input);
          return {
            text: `Title from ${provider}`,
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      );
      return calls;
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
  it('declares no registers, three calls (with configured provider hook), one subscribe', () => {
    const plugin = createConversationTitlesPlugin({
      model: 'anthropic/claude-haiku-4-5-20251001',
    });
    expect(plugin.manifest).toEqual({
      name: '@ax/conversation-titles',
      version: '0.0.0',
      registers: [],
      calls: [
        'llm:call:anthropic',
        'storage:get',
        'conversations:get',
        'conversations:set-title',
      ],
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

  it('is a no-op when there is more than one assistant turn (post-first turn)', async () => {
    // Regression: subscriber must NOT retry auto-titling after the first
    // assistant turn. If the first attempt was lost (LLM error / validation
    // rejected), every subsequent assistant turn would otherwise re-fire,
    // expanding LLM spend and titling from a transcript the design didn't
    // specify.
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [
        turn('user', [{ type: 'text', text: 'Q1' }]),
        turn('assistant', [{ type: 'text', text: 'A1' }]),
        turn('user', [{ type: 'text', text: 'Q2' }]),
        turn('assistant', [{ type: 'text', text: 'A2' }]),
      ],
    });
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const ctx = makeCtx({ conversationId: 'c1' });
    await stubs.bus.fire('chat:turn-end', ctx, { role: 'assistant' });

    expect(stubs.getCalls).toHaveLength(1);
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
      turns: [
        turn('user', [{ type: 'text', text: 'Hi' }]),
        turn('assistant', [{ type: 'text', text: 'Hello!' }]),
      ],
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
      turns: [
        turn('user', [{ type: 'text', text: 'Hi' }]),
        turn('assistant', [{ type: 'text', text: 'Hello!' }]),
      ],
    });
    stubs.setLlmResult({
      text: 'Untitled',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
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
    await stubs.bus.fire('chat:turn-end', ctx, { role: 'assistant' });

    expect(stubs.llmCalls).toHaveLength(1);
    expect(stubs.setTitleCalls).toHaveLength(0);

    // Privacy: the validation-skipped log MUST log the length of the
    // model's output (a useful "model misbehaving?" signal) and MUST NOT
    // log the raw text — model output is untrusted content (CLAUDE.md
    // invariant 5) and our SECURITY.md says we don't log prompt-derived
    // text.
    expect(debugSpy).toHaveBeenCalledWith(
      'conversation_titles_validation_skipped',
      expect.objectContaining({
        conversationId: 'c1',
        rawLength: 'Untitled'.length,
      }),
    );
    const calls = debugSpy.mock.calls;
    const skippedCall = calls.find(
      (c) => c[0] === 'conversation_titles_validation_skipped',
    );
    expect(skippedCall).toBeDefined();
    const bindings = skippedCall![1] as Record<string, unknown>;
    expect(bindings.raw).toBeUndefined();
    expect(JSON.stringify(bindings)).not.toContain('Untitled');
  });

  it('sanitizes quoted/multi-line model output before writing set-title', async () => {
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [
        turn('user', [{ type: 'text', text: 'Hi' }]),
        turn('assistant', [{ type: 'text', text: 'Hello!' }]),
      ],
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
      turns: [
        turn('user', [{ type: 'text', text: 'Hi' }]),
        turn('assistant', [{ type: 'text', text: 'Hello!' }]),
      ],
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

  // ---------------------------------------------------------------------
  // Runtime model override via `storage:get('settings:fast-model')`.
  //
  // The admin "Model config" tab and the onboarding wizard both write this
  // key. The plugin uses it as the runtime model selection; cfg.model is
  // the fallback when storage is empty / errors / not registered.
  // ---------------------------------------------------------------------

  function seedAssistantTurn(stubs: Stubs): void {
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [
        turn('user', [{ type: 'text', text: 'Hi' }]),
        turn('assistant', [{ type: 'text', text: 'Hello!' }]),
      ],
    });
  }

  it('uses storage:get override when present (different model-id, same provider)', async () => {
    const stubs = makeStubsBus();
    seedAssistantTurn(stubs);
    stubs.registerStorageGet(
      new TextEncoder().encode('anthropic/claude-sonnet-4-6'),
    );
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    await stubs.bus.fire('chat:turn-end', makeCtx({ conversationId: 'c1' }), {
      role: 'assistant',
    });

    expect(stubs.storageGetCalls).toEqual([{ key: 'settings:fast-model' }]);
    expect(stubs.llmCalls).toHaveLength(1);
    expect(stubs.llmCalls[0]?.model).toBe('claude-sonnet-4-6');
  });

  it('uses storage:get override with a different provider hook', async () => {
    const stubs = makeStubsBus();
    seedAssistantTurn(stubs);
    stubs.registerStorageGet(new TextEncoder().encode('openai/gpt-4o'));
    const altCalls = stubs.registerLlmCallProvider('openai');
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    await stubs.bus.fire('chat:turn-end', makeCtx({ conversationId: 'c1' }), {
      role: 'assistant',
    });

    // Storage override routed to the openai hook, NOT the default anthropic hook.
    expect(altCalls).toHaveLength(1);
    expect(altCalls[0]?.model).toBe('gpt-4o');
    expect(stubs.llmCalls).toHaveLength(0);
  });

  it('falls back to cfg.model when storage:get returns undefined', async () => {
    const stubs = makeStubsBus();
    seedAssistantTurn(stubs);
    stubs.registerStorageGet(undefined);
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    await stubs.bus.fire('chat:turn-end', makeCtx({ conversationId: 'c1' }), {
      role: 'assistant',
    });

    expect(stubs.llmCalls).toHaveLength(1);
    // Default fast model id from DEFAULT_TITLE_MODEL.
    expect(stubs.llmCalls[0]?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('falls back to cfg.model when storage:get throws', async () => {
    const stubs = makeStubsBus();
    seedAssistantTurn(stubs);
    stubs.registerStorageGet(async () => {
      throw new PluginError({
        code: 'unknown',
        plugin: 'mock-storage',
        hookName: 'storage:get',
        message: 'simulated backend hiccup',
      });
    });
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const fireResult = await stubs.bus.fire(
      'chat:turn-end',
      makeCtx({ conversationId: 'c1' }),
      { role: 'assistant' },
    );
    expect(fireResult.rejected).toBe(false);
    expect(stubs.llmCalls).toHaveLength(1);
    expect(stubs.llmCalls[0]?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('falls back to cfg.model when storage:get is not registered', async () => {
    const stubs = makeStubsBus(); // no registerStorageGet call
    seedAssistantTurn(stubs);
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    await stubs.bus.fire('chat:turn-end', makeCtx({ conversationId: 'c1' }), {
      role: 'assistant',
    });

    expect(stubs.storageGetCalls).toHaveLength(0);
    expect(stubs.llmCalls).toHaveLength(1);
    expect(stubs.llmCalls[0]?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('falls back to cfg.model when storage value is empty bytes', async () => {
    const stubs = makeStubsBus();
    seedAssistantTurn(stubs);
    stubs.registerStorageGet(new Uint8Array(0));
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    await stubs.bus.fire('chat:turn-end', makeCtx({ conversationId: 'c1' }), {
      role: 'assistant',
    });

    expect(stubs.llmCalls).toHaveLength(1);
    expect(stubs.llmCalls[0]?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('falls back to cfg.model when storage value is not a valid provider/model-id ref', async () => {
    const stubs = makeStubsBus();
    seedAssistantTurn(stubs);
    stubs.registerStorageGet(new TextEncoder().encode('no-slash'));
    const warnSpy = vi.fn();
    const plugin = createConversationTitlesPlugin();
    await plugin.init({ bus: stubs.bus, config: {} });

    const baseCtx = makeCtx({ conversationId: 'c1' });
    const ctx: AgentContext = {
      ...baseCtx,
      logger: { ...baseCtx.logger, warn: warnSpy },
    };
    await stubs.bus.fire('chat:turn-end', ctx, { role: 'assistant' });

    expect(stubs.llmCalls).toHaveLength(1);
    expect(stubs.llmCalls[0]?.model).toBe('claude-haiku-4-5-20251001');
    expect(warnSpy).toHaveBeenCalledWith(
      'conversation_titles_invalid_storage_ref',
      expect.objectContaining({ length: 'no-slash'.length }),
    );
  });

  it('swallows set-title failures (subscriber must not throw)', async () => {
    const stubs = makeStubsBus();
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [
        turn('user', [{ type: 'text', text: 'Hi' }]),
        turn('assistant', [{ type: 'text', text: 'Hello!' }]),
      ],
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

// ---------------------------------------------------------------------------
// parseModelRef
// ---------------------------------------------------------------------------

describe('@ax/conversation-titles parseModelRef', () => {
  it('splits on the first slash', () => {
    expect(parseModelRef('anthropic/claude-haiku-4-5-20251001')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
    });
  });

  it('splits routing-style values on the FIRST slash only', () => {
    expect(parseModelRef('openrouter/anthropic/claude-3-5-sonnet')).toEqual({
      provider: 'openrouter',
      modelId: 'anthropic/claude-3-5-sonnet',
    });
  });

  it.each([
    ['empty', ''],
    ['no-slash', 'no-slash'],
    ['leading-slash', '/leading'],
    ['trailing-slash', 'trailing/'],
  ])('throws invalid-config on %s', (_label, ref) => {
    expect(() => parseModelRef(ref)).toThrowError(PluginError);
  });
});

// ---------------------------------------------------------------------------
// factory config
// ---------------------------------------------------------------------------

describe('@ax/conversation-titles factory config', () => {
  it('produces a manifest with the configured provider hook (anthropic)', () => {
    const plugin = createConversationTitlesPlugin({
      model: 'anthropic/claude-haiku-4-5-20251001',
    });
    expect(plugin.manifest.calls).toEqual([
      'llm:call:anthropic',
      'storage:get',
      'conversations:get',
      'conversations:set-title',
    ]);
  });

  it('produces a manifest with a different provider hook when configured', () => {
    const plugin = createConversationTitlesPlugin({ model: 'openai/gpt-4' });
    expect(plugin.manifest.calls).toEqual([
      'llm:call:openai',
      'storage:get',
      'conversations:get',
      'conversations:set-title',
    ]);
  });

  it('uses the default model when cfg.model is omitted', () => {
    const plugin = createConversationTitlesPlugin();
    expect(plugin.manifest.calls).toContain('llm:call:anthropic');
  });

  it('throws invalid-config at factory time on bad model', () => {
    expect(() =>
      createConversationTitlesPlugin({ model: 'no-slash' }),
    ).toThrowError(PluginError);
  });
});

// ---------------------------------------------------------------------------
// dispatches the configured provider hook
// ---------------------------------------------------------------------------

describe('@ax/conversation-titles dispatches the configured provider hook', () => {
  it('calls llm:call:openai when configured for openai', async () => {
    const stubs = makeStubsBus();
    const openaiCalls: LlmCallInput[] = [];
    stubs.bus.registerService<LlmCallInput, LlmCallOutput>(
      'llm:call:openai',
      'mock-openai',
      async (_ctx, input) => {
        openaiCalls.push(input);
        return {
          text: 'OpenAI Title',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [
        turn('user', [{ type: 'text', text: 'hi' }]),
        turn('assistant', [{ type: 'text', text: 'hello' }]),
      ],
    });

    const plugin = createConversationTitlesPlugin({ model: 'openai/gpt-4' });
    await plugin.init({ bus: stubs.bus, config: {} });

    await stubs.bus.fire('chat:turn-end', makeCtx({ conversationId: 'c1' }), {
      role: 'assistant',
    });

    expect(openaiCalls.length).toBe(1);
    expect(openaiCalls[0].model).toBe('gpt-4');
    expect(stubs.llmCalls.length).toBe(0); // anthropic hook not called
  });
});
