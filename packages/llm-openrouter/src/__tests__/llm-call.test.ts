import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HookBus,
  LlmCallOutputSchema,
  makeAgentContext,
  PluginError,
  type LlmCallInput,
  type LlmCallOutput,
} from '@ax/core';
import {
  COMPLETION_MAX_BYTES,
  ERROR_BODY_MAX_BYTES,
  createLlmOpenRouterPlugin,
} from '../plugin.js';

// ---------------------------------------------------------------------------
// llm:call:openrouter — the OpenAI-compatible POST.
//
// Every test here drives a stub `fetch`; the suite never opens a socket. The
// stub also records the request, because half of what we're asserting is what
// went OUT on the wire (the Bearer header, the bare model id) rather than what
// came back.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function recorder(): {
  calls: RecordedRequest[];
  fetchImpl: (responses: Array<{ status: number; body: unknown }>) => typeof fetch;
} {
  const calls: RecordedRequest[] = [];
  return {
    calls,
    fetchImpl(responses) {
      let n = 0;
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
        calls.push({
          url: String(input),
          method: init?.method,
          headers,
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });
        const next = responses[Math.min(n, responses.length - 1)];
        n += 1;
        return new Response(JSON.stringify(next.body), {
          status: next.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
    },
  };
}

function completion(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gen-test',
    model: 'x-ai/grok-4.6',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello back' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 22 },
    ...over,
  };
}

async function boot(fetchImpl: typeof fetch): Promise<HookBus> {
  const plugin = createLlmOpenRouterPlugin({ apiKey: 'sk-or-test-key', retryDelayMs: 0, fetchImpl });
  const bus = new HookBus();
  await plugin.init({ bus, config: {} });
  return bus;
}

const CTX = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

const INPUT: LlmCallInput = {
  model: 'x-ai/grok-4.6',
  messages: [{ role: 'user', content: 'Hi' }],
  maxTokens: 32,
};

describe('@ax/llm-openrouter llm:call:openrouter — happy path', () => {
  it('maps text, usage, and the stop reason', async () => {
    const rec = recorder();
    const bus = await boot(rec.fetchImpl([{ status: 200, body: completion() }]));
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    expect(out).toEqual({
      text: 'hello back',
      stopReason: 'end_turn',
      usage: { inputTokens: 11, outputTokens: 22 },
    });
  });

  it('returns a value that validates against the shared LlmCallOutputSchema', async () => {
    const rec = recorder();
    const bus = await boot(rec.fetchImpl([{ status: 200, body: completion() }]));
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    expect(LlmCallOutputSchema.parse(out)).toEqual(out);
  });

  it('POSTs to openrouter.ai/api/v1/chat/completions with a Bearer header', async () => {
    const rec = recorder();
    const bus = await boot(rec.fetchImpl([{ status: 200, body: completion() }]));
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(rec.calls[0].method).toBe('POST');
    expect(rec.calls[0].headers.authorization).toBe('Bearer sk-or-test-key');
    expect(rec.calls[0].headers['content-type']).toBe('application/json');
  });

  it('sends the BARE provider-native model id, not the prefixed ref', async () => {
    const rec = recorder();
    const bus = await boot(rec.fetchImpl([{ status: 200, body: completion() }]));
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    expect(rec.calls[0].body.model).toBe('x-ai/grok-4.6');
  });

  it('sends `system` as an OpenAI-style leading system message', async () => {
    const rec = recorder();
    const bus = await boot(rec.fetchImpl([{ status: 200, body: completion() }]));
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, {
      ...INPUT,
      system: 'be brief',
      temperature: 0.2,
    });
    expect(rec.calls[0].body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(rec.calls[0].body.max_tokens).toBe(32);
    expect(rec.calls[0].body.temperature).toBe(0.2);
  });
});

describe('@ax/llm-openrouter finish_reason normalisation', () => {
  const cases: Array<[unknown, LlmCallOutput['stopReason']]> = [
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool_calls', 'tool_use'],
    ['content_filter', 'unknown'],
    ['error', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [wire, expected] of cases) {
    it(`maps finish_reason ${JSON.stringify(wire)} to ${expected}`, async () => {
      const rec = recorder();
      const bus = await boot(
        rec.fetchImpl([
          {
            status: 200,
            body: completion({
              choices: [{ index: 0, message: { content: 'x' }, finish_reason: wire }],
            }),
          },
        ]),
      );
      const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
      expect(out.stopReason).toBe(expected);
    });
  }
});

describe('@ax/llm-openrouter usage mapping', () => {
  it('defaults to zeros when the route omits usage entirely', async () => {
    const rec = recorder();
    const bus = await boot(
      rec.fetchImpl([{ status: 200, body: completion({ usage: undefined }) }]),
    );
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('defaults each token count independently', async () => {
    const rec = recorder();
    const bus = await boot(
      rec.fetchImpl([{ status: 200, body: completion({ usage: { prompt_tokens: 7 } }) }]),
    );
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    expect(out.usage).toEqual({ inputTokens: 7, outputTokens: 0 });
  });

  it('treats a null message content as empty text rather than crashing', async () => {
    const rec = recorder();
    const bus = await boot(
      rec.fetchImpl([
        {
          status: 200,
          body: completion({
            choices: [{ index: 0, message: { content: null }, finish_reason: 'tool_calls' }],
          }),
        },
      ]),
    );
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    expect(out.text).toBe('');
    expect(out.stopReason).toBe('tool_use');
  });

  it('rejects a response with no choices instead of returning empty text', async () => {
    const rec = recorder();
    const bus = await boot(rec.fetchImpl([{ status: 200, body: completion({ choices: [] }) }]));
    await expect(
      bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT),
    ).rejects.toBeInstanceOf(PluginError);
  });
});

describe('@ax/llm-openrouter transient retry', () => {
  it('retries once after a 429 and then succeeds', async () => {
    const rec = recorder();
    const bus = await boot(
      rec.fetchImpl([
        { status: 429, body: { error: { message: 'rate limited' } } },
        { status: 200, body: completion() },
      ]),
    );
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    expect(rec.calls).toHaveLength(2);
    expect(out.text).toBe('hello back');
  });

  it('retries once after a 503 and then succeeds', async () => {
    const rec = recorder();
    const bus = await boot(
      rec.fetchImpl([
        { status: 503, body: { error: { message: 'unavailable' } } },
        { status: 200, body: completion() },
      ]),
    );
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    expect(rec.calls).toHaveLength(2);
    expect(out.text).toBe('hello back');
  });

  it('does NOT retry a 400 and surfaces a PluginError immediately', async () => {
    const rec = recorder();
    const bus = await boot(
      rec.fetchImpl([{ status: 400, body: { error: { message: 'unknown model' } } }]),
    );
    let caught: unknown;
    try {
      await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect(caught).toMatchObject({
      code: 'unknown',
      plugin: '@ax/llm-openrouter',
      hookName: 'llm:call:openrouter',
    });
    expect(rec.calls).toHaveLength(1);
  });

  it('exhausts the single retry on a persistent 500', async () => {
    const rec = recorder();
    const bus = await boot(
      rec.fetchImpl([{ status: 500, body: { error: { message: 'internal' } } }]),
    );
    await expect(
      bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT),
    ).rejects.toBeInstanceOf(PluginError);
    // 1 initial + 1 retry = 2 attempts, then we stop.
    expect(rec.calls).toHaveLength(2);
  });

  it('never puts the API key in the failure message', async () => {
    const rec = recorder();
    const bus = await boot(
      rec.fetchImpl([{ status: 400, body: { error: { message: 'nope' } } }]),
    );
    let caught: unknown;
    try {
      await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    } catch (e) {
      caught = e;
    }
    expect(serialise(caught)).not.toContain('sk-or-test-key');
  });
});

describe('@ax/llm-openrouter credentialResolution mode', () => {
  const ORIGINAL = process.env.OPENROUTER_API_KEY;
  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = ORIGINAL;
  });

  function busWithCredential(
    get: (input: { ref: string; userId: string }) => Promise<string>,
    captured?: { calls: Array<{ ref: string; userId: string }> },
  ): HookBus {
    const bus = new HookBus();
    bus.registerService<{ ref: string; userId: string }, string>(
      'credentials:get',
      '@ax/credentials',
      async (_ctx, input) => {
        captured?.calls.push(input);
        return await get(input);
      },
    );
    return bus;
  }

  it('resolves the key per-call from credentials:get on provider:openrouter, not from the env', async () => {
    // A decoy env key: if the plugin ever preferred process.env over the
    // store, this is the value that would show up on the wire.
    process.env.OPENROUTER_API_KEY = 'sk-or-DECOY-env';
    const captured = { calls: [] as Array<{ ref: string; userId: string }> };
    const rec = recorder();
    const plugin = createLlmOpenRouterPlugin({
      credentialResolution: true,
      retryDelayMs: 0,
      fetchImpl: rec.fetchImpl([{ status: 200, body: completion() }]),
    });
    const bus = busWithCredential(async () => 'sk-or-from-store', captured);
    await plugin.init({ bus, config: {} });

    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', ctx, INPUT);

    expect(out.text).toBe('hello back');
    expect(captured.calls).toEqual([{ ref: 'provider:openrouter', userId: 'u1' }]);
    expect(rec.calls[0].headers.authorization).toBe('Bearer sk-or-from-store');
  });

  it('falls back to OPENROUTER_API_KEY when the store has no row', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-env';
    const rec = recorder();
    const plugin = createLlmOpenRouterPlugin({
      credentialResolution: true,
      retryDelayMs: 0,
      fetchImpl: rec.fetchImpl([{ status: 200, body: completion() }]),
    });
    const bus = busWithCredential(async () => {
      throw new PluginError({
        code: 'not-found',
        plugin: '@ax/credentials',
        message: 'no credential',
      });
    });
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', ctx, INPUT);
    expect(rec.calls[0].headers.authorization).toBe('Bearer sk-or-env');
  });

  it('rejects per-call (not at init) with no-openrouter-credential when nothing resolves', async () => {
    const rec = recorder();
    const plugin = createLlmOpenRouterPlugin({
      credentialResolution: true,
      retryDelayMs: 0,
      fetchImpl: rec.fetchImpl([{ status: 200, body: completion() }]),
    });
    const bus = busWithCredential(async () => {
      throw new PluginError({
        code: 'not-found',
        plugin: '@ax/credentials',
        message: 'no credential',
      });
    });
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await expect(
      bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', ctx, INPUT),
    ).rejects.toMatchObject({
      code: 'no-openrouter-credential',
      plugin: '@ax/llm-openrouter',
    });
    // Nothing went out on the wire — we never dial without a key.
    expect(rec.calls).toHaveLength(0);
  });

  it('uses cfg.apiKey as an explicit override and never queries credentials:get', async () => {
    const captured = { calls: [] as Array<{ ref: string; userId: string }> };
    const rec = recorder();
    const plugin = createLlmOpenRouterPlugin({
      credentialResolution: true,
      apiKey: 'sk-or-override',
      retryDelayMs: 0,
      fetchImpl: rec.fetchImpl([{ status: 200, body: completion() }]),
    });
    const bus = busWithCredential(async () => 'sk-or-from-store', captured);
    await plugin.init({ bus, config: {} });
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', ctx, INPUT);
    expect(captured.calls).toEqual([]);
    expect(rec.calls[0].headers.authorization).toBe('Bearer sk-or-override');
  });
});

describe('@ax/llm-openrouter defaults', () => {
  it('falls back to cfg.defaultModel / defaultMaxTokens when the caller omits them', async () => {
    const rec = recorder();
    const plugin = createLlmOpenRouterPlugin({
      apiKey: 'k',
      retryDelayMs: 0,
      defaultModel: 'qwen/qwen3-max',
      defaultMaxTokens: 128,
      fetchImpl: rec.fetchImpl([{ status: 200, body: completion() }]),
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, {
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(rec.calls[0].body.model).toBe('qwen/qwen3-max');
    expect(rec.calls[0].body.max_tokens).toBe(128);
  });

  it('uses a bare built-in default model when nothing is configured', async () => {
    const rec = recorder();
    const bus = await boot(rec.fetchImpl([{ status: 200, body: completion() }]));
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, {
      messages: [{ role: 'user', content: 'Hi' }],
    });
    // Whatever it is, it must NOT be a prefixed ref — the wire wants a bare
    // provider-native id.
    expect(String(rec.calls[0].body.model)).not.toMatch(/^openrouter\//);
  });
});

describe('@ax/llm-openrouter transport failures', () => {
  it('wraps a thrown fetch error in a PluginError without leaking the key', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const plugin = createLlmOpenRouterPlugin({
      apiKey: 'sk-or-test-key',
      retryDelayMs: 0,
      fetchImpl,
    });
    const bus = new HookBus();
    await plugin.init({ bus, config: {} });
    let caught: unknown;
    try {
      await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect(serialise(caught)).not.toContain('sk-or-test-key');
  });
});

// ---------------------------------------------------------------------------
// Response size cap — TASK-944. We read at most 4 MiB of a completion and at
// most 64 KiB of an error body, counted as the bytes arrive, so a runaway or
// hostile answer can't make the host hold it.
//
// Every size below is a literal, never the exported constant: during a red
// run the constants are still undefined, and a body sized from one would
// never end. The first test pins the constants to these literals.
// ---------------------------------------------------------------------------

const COMPLETION_CAP = 4 * 1024 * 1024;
const ERROR_CAP = 64 * 1024;

/** `total` bytes in `chunk`-byte pieces; records how far a reader pulled. */
function counted(total: number, chunk: number) {
  // A NaN total (an import still undefined during a red run) would never end.
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(chunk) || chunk <= 0) {
    throw new Error(`counted: bad sizes ${String(total)}/${String(chunk)}`);
  }
  const stats = { pulled: 0, cancelled: false, reason: undefined as unknown };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (stats.pulled * chunk >= total) return controller.close();
        stats.pulled += 1;
        controller.enqueue(new Uint8Array(chunk).fill(0x61));
      },
      cancel(reason) {
        stats.cancelled = true;
        stats.reason = reason;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}

/**
 * A cancel reaches the source through the pipe a few microtasks after the
 * reader gives up, so a check on the source waits a macrotask first.
 */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fetch that answers every request with `res`, counting the requests. */
function answering(res: Response): { fetchImpl: typeof fetch; calls: { count: number } } {
  const calls = { count: 0 };
  const fetchImpl = (async () => {
    calls.count += 1;
    return res;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Make one `llm:call:openrouter` that must fail, and return what it threw. */
async function thrownBy(bus: HookBus): Promise<unknown> {
  try {
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
  } catch (e) {
    return e;
  }
  throw new Error('expected llm:call:openrouter to reject');
}

describe('@ax/llm-openrouter response size cap', () => {
  it('the caps are 4 MiB and 64 KiB', () => {
    expect(COMPLETION_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(ERROR_BODY_MAX_BYTES).toBe(64 * 1024);
  });

  it('stops reading a completion past 4 MiB, says why, and does not retry', async () => {
    const { stream, stats } = counted(4 * COMPLETION_CAP, 64 * 1024);
    const server = answering(
      new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const bus = await boot(server.fetchImpl);

    const err = await thrownBy(bus);
    expect(err).toBeInstanceOf(PluginError);
    expect(err).toMatchObject({ code: 'unknown', plugin: '@ax/llm-openrouter' });
    expect((err as Error).message).toBe(
      'OpenRouter API call failed: the response was larger than 4 MiB, so we stopped reading it',
    );
    expect(server.calls.count).toBe(1);
    await nextTask();
    expect(stats.pulled).toBeLessThanOrEqual(COMPLETION_CAP / (64 * 1024) + 2);
    expect(stats.cancelled).toBe(true);
  });

  it('refuses a declared Content-Length over 4 MiB without reading', async () => {
    const { stream, stats } = counted(4 * COMPLETION_CAP, 64 * 1024);
    const server = answering(
      new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(COMPLETION_CAP + 1),
        },
      }),
    );
    const bus = await boot(server.fetchImpl);

    const err = await thrownBy(bus);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as Error).message).toBe(
      'OpenRouter API call failed: the response was larger than 4 MiB, so we stopped reading it',
    );
    expect(server.calls.count).toBe(1);
    await nextTask();
    expect(stats.pulled).toBe(0);
    expect(stats.cancelled).toBe(true);
  });

  it('accepts a completion one byte under 4 MiB', async () => {
    const bodyWith = (content: string) =>
      JSON.stringify(
        completion({
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        }),
      );
    const n = COMPLETION_CAP - 1 - Buffer.byteLength(bodyWith(''));
    const body = bodyWith('a'.repeat(n));
    expect(Buffer.byteLength(body)).toBe(COMPLETION_CAP - 1);
    const server = answering(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const bus = await boot(server.fetchImpl);

    const out = await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    expect(out.text.length).toBe(n);
  });

  it('reads at most 64 KiB of an error body, then reports the status', async () => {
    const { stream, stats } = counted(1024 * 1024, 4096);
    const server = answering(new Response(stream, { status: 400 }));
    const bus = await boot(server.fetchImpl);

    const err = await thrownBy(bus);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as Error).message).toMatch(/^OpenRouter API call failed: HTTP 400/);
    expect(server.calls.count).toBe(1);
    await nextTask();
    expect(stats.pulled).toBeLessThanOrEqual(ERROR_CAP / 4096 + 2);
    expect(stats.cancelled).toBe(true);
  });

  it('reports the status when an error body declares more than 64 KiB, without reading it', async () => {
    const { stream, stats } = counted(1024 * 1024, 4096);
    const server = answering(
      new Response(stream, {
        status: 400,
        headers: { 'content-length': String(ERROR_CAP + 1) },
      }),
    );
    const bus = await boot(server.fetchImpl);

    const err = await thrownBy(bus);
    expect(err).toBeInstanceOf(PluginError);
    expect((err as Error).message).toMatch(/^OpenRouter API call failed: HTTP 400/);
    expect(server.calls.count).toBe(1);
    await nextTask();
    expect(stats.pulled).toBe(0);
    expect(stats.cancelled).toBe(true);
  });
});

/** Flatten an error (message, code, cause, stack) into one searchable string. */
function serialise(e: unknown): string {
  if (e instanceof Error) {
    return [
      e.message,
      e.stack ?? '',
      JSON.stringify(e, Object.getOwnPropertyNames(e)),
      e.cause instanceof Error ? e.cause.message : String(e.cause ?? ''),
    ].join('\n');
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// reasoningEffort — TASK-348. The orchestrator's 5s budget is dominated by
// models that think before answering, so the normalized effort ladder has to
// reach the wire. OpenRouter's vocabulary is identical to ours, so this is a
// straight pass-through and the only thing worth asserting is that it happens.
// ---------------------------------------------------------------------------
describe('@ax/llm-openrouter llm:call:openrouter — reasoningEffort', () => {
  it.each(['minimal', 'low', 'medium', 'high'] as const)(
    'sends reasoning.effort=%s on the wire',
    async (effort) => {
      const rec = recorder();
      const bus = await boot(rec.fetchImpl([{ status: 200, body: completion() }]));
      await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, {
        ...INPUT,
        reasoningEffort: effort,
      });
      expect(rec.calls[0].body.reasoning).toEqual({ effort });
    },
  );

  it('omits `reasoning` ENTIRELY when the caller sets no effort', async () => {
    const rec = recorder();
    const bus = await boot(rec.fetchImpl([{ status: 200, body: completion() }]));
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, INPUT);
    // Negative space, deliberately: `toEqual` against a body that happens to
    // lack the key would pass on a request that carried `reasoning: undefined`
    // or `reasoning: {}`, and OpenRouter reads an empty object as "enable it".
    expect('reasoning' in rec.calls[0].body).toBe(false);
  });

  it('never sends a shape that disables reasoning outright', async () => {
    // Measured 2026-09-11: BOTH `{enabled:false}` and `{effort:'none'}` return
    // 400 "Reasoning is mandatory for this endpoint and cannot be disabled" on
    // z-ai/glm-5.3-flash and google/gemini-3.8-flash. `minimal` is our floor
    // precisely so a caller asking for the least deliberation degrades instead
    // of failing the call. This test is the guard on that invariant.
    const rec = recorder();
    const bus = await boot(rec.fetchImpl([{ status: 200, body: completion() }]));
    await bus.call<LlmCallInput, LlmCallOutput>('llm:call:openrouter', CTX, {
      ...INPUT,
      reasoningEffort: 'minimal',
    });
    const reasoning = rec.calls[0].body.reasoning as Record<string, unknown>;
    expect(reasoning.enabled).toBeUndefined();
    expect(reasoning.effort).not.toBe('none');
  });
});
