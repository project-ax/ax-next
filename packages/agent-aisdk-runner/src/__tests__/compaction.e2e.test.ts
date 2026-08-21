import { describe, expect, it } from 'vitest';
import {
  jsonSchema,
  tool,
  ToolLoopAgent,
  stepCountIs,
  type ModelMessage,
} from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import {
  createCompactor,
  findContextWindowExceeded,
} from '../compaction/compactor.js';

// ---------------------------------------------------------------------------
// Compaction, wired the way main.ts wires it: a real `ToolLoopAgent` driving a
// real multi-step tool loop, with the compactor on `prepareStep`.
//
// The unit suite proves the ladder rewrites messages correctly. This one
// proves the two things only the SDK can answer, and that a unit test would
// happily let us assume wrongly:
//
//   1. A `messages` override returned from `prepareStep` actually CARRIES
//      FORWARD — the compacted list is what later steps send, not a copy the
//      SDK throws away.
//   2. A throw from `prepareStep` reaches the turn loop with our error still
//      reachable in the `cause` chain. The SDK wraps stream failures in
//      `AI_NoOutputGeneratedError`, and if the wrap were lossy the ceiling
//      message the user is supposed to read would be replaced by "No output
//      generated. Check the stream for errors."
// ---------------------------------------------------------------------------

const UNKNOWN_MODEL = 'openrouter/some-vendor/some-model'; // 128k default window

type Chunk = Record<string, unknown>;

/**
 * Same chunk shapes the parity suite uses; see its notes on `finishReason`.
 *
 * `usage` is the V4 PROVIDER shape — `{ inputTokens: { total } }`, not a flat
 * `{ inputTokens }`. The flat form is accepted silently and maps to
 * `usage.inputTokens === undefined`, which would make every assertion here pass
 * for the wrong reason: no reported usage means the compactor falls back to its
 * estimate and never exercises the path this file exists to check.
 */
const toolStep = (inputTokens: number): Chunk[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'm', timestamp: new Date(0) },
  { type: 'tool-input-start', id: 'call-1', toolName: 'Bash' },
  { type: 'tool-input-end', id: 'call-1' },
  {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'Bash',
    input: JSON.stringify({ command: 'ls' }),
  },
  {
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: { inputTokens: { total: inputTokens }, outputTokens: { total: 1 } },
  },
];

const textStep = (inputTokens: number): Chunk[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'r', modelId: 'm', timestamp: new Date(0) },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'done' },
  { type: 'text-end', id: 't' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: { inputTokens: { total: inputTokens }, outputTokens: { total: 1 } },
  },
];

/** Replays `steps` one per provider call, recording every prompt it was sent. */
function modelReplaying(steps: Chunk[][], sentPrompts: unknown[]): MockLanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      sentPrompts.push(prompt);
      const chunks = steps[i++];
      if (chunks === undefined) throw new Error('model script exhausted');
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  });
}

function bashToolReturning(output: string) {
  return tool({
    description: 'run a command',
    inputSchema: jsonSchema<{ command: string }>({
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    }),
    execute: async () => output,
  });
}

/** A conversation whose older tool outputs are big enough to be worth masking. */
function longConversation(pairs: number, chars: number): ModelMessage[] {
  const out: ModelMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
  ];
  for (let i = 0; i < pairs; i++) {
    out.push(
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: `c${i}`, toolName: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: `c${i}`,
            toolName: 'Bash',
            output: { type: 'text', value: `${i}:`.padEnd(chars, 'x') },
          },
        ],
      },
    );
  }
  return out;
}

/** Consume a stream the way main.ts's turn loop does. */
async function drain(
  result: Awaited<ReturnType<ToolLoopAgent<never, never>['stream']>>,
): Promise<{ streamError: unknown; stepsError: unknown }> {
  let streamError: unknown;
  for await (const part of result.fullStream) {
    if (part.type === 'error') streamError = part.error;
  }
  let stepsError: unknown;
  try {
    await result.steps;
  } catch (err) {
    stepsError = err;
  }
  return { streamError, stepsError };
}

describe('compaction on a real ToolLoopAgent', () => {
  it('compacts between steps, and the compaction carries forward', async () => {
    const sentPrompts: unknown[] = [];
    const compactor = createCompactor({
      modelRef: UNKNOWN_MODEL,
      instructions: 'be helpful',
      toolCount: 1,
      log: () => {},
    });
    const agent = new ToolLoopAgent({
      // 90k of the 128k default window — over the 0.6 trigger, under the
      // ceiling — reported by step 1, which is what step 2 acts on.
      model: modelReplaying([toolStep(90_000), textStep(20_000)], sentPrompts),
      instructions: 'be helpful',
      tools: { Bash: bashToolReturning('fresh output') },
      stopWhen: stepCountIs(10),
      prepareStep: ({ steps, messages }) => compactor.step({ steps, messages }),
    });

    const messages = longConversation(8, 20_000);
    const before = JSON.stringify(messages);
    const result = await agent.stream({ messages });
    const { streamError, stepsError } = await drain(result);
    expect(streamError).toBeUndefined();
    expect(stepsError).toBeUndefined();

    // Step 1 had no previous step to report usage, and this conversation is
    // under the threshold by estimate, so it went out whole.
    expect(JSON.stringify(sentPrompts[0])).not.toContain('were dropped');
    // Step 2 acted on step 1's reported 90k.
    expect(JSON.stringify(sentPrompts[1])).toContain('were dropped');

    // The transcript's own messages are untouched — compaction is a send-site
    // transform and the stored bytes are the host's source of truth.
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('surfaces the ceiling error through the SDK with its message intact', async () => {
    const sentPrompts: unknown[] = [];
    const compactor = createCompactor({
      modelRef: UNKNOWN_MODEL,
      instructions: 'be helpful',
      toolCount: 1,
      log: () => {},
    });
    const agent = new ToolLoopAgent({
      // 125k of the 128k window, reported by step 1. The tool that ran on that
      // step returned 400k characters, so the whole problem is in the message
      // the model is mid-thought about — inside the preserved window, where the
      // ladder may not touch it. Nothing to reclaim, still over the ceiling.
      model: modelReplaying([toolStep(125_000), textStep(10)], sentPrompts),
      instructions: 'be helpful',
      tools: { Bash: bashToolReturning('x'.repeat(400_000)) },
      stopWhen: stepCountIs(10),
      prepareStep: ({ steps, messages }) => compactor.step({ steps, messages }),
    });

    const result = await agent.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read the log' }] }],
    });
    const { streamError, stepsError } = await drain(result);

    // WHERE the error lands is the whole point, and it is not where you would
    // guess. `result.steps` RESOLVES: step 1 succeeded, so the SDK has steps to
    // hand back and raises nothing (`NoOutputGeneratedError` fires only when a
    // turn produced nothing at all). The failure exists ONLY as an `error`
    // stream part. That is why the turn loop checks `streamError` before it
    // trusts a resolved `steps` — without that check this ceiling would end the
    // turn as a success with partial content (see main.ts, and the matching
    // parity row).
    expect(stepsError).toBeUndefined();
    const found = findContextWindowExceeded(streamError);
    expect(found).toBeDefined();
    expect(found?.name).toBe('ContextWindowExceededError');
    expect(found?.message).toContain('Starting a new conversation');
    // It failed on step 2, having genuinely tried step 1.
    expect(sentPrompts).toHaveLength(1);
  });
});
